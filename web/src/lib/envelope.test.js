import test from "node:test";
import assert from "node:assert/strict";
import { computeBuildable } from "./envelope.js";

const narrowParcel = { width_ft: 25, depth_ft: 102, area_sqft: 2548 };
const residentialRules = {
  front_yard_min_ft: 0,
  rear_yard_min_ft: 20,
  side_yard_one_min_ft: 2,
  side_yard_total_min_ft: 5,
  max_building_coverage_pct: 65,
  max_stories: 3,
  max_far: null,
};

test("uses per-edge rectangular setbacks for a narrow parcel", () => {
  const result = computeBuildable(narrowParcel, residentialRules);
  assert.equal(result.envelope.areaSqft, 1640);
  assert.equal(result.footprint, 1640);
  assert.equal(result.buildable, 4920);
});

test("blank FAR does not cap buildable area at zero", () => {
  for (const max_far of [null, undefined, ""]) {
    const result = computeBuildable(narrowParcel, { ...residentialRules, max_far });
    assert.equal(result.farLimited, false);
    assert.equal(result.buildable, 4920);
  }
});

test("a real FAR value still caps building area", () => {
  const result = computeBuildable(narrowParcel, { ...residentialRules, max_far: 1.5 });
  assert.equal(result.farLimited, true);
  assert.equal(result.buildable, 3822);
});
