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

// MOD-IV property class prefixes, and the kind of use each one asserts. Class 4
// splits into 4A/4B/4C but every branch is non-residential for our purposes.
const CLASS_USE = {
  1: "vacant",
  2: "residential",
  3: "farm",
  4: "commercial",
  15: "public",
};

const classUse = (propClass) => {
  const raw = String(propClass ?? "").trim().toUpperCase();
  if (!raw) return null;
  const digits = raw.match(/^\d+/)?.[0];
  if (!digits) return null;
  // 15A/15B/15C must be read as 15, not as 1.
  return CLASS_USE[Number(digits)] ?? null;
};

// How MOD-IV's own class list reads in plain language, for display.
const CLASS_LABEL = {
  vacant: "Vacant land",
  residential: "Residential",
  farm: "Farm",
  commercial: "Commercial",
  public: "Public / exempt",
};

/**
 * Plain-language use recorded by the assessor for this parcel, or null when the
 * class is absent or not one we recognise. This is what the property *is*,
 * independent of what any zoning polygon says it should be.
 */
export function propertyUseLabel(propClass) {
  const use = classUse(propClass);
  if (!use) return null;
  return {
    use,
    label: CLASS_LABEL[use],
    class_code: String(propClass).trim().toUpperCase(),
    is_residential: use === "residential",
    // Vacant land carries no use assertion, so it is not "non-residential" in
    // the sense that should warn anyone off — a vacant lot is the normal input.
    blocks_residential_plan: use === "commercial" || use === "public",
  };
}

/**
 * Cross-check a resolved district against the parcel's recorded MOD-IV class.
 *
 * The zoning layer and the assessor's record are independent sources describing
 * the same parcel. When they disagree — a district zoned residential over a lot
 * the assessor records as 4A Commercial — at least one is wrong about this
 * parcel, and we cannot tell which from here. Returning either one's rules would
 * be a confident wrong answer, so the disagreement itself becomes a refusal.
 *
 * Only a genuine contradiction blocks. A vacant, farm, or unrecorded class says
 * nothing about permitted use and passes through untouched, and a district that
 * permits several uses contradicts none of them — a commercial lot in a mixed-use
 * corridor is what that district is for, not a sign the sources disagree.
 */
export function crossCheckPropertyClass(check, propClass, district) {
  if (!check || check.status !== "matched") return check;

  const recorded = classUse(propClass);
  if (recorded == null || recorded === "vacant" || recorded === "farm") return check;

  // A district may permit more than one use, so this is a set and the test is
  // membership, not equality. Only a class the district permits nothing of is a
  // contradiction.
  const zoned = districtUses(district, check.district_code);
  if (zoned == null || zoned.includes(recorded)) return check;

  return {
    ...check,
    status: "class_conflict",
    recorded_class: String(propClass).trim().toUpperCase(),
    recorded_use: recorded,
    zoned_uses: zoned,
    // Kept singular for existing copy; the set is the authoritative field.
    zoned_use: zoned.join(" / "),
  };
}

/**
 * The uses a district permits, or null when we cannot say.
 *
 * Returning null is deliberate and different from returning an empty set: null
 * means "no opinion, do not block", which is the right answer for a district
 * code we do not recognise. Guessing a single use for an unfamiliar code would
 * manufacture conflicts out of ignorance.
 */
function districtUses(district, districtCode) {
  // An explicit permitted-use list from the town config is the best evidence
  // available — it comes from the ordinance rather than from the code's spelling.
  const permitted = permittedUses(district);
  if (permitted) return permitted;

  const declared = classUse(district?.property_class);
  if (declared) return [declared];

  const code = normalizedCode(district?.code ?? districtCode);
  if (!code) return null;
  if (code === "P" || code.startsWith("P-")) return ["public"];
  // Mixed use is exactly that: it permits residential and commercial together,
  // so neither class contradicts it. Defaulting it to commercial would flag an
  // ordinary residential lot in a mixed-use corridor as a source conflict.
  if (code.startsWith("MU")) return ["residential", "commercial"];
  if (code === "C" || code.startsWith("C-")) return ["commercial"];
  if (code === "R" || code.startsWith("R-")) return ["residential"];
  return null;
}

// Map the town config's permitted_uses vocabulary onto MOD-IV use categories.
// Anything dwelling-shaped is residential; the rest we leave to the caller's
// other signals rather than inventing a category for it.
const RESIDENTIAL_USE_TOKENS = /(family|dwelling|residen|apartment|townhouse|adu)/i;

function permittedUses(district) {
  const list = district?.permitted_uses;
  if (!Array.isArray(list) || list.length === 0) return null;

  const uses = new Set();
  for (const entry of list) {
    const token = String(entry ?? "");
    if (RESIDENTIAL_USE_TOKENS.test(token)) uses.add("residential");
    else if (/commerc|retail|office|business|mixed/i.test(token)) uses.add("commercial");
  }
  return uses.size > 0 ? [...uses] : null;
}
