// Which edge of the lot faces the street.
//
// The envelope math has to put the front setback on the front. Until now that
// was a convention — the front was whichever edge the recorded frontage
// implied — which is right for a rectangular lot squared to its street and
// silently wrong for a corner lot, a flag lot, or anything on a bend.
//
// NJ publishes road centerlines through the same NJGIN ArcGIS host the parcel
// importer reads, natively in EPSG:3424, so the geometry lines up with the
// parcels without a reprojection step. This module fetches the segments around
// a parcel, finds the nearest one, and reports which parcel edge faces it.
//
// Read-only, public, CORS-open. Same caveat as the parcels: centerlines are a
// planning reference, not a survey of the right-of-way.

const LAYER =
  "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/ArcGIS/rest/services/Tran_road/FeatureServer/0";

export const NJ_ROADS_SOURCE = "NJGIN Tran_road centerlines";

const FT_PER_DEG_LAT = 364000; // ~69 miles, close enough at parcel scale
const SEARCH_DEG = 0.0012; // ~430 ft: far enough to catch the fronting street

/** Local planar feet about an origin, so distances are comparable. */
function toFeet([lng, lat], origin) {
  const kx = Math.cos((origin[1] * Math.PI) / 180) * FT_PER_DEG_LAT;
  return { x: (lng - origin[0]) * kx, y: (lat - origin[1]) * FT_PER_DEG_LAT };
}

/** Perpendicular distance from a point to a finite segment, in feet. */
function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t)); // clamp: the nearest point may be an endpoint
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Outer ring of a Polygon or the largest ring of a MultiPolygon. */
function outerRing(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") return geometry.coordinates?.[0] ?? null;
  if (geometry.type === "MultiPolygon") {
    let best = null;
    for (const poly of geometry.coordinates ?? []) {
      const ring = poly?.[0];
      if (ring && (!best || ring.length > best.length)) best = ring;
    }
    return best;
  }
  return null;
}

/**
 * Planning-only rectangular dimensions for a parcel whose MOD-IV record does
 * not contain frontage × depth. Coordinates must already be in a local feet
 * frame (the shape exposed as parcel_geojson by the NJGIN adapter).
 *
 * When a road match exists, its fronting edge defines the frontage axis. The
 * full parcel is projected onto that axis and its perpendicular to obtain an
 * enclosing width/depth. Without a road match, use the smallest edge-aligned
 * bounding rectangle and call its shorter side frontage. These are explicitly
 * estimates for the interactive diagram, never deed or survey dimensions.
 */
export function buildParcelPlanFrame(parcelGeojson, streetEdge = null) {
  const geometry = parcelGeojson?.type === "Feature" ? parcelGeojson.geometry : parcelGeojson;
  const ring = outerRing(geometry);
  if (!ring || ring.length < 4) return null;
  const points =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  if (points.length < 3) return null;

  const axisFromEdge = (a, b) => {
    const dx = Number(b?.[0]) - Number(a?.[0]);
    const dy = Number(b?.[1]) - Number(a?.[1]);
    const length = Math.hypot(dx, dy);
    if (!(length > 1)) return null;
    const ux = dx / length;
    const uy = dy / length;
    const vx = -uy;
    const vy = ux;
    const along = points.map(([x, y]) => Number(x) * ux + Number(y) * uy);
    const across = points.map(([x, y]) => Number(x) * vx + Number(y) * vy);
    const width = Math.max(...along) - Math.min(...along);
    const depth = Math.max(...across) - Math.min(...across);
    if (!(width > 1) || !(depth > 1)) return null;
    return { ux, uy, vx, vy, width, depth, boxArea: width * depth, a, b };
  };

  const frontIndex = Number(streetEdge?.edgeIndex);
  let selected =
    Number.isInteger(frontIndex) && frontIndex >= 0 && frontIndex < points.length
      ? axisFromEdge(points[frontIndex], points[(frontIndex + 1) % points.length])
      : null;
  let streetOriented = Boolean(selected);

  if (!selected) {
    for (let index = 0; index < points.length; index += 1) {
      const candidate = axisFromEdge(points[index], points[(index + 1) % points.length]);
      if (candidate && (!selected || candidate.boxArea < selected.boxArea)) selected = candidate;
    }
    streetOriented = false;
  }
  if (!selected) return null;

  let { ux, uy, vx, vy } = selected;
  if (streetOriented) {
    const center = centroidOf(points);
    const midpoint = [
      (Number(selected.a[0]) + Number(selected.b[0])) / 2,
      (Number(selected.a[1]) + Number(selected.b[1])) / 2,
    ];
    // +Y is always into the lot, away from the matched street edge.
    if ((center[0] - midpoint[0]) * vx + (center[1] - midpoint[1]) * vy < 0) {
      vx *= -1;
      vy *= -1;
    }
  } else if (selected.width > selected.depth) {
    // With no street match, keep the conventional shorter-side frontage.
    [ux, uy, vx, vy] = [vx, vy, ux, uy];
  }

  const rawPoint = ([x, y]) => ({
    x: Number(x) * ux + Number(y) * uy,
    y: Number(x) * vx + Number(y) * vy,
  });
  const allCoordinates =
    geometry.type === "Polygon"
      ? geometry.coordinates.flat(1)
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates.flat(2)
        : [];
  const projected = allCoordinates.map(rawPoint);
  if (!projected.length) return null;
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const projectCoordinate = (coordinate) => {
    const point = rawPoint(coordinate);
    return [point.x - minX, point.y - minY];
  };
  const projectGeometry = (input) => {
    const source = input?.type === "Feature" ? input.geometry : input;
    if (!source) return null;
    if (source.type === "Polygon") {
      return {
        type: "Polygon",
        coordinates: source.coordinates.map((sourceRing) => sourceRing.map(projectCoordinate)),
      };
    }
    if (source.type === "MultiPolygon") {
      return {
        type: "MultiPolygon",
        coordinates: source.coordinates.map((polygon) =>
          polygon.map((sourceRing) => sourceRing.map(projectCoordinate))
        ),
      };
    }
    return null;
  };

  return {
    width_ft: Math.round((maxX - minX) * 10) / 10,
    depth_ft: Math.round((maxY - minY) * 10) / 10,
    source: "parcel_geometry",
    method: streetOriented ? "street_oriented" : "minimum_bounding_rectangle",
    geometry: projectGeometry(geometry),
    projectGeometry,
  };
}

export function estimateParcelRectDims(parcelGeojson, streetEdge = null) {
  const frame = buildParcelPlanFrame(parcelGeojson, streetEdge);
  if (!frame) return null;
  return {
    width_ft: frame.width_ft,
    depth_ft: frame.depth_ft,
    source: frame.source,
    method: frame.method,
  };
}

function centroidOf(ring) {
  const points =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  const sum = points.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

/** Every line segment of a road feature, as flat coordinate pairs. */
function roadSegments(feature) {
  const g = feature?.geometry;
  if (!g) return [];
  const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
  const out = [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i += 1) out.push([line[i], line[i + 1]]);
  }
  return out;
}

/** Human-readable primary name supplied by the NENA road layer. */
function roadName(props) {
  const name =
    props?.PRIMENAME ||
    [props?.ST_PREDIR, props?.ST_NAME, props?.ST_POSTYP, props?.ST_POSDIR]
      .filter(Boolean)
      .join(" ")
      .trim();
  return name || null;
}

/** Fetch centerlines around a point. Returns [] rather than throwing. */
export async function fetchNearbyRoads([lng, lat], signal) {
  const params = new URLSearchParams({
    geometry: `${lng - SEARCH_DEG},${lat - SEARCH_DEG},${lng + SEARCH_DEG},${lat + SEARCH_DEG}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "PRIMENAME,ST_PREDIR,ST_NAME,ST_POSTYP,ST_POSDIR,SUBTYPE",
    returnGeometry: "true",
    f: "geojson",
  });
  try {
    const res = await fetch(`${LAYER}/query?${params}`, { signal });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.features) ? body.features : [];
  } catch {
    return []; // a missing road layer degrades to the previous convention
  }
}

/**
 * Which parcel edge faces the street, given the parcel and nearby centerlines.
 *
 * Each edge is scored by the distance from its midpoint to the nearest road.
 * The midpoint rather than the whole edge because a long side running toward
 * the street would otherwise beat the short edge actually fronting it.
 *
 * Returns null when nothing is close enough to be the fronting street — a lot
 * with no road within the search radius should say so, not guess.
 */
export function streetFacingEdge(parcelGeojson, roads) {
  const geometry = parcelGeojson?.type === "Feature" ? parcelGeojson.geometry : parcelGeojson;
  const ring = outerRing(geometry);
  if (!ring || ring.length < 4 || !roads?.length) return null;

  const origin = centroidOf(ring);
  const segments = [];
  for (const feature of roads) {
    const name = roadName(feature.properties);
    for (const [a, b] of roadSegments(feature)) {
      segments.push({ name, a: toFeet(a, origin), b: toFeet(b, origin) });
    }
  }
  if (!segments.length) return null;

  let best = null;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const a = toFeet(ring[i], origin);
    const b = toFeet(ring[i + 1], origin);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const lengthFt = Math.hypot(b.x - a.x, b.y - a.y);
    if (lengthFt < 1) continue; // skip slivers from digitising noise

    let nearest = null;
    for (const seg of segments) {
      const d = distanceToSegment(mid, seg.a, seg.b);
      if (!nearest || d < nearest.distanceFt) nearest = { distanceFt: d, name: seg.name };
    }
    if (nearest && (!best || nearest.distanceFt < best.distanceFt)) {
      const center = toFeet(origin, origin);
      const inward = { x: center.x - mid.x, y: center.y - mid.y };
      const inwardLength = Math.hypot(inward.x, inward.y);
      const edgeUnit = { x: (b.x - a.x) / lengthFt, y: (b.y - a.y) / lengthFt };
      const inwardUnit =
        inwardLength > 0
          ? { x: inward.x / inwardLength, y: inward.y / inwardLength }
          : { x: -edgeUnit.y, y: edgeUnit.x };
      // Geographic north expressed in model coordinates. The renderer defines
      // a direction as (sin(angle), -cos(angle)), with +X along the front edge
      // and +Y into the parcel.
      const northX = edgeUnit.y;
      const northY = inwardUnit.y;
      best = {
        edgeIndex: i,
        lengthFt,
        distanceFt: nearest.distanceFt,
        streetName: nearest.name,
        // Compass bearing of the edge, for orienting the massing.
        bearingDeg: ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360,
        northAngleDeg:
          ((Math.atan2(northX, -northY) * 180) / Math.PI + 360) % 360,
      };
    }
  }

  // Beyond ~150 ft the "nearest" road is more likely the next street over than
  // the one this lot fronts, so decline rather than mislead.
  if (!best || best.distanceFt > 150) return null;
  return best;
}

/** Fetch and match in one abortable operation for React callers. */
export async function matchParcelToRoad(parcelGeojson, signal) {
  const geometry = parcelGeojson?.type === "Feature" ? parcelGeojson.geometry : parcelGeojson;
  const ring = outerRing(geometry);
  if (!ring || ring.length < 4) return null;
  const roads = await fetchNearbyRoads(centroidOf(ring), signal);
  return streetFacingEdge(geometry, roads);
}
