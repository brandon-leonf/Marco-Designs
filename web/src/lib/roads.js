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
