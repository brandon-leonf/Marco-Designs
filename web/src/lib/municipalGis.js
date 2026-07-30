import * as turf from "@turf/turf";

/**
 * Level B zoning sources.
 *
 * There is no statewide municipal-zoning service in New Jersey. Each entry is
 * therefore an explicit, reviewable adapter to a municipality's own published
 * GIS. Adding a town means adding its official layer URL and field mapping;
 * nothing is inferred from a generic ArcGIS search result.
 */
const MUNICIPAL_GIS_SOURCES = [
  {
    municipality: "Jersey City",
    stateCode: "NJ",
    provider: "Jersey City Division of City Planning",
    layerUrl:
      "https://services2.arcgis.com/UXbywc7dSkfgdPp4/arcgis/rest/services/Zoning_Districts/FeatureServer/0",
    officialMapUrl:
      "https://experience.arcgis.com/experience/63717e4171904651a65fe9827fcb5571/",
    codeField: "ZONE",
    nameField: "NAME",
    secondaryField: "REPLAN",
    referenceField: "LINK",
    where: "REPLAN = 'No'",
    fallbackWhere: "REPLAN = 'Yes'",
    fallbackType: "Redevelopment plan",
  },
];

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+(CITY|TWP|TOWNSHIP|BORO|BOROUGH|VILLAGE)$/, "");

export function municipalGisSourceFor(municipality, stateCode) {
  const name = normalize(municipality);
  const state = String(stateCode ?? "").trim().toUpperCase();
  return (
    MUNICIPAL_GIS_SOURCES.find(
      (source) =>
        normalize(source.municipality) === name &&
        String(source.stateCode).toUpperCase() === state
    ) ?? null
  );
}

/**
 * Level B: identify a district from an official municipal polygon service.
 *
 * This result intentionally contains no dimensional rules. It may name the
 * district and link to the official source, but it must never be passed to the
 * zoning calculator until Marco has reviewed and configured those rules.
 */
export async function resolveMunicipalGisZoning({
  municipality,
  stateCode,
  parcelGeojson,
  lat,
  lon,
  signal,
}) {
  const source = municipalGisSourceFor(municipality, stateCode);
  if (!source) return { status: "unavailable" };

  const point = pointForProperty(parcelGeojson, lat, lon);
  if (!point) return { status: "unavailable", source };

  const fields = [
    source.codeField,
    source.nameField,
    source.secondaryField,
    source.referenceField,
  ].filter(Boolean);
  const url = new URL(`${source.layerUrl}/query`);
  const params = {
    f: "json",
    where: source.where ?? "1=1",
    geometry: JSON.stringify({
      x: point[0],
      y: point[1],
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: fields.join(","),
    returnGeometry: "false",
    resultRecordCount: "10",
  };
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  let body = await fetchArcgisQuery(url, signal);
  let districtType = "Zoning district";
  if ((body?.features ?? []).length === 0 && source.fallbackWhere) {
    url.searchParams.set("where", source.fallbackWhere);
    body = await fetchArcgisQuery(url, signal);
    districtType = source.fallbackType ?? "Municipal district";
  }

  const matches = (body?.features ?? [])
    .map((feature) => feature?.attributes ?? feature?.properties ?? {})
    .map((attributes) => ({
      district_code: clean(attributes[source.codeField]),
      district_name: clean(attributes[source.nameField]),
      secondary_district: clean(attributes[source.secondaryField]),
      district_reference_url: clean(attributes[source.referenceField]),
    }))
    .filter((match) => match.district_code || match.district_name);

  if (matches.length === 0) return { status: "unmapped", source };

  const distinct = new Map();
  for (const match of matches) {
    distinct.set(
      `${match.district_code ?? ""}|${match.district_name ?? ""}|${match.secondary_district ?? ""}`,
      match
    );
  }
  if (distinct.size > 1) {
    return {
      status: "boundary_conflict",
      source,
      competing_codes: [...distinct.values()].map(
        (match) => match.district_code ?? match.district_name
      ),
    };
  }

  const match = [...distinct.values()][0];
  return {
    status: "matched",
    level: "B",
    ...match,
    district_type: districtType,
    provider: source.provider,
    source_url: source.officialMapUrl,
    layer_url: source.layerUrl,
  };
}

async function fetchArcgisQuery(url, signal) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Municipal zoning service returned ${response.status}.`);
  }
  const body = await response.json();
  if (body?.error) {
    throw new Error(body.error.message ?? "Municipal zoning service rejected the query.");
  }
  return body;
}

function pointForProperty(parcelGeojson, lat, lon) {
  if (parcelGeojson) {
    try {
      return turf.pointOnFeature({
        type: "Feature",
        properties: {},
        geometry: parcelGeojson,
      }).geometry.coordinates;
    } catch {
      // Fall through to the geocoded address point.
    }
  }
  const y = Number(lat);
  const x = Number(lon);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text && !/^no$/i.test(text) ? text : null;
}
