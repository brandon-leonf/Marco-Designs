import assert from "node:assert/strict";
import {
  assessorFloorEquivalents,
  estimateExistingBuilding,
  lotCoveragePercent,
  selectComparables,
  summarizeComparables,
} from "../src/lib/existingBuildingFacts.js";

// --- MOD-IV floor codes ----------------------------------------------------
// The story count for an addition comes out of BLDG_DESC, which is a free-text
// assessor field with several spellings of the same fact.
assert.equal(assessorFloorEquivalents("2S-AL-L"), 2, "218 74th St, North Bergen");
assert.equal(assessorFloorEquivalents("2.5F"), 2.5);
assert.equal(assessorFloorEquivalents("1.5S-AL-O"), 1.5);
assert.equal(assessorFloorEquivalents("3S-F-L"), 3);
assert.equal(assessorFloorEquivalents("4S-B-C"), 4);
assert.equal(assessorFloorEquivalents("RANCH"), null, "no floor code is not a floor count");
assert.equal(assessorFloorEquivalents(null), null);

// --- Comparables -----------------------------------------------------------
const blockComparables = [
  { footprintSqft: 1041, lotAreaSqft: 3500, buildingDesc: "2S-F-L" },
  { footprintSqft: 1142, lotAreaSqft: 3500, buildingDesc: "2S-AL-L" },
  { footprintSqft: 1068, lotAreaSqft: 3500, buildingDesc: "2S-AL-L" },
  { footprintSqft: 1262, lotAreaSqft: 3800, buildingDesc: "2S-B-O" },
  { footprintSqft: 1566, lotAreaSqft: 5000, buildingDesc: "3S-AL-O" },
];
const summary = summarizeComparables(blockComparables);
assert.equal(summary.count, 5);
assert.ok(summary.coverage > 0.3 && summary.coverage < 0.34, "row-house block covers about a third");
assert.ok(summary.coverageLow < summary.coverage && summary.coverage < summary.coverageHigh);
assert.equal(summary.floorEquivalents, 2, "the block is predominantly two storeys");
assert.equal(summarizeComparables([]), null);
assert.equal(summarizeComparables([{ footprintSqft: 900 }]), null, "a footprint with no lot is not a ratio");

// --- Choosing comparables --------------------------------------------------
// A 400 ft box around 218 74th St catches 207 lots, and most of them are not
// comparable: Broadway storefronts covering almost their whole lot, and small
// dense lots half the subject's size. Taken together they read as 45% median
// coverage against the block's real 34%, which made the actual house look like
// an anomaly. The filter is what keeps the neighbourhood honest.
const subject = { prop_class: "2", lot_area_sqft: 3496 };
const storefronts = Array.from({ length: 8 }, (_, index) => ({
  footprintSqft: 1250 + index * 20,
  lotAreaSqft: 1360,
  propClass: "4A",
  buildingDesc: "2S-B-C",
}));
const smallDenseLots = Array.from({ length: 8 }, (_, index) => ({
  footprintSqft: 1300 + index * 15,
  lotAreaSqft: 2500,
  propClass: "2",
  buildingDesc: "2S-B-O",
}));
const pollutedNeighbourhood = [
  ...blockComparables.map((item) => ({ ...item, propClass: "2" })),
  ...storefronts,
  ...smallDenseLots,
  { footprintSqft: 21000, lotAreaSqft: 55000, propClass: "2", buildingDesc: "3S-F-L" },
];

assert.ok(
  summarizeComparables(pollutedNeighbourhood).coverage > 0.45,
  "left unfiltered, the same neighbourhood reads far too dense"
);

const picked = selectComparables(pollutedNeighbourhood, subject);
assert.ok(
  picked.every((item) => item.propClass === "2"),
  "a storefront is not a comparable for a row house"
);
assert.ok(
  picked.every((item) => item.lotAreaSqft <= 3496 * 2 && item.lotAreaSqft >= 3496 * 0.5),
  "coverage is a ratio, so the half-acre lot cannot inform a 3,496 sq ft one"
);
assert.ok(
  picked.slice(0, 4).every((item) => Math.abs(item.lotAreaSqft - 3496) < 400),
  "the closest-sized lots rank first, so the denser small lots cannot outvote them"
);
assert.ok(
  Math.abs(summarizeComparables(picked.slice(0, 4)).coverage - 0.32) < 0.03,
  "this block covers about a third of each lot, not close to half"
);

// A dense town supplies far more neighbours than a median needs. Only the
// closest in size are kept — the cut has to be by resemblance, not by whatever
// order the parcel service happened to answer in.
const crowded = Array.from({ length: 60 }, (_, index) => ({
  footprintSqft: 1150,
  lotAreaSqft: 2000 + index * 60,
  propClass: "2",
  buildingDesc: "2S-B-O",
}));
const capped = selectComparables(crowded, subject);
assert.equal(capped.length, 30, "the comparable set stays small enough for the median to mean something");
// Similarity is proportional, not absolute: a lot half the subject's size is as
// far from it as one twice the size, which is what the log ratio expresses.
const sizeDistance = (item) => Math.abs(Math.log(item.lotAreaSqft / 3496));
const keptDistance = Math.max(...capped.map(sizeDistance));
const droppedDistance = Math.min(
  ...crowded.filter((item) => !capped.includes(item)).map(sizeDistance)
);
assert.ok(keptDistance <= droppedDistance, "every kept lot is closer in size than every dropped one");

// With too few same-class comparables to take a median from, the pool widens
// rather than reporting a median of one.
const sparse = selectComparables(
  [
    { footprintSqft: 1100, lotAreaSqft: 3400, propClass: "2" },
    { footprintSqft: 1300, lotAreaSqft: 3600, propClass: "4A" },
    { footprintSqft: 1200, lotAreaSqft: 3500, propClass: "4A" },
  ],
  subject
);
assert.equal(sparse.length, 3, "two comparables is not enough to filter down to");

// --- 218 74th St, North Bergen: outline present ----------------------------
// Block 295 / lot 19.02. OSM way 766517939 is drawn on the lot; MOD-IV records
// LAND_DESC 35X100 and BLDG_DESC 2S-AL-L.
const northBergen = {
  building_desc: "2S-AL-L",
  land_desc: "35X100",
  lot_area_sqft: 3501,
  dwelling_units: 2,
};
const measured = estimateExistingBuilding({
  detected: {
    areaSqft: 1139,
    fullAreaSqft: 1139,
    clipped: false,
    tags: { building: "yes" },
    source: { id: "osm", name: "OpenStreetMap buildings" },
  },
  comparables: blockComparables,
  parcel: northBergen,
});
assert.equal(measured.footprintSqft, 1139);
assert.equal(measured.stories, 2);
assert.equal(measured.totalAreaSqft, 2278);
assert.equal(measured.footprintBasis, "osm");
assert.equal(measured.storyBasis, "assessor");
assert.equal(measured.corroborated, true, "the outline matches the rest of the block");
assert.equal(measured.confidence, "High", "mapped outline + assessor floors + block agreement");
assert.ok(Math.abs(measured.coveragePercent - 32.5) < 0.2, "32.5% of the lot is covered");
assert.ok(measured.range.footprintLow < 1139 && measured.range.footprintHigh > 1139);

// A state-measured outline clears High on its own evidence, with no block to
// corroborate it.
const njdep = estimateExistingBuilding({
  detected: {
    areaSqft: 1139,
    fullAreaSqft: 1139,
    clipped: false,
    tags: null,
    source: { id: "njdep", name: "NJDEP Building Footprints" },
  },
  comparables: [],
  parcel: northBergen,
});
assert.equal(njdep.confidence, "High");
assert.equal(njdep.comparableCount, 0);

// An outline that crosses the lot line is worth one grade less: only this
// owner's share of an attached row house is theirs to count.
const clipped = estimateExistingBuilding({
  detected: {
    areaSqft: 700,
    fullAreaSqft: 1400,
    clipped: true,
    tags: null,
    source: { id: "osm", name: "OpenStreetMap buildings" },
  },
  comparables: [],
  parcel: northBergen,
});
assert.equal(clipped.footprintSqft, 700, "the neighbour's half is not counted");
assert.equal(clipped.confidence, "Medium");

// --- Nothing published on the lot -----------------------------------------
// The block is mapped, this lot is not: the comparables carry the estimate and
// the grade drops to say so.
const fromBlock = estimateExistingBuilding({
  detected: null,
  comparables: blockComparables,
  parcel: northBergen,
});
assert.equal(fromBlock.footprintBasis, "comparables");
assert.equal(fromBlock.stories, 2, "MOD-IV still answers the story count");
assert.equal(fromBlock.confidence, "Medium");
assert.ok(
  Math.abs(fromBlock.footprintSqft - 1139) < 200,
  `block estimate ${fromBlock.footprintSqft} should land near the real 1,139 sq ft`
);
// Both figures are rounded independently, so they agree to within the rounding.
assert.ok(Math.abs(fromBlock.totalAreaSqft - fromBlock.footprintSqft * 2) <= 1);
assert.ok(
  fromBlock.range.footprintLow < fromBlock.footprintSqft &&
    fromBlock.range.footprintHigh > fromBlock.footprintSqft,
  "the comparables' quartiles become the range"
);

// Nothing mapped anywhere: the recorded lot is all that is left, and Low says so.
const fromLot = estimateExistingBuilding({
  detected: null,
  comparables: [],
  parcel: northBergen,
});
assert.equal(fromLot.footprintBasis, "lot_model");
assert.equal(fromLot.confidence, "Low");
assert.ok(fromLot.footprintSqft > 0 && fromLot.footprintSqft <= 3501 * 0.45, "capped against the lot");
assert.ok(fromLot.range.footprintHigh - fromLot.range.footprintLow > 500, "a wide band, honestly drawn");

// No story code anywhere means no total area is invented.
const noStories = estimateExistingBuilding({
  detected: null,
  comparables: [],
  parcel: { land_desc: "35X100", lot_area_sqft: 3501 },
});
assert.equal(noStories.stories, null);
assert.equal(noStories.totalAreaSqft, null);
assert.equal(noStories.confidence, "Low");

// A parcel with no geometry, no records and no neighbours cannot be estimated,
// and must say nothing rather than guess.
assert.equal(estimateExistingBuilding({ detected: null, comparables: [], parcel: {} }), null);
assert.equal(estimateExistingBuilding(), null);

// --- Lot coverage ----------------------------------------------------------
assert.ok(Math.abs(lotCoveragePercent(1139, 3501) - 32.53) < 0.01);
assert.equal(lotCoveragePercent(1139, 0), null);
assert.equal(lotCoveragePercent(null, 3501), null);

console.log("existing-building estimator: all assertions passed");
