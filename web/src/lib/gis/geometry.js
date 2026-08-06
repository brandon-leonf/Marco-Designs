// Geometry normalization shared by every zoning-layer source.
//
// The four source families disagree about how a polygon with holes is written
// down. Shapefiles and ArcGIS JSON put every ring in one flat list and encode
// outer-versus-hole in the ring's direction; GeoJSON, WKB and KML nest holes
// inside their outer ring. Everything downstream — the Leaflet preview, the
// point-in-polygon address test, Turf's area calculation, and PostGIS through
// the publish RPC — expects the nested GeoJSON form with RFC 7946 winding, so
// each reader converts to that here rather than each consumer coping with four
// conventions.

/**
 * Twice the signed area of a ring. Positive is counter-clockwise in
 * longitude/latitude order, which RFC 7946 requires of an exterior ring.
 */
export function ringSignedArea(ring) {
  let sum = 0;
  for (let index = 0, last = ring.length - 1; index < ring.length; last = index, index += 1) {
    sum += (ring[last][0] - ring[index][0]) * (ring[last][1] + ring[index][1]);
  }
  return sum;
}

/** A ring's first point repeated at the end, as every format requires. */
export function closeRing(ring) {
  if (ring.length < 3) return ring;
  const [first] = ring;
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
}

/**
 * Group a flat ring list into polygons the way the shapefile and ArcGIS JSON
 * specifications define it: a clockwise ring opens a new polygon and every
 * counter-clockwise ring after it is a hole in that polygon.
 *
 * Two things go wrong in real municipal data and are handled rather than
 * trusted. A layer whose rings are all wound the same way — common in exports
 * that have been through a repair tool — would otherwise collapse into one
 * polygon with every other ring as a hole, so a ring is only accepted as a hole
 * when it actually falls inside the polygon it would belong to. And a file whose
 * very first ring is counter-clockwise has no polygon to attach it to, so it
 * becomes an exterior ring instead of being dropped.
 */
export function polygonsFromFlatRings(rings) {
  const usable = rings.filter((ring) => ring.length >= 4);
  if (usable.length === 0) return null;

  const polygons = [];
  for (const ring of usable) {
    const isClockwise = ringSignedArea(ring) < 0;
    const current = polygons[polygons.length - 1];
    if (isClockwise || !current || !ringInsideRing(ring, current[0])) {
      polygons.push([ring]);
    } else {
      current.push(ring);
    }
  }

  const wound = polygons.map((polygon) =>
    polygon.map((ring, index) => orientRing(ring, index === 0))
  );
  return wound.length === 1
    ? { type: "Polygon", coordinates: wound[0] }
    : { type: "MultiPolygon", coordinates: wound.map((polygon) => [...polygon]) };
}

/** Re-wind one ring: exterior counter-clockwise, hole clockwise (RFC 7946 §3.1.6). */
function orientRing(ring, exterior) {
  const counterClockwise = ringSignedArea(ring) > 0;
  return counterClockwise === exterior ? ring : [...ring].reverse();
}

/** Apply RFC 7946 winding to an already-nested polygonal geometry. */
export function normalizeWinding(geometry) {
  if (geometry?.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring, index) => orientRing(ring, index === 0)),
    };
  }
  if (geometry?.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((polygon) =>
        polygon.map((ring, index) => orientRing(ring, index === 0))
      ),
    };
  }
  return geometry;
}

/**
 * Reduce any geometry to the Polygon or MultiPolygon a zoning boundary has to
 * be, or null when there is no area in it at all.
 *
 * Published zoning layers routinely carry more than their district polygons:
 * annotation points, boundary centrelines, and mixed geometry collections. A
 * point cannot be a district, so it is dropped here — and reported by count, so
 * the operator learns the layer was filtered instead of wondering where the
 * features went.
 */
export function toPolygonal(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") {
    return geometry.coordinates?.length ? normalizeWinding(geometry) : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = (geometry.coordinates ?? []).filter((polygon) => polygon?.length);
    if (polygons.length === 0) return null;
    return normalizeWinding(
      polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons }
    );
  }
  if (geometry.type === "GeometryCollection") {
    const polygons = [];
    for (const child of geometry.geometries ?? []) {
      const polygonal = toPolygonal(child);
      if (!polygonal) continue;
      if (polygonal.type === "Polygon") polygons.push(polygonal.coordinates);
      else polygons.push(...polygonal.coordinates);
    }
    if (polygons.length === 0) return null;
    return polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

/**
 * Longitude/latitude bounds of a feature list, used to centre the preview map
 * and to sanity-check that a layer landed where the municipality is.
 */
export function featuresBbox(features) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return;
      minX = Math.min(minX, coords[0]);
      minY = Math.min(minY, coords[1]);
      maxX = Math.max(maxX, coords[0]);
      maxY = Math.max(maxY, coords[1]);
      return;
    }
    coords.forEach(visit);
  };

  for (const feature of features ?? []) {
    const coordinates = feature?.geometry?.coordinates;
    if (Array.isArray(coordinates)) visit(coordinates);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** Whether a ring's first vertex lies inside another ring (ray casting). */
function ringInsideRing(ring, outer) {
  const [x, y] = ring[0];
  let inside = false;
  for (let index = 0, last = outer.length - 1; index < outer.length; last = index, index += 1) {
    const [xi, yi] = outer[index];
    const [xj, yj] = outer[last];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
