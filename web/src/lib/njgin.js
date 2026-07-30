// Live NJGIN parcel data — https://nj.gov/njgin/edata/parcels/
//
// The imported `parcels` table (scripts/import_parcels.py) is still the
// preferred source: PostGIS owns the geometry, and only that path can verify
// zoning by intersecting the parcel with a municipal zoning layer. This module
// is the fallback for municipalities where that import has not been run — it
// queries the same statewide NJOGIS service the importer reads from, live from
// the browser, so address search works without a loaded database.
//
// The service is public, CORS-open, and read-only. Geometry comes back as
// GeoJSON in EPSG:4326; `toLocalFeet` converts it to planar feet so ParcelPlan
// can draw it exactly as it draws the EPSG:3424 geometry from PostGIS.
//
// NJGIN's own caveat applies and is surfaced in the UI: these polygons are not
// survey data and do not represent legal boundaries.

import * as turf from "@turf/turf";
import { envelopeFromGeoJSON } from "./envelope.js";

const LAYER =
  "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/ArcGIS/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0";

export const NJGIN_SOURCE_URL = "https://nj.gov/njgin/edata/parcels/";
export const NJGIN_LAYER_NAME = "NJOGIS Statewide Parcels + MOD-IV";

// Mirrors ATTRS in scripts/import_parcels.py so both sources expose the same
// MOD-IV fields. OWNER_NAME is redacted at the source under Daniel's Law.
const OUT_FIELDS = [
  "PAMS_PIN",
  "PCLBLOCK",
  "PCLLOT",
  "PROP_LOC",
  "PROP_CLASS",
  "LAND_DESC",
  "CALC_ACRE",
  "YR_CONSTR",
  "MUN_NAME",
  "COUNTY",
].join(",");

const SQFT_PER_ACRE = 43560;
const FT_PER_M = 3.280839895;

/**
 * ArcGIS `where` is SQL, so anything interpolated has to be constrained. Keep
 * the characters that appear in New Jersey street addresses and drop the rest;
 * nothing that survives can close a string literal. `_` and `%` go too — they
 * are LIKE wildcards, and a typed address should match itself, not a pattern.
 */
function sqlLiteral(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 .,\-/#&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** PAMS_PIN is `district_block_lot`, so it keeps its underscores. Compared
 *  with `=`, never LIKE, so the wildcard concern above does not apply. */
function pinLiteral(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.\-]/g, "");
}

/**
 * NJGIN spells municipalities with their type suffix ("UNION CITY CITY",
 * "NORTH BERGEN TWP"), which our own records do not carry. Match on the county
 * plus a name prefix rather than guessing the suffix.
 */
function muniWhere(muni) {
  const name = sqlLiteral(muni?.name);
  const county = sqlLiteral(muni?.county);
  if (!name) throw new Error("Municipality name is required to query NJGIN.");
  const clauses = [`MUN_NAME LIKE '${name}%'`];
  if (county) clauses.push(`COUNTY = '${county}'`);
  return clauses.join(" AND ");
}

async function query(params, signal) {
  const url = new URL(`${LAYER}/query`);
  Object.entries({ f: "geojson", ...params }).forEach(([key, value]) =>
    url.searchParams.set(key, String(value))
  );

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`NJGIN parcel service returned ${response.status}.`);
  }
  const body = await response.json();
  // ArcGIS reports failures with HTTP 200 and an `error` member.
  if (body.error) {
    throw new Error(body.error.message ?? "NJGIN parcel service rejected the query.");
  }
  return body;
}

/**
 * Lot area. Measured from the polygon whenever the geometry is in hand, and
 * only otherwise from MOD-IV acreage.
 *
 * The two disagree more often than you would expect — CALC_ACRE frequently
 * covers a tax record's additional lots (ADD_LOTS1/2), so it can be double the
 * polygon actually drawn. Since the buildable envelope is an inset of that
 * polygon, taking the lot area from anywhere else would cap coverage and FAR
 * against a lot the diagram does not show. Search results have no geometry
 * loaded yet, so the MOD-IV figure stands in there.
 */
function lotAreaSqft(properties, feature) {
  const measured = feature ? turf.area(feature) * FT_PER_M * FT_PER_M : 0;
  if (measured > 0) return Math.round(measured);
  const acres = Number(properties?.CALC_ACRE);
  return isFinite(acres) && acres > 0 ? Math.round(acres * SQFT_PER_ACRE) : null;
}

/** MOD-IV stores names in caps ("CARLSTADT BORO"); the UI reads them as prose. */
const titleCase = (value) =>
  value == null
    ? null
    : String(value)
        .toLowerCase()
        .replace(/\b[a-z]/g, (c) => c.toUpperCase());
const municipalityName = (value) =>
  titleCase(value)?.replace(/\s+(City|Twp|Town|Boro|Borough|Village)$/i, "") ?? null;

function toRow(properties, feature) {
  return {
    // No database row exists for a live parcel; PAMS_PIN is the stable key.
    parcel_id: null,
    pams_pin: properties.PAMS_PIN,
    address: properties.PROP_LOC || null,
    block: properties.PCLBLOCK || null,
    lot: properties.PCLLOT || null,
    prop_class: properties.PROP_CLASS || null,
    lot_area_sqft: lotAreaSqft(properties, feature),
    // Carried through so a statewide hit can say which town it is in, and so
    // the app can switch to that municipality when it happens to be loaded.
    muni_name: municipalityName(properties.MUN_NAME),
    county: titleCase(properties.COUNTY) || null,
    source: "njgin",
  };
}

/**
 * Address search within one municipality, returning the same row shape as the
 * `search_parcels` RPC so the UI does not branch on which source answered.
 */
export async function searchNjginParcels(muni, text, limit = 15) {
  const needle = sqlLiteral(text);
  if (needle.length < 3) return [];

  const body = await query({
    where: `${muniWhere(muni)} AND UPPER(PROP_LOC) LIKE '%${needle}%'`,
    outFields: OUT_FIELDS,
    orderByFields: "PROP_LOC",
    returnGeometry: false,
    resultRecordCount: Math.min(limit, 50),
  });

  return (body.features ?? [])
    .map((feature) => toRow(feature.properties ?? {}, null))
    .filter((row) => row.pams_pin)
    .map((row) => ({ ...row, kind: "parcel", scope: "muni" }));
}

/**
 * The same address search with the municipality filter dropped, so a client can
 * type any New Jersey address rather than only one inside the town this tool
 * has zoning for. The boundary that comes back is as real as any other NJGIN
 * parcel; what is missing is a zoning layer to intersect it with, which is why
 * these rows are marked `scope: "statewide"` and flagged as unverified in the UI.
 */
export async function searchNjginParcelsAnywhere(text, limit = 10) {
  const needle = sqlLiteral(text);
  if (needle.length < 3) return [];

  const body = await query({
    where: `UPPER(PROP_LOC) LIKE '%${needle}%'`,
    outFields: OUT_FIELDS,
    orderByFields: "PROP_LOC",
    returnGeometry: false,
    resultRecordCount: Math.min(limit, 50),
  });

  return (body.features ?? [])
    .map((feature) => toRow(feature.properties ?? {}, null))
    .filter((row) => row.pams_pin)
    .map((row) => ({ ...row, kind: "parcel", scope: "statewide" }));
}

/**
 * Find the statewide parcel polygon containing a geocoded WGS84 point.
 *
 * This is the primary parcel lookup path: address -> Census coordinates ->
 * ArcGIS point-in-polygon query. It avoids municipality-specific parcel
 * searches entirely. A point on a condominium or tax-boundary seam can return
 * more than one feature, so the smallest containing polygon is presented first.
 */
export async function findNjginParcelAtPoint(lat, lon, limit = 5, signal, addressText = "") {
  const y = Number(lat);
  const x = Number(lon);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];

  const pointQuery = {
      geometry: JSON.stringify({
        x,
        y,
        spatialReference: { wkid: 4326 },
      }),
      geometryType: "esriGeometryPoint",
      inSR: 4326,
      spatialRel: "esriSpatialRelIntersects",
      outFields: OUT_FIELDS,
      returnGeometry: true,
      outSR: 4326,
      resultRecordCount: Math.min(limit, 20),
    };
  let body = await query(pointQuery, signal);
  let features = body.features ?? [];

  // Census address coordinates are interpolated along the street centerline.
  // When that point falls in the right-of-way instead of inside a tax parcel,
  // retain point-in-polygon as the first attempt, then make one tightly bounded
  // proximity query and rank those parcels by the matched street address.
  if (features.length === 0) {
    body = await query(
      {
        ...pointQuery,
        distance: 150,
        units: "esriSRUnit_Foot",
        resultRecordCount: 30,
      },
      signal
    );
    features = (body.features ?? []).sort(
      (a, b) =>
        addressMatchScore(b?.properties?.PROP_LOC, addressText) -
          addressMatchScore(a?.properties?.PROP_LOC, addressText) ||
        turf.area(a) - turf.area(b)
    );
    const bestScore = addressMatchScore(features[0]?.properties?.PROP_LOC, addressText);
    if (bestScore >= 10) {
      features = features.filter(
        (feature) => addressMatchScore(feature?.properties?.PROP_LOC, addressText) === bestScore
      );
    }
  } else {
    features = features.sort((a, b) => turf.area(a) - turf.area(b));
  }

  return features
    .filter((feature) => feature?.geometry)
    .slice(0, Math.min(limit, 20))
    .map((feature) => ({
      ...toRow(feature.properties ?? {}, feature),
      kind: "parcel",
      scope: "statewide",
      lat: y,
      lon: x,
    }))
    .filter((row) => row.pams_pin);
}

function addressMatchScore(parcelAddress, geocodedAddress) {
  const parcel = String(parcelAddress ?? "").toUpperCase();
  const geocoded = String(geocodedAddress ?? "").toUpperCase();
  if (!parcel || !geocoded) return 0;
  const number = geocoded.match(/^\s*(\d+)/)?.[1];
  const streetWords = geocoded
    .replace(/^\s*\d+\s*/, "")
    .split(",")[0]
    .split(/\s+/)
    .filter((word) => word.length > 2);
  let score = 0;
  if (number && new RegExp(`(^|\\D)${number}(\\D|$)`).test(parcel)) score += 10;
  for (const word of streetWords) {
    if (parcel.includes(word)) score += 2;
  }
  return score;
}

/**
 * Metres per degree at a given latitude (WGS84 series expansion). Used to build
 * the local planar frame below.
 */
function metresPerDegree(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat),
    lon: 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat),
  };
}

/**
 * Project lon/lat GeoJSON into planar feet on a tangent plane through `origin`.
 *
 * PostGIS hands the UI EPSG:3424 (NJ State Plane, US survey feet) and
 * ParcelPlan draws those coordinates directly. This produces the same thing for
 * the live path: not State Plane itself, but a local frame in feet with north
 * up, which is all the plan view needs. Over a parcel-sized extent the
 * difference from a true projection is far below the accuracy of the source
 * polygons.
 */
function toLocalFeet(geometry, origin) {
  if (!geometry) return null;
  const perDegree = metresPerDegree(origin[1]);
  const xScale = perDegree.lon * FT_PER_M;
  const yScale = perDegree.lat * FT_PER_M;
  const point = ([lon, lat]) => [(lon - origin[0]) * xScale, (lat - origin[1]) * yScale];

  const ring = (coords) => coords.map(point);
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: geometry.coordinates.map(ring) };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((rings) => rings.map(ring)),
    };
  }
  return null;
}

/**
 * One live parcel plus its buildable envelope at a uniform inset, shaped like
 * the `parcel_envelope` RPC. `insetFt` is the LARGEST applicable setback, the
 * same conservative convention the PostGIS path uses.
 *
 * Returns `{ raw }` alongside the display fields so the caller can re-inset for
 * a different district without another network round trip.
 */
export async function fetchNjginParcel(muni, pamsPin, insetFt = 0) {
  // PAMS_PIN is district_block_lot — already unique statewide — so a null
  // municipality is a legitimate "look this up wherever it is" lookup, which
  // is what an out-of-town address search needs.
  const scope = muni ? `${muniWhere(muni)} AND ` : "";
  const body = await query({
    where: `${scope}PAMS_PIN = '${pinLiteral(pamsPin)}'`,
    outFields: OUT_FIELDS,
    returnGeometry: true,
    outSR: 4326,
    resultRecordCount: 1,
  });

  const feature = body.features?.[0];
  if (!feature?.geometry) {
    throw new Error(`NJGIN has no parcel geometry for PIN ${pamsPin}.`);
  }
  return njginParcelFromFeature(feature, insetFt);
}

/** Re-derives the envelope for an already-fetched feature at a new inset. */
export function njginParcelFromFeature(feature, insetFt = 0) {
  const properties = feature.properties ?? {};
  const origin = turf.centroid(feature).geometry.coordinates;

  // Turf buffers in lon/lat; the inset is applied there, then the result is
  // brought into the same local frame as the parcel outline.
  const envelope =
    insetFt > 0 ? envelopeFromGeoJSON(feature, insetFt) : { feature: null, areaSqft: 0 };
  const envelopeGeometry = envelope.feature?.geometry ?? null;
  const envelopeArea = envelopeGeometry ? Math.round(envelope.areaSqft) : null;

  return {
    ...toRow(properties, feature),
    year_built: properties.YR_CONSTR ? String(properties.YR_CONSTR) : null,
    land_desc: properties.LAND_DESC || null,
    lot_frontage_ft: null,
    lot_depth_ft: null,
    is_survey_confirmed: false,
    parcel_geojson: toLocalFeet(feature.geometry, origin),
    // The service hands back EPSG:4326; the map wants it untouched.
    parcel_geojson_wgs84: feature.geometry,
    envelope_geojson: envelopeArea > 0 ? toLocalFeet(envelopeGeometry, origin) : null,
    envelope_area_sqft: envelopeArea > 0 ? envelopeArea : null,
    raw: feature,
  };
}
