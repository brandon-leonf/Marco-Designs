/**
 * Turn the public parcel/building records into editable existing-house inputs.
 *
 * An addition is priced against what is already standing, so the three fields
 * the form asks for — footprint, stories, total floor area — have to be
 * answered before anything else can be. Public records rarely answer all three
 * outright, so they are assembled from whatever evidence exists, in a fixed
 * order of preference, and the result is reported with the confidence that
 * evidence actually earns:
 *
 *   footprint  measured outline on this lot > neighbouring outlines scaled to
 *              this lot > a rectangle modelled from the recorded lot dimensions
 *   stories    NJ MOD-IV BLDG_DESC floor code > mapped building levels >
 *              the block's assessor floor codes
 *   total      footprint x floor-equivalents
 *
 * NJ MOD-IV's BLDG_DESC commonly starts with a floor code such as `2.5F`. It is
 * not a finished-area field, so the total area remains an estimate: building
 * outline x assessor floor-equivalents. A half floor is shown as the next whole
 * physical story (`2.5F` => 3 stories), which also lets the UI express the
 * average-floor footprint the form asks for.
 *
 * Nothing here is a survey, and the UI must never present it as one.
 */

import { recordedRectDims } from "./envelope.js";

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function assessorFloorEquivalents(buildingDescription) {
  // Common MOD-IV variants include `2.5F`, `2S-F` and `2SF`.
  const match = String(buildingDescription ?? "").match(
    /(?:^|[-\s])(\d+(?:\.\d+)?)\s*(?:S(?:F)?|F)(?:$|[-\s])/i
  );
  return positiveNumber(match?.[1]);
}

function osmFloorEquivalents(tags) {
  const levels = positiveNumber(tags?.["building:levels"] ?? tags?.levels);
  if (!levels) return null;
  const roofLevels = positiveNumber(tags?.["roof:levels"]) ?? 0;
  return levels + roofLevels;
}

function sorted(values) {
  return values.filter((value) => positiveNumber(value) != null).sort((a, b) => a - b);
}

/** Linear-interpolated percentile over an already-sorted list. */
function percentile(values, fraction) {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const position = (values.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

const median = (values) => percentile(values, 0.5);

// How far a comparable's lot may be from the subject's before it stops being
// one, and the widened band used when the strict one leaves too few to trust.
const LOT_BAND = { low: 0.5, high: 2 };
const WIDE_LOT_BAND = { low: 0.33, high: 3 };
const MIN_COMPARABLES = 3;
const MAX_COMPARABLES = 30;

/**
 * Narrow the neighbourhood to the lots that are actually comparable.
 *
 * Two filters, both of which an appraiser would apply before quoting a number:
 * the property has to be the same MOD-IV class — a commercial strip covering
 * every inch of its lot is not evidence about the row house behind it — and the
 * lot has to be near the subject's size, since coverage is a ratio and a
 * half-acre lot is not built out like a 35-foot one. The size band widens only
 * when the strict one leaves too few comparables to take a median from.
 */
export function selectComparables(comparables = [], parcel = null) {
  const usable = comparables.filter(
    (item) => positiveNumber(item?.footprintSqft) && positiveNumber(item?.lotAreaSqft)
  );
  const propClass = parcel?.prop_class ? String(parcel.prop_class).toUpperCase() : null;
  const sameUse = propClass
    ? usable.filter((item) => String(item?.propClass ?? "").toUpperCase() === propClass)
    : usable;
  const pool = sameUse.length >= MIN_COMPARABLES ? sameUse : usable;

  const lotArea = positiveNumber(parcel?.lot_area_sqft);
  if (!lotArea) return pool.slice(0, MAX_COMPARABLES);

  const withinBand = (band) =>
    pool.filter(
      (item) => item.lotAreaSqft >= lotArea * band.low && item.lotAreaSqft <= lotArea * band.high
    );
  let selected = withinBand(LOT_BAND);
  if (selected.length < MIN_COMPARABLES) selected = withinBand(WIDE_LOT_BAND);
  if (selected.length < MIN_COMPARABLES) selected = pool;

  // Keep the closest in size, so a long tail of near-band lots cannot outvote
  // the ones that actually resemble this property.
  return [...selected]
    .sort(
      (a, b) =>
        Math.abs(Math.log(a.lotAreaSqft / lotArea)) - Math.abs(Math.log(b.lotAreaSqft / lotArea))
    )
    .slice(0, MAX_COMPARABLES);
}

/**
 * What the neighbouring lots say about how much of a lot gets built on here.
 *
 * Expressed as a coverage ratio rather than a raw footprint, because the
 * comparable next door is only comparable once it is put on the same size lot.
 * The quartiles travel with it: they become the range the UI shows instead of
 * a single invented number.
 */
export function summarizeComparables(comparables = []) {
  const ratios = sorted(
    comparables.map((item) => {
      const footprint = positiveNumber(item?.footprintSqft);
      const lotArea = positiveNumber(item?.lotAreaSqft);
      return footprint && lotArea ? footprint / lotArea : null;
    })
  );
  if (ratios.length === 0) return null;

  const floors = sorted(
    comparables.map((item) =>
      positiveNumber(item?.floorEquivalents) ?? assessorFloorEquivalents(item?.buildingDesc)
    )
  );
  return {
    count: ratios.length,
    coverage: median(ratios),
    coverageLow: percentile(ratios, 0.25),
    coverageHigh: percentile(ratios, 0.75),
    floorEquivalents: floors.length ? median(floors) : null,
    floorCount: floors.length,
  };
}

/**
 * A footprint modelled from the recorded lot, used only when nothing at all has
 * been mapped nearby. Deliberately crude and always reported as Low: an urban
 * New Jersey house takes the lot's width less a side yard each side, and around
 * half its depth, and that is the whole of the reasoning.
 */
/**
 * Whether this record describes a lot a house stands on at all.
 *
 * MOD-IV class 15 is exempt property, and a condominium's shared ground is
 * carried as its own parcel described "COMMON ELEMENTS" — 1812 New York Ave in
 * Union City resolves to one, an 185 sq ft strip. Modelling a house from the
 * area of a shape like that produced a 300 sq ft footprint covering 162% of its
 * own lot. There is no house to describe here, and saying so is the answer.
 */
function describesABuildingLot(parcel) {
  // Class 15 is not a test here either: a tax-exempt owner still owns a lot,
  // and a church or school with an addition in mind is an ordinary client.
  return !/COMMON ELEMENT/i.test(String(parcel?.building_desc ?? ""));
}

function lotModelFootprint(parcel) {
  if (!describesABuildingLot(parcel)) return null;
  const lotAreaSqft = positiveNumber(parcel?.lot_area_sqft);
  const dims = recordedRectDims(parcel);
  if (dims) {
    const width = Math.max(dims.width_ft - 8, dims.width_ft * 0.55);
    const depth = Math.min(dims.depth_ft * 0.5, 55);
    const modelled = width * depth;
    return {
      footprintSqft: lotAreaSqft ? Math.min(modelled, lotAreaSqft * 0.45) : modelled,
      detail: `a ${dims.width_ft} x ${dims.depth_ft} ft recorded lot`,
    };
  }
  if (lotAreaSqft) {
    return {
      footprintSqft: lotAreaSqft * 0.3,
      detail: `a ${Math.round(lotAreaSqft).toLocaleString("en-US")} sq. ft. lot`,
    };
  }
  return null;
}

/** The footprint a house with this many recorded units is unlikely to fall below. */
function dwellingFloor(parcel, floorEquivalents) {
  const units = positiveNumber(parcel?.dwelling_units);
  if (!units) return null;
  return (units * 600) / (floorEquivalents ?? 2);
}

const FOOTPRINT_POINTS = { njdep: 3, osm: 2, comparables: 1, lot_model: 0 };
const STORY_POINTS = { assessor: 2, mapped: 1, neighborhood: 1, assumed: 0 };
// Half the plausible spread, as a fraction, for each way of getting a footprint.
const FOOTPRINT_SPREAD = { njdep: 0.1, osm: 0.15, lot_model: 0.35 };

function confidenceFromScore(score) {
  if (score >= 5) return "High";
  if (score >= 3) return "Medium";
  return "Low";
}

/**
 * Everything the form needs about the house that is already there, plus the
 * evidence behind each number.
 *
 * `detected` is the outline standing on this parcel (null when none is
 * published), `comparables` are the paired neighbouring building/lot records,
 * and `parcel` supplies MOD-IV. Returns null only when there is no parcel to
 * reason about at all.
 */
export function estimateExistingBuilding({ detected = null, comparables = [], parcel = null } = {}) {
  const lotAreaSqft = positiveNumber(parcel?.lot_area_sqft);
  const summary = summarizeComparables(selectComparables(comparables, parcel));

  // --- Stories -------------------------------------------------------------
  const assessorFloors = assessorFloorEquivalents(parcel?.building_desc);
  const mappedFloors = osmFloorEquivalents(detected?.tags);
  const neighborhoodFloors = summary?.floorEquivalents ?? null;
  const floorEquivalents = assessorFloors ?? mappedFloors ?? neighborhoodFloors;
  const storyBasis = assessorFloors
    ? "assessor"
    : mappedFloors
      ? "mapped"
      : neighborhoodFloors
        ? "neighborhood"
        : "assumed";
  const storySource = assessorFloors
    ? `NJ MOD-IV building description ${parcel.building_desc}`
    : mappedFloors
      ? "OpenStreetMap building levels"
      : neighborhoodFloors
        ? `the assessor floor codes on ${summary.floorCount} nearby lots`
        : null;

  // --- Footprint -----------------------------------------------------------
  let footprintBasis = null;
  let baseFootprint = null;
  let footprintSource = null;
  let footprintRange = null;

  if (detected) {
    const clippedFootprint = positiveNumber(detected.areaSqft);
    const completeOutline = positiveNumber(detected.fullAreaSqft);
    // A slight parcel-line crossing is normally map/parcel alignment, as in the
    // sample row house. If the complete outline is much larger, it likely groups
    // several attached properties; keep only this parcel's share in that case.
    baseFootprint =
      completeOutline && (!clippedFootprint || completeOutline <= clippedFootprint * 1.5)
        ? completeOutline
        : clippedFootprint ?? completeOutline;
    footprintBasis = detected.source?.id === "njdep" ? "njdep" : "osm";
    footprintSource = detected.source?.name ?? "a published building outline";
  } else if (summary && lotAreaSqft) {
    baseFootprint = summary.coverage * lotAreaSqft;
    footprintBasis = "comparables";
    footprintSource = `${summary.count} mapped building${summary.count === 1 ? "" : "s"} on nearby lots`;
    footprintRange = {
      low: summary.coverageLow * lotAreaSqft,
      high: summary.coverageHigh * lotAreaSqft,
    };
  } else {
    const modelled = lotModelFootprint(parcel);
    if (!modelled) return null;
    baseFootprint = modelled.footprintSqft;
    footprintBasis = "lot_model";
    footprintSource = `${modelled.detail}, with no mapped building to measure`;
  }

  const floor = dwellingFloor(parcel, floorEquivalents);
  if (footprintBasis !== "njdep" && footprintBasis !== "osm" && floor && floor > baseFootprint) {
    baseFootprint = floor;
  }
  if (!positiveNumber(baseFootprint)) return null;

  if (!footprintRange) {
    const spread = FOOTPRINT_SPREAD[footprintBasis] ?? 0.25;
    footprintRange = { low: baseFootprint * (1 - spread), high: baseFootprint * (1 + spread) };
  }

  // --- Confidence ----------------------------------------------------------
  let score = (FOOTPRINT_POINTS[footprintBasis] ?? 0) + (STORY_POINTS[storyBasis] ?? 0);
  const reasons = [];
  reasons.push(
    footprintBasis === "comparables"
      ? `Footprint estimated from ${footprintSource}, scaled to this lot.`
      : footprintBasis === "lot_model"
        ? `Footprint modelled from ${footprintSource}.`
        : `Footprint measured from ${footprintSource}.`
  );
  if (storySource) reasons.push(`Stories read from ${storySource}.`);
  else reasons.push("No record of the story count was found; confirm it below.");

  // A mapped outline that matches what the rest of the block was built to is
  // worth more than the same outline standing alone.
  let corroborated = false;
  if (
    (footprintBasis === "njdep" || footprintBasis === "osm") &&
    summary &&
    summary.count >= 3 &&
    lotAreaSqft
  ) {
    const expected = summary.coverage * lotAreaSqft;
    corroborated = Math.abs(baseFootprint - expected) <= expected * 0.25;
    if (corroborated) {
      score += 1;
      reasons.push(
        `The outline is consistent with the ${summary.count} nearby lots, which average ${Math.round(summary.coverage * 100)}% lot coverage.`
      );
    } else {
      reasons.push(
        `The outline differs from the ${summary.count} nearby lots, which average ${Math.round(summary.coverage * 100)}% lot coverage — worth checking.`
      );
    }
  }
  if (detected?.clipped) {
    score -= 1;
    reasons.push("The mapped outline crosses this lot's boundary, so only its share is counted.");
  }

  // --- Derived figures -----------------------------------------------------
  const stories = floorEquivalents ? Math.ceil(floorEquivalents) : null;
  const totalAreaSqft = floorEquivalents ? Math.round(baseFootprint * floorEquivalents) : null;
  // This is an average floor plate, matching gross building area / physical
  // stories. It is intentionally labelled as derived in the UI: stepped-back
  // upper floors and half stories make it an estimate rather than a survey.
  const footprintSqft = stories ? Math.round(totalAreaSqft / stories) : Math.round(baseFootprint);
  const coveragePercent = lotAreaSqft ? (footprintSqft / lotAreaSqft) * 100 : null;

  const round = (value) => Math.round(value);
  return {
    footprintSqft,
    stories,
    totalAreaSqft,
    floorEquivalents: floorEquivalents ?? null,
    coveragePercent,
    lotAreaSqft,
    confidence: confidenceFromScore(score),
    confidenceScore: score,
    footprintBasis,
    footprintSource,
    storyBasis,
    storySource,
    corroborated,
    comparableCount: summary?.count ?? 0,
    reasons,
    range: {
      footprintLow: round(Math.min(footprintRange.low, footprintSqft)),
      footprintHigh: round(Math.max(footprintRange.high, footprintSqft)),
      totalAreaLow: floorEquivalents ? round(footprintRange.low * floorEquivalents) : null,
      totalAreaHigh: floorEquivalents ? round(footprintRange.high * floorEquivalents) : null,
    },
    explanation: totalAreaSqft
      ? `derived from ${totalAreaSqft.toLocaleString("en-US")} sq. ft. total building area ÷ ${stories} stories`
      : "based only on the building outline; confirm the stories and total area",
    totalAreaExplanation: totalAreaSqft
      ? `${totalAreaSqft.toLocaleString("en-US")} sq. ft. is ${
          footprintBasis === "njdep" || footprintBasis === "osm" ? "estimated from" : "modelled from"
        } a ${Math.round(baseFootprint).toLocaleString("en-US")} sq. ft. footprint × ${floorEquivalents} floor-equivalents`
      : null,
  };
}

export function lotCoveragePercent(footprintSqft, lotAreaSqft) {
  const footprint = positiveNumber(footprintSqft);
  const lotArea = positiveNumber(lotAreaSqft);
  return footprint && lotArea ? (footprint / lotArea) * 100 : null;
}
