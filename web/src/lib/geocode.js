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
export async function geocodeAddress(text, limit = 5, signal, proximity = null) {
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
    .filter(Boolean)
    .sort((a, b) => distanceFrom(a, proximity) - distanceFrom(b, proximity))
    .slice(0, Math.min(limit, 10));
}

/**
 * Obtain the user's position for local result ranking. These coordinates stay
 * in the browser: neither the Census request nor the NJGIN request receives
 * them. Only address candidates returned by those services are compared with
 * this point after they arrive.
 */
export function locateCurrentPosition(signal) {
  if (!globalThis.navigator?.geolocation) {
    return Promise.reject(new Error("Location is not available in this browser."));
  }
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Location request was cancelled.", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      handler(value);
    };
    const onAbort = () =>
      finish(reject, new DOMException("Location request was cancelled.", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        finish(resolve, {
          lat: Number(position.coords.latitude),
          lon: Number(position.coords.longitude),
          accuracy: Number(position.coords.accuracy) || null,
        }),
      (error) => finish(reject, new Error(locationErrorMessage(error))),
      // Desktop location providers can take longer than ten seconds to wake
      // up. Prefer a precise reading, accept a previously cached fix
      // immediately, and leave enough time for Wi-Fi positioning to answer.
      { enableHighAccuracy: true, timeout: 30000, maximumAge: Infinity }
    );
  });
}

function locationErrorMessage(error) {
  if (error?.code === 1) return "Location permission was not granted.";
  if (error?.code === 2) return "Your current location could not be determined.";
  if (error?.code === 3) return "The location request timed out.";
  return error?.message || "Your current location could not be determined.";
}

function distanceFrom(row, proximity) {
  if (!proximity) return 0;
  const lat1 = Number(row?.lat);
  const lon1 = Number(row?.lon);
  const lat2 = Number(proximity?.lat);
  const lon2 = Number(proximity?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
