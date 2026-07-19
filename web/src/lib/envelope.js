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

  const stories = district.max_stories ?? 1;
  let buildable = footprint * stories;

  const farCap = district.max_far != null ? lotArea * district.max_far : Infinity;
  buildable = Math.min(buildable, farCap);

  return {
    lotArea,
    envelope,
    footprint,
    stories,
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
  const coveragePct = district.max_building_coverage_pct;
  const coverageCap = coveragePct != null ? lotAreaSqft * (coveragePct / 100) : Infinity;
  const footprint = Math.min(envelopeAreaSqft ?? 0, coverageCap);

  const stories = district.max_stories ?? 1;
  let buildable = footprint * stories;
  const farCap = district.max_far != null ? lotAreaSqft * district.max_far : Infinity;
  buildable = Math.min(buildable, farCap);

  return {
    lotArea: lotAreaSqft,
    envelopeArea: envelopeAreaSqft ?? 0,
    footprint,
    stories,
    buildable,
    binding: footprint === 0 ? "setbacks" : coverageCap < (envelopeAreaSqft ?? 0) ? "coverage" : "setbacks",
    farLimited: buildable === farCap && farCap !== Infinity,
  };
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
