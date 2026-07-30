// USGS 3DEP terrain sampling through The National Map's Elevation Point Query
// Service. Values are interpolated planning data, not surveyed elevations.

export const TERRAIN_SOURCE = "USGS 3DEP Elevation Point Query Service";
const ENDPOINT = "https://epqs.nationalmap.gov/v1/json";
const FT_PER_DEG_LAT = 364000;

function centerOfGeometry(parcelGeojson) {
  const geometry = parcelGeojson?.type === "Feature" ? parcelGeojson.geometry : parcelGeojson;
  let rings = [];
  if (geometry?.type === "Polygon") rings = geometry.coordinates ?? [];
  if (geometry?.type === "MultiPolygon") {
    rings = (geometry.coordinates ?? []).flatMap((polygon) => polygon ?? []);
  }
  const points = rings.flat();
  if (!points.length) return null;
  const sum = points.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

export function parcelCenter(parcelGeojson) {
  return centerOfGeometry(parcelGeojson);
}

async function fetchElevation(lng, lat, signal) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("x", String(lng));
  url.searchParams.set("y", String(lat));
  url.searchParams.set("units", "Feet");
  url.searchParams.set("wkid", "4326");
  url.searchParams.set("includeDate", "false");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`USGS terrain service returned ${response.status}.`);
  const body = await response.json();
  const value = Number(body?.value);
  if (!Number.isFinite(value) || value < -10000) throw new Error("No 3DEP elevation at this point.");
  return { elevationFt: value, resolutionM: Number(body?.resolution) || null };
}

/**
 * Sample a parcel-aligned 3×3 grid. `northAngleDeg` expresses true north in
 * model coordinates, so samples remain registered when the street-facing edge
 * rotates the model away from the geographic axes.
 */
export async function fetchTerrainGrid({
  parcelGeojson,
  lotWidthFt,
  lotDepthFt,
  northAngleDeg,
  signal,
}) {
  const center = centerOfGeometry(parcelGeojson);
  if (!center || northAngleDeg == null) return null;
  const angle = (northAngleDeg * Math.PI) / 180;
  const north = { x: Math.sin(angle), y: -Math.cos(angle) };
  const east = { x: north.y, y: -north.x };
  const lngFeet = Math.cos((center[1] * Math.PI) / 180) * FT_PER_DEG_LAT;
  const positions = [0, 0.5, 1];
  const requests = [];

  for (const v of positions) {
    for (const u of positions) {
      const modelX = (u - 0.5) * lotWidthFt;
      const modelY = (v - 0.5) * lotDepthFt;
      const eastFt = modelX * east.x + modelY * east.y;
      const northFt = modelX * north.x + modelY * north.y;
      const lng = center[0] + eastFt / lngFeet;
      const lat = center[1] + northFt / FT_PER_DEG_LAT;
      requests.push(
        fetchElevation(lng, lat, signal).then((sample) => ({
          u,
          v,
          x: u * lotWidthFt,
          y: v * lotDepthFt,
          ...sample,
        }))
      );
    }
  }

  const samples = await Promise.all(requests);
  const centerElevation = samples[4].elevationFt;
  const normalized = samples.map((sample) => ({
    ...sample,
    z: sample.elevationFt - centerElevation,
  }));
  const elevations = samples.map((sample) => sample.elevationFt);
  const riseFt = Math.max(...elevations) - Math.min(...elevations);
  const runFt = Math.hypot(lotWidthFt, lotDepthFt);
  return {
    samples: normalized,
    centerElevationFt: centerElevation,
    minElevationFt: Math.min(...elevations),
    maxElevationFt: Math.max(...elevations),
    riseFt,
    slopePct: runFt > 0 ? (riseFt / runFt) * 100 : 0,
    resolutionM: samples.find((sample) => sample.resolutionM)?.resolutionM ?? null,
  };
}

