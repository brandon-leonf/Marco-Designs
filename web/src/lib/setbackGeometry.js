import {
  buffer,
  difference,
  featureCollection,
  lineString,
  multiLineString,
  polygon,
} from "@turf/turf";

// Turf's buffer operation expects longitude/latitude. The site-plan geometry
// is already in a local feet-based frame, so temporarily place that frame near
// New Jersey, buffer it in feet, and project it back. At parcel scale this
// preserves the source shape while giving us reliable round joins along a
// curved frontage.
const ORIGIN_LNG = -74;
const ORIGIN_LAT = 40;
const FT_PER_DEG_LAT = 364000;
const FT_PER_DEG_LNG = Math.cos((ORIGIN_LAT * Math.PI) / 180) * FT_PER_DEG_LAT;

const asGeometry = (value) => (value?.type === "Feature" ? value.geometry : value);
const toGeo = ([x, y]) => [
  ORIGIN_LNG + Number(x) / FT_PER_DEG_LNG,
  ORIGIN_LAT + Number(y) / FT_PER_DEG_LAT,
];
const fromGeo = ([lng, lat]) => [
  (Number(lng) - ORIGIN_LNG) * FT_PER_DEG_LNG,
  (Number(lat) - ORIGIN_LAT) * FT_PER_DEG_LAT,
];

function mapGeometryCoordinates(geometry, mapCoordinate) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring) => ring.map(mapCoordinate)),
    };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((poly) =>
        poly.map((ring) => ring.map(mapCoordinate))
      ),
    };
  }
  return null;
}

function outerRings(geometry) {
  if (geometry?.type === "Polygon") return geometry.coordinates?.[0] ? [geometry.coordinates[0]] : [];
  if (geometry?.type === "MultiPolygon") {
    return geometry.coordinates.map((poly) => poly?.[0]).filter(Boolean);
  }
  return [];
}

function openRing(ring) {
  if (!ring?.length) return [];
  const last = ring.length - 1;
  return ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1]
    ? ring.slice(0, -1)
    : ring;
}

function signedArea(ring) {
  const points = openRing(ring);
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    twiceArea += Number(x1) * Number(y2) - Number(x2) * Number(y1);
  }
  return twiceArea / 2;
}

/**
 * Split parcel-boundary segments into the street-facing front, the opposing
 * rear, and both sides. buildParcelPlanFrame guarantees +Y points away from
 * the matched street, so the inward normal identifies even a curved frontage
 * one short segment at a time.
 */
function classifiedBoundarySegments(geometry) {
  const front = [];
  const rear = [];
  for (const sourceRing of outerRings(geometry)) {
    const ring = openRing(sourceRing);
    if (ring.length < 3) continue;
    const direction = signedArea(ring) >= 0 ? 1 : -1;
    const ys = ring.map((coordinate) => Number(coordinate[1]));
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const candidates = [];

    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      const dx = Number(b[0]) - Number(a[0]);
      const dy = Number(b[1]) - Number(a[1]);
      const length = Math.hypot(dx, dy);
      if (!(length > 0.05)) continue;
      const inwardY = direction * dx / length;
      const midpointY = (Number(a[1]) + Number(b[1])) / 2;
      candidates.push({ segment: [a, b], inwardY, midpointY });
    }

    const frontSegments = candidates
      .filter(({ inwardY, midpointY }) => inwardY > 0.28 && midpointY <= centerY)
      .map(({ segment }) => segment);
    const rearSegments = candidates
      .filter(({ inwardY, midpointY }) => inwardY < -0.28 && midpointY >= centerY)
      .map(({ segment }) => segment);

    // A malformed or unusually digitised ring should still get one definite
    // front and rear edge instead of silently omitting a required setback.
    front.push(
      ...(frontSegments.length
        ? frontSegments
        : [candidates.reduce((best, item) =>
            !best || item.midpointY < best.midpointY ? item : best
          ).segment])
    );
    rear.push(
      ...(rearSegments.length
        ? rearSegments
        : [candidates.reduce((best, item) =>
            !best || item.midpointY > best.midpointY ? item : best
          ).segment])
    );
  }
  return { front, rear };
}

function polygonFeature(geometry) {
  if (geometry.type === "Polygon") return polygon(geometry.coordinates);
  return { type: "Feature", properties: {}, geometry };
}

function bufferedBoundary(segments, distanceFt) {
  if (!(distanceFt > 0) || !segments.length) return null;
  const geographicSegments = segments.map((segment) => segment.map(toGeo));
  const lines = geographicSegments.length === 1
    ? lineString(geographicSegments[0])
    : multiLineString(geographicSegments);
  return buffer(lines, distanceFt, { units: "feet", steps: 16 });
}

/**
 * Closed, edge-specific buildable envelope in the plan's local feet frame.
 *
 * 1. An inward parcel buffer applies the side-yard minimum to both sides.
 * 2. Bands measured from the real front and rear boundary are removed using
 *    their own setback distances.
 * 3. Because those bands are made from the actual boundary segments, a curved
 *    street frontage remains curved instead of becoming a rectangular chord.
 */
export function buildSetbackEnvelope(parcelGeometry, setbacks) {
  const source = asGeometry(parcelGeometry);
  if (!source || !["Polygon", "MultiPolygon"].includes(source.type)) return null;

  const sideOne = Math.max(0, Number(setbacks?.sideOne ?? setbacks?.side) || 0);
  const sideTotal = Math.max(0, Number(setbacks?.sideTotal) || 0);
  const side = Math.max(sideOne, sideTotal / 2);
  const front = Math.max(0, Number(setbacks?.front) || 0);
  const rear = Math.max(0, Number(setbacks?.rear) || 0);

  const geographic = mapGeometryCoordinates(source, toGeo);
  let envelope = side > 0
    ? buffer(polygonFeature(geographic), -side, { units: "feet", steps: 16 })
    : polygonFeature(geographic);
  if (!envelope) return null;

  const classified = classifiedBoundarySegments(source);
  const frontBand = bufferedBoundary(classified.front, front);
  const rearBand = bufferedBoundary(classified.rear, rear);
  for (const band of [frontBand, rearBand]) {
    if (!band || !envelope) continue;
    envelope = difference(featureCollection([envelope, band]));
  }
  return envelope?.geometry
    ? mapGeometryCoordinates(envelope.geometry, fromGeo)
    : null;
}

function ringArea(ring) {
  return Math.abs(signedArea(ring));
}

/** Exact square-foot area because plan coordinates are already feet. */
export function planarGeometryArea(geometry) {
  const source = asGeometry(geometry);
  const polygons = source?.type === "Polygon"
    ? [source.coordinates]
    : source?.type === "MultiPolygon"
      ? source.coordinates
      : [];
  return polygons.reduce((sum, rings) => {
    if (!rings?.length) return sum;
    return sum + ringArea(rings[0]) - rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0);
  }, 0);
}
