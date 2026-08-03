import assert from "node:assert/strict";
import { resolveZoningAreas } from "../src/lib/zoningLookup.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  computeBuildable,
  missingDistrictRules,
  resolveStories,
} from "../src/lib/envelope.js";
import { standardizedPropertyAddress } from "../src/lib/address.js";
import { buildParcelPlanFrame, estimateParcelRectDims } from "../src/lib/roads.js";
import { rectFitsGeometry } from "../src/lib/placement.js";
import {
  buildSetbackEnvelope,
  planarGeometryArea,
} from "../src/lib/setbackGeometry.js";

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

assert.deepEqual(
  resolveStories({ max_stories: 2.5, max_height_ft: 35 }),
  {
    stories: 3,
    permittedStories: 3,
    heightLimited: false,
    storiesByHeight: 3,
  },
  "Legacy half-story values must normalize to whole floors"
);

assert.deepEqual(
  estimateParcelRectDims(
    {
      type: "Polygon",
      coordinates: [[[0, 0], [25, 0], [25, 100], [0, 100], [0, 0]]],
    },
    { edgeIndex: 0 }
  ),
  {
    width_ft: 25,
    depth_ft: 100,
    source: "parcel_geometry",
    method: "street_oriented",
  },
  "A street-facing NJGIN parcel edge must orient estimated frontage and depth"
);

const irregularPlanFrame = buildParcelPlanFrame(
  {
    type: "Polygon",
    coordinates: [[[0, 0], [30, 0], [30, 100], [18, 70], [0, 100], [0, 0]]],
  },
  { edgeIndex: 0 }
);
assert.equal(irregularPlanFrame.geometry.coordinates[0].length, 6);
assert.equal(
  rectFitsGeometry(
    { x0: 19, y0: 72, x1: 27, y1: 90 },
    irregularPlanFrame.geometry
  ),
  false,
  "A floor in an irregular parcel cutout must not pass the polygon placement check"
);

const curvedFrontParcel = {
  type: "Polygon",
  coordinates: [[
    [0, 22],
    [18, 19],
    [34, 10],
    [48, 2],
    [62, 0],
    [100, 0],
    [100, 160],
    [0, 160],
    [0, 22],
  ]],
};
const curvedEnvelope = buildSetbackEnvelope(curvedFrontParcel, {
  front: 35,
  rear: 50,
  sideOne: 15,
  sideTotal: 30,
});
assert(curvedEnvelope, "Edge-specific setbacks must leave a buildable envelope");
const curvedEnvelopePolygons = curvedEnvelope.type === "Polygon"
  ? [curvedEnvelope.coordinates]
  : curvedEnvelope.coordinates;
assert(
  curvedEnvelopePolygons.every((poly) => poly.every((ring) =>
    ring.length >= 4 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  )),
  "Every buildable-envelope ring must be visibly closed"
);
assert(
  planarGeometryArea(curvedEnvelope) > 1000,
  "Distinct front, rear, and side setbacks must preserve the realistically buildable parcel area"
);
assert(
  rectFitsGeometry({ x0: 0, y0: 60, x1: 14, y1: 80 }, curvedEnvelope) === false &&
    rectFitsGeometry({ x0: 86, y0: 60, x1: 100, y1: 80 }, curvedEnvelope) === false,
  "Both side-yard boundaries must be enforced"
);

assert.equal(
  standardizedPropertyAddress(
    { address: "712 22ND ST" },
    {
      matched_address: "712 22ND ST, UNION, NJ, 07087",
      muni_name: "Union City",
      state_code: "NJ",
    },
    { name: "Union City", state_code: "NJ" }
  ),
  "712 22nd St, Union City, NJ 07087",
  "NJGIN municipality metadata must override an imprecise geocoder city label"
);

assert.equal(
  standardizedPropertyAddress(
    { address: "57 SHERI DR" },
    {
      matched_address: "57 SHERI DR, ALLENDALE, NJ, 07401",
      muni_name: "Allendale",
      state_code: "NJ",
    },
    { name: "Allendale Borough", state_code: "NJ" }
  ),
  "57 Sheri Dr, Allendale, NJ 07401"
);

assert.throws(
  () => computeBuildable({ width_ft: 25, depth_ft: 100, area_sqft: 2500 }, {
    ...rules,
    rear_yard_min_ft: null,
  }),
  /missing zoning rules/,
  "The engine must refuse incomplete configs instead of using a zero/default rule"
);

const square = (west, south, east, north) => ({
  type: "Polygon",
  coordinates: [[
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]],
});
const liveParcel = square(-74.14, 41.02, -74.139, 41.021);
const matchedLiveParcel = resolveZoningAreas(
  [{
    district_code: "AAA",
    district_name: "District",
    is_overlay: false,
    has_rules: true,
    geojson: square(-74.15, 41.01, -74.13, 41.03),
  }],
  liveParcel
);
assert.equal(matchedLiveParcel.status, "matched");
assert.equal(matchedLiveParcel.district_code, "AAA");
assert(matchedLiveParcel.overlap_pct > 99.9);

const multiDistrictLayer = [
  {
    district_code: "AAA",
    is_overlay: false,
    has_rules: true,
    geojson: square(-74.15, 41.01, -74.14, 41.03),
  },
  {
    district_code: "AA",
    is_overlay: false,
    has_rules: true,
    geojson: square(-74.14, 41.01, -74.13, 41.03),
  },
];
assert.equal(
  resolveZoningAreas(
    multiDistrictLayer,
    square(-74.139, 41.02, -74.138, 41.021)
  ).district_code,
  "AA",
  "A parcel inside the second published polygon must resolve to that polygon's district"
);

assert.equal(resolveZoningAreas([], liveParcel).status, "no_layer");
assert.equal(
  resolveZoningAreas(
    [{
      district_code: "AAA",
      is_overlay: false,
      has_rules: false,
      geojson: square(-74.15, 41.01, -74.13, 41.03),
    }],
    liveParcel
  ).status,
  "rules_missing"
);

console.log("Zoning source-of-truth checks passed.");
