import * as turf from "@turf/turf";

const SQFT_PER_SQM = 10.7639104167;

const normalizedCode = (value) => String(value ?? "").trim().toUpperCase();

/**
 * Resolve a WGS84 parcel polygon against the public zoning GeoJSON returned by
 * Supabase. This is the live-NJGIN equivalent of resolve_parcel_zoning(): it
 * lets a statewide parcel use a published municipal zoning layer even when the
 * parcel itself has not been copied into Marco's local parcels table.
 */
export function resolveZoningAreas(areas, parcelGeometry) {
  const baseAreas = (areas ?? []).filter(
    (area) => !area.is_overlay && area?.geojson && normalizedCode(area.district_code)
  );
  if (baseAreas.length === 0) return { status: "no_layer" };
  if (!parcelGeometry) return { status: "unmapped" };

  const parcel = turf.feature(parcelGeometry);
  const parcelAreaSqft = turf.area(parcel) * SQFT_PER_SQM;
  if (!(parcelAreaSqft > 0)) return { status: "unmapped" };

  const matches = baseAreas
    .map((area) => {
      try {
        const overlap = turf.intersect(
          turf.featureCollection([parcel, turf.feature(area.geojson)])
        );
        const overlapAreaSqft = overlap ? turf.area(overlap) * SQFT_PER_SQM : 0;
        return {
          area,
          overlapAreaSqft,
          overlapPct: (overlapAreaSqft / parcelAreaSqft) * 100,
        };
      } catch {
        // One malformed source polygon must not make every valid polygon in the
        // published layer unreadable. The admin validates geometry separately.
        return { area, overlapAreaSqft: 0, overlapPct: 0 };
      }
    })
    .filter((match) => match.overlapAreaSqft > 0)
    .sort(
      (a, b) =>
        b.overlapAreaSqft - a.overlapAreaSqft ||
        normalizedCode(a.area.district_code).localeCompare(
          normalizedCode(b.area.district_code)
        )
    );

  if (matches.length === 0) return { status: "unmapped" };

  const top = matches[0];
  const second = matches[1];
  const result = {
    district_code: top.area.district_code,
    district_name: top.area.district_name,
    overlap_area_sqft: Math.round(top.overlapAreaSqft * 10) / 10,
    overlap_pct: Math.round(top.overlapPct * 100) / 100,
    competing_codes: matches.map((match) => match.area.district_code),
  };

  if (top.overlapPct < 80 || (second?.overlapPct ?? 0) >= 20) {
    return { ...result, status: "boundary_conflict" };
  }
  if (!top.area.has_rules) return { ...result, status: "rules_missing" };
  return { ...result, status: "matched" };
}
