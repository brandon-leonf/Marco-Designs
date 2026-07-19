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
  const lotArea = lot.width_ft * lot.depth_ft;
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
 * Envelope for an arbitrary parcel polygon (GeoJSON, EPSG:4326 from the API).
 * Display-only mirror of buildable_envelope(); PostGIS remains authoritative.
 */
export function envelopeFromGeoJSON(parcelFeature, insetFt) {
  const buffered = turf.buffer(parcelFeature, -insetFt, { units: "feet" });
  if (!buffered) return { feature: null, areaSqft: 0 };
  const SQFT_PER_SQM = 10.7639;
  return { feature: buffered, areaSqft: turf.area(buffered) * SQFT_PER_SQM };
}
