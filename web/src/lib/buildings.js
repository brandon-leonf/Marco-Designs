import * as turf from "@turf/turf";

/**
 * Detect the existing building on a parcel, from published footprint data.
 *
 * Two sources, tried in order:
 *
 * 1. NJDEP Building Footprints — the State's own layer. Authoritative where it
 *    exists, but it is compiled from LiDAR flights (NOAA Post-Sandy and
 *    friends) rather than flown statewide, so whole municipalities are absent.
 *    Union City is one of them.
 * 2. OpenStreetMap buildings, via Overpass. The brief asked for Overture Maps
 *    here; Overture publishes GeoParquet on object storage with no queryable
 *    endpoint a browser can call, so its buildings theme cannot be read live.
 *    OSM is what that theme is largely built from, and it does answer over
 *    HTTP with CORS, so it stands in as the fallback.
 *
 * Neither is a survey, and the UI must say which one answered — see
 * `source` on the returned object.
 */

const NJDEP_URL =
  "https://mapsdep.nj.gov/arcgis/rest/services/Features/Structures/MapServer/8/query";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const SQ_FT_PER_SQ_M = 10.763910416709722;

export const BUILDING_SOURCES = {
  njdep: {
    id: "njdep",
    name: "NJDEP Building Footprints",
    url: "https://mapsdep.nj.gov/arcgis/rest/services/Features/Structures/MapServer/8",
    detail: "New Jersey Department of Environmental Protection, derived from LiDAR surveys",
  },
  osm: {
    id: "osm",
    name: "OpenStreetMap buildings",
    url: "https://www.openstreetmap.org/copyright",
    detail: "Contributor-maintained building outlines, via the Overpass API",
  },
};

/** Every polygon ring in a GeoJSON geometry, as turf polygons. */
function toPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [turf.polygon(geometry.coordinates)];
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((rings) => turf.polygon(rings));
  }
  return [];
}

/** The parcel as one turf polygon, or null when it cannot be read. */
function parcelPolygon(parcelGeojson) {
  const polygons = toPolygons(parcelGeojson);
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return polygons[0];
  // A multipart parcel is treated as its union so overlap is measured once.
  // Turf 7 takes a FeatureCollection here, not two positional polygons.
  return turf.union(turf.featureCollection(polygons)) ?? polygons[0];
}

/**
 * Of the candidate buildings, the one overlapping this parcel most.
 *
 * The area reported is the *clipped* footprint — the part of the building
 * standing on this lot — because that is the figure the zoning maths subtracts
 * from what the lot permits. On an attached row house the neighbour's half is
 * not this owner's to count.
 */
function bestOverlap(candidates, parcel) {
  let best = null;
  for (const candidate of candidates) {
    for (const polygon of toPolygons(candidate)) {
      let clipped = null;
      try {
        // Turf 7 signature: one FeatureCollection of the shapes to intersect.
        clipped = turf.intersect(turf.featureCollection([polygon, parcel]));
      } catch {
        // Self-intersecting or otherwise invalid source geometry: skip it
        // rather than let one bad outline abort the whole detection.
        continue;
      }
      if (!clipped) continue;
      const areaSqFt = turf.area(clipped) * SQ_FT_PER_SQ_M;
      if (areaSqFt <= 0) continue;
      if (!best || areaSqFt > best.areaSqft) {
        best = {
          areaSqft: areaSqFt,
          geometry: clipped.geometry,
          fullGeometry: polygon.geometry,
          fullAreaSqft: turf.area(polygon) * SQ_FT_PER_SQ_M,
        };
      }
    }
  }
  return best;
}

/** NJDEP footprints intersecting the parcel. */
async function queryNjdep(parcelGeojson, signal) {
  const rings =
    parcelGeojson.type === "Polygon"
      ? parcelGeojson.coordinates
      : parcelGeojson.coordinates.flat();
  const params = new URLSearchParams({
    geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPolygon",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  const response = await fetch(`${NJDEP_URL}?${params}`, { signal });
  if (!response.ok) throw new Error(`NJDEP returned ${response.status}.`);
  const body = await response.json();
  return (body.features ?? []).map((feature) => feature.geometry).filter(Boolean);
}

/** OpenStreetMap buildings over the parcel's bounding box. */
async function queryOverpass(parcelGeojson, signal) {
  const [west, south, east, north] = turf.bbox(parcelGeojson);
  const query = `[out:json][timeout:25];(way["building"](${south},${west},${north},${east});relation["building"](${south},${west},${north},${east}););out geom;`;
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    body: new URLSearchParams({ data: query }),
    signal,
  });
  if (!response.ok) throw new Error(`Overpass returned ${response.status}.`);
  const body = await response.json();

  const geometries = [];
  for (const element of body.elements ?? []) {
    if (element.type === "way" && Array.isArray(element.geometry)) {
      const ring = element.geometry.map((point) => [point.lon, point.lat]);
      if (ring.length < 4) continue;
      // Overpass leaves the ring open; GeoJSON requires it closed.
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
      if (ring.length < 4) continue;
      geometries.push({ type: "Polygon", coordinates: [ring] });
    } else if (element.type === "relation") {
      for (const member of element.members ?? []) {
        if (member.role !== "outer" || !Array.isArray(member.geometry)) continue;
        const ring = member.geometry.map((point) => [point.lon, point.lat]);
        if (ring.length < 4) continue;
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
        if (ring.length < 4) continue;
        geometries.push({ type: "Polygon", coordinates: [ring] });
      }
    }
  }
  return geometries;
}

/**
 * The existing building standing on this parcel, or null if neither source
 * has one. Never throws for a source that simply has no coverage — that is an
 * answer ("nothing published here"), not a failure.
 */
export async function detectExistingBuilding(parcelGeojson, signal) {
  const parcel = parcelPolygon(parcelGeojson);
  if (!parcel) return null;

  for (const [sourceId, load] of [
    ["njdep", queryNjdep],
    ["osm", queryOverpass],
  ]) {
    let candidates = [];
    try {
      candidates = await load(parcelGeojson, signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // One source being unreachable must not stop the next from answering.
      continue;
    }
    if (candidates.length === 0) continue;
    const best = bestOverlap(candidates, parcel);
    if (!best) continue;
    return {
      ...best,
      areaSqft: Math.round(best.areaSqft),
      fullAreaSqft: Math.round(best.fullAreaSqft),
      // True when the outline crosses the lot line, so the UI can explain why
      // the reported footprint is smaller than the building looks.
      clipped: Math.round(best.fullAreaSqft) - Math.round(best.areaSqft) > 5,
      candidateCount: candidates.length,
      source: BUILDING_SOURCES[sourceId],
    };
  }
  return null;
}
