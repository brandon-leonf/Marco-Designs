import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { computeBuildable, missingDistrictRules } from "../src/lib/envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, "../../config/towns/union-city-nj.json");
const town = JSON.parse(await readFile(configPath, "utf8"));
const source = town.zoning_districts.find((district) => district.code === "R");
assert(source, "Union City config must include district R");

// This is the exact shape produced by load_town.py and returned by Supabase.
// The browser calculation below therefore proves the checked-in config values
// survive the config -> database -> frontend field mapping.
const rules = {
  code: source.code,
  front_yard_min_ft: source.setbacks_ft.front_yard_min,
  rear_yard_min_ft: source.setbacks_ft.rear_yard_min,
  side_yard_one_min_ft: source.setbacks_ft.side_yard_one_min,
  side_yard_total_min_ft: source.setbacks_ft.side_yard_total_min,
  max_building_coverage_pct: source.max_coverage_pct.building,
  max_impervious_coverage_pct: source.max_coverage_pct.lot_impervious,
  max_stories: source.max_height.stories,
  max_height_ft: source.max_height.feet,
  max_far: source.max_far,
};

assert.deepEqual(missingDistrictRules(rules), [], "R config must contain every calculation rule");

const result = computeBuildable(
  { width_ft: 25, depth_ft: 100, area_sqft: 2500 },
  rules
);
assert.equal(result.envelope.insets.front, 7);
assert.equal(result.envelope.insets.rear, 20);
assert.equal(result.envelope.insets.sideOne, 2);
assert.equal(result.envelope.insets.sideTotal, 5);
assert.equal(result.envelope.widthFt, 20);
assert.equal(result.envelope.depthFt, 73);
assert.equal(result.envelope.areaSqft, 1460);
assert.equal(result.footprint, 1460);
assert.equal(result.stories, 3);
assert.equal(result.buildable, 4380);

assert.throws(
  () => computeBuildable({ width_ft: 25, depth_ft: 100, area_sqft: 2500 }, {
    ...rules,
    rear_yard_min_ft: null,
  }),
  /missing zoning rules/,
  "The engine must refuse incomplete configs instead of using a zero/default rule"
);

console.log("Zoning source-of-truth checks passed.");
