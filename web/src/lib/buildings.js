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

// Overpass is community-run and regularly answers "too busy" rather than data.
// A single endpoint therefore turns a transient load spike into "this parcel
// has no published building", which is a very different claim. Mirrors are
// tried in order until one actually returns data.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// One budget for the whole Overpass step, however many mirrors it takes. A
// per-attempt timeout bounds each try but not the wait, and the wait is what
// the client experiences.
const OVERPASS_BUDGET_MS = 8000;
// How long a mirror is given to itself before the next one is enlisted
// alongside it, so a slow instance does not have to fail before we look further.
const OVERPASS_HEDGE_MS = 2500;

const SQ_FT_PER_SQ_M = 10.763910416709722;
const FT_PER_DEGREE_LAT = 364566;

// Outbuildings are not the house. They are kept out of the comparables so a
// block full of detached garages cannot drag the estimate down.
const ACCESSORY_BUILDING_TAGS = new Set([
  "garage",
  "garages",
  "carport",
  "shed",
  "hut",
  "roof",
  "greenhouse",
  "conservatory",
  "cabin",
]);
const ACCESSORY_MAX_SQFT = 260;

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
    const candidateGeometry = candidate?.geometry?.type ? candidate.geometry : candidate;
    const candidateTags = candidate?.tags ?? candidate?.properties ?? null;
    for (const polygon of toPolygons(candidateGeometry)) {
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
          tags: candidateTags,
        };
      }
    }
  }
  return best;
}

/**
 * The parcel's bounding box, grown by `radiusFt` on every side.
 *
 * The wider box is what makes the neighbourhood readable: when nothing is
 * published on this lot, the houses either side of it are the best available
 * evidence for what stands on it.
 */
function expandedBbox(parcelGeojson, radiusFt) {
  const [west, south, east, north] = turf.bbox(parcelGeojson);
  if (!(radiusFt > 0)) return [west, south, east, north];
  const latPad = radiusFt / FT_PER_DEGREE_LAT;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const lonPad = latPad / Math.max(Math.cos(midLat), 0.1);
  return [west - lonPad, south - latPad, east + lonPad, north + latPad];
}

/** NJDEP footprints inside a bounding box. */
async function queryNjdep([west, south, east, north], signal) {
  const params = new URLSearchParams({
    geometry: JSON.stringify({
      xmin: west,
      ymin: south,
      xmax: east,
      ymax: north,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "200",
    f: "geojson",
  });
  const response = await fetch(`${NJDEP_URL}?${params}`, { signal });
  if (!response.ok) throw new Error(`NJDEP returned ${response.status}.`);
  const body = await response.json();
  return (body.features ?? [])
    .filter((feature) => feature.geometry)
    .map((feature) => ({ geometry: feature.geometry, properties: feature.properties ?? null }));
}

/**
 * Run one Overpass query, moving to the next mirror when an instance declines.
 *
 * A loaded instance answers HTTP 200 with an XML error document rather than a
 * status code, so the body has to be inspected before a mirror can be believed.
 */
async function overpassJson(query, signal) {
  // Tried one at a time, this cost the sum of every mirror's timeout — 27
  // seconds of "Measuring the existing building…" on a day when Overpass was
  // busy, which is what the fallback list was supposed to prevent. Mirrors are
  // now hedged instead: the next one is only enlisted if the ones already
  // running have stayed quiet, so a healthy primary is still a single request,
  // and a dead one costs seconds rather than a minute.
  const settled = new AbortController();
  const cancelAll = () => settled.abort();
  signal?.addEventListener("abort", cancelAll);
  const budget = setTimeout(cancelAll, OVERPASS_BUDGET_MS);

  const ask = async (endpoint) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: settled.signal,
      });
      if (!response.ok) throw new Error(`Overpass returned ${response.status}.`);
      const text = await response.text();
      // A loaded instance answers 200 with an XML error document, so the body
      // has to be read before the mirror can be believed.
      if (!text.trimStart().startsWith("{")) {
        const reason = text.match(/Error<\/strong>:\s*([^<]+)/i)?.[1]?.trim();
        throw new Error(reason || "Overpass returned a non-JSON response.");
      }
      return JSON.parse(text);
    } catch (error) {
      // The budget expiring reads as an abort; report it as the timeout it is.
      if (settled.signal.aborted && !signal?.aborted) {
        throw new Error(`Overpass did not answer within ${OVERPASS_BUDGET_MS / 1000}s.`);
      }
      throw error;
    }
  };

  const quiet = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    const running = [];
    for (const [index, endpoint] of OVERPASS_URLS.entries()) {
      running.push(ask(endpoint));
      if (index === OVERPASS_URLS.length - 1) break;
      // Either one of the mirrors already running answers, or they all fail, or
      // the hedge delay elapses — any of which is a reason to enlist the next.
      const answered = await Promise.race([
        Promise.any(running).then(
          (body) => ({ body }),
          () => null
        ),
        quiet(OVERPASS_HEDGE_MS),
      ]);
      if (answered?.body) return answered.body;
    }
    return await Promise.any(running);
  } catch (error) {
    if (signal?.aborted) throw error;
    const reasons = error?.errors?.map((item) => item?.message).filter(Boolean) ?? [];
    throw new Error(reasons[0] ?? error?.message ?? "No Overpass mirror answered.");
  } finally {
    // Whether a mirror won or none did, nothing is still worth waiting for.
    clearTimeout(budget);
    settled.abort();
    signal?.removeEventListener("abort", cancelAll);
  }
}

/** OpenStreetMap buildings inside a bounding box. */
async function queryOverpass([west, south, east, north], signal) {
  const query = `[out:json][timeout:25];(way["building"](${south},${west},${north},${east});relation["building"](${south},${west},${north},${east}););out geom;`;
  const body = await overpassJson(query, signal);

  const buildings = [];
  for (const element of body.elements ?? []) {
    if (element.type === "way" && Array.isArray(element.geometry)) {
      const ring = element.geometry.map((point) => [point.lon, point.lat]);
      if (ring.length < 4) continue;
      // Overpass leaves the ring open; GeoJSON requires it closed.
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
      if (ring.length < 4) continue;
      buildings.push({
        geometry: { type: "Polygon", coordinates: [ring] },
        tags: element.tags ?? null,
      });
    } else if (element.type === "relation") {
      for (const member of element.members ?? []) {
        if (member.role !== "outer" || !Array.isArray(member.geometry)) continue;
        const ring = member.geometry.map((point) => [point.lon, point.lat]);
        if (ring.length < 4) continue;
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
        if (ring.length < 4) continue;
        buildings.push({
          geometry: { type: "Polygon", coordinates: [ring] },
          tags: element.tags ?? null,
        });
      }
    }
  }
  return buildings;
}

/** Whether a mapped outline is an outbuilding rather than the house. */
function isAccessory(tags, areaSqft) {
  const kind = String(tags?.building ?? "").toLowerCase();
  return ACCESSORY_BUILDING_TAGS.has(kind) || areaSqft < ACCESSORY_MAX_SQFT;
}

/**
 * Every candidate outline that is *not* standing on this parcel, measured and
 * centroid-tagged so it can be matched to the lot it does stand on.
 */
function neighborsOf(candidates, parcel) {
  const neighbors = [];
  for (const candidate of candidates) {
    const candidateGeometry = candidate?.geometry?.type ? candidate.geometry : candidate;
    const tags = candidate?.tags ?? candidate?.properties ?? null;
    for (const polygon of toPolygons(candidateGeometry)) {
      let overlapsParcel = false;
      try {
        overlapsParcel = Boolean(turf.intersect(turf.featureCollection([polygon, parcel])));
      } catch {
        continue;
      }
      if (overlapsParcel) continue;
      const areaSqft = turf.area(polygon) * SQ_FT_PER_SQ_M;
      if (!(areaSqft > 0)) continue;
      neighbors.push({
        areaSqft: Math.round(areaSqft),
        centroid: turf.centroid(polygon),
        accessory: isAccessory(tags, areaSqft),
        tags,
      });
    }
  }
  return neighbors;
}

function normalizeDetected(best, sourceId, candidateCount) {
  return {
    ...best,
    areaSqft: Math.round(best.areaSqft),
    fullAreaSqft: Math.round(best.fullAreaSqft),
    // True when the outline crosses the lot line, so the UI can explain why
    // the reported footprint is smaller than the building looks.
    clipped: Math.round(best.fullAreaSqft) - Math.round(best.areaSqft) > 5,
    candidateCount,
    source: BUILDING_SOURCES[sourceId],
  };
}

/**
 * What is published on this parcel, and what is published around it.
 *
 * Two answers, not one. `detected` is the building standing on the lot, when a
 * source has drawn it. `neighbors` are the outlines nearby — the raw material
 * for an estimate when this particular lot was never mapped, which in New
 * Jersey is common enough that leaving the client with an empty required field
 * is a worse answer than a labelled approximation.
 *
 * `unreachable` records sources that failed rather than sources that are empty.
 * The difference matters: "nobody has mapped this" and "the mapping service is
 * down" must not be reported to a client as the same fact.
 */
export async function surveyParcelBuildings(parcelGeojson, signal, { radiusFt = 400 } = {}) {
  const parcel = parcelPolygon(parcelGeojson);
  if (!parcel) return null;
  const bbox = expandedBbox(parcelGeojson, radiusFt);

  const unreachable = [];
  let fallback = null;
  for (const [sourceId, load] of [
    ["njdep", queryNjdep],
    ["osm", queryOverpass],
  ]) {
    let candidates = [];
    try {
      candidates = await load(bbox, signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // One source being unreachable must not stop the next from answering.
      unreachable.push({ source: BUILDING_SOURCES[sourceId], message: error?.message ?? String(error) });
      continue;
    }
    if (candidates.length === 0) continue;
    const best = bestOverlap(candidates, parcel);
    if (best) {
      return {
        source: BUILDING_SOURCES[sourceId],
        detected: normalizeDetected(best, sourceId, candidates.length),
        neighbors: neighborsOf(candidates, parcel),
        bbox,
        unreachable,
      };
    }
    // This source maps the neighbourhood but not this lot. Keep its outlines
    // for the comparables and let the next source try for a direct hit.
    fallback ??= { source: BUILDING_SOURCES[sourceId], neighbors: neighborsOf(candidates, parcel) };
  }

  return {
    source: fallback?.source ?? null,
    detected: null,
    neighbors: fallback?.neighbors ?? [],
    bbox,
    unreachable,
  };
}

/**
 * Match each neighbouring outline to the lot it stands on, keeping the largest
 * building per lot — the house, not its garage.
 *
 * The pairing is what turns "there are buildings nearby" into a usable ratio:
 * a footprint means nothing without the lot it sits on, and MOD-IV supplies the
 * lot area and the assessor's floor count for each one.
 */
export function pairBuildingsToParcels(neighbors, parcels) {
  // A dense town brings a few hundred buildings and a few hundred lots to this
  // function, and the naive pairing is their product. Each lot's polygons and
  // bounding box are prepared once, and the box rejects almost every pair
  // before the point-in-polygon test is reached.
  const indexed = (parcels ?? [])
    .map((candidate) => {
      const geometry = candidate?.geometry ?? candidate?.parcel_geojson_wgs84;
      const polygons = geometry ? toPolygons(geometry) : [];
      if (polygons.length === 0 || !candidate?.lot_area_sqft) return null;
      return { lot: candidate, polygons, bbox: turf.bbox(geometry) };
    })
    .filter(Boolean);

  const byPin = new Map();
  for (const neighbor of neighbors ?? []) {
    if (neighbor.accessory || !neighbor.centroid) continue;
    const [x, y] = neighbor.centroid.geometry.coordinates;
    const match = indexed.find(({ polygons, bbox }) => {
      if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) return false;
      return polygons.some((polygon) => {
        try {
          return turf.booleanPointInPolygon(neighbor.centroid, polygon);
        } catch {
          return false;
        }
      });
    });
    const lot = match?.lot;
    if (!lot) continue;
    const key = lot.pams_pin ?? `${lot.block}-${lot.lot}`;
    const existing = byPin.get(key);
    if (existing && existing.footprintSqft >= neighbor.areaSqft) continue;
    byPin.set(key, {
      pamsPin: lot.pams_pin ?? null,
      address: lot.address ?? null,
      lotAreaSqft: lot.lot_area_sqft,
      // MOD-IV property class and the assessor's building description are what
      // make a neighbour comparable: a Broadway storefront covering its whole
      // lot says nothing about the row house behind it.
      propClass: lot.prop_class ?? null,
      buildingDesc: lot.building_desc ?? null,
      footprintSqft: neighbor.areaSqft,
    });
  }
  return [...byPin.values()];
}
