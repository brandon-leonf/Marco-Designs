// Address and jurisdiction lookup through the U.S. Census Geocoder.
//
// This layer deliberately stops at the address point. A Census match can say
// where an address is and which Census geography contains it, but it is not a
// parcel boundary and it is not zoning. The statewide NJGIN point query in
// lib/njgin.js owns the next layer of the lookup.

const ENDPOINT =
  "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";

export const GEOCODER_NAME = "U.S. Census Geocoder";
export const GEOCODER_URL =
  "https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html";

/**
 * Geocode one free-form U.S. address. The returned rows share the parcel
 * picker's shape, but `kind: "place"` is important: coordinates establish a
 * location only until NJGIN independently returns a containing polygon.
 */
export async function geocodeAddress(text, limit = 5, signal) {
  const address = String(text ?? "").trim();
  if (address.length < 5) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("vintage", "Current_Current");
  // Census explicitly does not support browser CORS requests. JSONP is its
  // documented client-side transport, so load the response through a temporary
  // callback rather than routing a resident's address through our own proxy.
  url.searchParams.set("format", "jsonp");
  const body = await requestJsonp(url, signal);
  const matches = body?.result?.addressMatches;
  if (!Array.isArray(matches)) return [];

  return matches
    .slice(0, Math.min(limit, 10))
    .map((match, index) => {
      const lon = Number(match?.coordinates?.x);
      const lat = Number(match?.coordinates?.y);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      const geographies = match.geographies ?? {};
      const incorporated = firstGeography(geographies, "Incorporated Places");
      const subdivision = firstGeography(geographies, "County Subdivisions");
      const county = firstGeography(geographies, "Counties");
      const censusBlock = firstGeography(geographies, "Census Blocks");
      const municipality = geographyName(incorporated) ?? geographyName(subdivision);
      const stateCode = stateFromMatchedAddress(match.matchedAddress);
      const rawStateFips = censusBlock?.STATE ?? county?.STATE ?? null;
      const stateFips =
        rawStateFips == null ? null : String(rawStateFips).padStart(2, "0");

      return {
        kind: "place",
        scope: "geocode",
        pams_pin: `census:${lon.toFixed(7)},${lat.toFixed(7)}:${index}`,
        parcel_id: null,
        address: shortLabel(match.matchedAddress),
        full_label: match.matchedAddress ?? address,
        matched_address: match.matchedAddress ?? address,
        block: null,
        lot: null,
        lot_area_sqft: null,
        muni_name: municipality,
        county: geographyName(county),
        state_code: stateCode,
        state_fips: stateFips,
        in_new_jersey: stateCode === "NJ" || stateFips === "34",
        lat,
        lon,
        source: "census",
      };
    })
    .filter(Boolean);
}

function requestJsonp(url, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Address lookup was cancelled.", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const callback = `__marcoCensus_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      script.remove();
      try {
        delete globalThis[callback];
      } catch {
        globalThis[callback] = undefined;
      }
    };
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    const onAbort = () =>
      finish(reject, new DOMException("Address lookup was cancelled.", "AbortError"));

    globalThis[callback] = (body) => finish(resolve, body);
    script.async = true;
    script.onerror = () =>
      finish(reject, new Error("Census address lookup could not be reached."));
    url.searchParams.set("callback", callback);
    script.src = url.toString();
    signal?.addEventListener("abort", onAbort, { once: true });
    document.head.appendChild(script);
  });
}

function firstGeography(geographies, key) {
  const rows = geographies?.[key];
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

function geographyName(row) {
  if (!row) return null;
  return row.BASENAME ?? row.NAME ?? null;
}

function stateFromMatchedAddress(value) {
  const match = String(value ?? "").match(/,\s*([A-Z]{2})(?:,|\s+\d{5}(?:-\d{4})?$)/);
  return match?.[1] ?? null;
}

function shortLabel(value) {
  const parts = String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(0, 2).join(", ") || "Located address";
}
