// Live NJGIN parcel data — https://nj.gov/njgin/edata/parcels/
//
// This statewide NJOGIS service is the application's default New Jersey parcel
// authority. Local imported rows remain a legacy/offline-compatible path, but
// current address searches and map clicks resolve their polygon, block/lot and
// standardized PAMS_PIN here, then intersect that polygon with Marco's
// published municipal zoning layer in the browser.
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
  "BLDG_DESC",
  "DWELL",
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
    building_desc: properties.BLDG_DESC || null,
    dwelling_units: Number(properties.DWELL) > 0 ? Number(properties.DWELL) : null,
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
export async function searchNjginParcelsAnywhere(text, limit = 10, proximity = null) {
  const needle = sqlLiteral(text);
  if (needle.length < 3) return [];
  const prioritizeNearby = hasPoint(proximity);

  const body = await query({
    where: statewideAddressWhere(needle),
    outFields: OUT_FIELDS,
    orderByFields: "PROP_LOC",
    returnGeometry: prioritizeNearby,
    ...(prioritizeNearby ? { outSR: 4326, geometryPrecision: 5 } : {}),
    // Pull a broader candidate set only while ranking locally. No browser
    // coordinates are included in this request.
    resultRecordCount: prioritizeNearby
      ? Math.max(Math.min(limit * 10, 100), 50)
      : Math.min(limit, 50),
  });

  const rows = (body.features ?? [])
    .map((feature) => {
      const row = toRow(feature.properties ?? {}, null);
      if (!prioritizeNearby || !feature?.geometry) return row;
      const [lon, lat] = turf.centroid(feature).geometry.coordinates;
      return { ...row, lat, lon };
    })
    .filter((row) => row.pams_pin);
  if (prioritizeNearby) {
    rows.sort((a, b) => distanceFrom(a, proximity) - distanceFrom(b, proximity));
  }
  return rows
    .slice(0, Math.min(limit, 50))
    .map((row) => ({ ...row, kind: "parcel", scope: "statewide" }));
}

/**
 * MOD-IV road names are not standardized: the same road can be stored as
 * ROUTE 35, HWY 35, STATE HWY 35, or RT 35. Anchor numbered addresses to the
 * exact house number plus the first meaningful street token so all of those
 * variants enter the local distance ranking. The leading-space pattern also
 * prevents a search for 203 from being flooded by 1203, 2203, and 5203.
 */
function statewideAddressWhere(needle) {
  const words = needle.split(/\s+/).filter(Boolean);
  const houseNumber = words[0];
  if (!/^\d+[A-Z]?$/.test(houseNumber)) {
    return `UPPER(PROP_LOC) LIKE '%${needle}%'`;
  }

  const genericRoadWords = new Set([
    "N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST",
    "ROUTE", "RT", "HIGHWAY", "HWY", "STATE", "US",
    "ST", "STREET", "RD", "ROAD", "AVE", "AVENUE", "BLVD", "BOULEVARD",
    "DR", "DRIVE", "LN", "LANE", "CT", "COURT", "PL", "PLACE",
  ]);
  const streetToken = words.slice(1).find((word) => !genericRoadWords.has(word));
  return streetToken
    ? `UPPER(PROP_LOC) LIKE '${houseNumber} %${streetToken}%'`
    : `UPPER(PROP_LOC) LIKE '${houseNumber} %'`;
}

function hasPoint(value) {
  return Number.isFinite(Number(value?.lat)) && Number.isFinite(Number(value?.lon));
}

function distanceFrom(row, proximity) {
  if (!hasPoint(row) || !hasPoint(proximity)) return Number.POSITIVE_INFINITY;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const lat1 = radians(Number(row.lat));
  const lat2 = radians(Number(proximity.lat));
  const dLat = lat2 - lat1;
  const dLon = radians(Number(proximity.lon) - Number(row.lon));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  // A polygon that names no property cannot confirm one. NJGIN's composite
  // layer carries shapes with no MOD-IV record joined behind them — condominium
  // sub-lots and unjoined fragments that sit over the real tax parcel — and
  // they are indistinguishable from a lot until the attributes are read. The
  // point for 511 8th St, Union City lands in one: a 1,448 sq ft sliver with no
  // address, class or LAND_DESC. With no recorded frontage to read, the lot
  // dimensions get measured off that fragment (58 x 25 ft rather than the
  // lot's 24 x 100), and a 25 ft depth cannot hold the 7 ft front and 20 ft
  // rear setbacks — so the property was reported as unbuildable without a
  // variance on the strength of a shape that was never its boundary.
  // Four kinds of record are never the lot a house is built on, and all four
  // are shaped exactly like one until the attributes are read: a polygon with
  // no MOD-IV record joined behind it, exempt property (class 15), a
  // condominium's shared ground, and the per-unit sub-records a condominium is
  // split into. Around 1812 New York Ave, Union City, thirty of the forty
  // parcels within 150 ft are one of these, and the app was choosing among them
  // by area — landing on an 185 sq ft common-elements strip recorded at 1720
  // New York Ave and reporting it as the property.
  const isBuildingLot = (feature) => {
    const props = feature?.properties ?? {};
    if (!props.PROP_LOC) return false;
    if (String(props.PROP_CLASS ?? "").toUpperCase().startsWith("15")) return false;
    if (/COMMON ELEMENT/i.test(String(props.BLDG_DESC ?? ""))) return false;
    // `0910_89_16.01_C0101` is one unit inside a condominium, not its land.
    if (/_C\d+$/i.test(String(props.PAMS_PIN ?? ""))) return false;
    return true;
  };
  const unidentified = features.length > 0 && !features.some(isBuildingLot);

  // Census address coordinates are interpolated along the street centerline.
  // When that point falls in the right-of-way instead of inside a tax parcel —
  // or inside something that is not a lot — retain point-in-polygon as the
  // first attempt, then make one tightly bounded proximity query and rank those
  // parcels by the matched street address.
  if (features.length === 0 || unidentified) {
    body = await query(
      {
        ...pointQuery,
        distance: 150,
        units: "esriSRUnit_Foot",
        resultRecordCount: 30,
      },
      signal
    );
    const ranked = (body.features ?? []).filter(isBuildingLot).sort(
      (a, b) =>
        addressMatchScore(b?.properties?.PROP_LOC, addressText) -
          addressMatchScore(a?.properties?.PROP_LOC, addressText) ||
        turf.area(a) - turf.area(b)
    );
    const bestScore = addressMatchScore(ranked[0]?.properties?.PROP_LOC, addressText);
    if (bestScore >= 10) {
      // The house number matched: this is the addressed lot, not a neighbour.
      features = ranked.filter(
        (feature) => addressMatchScore(feature?.properties?.PROP_LOC, addressText) === bestScore
      );
    } else if (features.length === 0) {
      // Nothing contained the point and nothing nearby is addressed to it.
      // MOD-IV records no lot at 1812 New York Ave — the building there is
      // assessed as 1720 — and the nearest lots are 401 18th St and 1722-24
      // New York Ave. Neither is the property, and answering with one of them
      // is worse than saying the address could not be matched.
      features = [];
    }
    // Otherwise the containing polygon stands. A weak match on a neighbouring
    // lot is not a better answer than the shape the point actually fell in —
    // that applies to map clicks in particular, which carry no address to
    // match on.
  } else {
    // A condominium's common ground overlaps the lots it serves, and it is
    // usually the smaller shape — so smallest-first has to yield to "is a lot
    // at all" before it decides which of several containing polygons wins.
    features = features.sort(
      (a, b) => Number(isBuildingLot(b)) - Number(isBuildingLot(a)) || turf.area(a) - turf.area(b)
    );
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

/**
 * Every parcel intersecting a WGS84 bounding box, geometry included.
 *
 * The building comparables need the lot each mapped outline stands on: a
 * footprint is only meaningful next to its lot area and the assessor's
 * description of what was built there.
 */
export async function fetchNjginParcelsInBbox([west, south, east, north], signal, limit = 400) {
  const body = await query(
    {
      geometry: JSON.stringify({
        xmin: west,
        ymin: south,
        xmax: east,
        ymax: north,
        spatialReference: { wkid: 4326 },
      }),
      geometryType: "esriGeometryEnvelope",
      inSR: 4326,
      spatialRel: "esriSpatialRelIntersects",
      outFields: OUT_FIELDS,
      returnGeometry: true,
      outSR: 4326,
      // These polygons are only ever asked one question — which lot is this
      // building standing on — so they travel coarse. Full-precision outlines
      // for a few hundred urban parcels are megabytes the answer does not need.
      geometryPrecision: 6,
      maxAllowableOffset: 0.000005,
      resultRecordCount: Math.min(limit, 1000),
    },
    signal
  );

  return (body.features ?? [])
    .filter((feature) => feature?.geometry)
    .map((feature) => ({
      ...toRow(feature.properties ?? {}, feature),
      land_desc: feature.properties?.LAND_DESC || null,
      geometry: feature.geometry,
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
