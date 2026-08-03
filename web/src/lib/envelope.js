// Client-side buildable-envelope math, mirroring the PostGIS reference
// functions in db/migrations/0005_geometry_functions.sql.
//
// PostGIS stays the authoritative geometry engine (parcels live in EPSG:3424,
// insets happen server-side in feet). This module exists so the UI can give
// instant feedback for the simple rectangular-lot case without a round trip.
// For real parcel polygons fetched as GeoJSON, use `envelopeFromGeoJSON`
// (Turf.js) — same operation, client-side, for display only.

import * as turf from "@turf/turf";

/**
 * Rules the algorithm cannot run without. A district missing any of these
 * would silently produce a wrong answer — a lot with no setbacks reads as
 * "build on 100% of the parcel" — so the UI refuses to calculate instead.
 */
const REQUIRED_RULES = {
  front_yard_min_ft: "front setback",
  rear_yard_min_ft: "rear setback",
  max_building_coverage_pct: "maximum building coverage",
  max_stories: "maximum stories",
};

/** Plain-language list of the rules a district is still missing. */
export function missingDistrictRules(district) {
  if (!district) return ["all zoning rules"];
  const missing = Object.entries(REQUIRED_RULES)
    .filter(([field]) => district[field] == null)
    .map(([, label]) => label);
  // Either side-yard expression is enough; the resolver derives the other.
  if (district.side_yard_one_min_ft == null && district.side_yard_total_min_ft == null) {
    missing.push("side setback");
  }
  return missing;
}

/**
 * Calculation entry-point guard. UI checks are useful feedback, but the rules
 * engine must protect itself too: no caller may obtain a result from defaults
 * when the published zoning configuration is incomplete.
 */
function requireDistrictRules(district) {
  const missing = missingDistrictRules(district);
  if (missing.length) {
    throw new Error(`Cannot calculate: missing zoning rules (${missing.join(", ")}).`);
  }
}

/**
 * ADU policy for a district, from `extra_rules.adu`.
 *
 * Three states, and the difference matters. A district that explicitly says
 * ADUs are not permitted is an answer to the client's question, not a reason
 * to compute a price. A district with no ADU block recorded is unknown — the
 * remaining-capacity figure is still useful there, carrying its caveat.
 */
export function aduRules(district) {
  const adu = district?.extra_rules?.adu;
  if (!adu || adu.allowed == null) {
    return { known: false, allowed: null, maxSizeSqft: null };
  }
  return {
    known: true,
    allowed: Boolean(adu.allowed),
    maxSizeSqft: adu.max_size_sqft == null ? null : Number(adu.max_size_sqft),
    detachedAllowed: adu.detached_allowed == null ? null : Boolean(adu.detached_allowed),
    parkingRequired: adu.parking_required == null ? null : Boolean(adu.parking_required),
  };
}

/**
 * Assumed floor-to-floor height, used only to convert a height limit into a
 * number of floors. Surfaced in the UI whenever the height limit is what
 * binds, so the assumption is never hidden inside a number.
 */
export const FLOOR_TO_FLOOR_FT = 10;

/**
 * Allowable stories = the permitted count, capped by what the height limit
 * physically allows (kickoff core algorithm, step 3).
 */
export function resolveStories(district) {
  // Stories are whole occupied floors. Round legacy half-story records up so
  // 2.5 becomes 3, while max_height_ft independently caps the total height.
  const permitted = Math.max(1, Math.ceil(Number(district.max_stories ?? 1)));
  const heightFt = district.max_height_ft;
  if (heightFt == null) {
    return {
      stories: permitted,
      permittedStories: permitted,
      heightLimited: false,
      storiesByHeight: null,
    };
  }
  const byHeight = Math.floor(Number(heightFt) / FLOOR_TO_FLOOR_FT);
  const stories = Math.max(1, Math.min(permitted, byHeight));
  return {
    stories,
    permittedStories: permitted,
    heightLimited: stories < permitted,
    storiesByHeight: byHeight,
  };
}

/**
 * Dimensional non-conformities: the lot is smaller than the district's
 * minimums. Reported, never used to block — pre-existing undersized lots are
 * common and are often still buildable, which is a municipal determination.
 */
export function lotViolations(district, lot) {
  const out = [];
  const check = (value, min, label, unit) => {
    if (value == null || min == null) return;
    if (Number(value) > 0 && Number(value) < Number(min)) {
      out.push({ label, value: Number(value), min: Number(min), unit });
    }
  };
  check(lot.areaSqft, district.min_lot_area_sqft, "Lot area", "sq ft");
  check(lot.widthFt, district.min_lot_width_ft, "Lot width", "ft");
  check(lot.depthFt, district.min_lot_depth_ft, "Lot depth", "ft");
  return out;
}

/**
 * Per-edge inset of a rectangular lot. Exact arithmetic — better than a
 * uniform buffer for rectangles, and matches how the rules engine will treat
 * front/side/rear setbacks differently.
 * Returns null envelope when the setbacks consume the lot.
 */
export function rectEnvelope(lot, district) {
  const front = district.front_yard_min_ft ?? 0;
  const rear = district.rear_yard_min_ft ?? 0;
  const sideOne = district.side_yard_one_min_ft ?? 0;
  const sideTotal = Math.max(district.side_yard_total_min_ft ?? 0, sideOne * 2);

  const envWidth = lot.width_ft - sideTotal;
  const envDepth = lot.depth_ft - front - rear;
  if (envWidth <= 0 || envDepth <= 0) {
    return { widthFt: 0, depthFt: 0, areaSqft: 0, insets: { front, rear, sideOne, sideTotal } };
  }
  return {
    widthFt: envWidth,
    depthFt: envDepth,
    areaSqft: envWidth * envDepth,
    insets: { front, rear, sideOne, sideTotal },
  };
}

/**
 * Buildable numbers, straight from the kickoff algorithm (and identical to
 * max_footprint_sqft / max_buildable_sqft in PostGIS):
 *   footprint = min(envelope area, lot area * coverage%)
 *   buildable = footprint * stories, then capped by FAR if the town uses it.
 */
export function computeBuildable(lot, district) {
  requireDistrictRules(district);
  // A deed/tax-record area may differ slightly from the simple bounding
  // rectangle. Prefer the explicitly entered area for coverage and FAR caps,
  // while width/depth continue to drive the preview envelope geometry.
  const lotArea =
    Number(lot.area_sqft) > 0
      ? Number(lot.area_sqft)
      : lot.width_ft * lot.depth_ft;
  const envelope = rectEnvelope(lot, district);

  const coveragePct = district.max_building_coverage_pct;
  const coverageCap = coveragePct != null ? lotArea * (coveragePct / 100) : Infinity;
  const footprint = Math.min(envelope.areaSqft, coverageCap);

  const { stories, permittedStories, heightLimited, storiesByHeight } = resolveStories(district);
  let buildable = footprint * stories;

  const farCap = district.max_far != null ? lotArea * district.max_far : Infinity;
  buildable = Math.min(buildable, farCap);

  return {
    lotArea,
    envelope,
    footprint,
    stories,
    heightLimited,
    storiesByHeight,
    permittedStories,
    buildable,
    binding:
      footprint === 0
        ? "setbacks"
        : coverageCap < envelope.areaSqft
          ? "coverage"
          : "setbacks",
    farLimited: buildable === farCap && farCap !== Infinity,
  };
}

/**
 * Buildable numbers when the envelope area is already known (real parcels:
 * PostGIS computed it via the parcel_envelope RPC). Same caps as
 * computeBuildable, minus the rectangle-specific setback arithmetic.
 */
export function computeBuildableFromAreas(lotAreaSqft, envelopeAreaSqft, district) {
  requireDistrictRules(district);
  const coveragePct = district.max_building_coverage_pct;
  const coverageCap = coveragePct != null ? lotAreaSqft * (coveragePct / 100) : Infinity;
  const footprint = Math.min(envelopeAreaSqft ?? 0, coverageCap);

  const { stories, permittedStories, heightLimited, storiesByHeight } = resolveStories(district);
  let buildable = footprint * stories;
  const farCap = district.max_far != null ? lotAreaSqft * district.max_far : Infinity;
  buildable = Math.min(buildable, farCap);

  return {
    lotArea: lotAreaSqft,
    envelopeArea: envelopeAreaSqft ?? 0,
    footprint,
    stories,
    heightLimited,
    storiesByHeight,
    permittedStories,
    buildable,
    binding: footprint === 0 ? "setbacks" : coverageCap < (envelopeAreaSqft ?? 0) ? "coverage" : "setbacks",
    farLimited: buildable === farCap && farCap !== Infinity,
  };
}

/** Parse frontage × depth wherever MOD-IV LAND_DESC contains that pattern. */
export function parseLandDescriptionDimensions(landDescription) {
  const match = String(landDescription ?? "").match(
    /(?:^|[^0-9.])(\d+(?:\.\d+)?)\s*(?:X|×)\s*(\d+(?:\.\d+)?)(?=$|[^0-9.])/i
  );
  if (!match) return null;
  const width = Number(match[1]);
  const depth = Number(match[2]);
  return width > 0 && depth > 0
    ? { width_ft: width, depth_ft: depth, source: "land_desc" }
    : null;
}

/**
 * Resolve parcel dimensions in the required order: parse LAND_DESC first,
 * then use the frontage/depth fields populated by the imported MOD-IV record.
 * A real parcel with neither source returns null; callers must never substitute
 * the application's starter lot dimensions.
 */
export function recordedRectDims(parcel) {
  const fromDescription = parseLandDescriptionDimensions(
    parcel?.land_desc ?? parcel?.LAND_DESC ?? parcel?.mod_iv?.LAND_DESC
  );
  if (fromDescription) return fromDescription;

  const width = Number(parcel?.lot_frontage_ft);
  const depth = Number(parcel?.lot_depth_ft);
  return width > 0 && depth > 0
    ? { width_ft: width, depth_ft: depth, source: "imported_mod_iv" }
    : null;
}

/** Largest applicable setback → conservative uniform inset for previews. */
export function conservativeInsetFt(district) {
  return Math.max(
    district.front_yard_min_ft ?? 0,
    district.rear_yard_min_ft ?? 0,
    district.side_yard_one_min_ft ?? 0
  );
}

/**
 * Envelope for an arbitrary parcel polygon (GeoJSON, EPSG:4326 from the API).
 * Display-only mirror of buildable_envelope(); PostGIS remains authoritative.
 */
export function envelopeFromGeoJSON(parcelFeature, insetFt) {
  const buffered = turf.buffer(parcelFeature, -insetFt, { units: "feet" });
  if (!buffered) return { feature: null, areaSqft: 0 };
  const SQFT_PER_SQM = 10.7639;
  return { feature: buffered, areaSqft: turf.area(buffered) * SQFT_PER_SQM };
}
