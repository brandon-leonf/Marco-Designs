/**
 * Reviewable ordinance-derived district catalogs.
 *
 * GIS layers answer where a district is; the adopted code answers what the
 * district is called and which dimensional rules govern it. Entries here are
 * intentionally explicit and source-linked. Values are included only when the
 * ordinance maps cleanly onto the editor's single numeric field. Conditional
 * standards remain blank with an explanation instead of being flattened into a
 * misleading number.
 */
const verifiedDistrict = (code, name, rules = {}, notes = []) => ({
  code,
  name,
  rules,
  notes,
});

const articleSpecificDistrict = (code, name, reference) =>
  verifiedDistrict(code, name, {}, [
    `The adopted ordinance provides parcel-, use-, plan- or overlay-specific standards in ${reference}. Review that provision before entering fixed values.`,
  ]);

const parsippanyBulkRules = (
  minLotArea,
  minLotWidth,
  frontYard,
  oneSideYard,
  totalSideYard,
  rearYard,
  buildingCoverage,
  stories,
  height,
  imperviousCoverage
) => ({
  min_lot_area_sqft: minLotArea,
  min_lot_width_ft: minLotWidth,
  front_yard_min_ft: frontYard,
  side_yard_one_min_ft: oneSideYard,
  side_yard_total_min_ft: totalSideYard,
  rear_yard_min_ft: rearYard,
  max_building_coverage_pct: buildingCoverage,
  ...(Number.isInteger(stories) ? { max_stories: stories } : {}),
  max_height_ft: height,
  max_impervious_coverage_pct: imperviousCoverage,
});

const CATALOGS = [
  {
    municipality: "Asbury Park",
    stateCode: "NJ",
    title: "Asbury Park Code § 30-66.1 and Schedule 1 (§ 30-67)",
    sourceUrl: "https://ecode360.com/34680228",
    districts: [
      {
        code: "R1",
        name: "Single-Family Residential",
        rules: {
          front_yard_min_ft: 25,
          rear_yard_min_ft: 25,
          side_yard_one_min_ft: 6,
          side_yard_total_min_ft: 14,
          min_lot_area_sqft: 5000,
          min_lot_width_ft: 50,
          front_yard_prevailing_rule: true,
          max_building_coverage_pct: 30,
          max_impervious_coverage_pct: 65,
          max_height_ft: 30,
        },
        notes: [
          "The schedule permits 2.5 stories. Max Stories remains blank because this editor accepts whole floors; the 30-foot height is filled.",
        ],
      },
      {
        code: "R2",
        name: "One- and Two-Family Residential",
        rules: {
          front_yard_min_ft: 25,
          rear_yard_min_ft: 25,
          side_yard_one_min_ft: 6,
          side_yard_total_min_ft: 14,
          min_lot_width_ft: 50,
          front_yard_prevailing_rule: true,
          max_building_coverage_pct: 30,
          max_impervious_coverage_pct: 65,
          max_height_ft: 30,
        },
        notes: [
          "Minimum lot area is 2,500 square feet per dwelling unit, so it cannot be represented honestly by the editor's single fixed-area field.",
          "The schedule permits 2.5 stories. Max Stories remains blank; the 30-foot height is filled.",
        ],
      },
      {
        code: "R3",
        name: "Multifamily Residential",
        rules: {
          front_yard_min_ft: 30,
          rear_yard_min_ft: 30,
          front_yard_prevailing_rule: true,
          max_building_coverage_pct: 30,
          max_impervious_coverage_pct: 65,
        },
        notes: [
          "R3 has separate 1–2-family and multifamily standards for lot area, width, side yards, stories, height, and FAR. Those conditional fields remain blank rather than applying one use's limits to the other.",
        ],
      },
      {
        code: "B",
        name: "Business District",
        rules: {
          rear_yard_min_ft: 10,
          max_stories: 4,
          max_height_ft: 50,
          max_building_coverage_pct: 80,
          max_impervious_coverage_pct: 80,
          max_far: 2.5,
        },
        notes: [
          "Lot area and width depend on whether a parcel is vacant. Front and side yards depend on the street and adjacent use, so those fields remain blank.",
        ],
      },
      {
        code: "L-I",
        name: "Light Industrial",
        rules: {
          rear_yard_min_ft: 20,
          side_yard_one_min_ft: 5,
          side_yard_total_min_ft: 10,
          min_lot_area_sqft: 10000,
          min_lot_width_ft: 75,
          max_stories: 3,
          max_height_ft: 40,
          max_building_coverage_pct: 80,
          max_impervious_coverage_pct: 90,
          max_far: 1,
        },
        notes: [
          "The schedule states a 10-foot maximum front yard; the editor field is a minimum, so it remains blank.",
        ],
      },
      {
        code: "P1",
        name: "Parks",
        rules: {},
        notes: ["P1 is designated in § 30-66.1 but has no row in Schedule 1's bulk table."],
      },
      {
        code: "P2",
        name: "Schools",
        rules: {},
        notes: ["P2 is designated in § 30-66.1 but has no row in Schedule 1's bulk table."],
      },
    ],
  },
  {
    municipality: "Weehawken",
    stateCode: "NJ",
    title: "Weehawken Code § 23-4.1 and Schedule A (§ 23-6.1)",
    sourceUrl: "https://ecode360.com/34512416",
    districts: [
      {
        code: "R-1",
        name: "One Family Residence",
        rules: {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 20,
          side_yard_one_min_ft: 6,
          side_yard_total_min_ft: 14,
          min_lot_area_sqft: 5000,
          min_lot_width_ft: 50,
          front_yard_prevailing_rule: true,
          max_building_coverage_pct: 35,
          max_stories: 3,
          max_height_ft: 35,
        },
        notes: [
          "The front yard is the average of existing buildings on the same side of the street, with a 10-foot minimum and 20-foot maximum. The editor records the minimum and prevailing-yard rule; review the 20-foot cap separately.",
          "The side yards are six feet on one side and eight feet on the other; the editor records six feet for one side and 14 feet total.",
        ],
      },
      {
        code: "R-2",
        name: "One, Two and Three Family Residence",
        rules: {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 20,
          min_lot_area_sqft: 2500,
          min_lot_width_ft: 25,
          front_yard_prevailing_rule: true,
          max_building_coverage_pct: 35,
          max_stories: 3,
          max_height_ft: 35,
        },
        notes: [
          "The front-yard rule is the R-1 prevailing setback, including its 10-foot minimum and 20-foot maximum.",
          "Side yards are three feet and seven feet, but also depend on building height. They remain blank rather than understating the height-based requirement.",
        ],
      },
      {
        code: "R-3",
        name: "One, Two and Three Family Residence including Townhouses",
        rules: {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 20,
          front_yard_prevailing_rule: true,
          max_stories: 3,
          max_height_ft: 35,
        },
        notes: [
          "Schedule A has different lot area, width, side-yard and coverage standards for R-2 uses versus townhouses. Those use-specific fields remain blank.",
          "The front-yard rule is the R-1 prevailing setback, including its 10-foot minimum and 20-foot maximum.",
        ],
      },
      {
        code: "R-4",
        name: "Multi-Family Residence",
        rules: {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 20,
          front_yard_prevailing_rule: true,
        },
        notes: [
          "R-4 multifamily development and R-3 uses follow different lot, side-yard, coverage and height standards. Those use-specific fields remain blank.",
          "The front-yard rule is the R-1 prevailing setback, including its 10-foot minimum and 20-foot maximum.",
        ],
      },
      {
        code: "RA-1",
        name: "One, Two and Three Family Residence",
        rules: {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 25,
          side_yard_one_min_ft: 10,
          side_yard_total_min_ft: 20,
          min_lot_width_ft: 50,
          front_yard_prevailing_rule: true,
          max_building_coverage_pct: 35,
          max_stories: 3,
          max_height_ft: 35,
        },
        notes: [
          "Minimum lot area changes with the number of dwelling units, so the editor's single fixed lot-area field remains blank.",
          "The front yard is the average setback on the same side of the block, but never less than 10 feet.",
        ],
      },
      {
        code: "R/B-1",
        name: "Multi-Family with Business",
        rules: {
          rear_yard_min_ft: 20,
          max_stories: 4,
          max_height_ft: 40,
        },
        notes: [
          "Schedule A distinguishes business/multifamily development from R-4 uses. Lot, width, front-yard, side-yard and coverage fields remain blank where those standards differ by use or building height.",
        ],
      },
      {
        code: "R/B-2",
        name: "High Rise Multi-Family with Business",
        rules: {},
        notes: [
          "Schedule A provides separate standards for high-rise residential/business, business-only, and R/B-1 uses. A single set of numeric fields would be misleading, so these values require use-specific review.",
        ],
      },
      {
        code: "B-2",
        name: "Outdoor Recreation",
        rules: {
          min_lot_area_sqft: 130680,
          max_building_coverage_pct: 15,
          max_height_ft: 20,
        },
        notes: [
          "Front, rear and side yards are formulas based on lot depth or building height, subject to minimums. They remain blank because the editor stores fixed setbacks.",
        ],
      },
      {
        code: "B-3",
        name: "Office Park",
        rules: {
          front_yard_min_ft: 50,
          rear_yard_min_ft: 50,
          side_yard_one_min_ft: 30,
          min_lot_area_sqft: 130680,
          min_lot_width_ft: 150,
          max_stories: 5,
          max_height_ft: 50,
        },
        notes: [
          "Maximum coverage decreases as the number of stories increases, so the single coverage field remains blank.",
          "Planned developments may be subject to exceptions under § 23-10.",
        ],
      },
      {
        code: "I",
        name: "Industrial Park",
        rules: {
          front_yard_min_ft: 50,
          rear_yard_min_ft: 50,
          side_yard_one_min_ft: 30,
          min_lot_area_sqft: 130680,
          min_lot_width_ft: 150,
          max_stories: 2,
          max_height_ft: 30,
        },
        notes: [
          "Maximum coverage differs between one- and two-story buildings, so the single coverage field remains blank.",
          "Planned developments may be subject to exceptions under § 23-10.",
        ],
      },
      {
        code: "I/O",
        name: "Industrial and Office",
        rules: {
          rear_yard_min_ft: 50,
          side_yard_one_min_ft: 3.5,
          min_lot_area_sqft: 10000,
          min_lot_width_ft: 50,
          max_building_coverage_pct: 50,
          max_stories: 5,
          max_height_ft: 50,
        },
        notes: [
          "The front yard is one-half the building height measured from the street center line, with a five-foot minimum. It remains blank because the editor stores a fixed setback from the lot line.",
        ],
      },
      {
        code: "PD",
        name: "Planned Development District",
        rules: {},
        notes: [
          "Planned-development bulk standards depend on § 23-10 criteria, incentives and Planning Board approval; they cannot be represented as one fixed district profile.",
        ],
      },
      {
        code: "SW",
        name: "Special Waterfront",
        rules: {
          front_yard_min_ft: 50,
          rear_yard_min_ft: 50,
          side_yard_one_min_ft: 30,
          min_lot_area_sqft: 130680,
          min_lot_width_ft: 100,
        },
        notes: [
          "Coverage and height follow the I or B-3 standards depending on use, so those use-specific fields remain blank.",
        ],
      },
      {
        code: "B-1",
        name: "Shopping Center Business",
        rules: {
          front_yard_min_ft: 20,
          rear_yard_min_ft: 50,
          side_yard_one_min_ft: 10,
          min_lot_area_sqft: 87120,
          min_lot_width_ft: 200,
          max_building_coverage_pct: 40,
          max_stories: 2,
          max_height_ft: 30,
        },
        notes: [],
      },
    ],
  },
  {
    municipality: "North Bergen",
    stateCode: "NJ",
    title: "North Bergen Zoning Ordinance § 3.1 and district bulk tables",
    sourceUrl: "https://www.northbergen.org/_Content/pdf/NB_ZoningOrdinance_FORWEB.pdf",
    districts: [
      verifiedDistrict(
        "R-1",
        "Low-Density Residential",
        {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 30,
          min_lot_depth_ft: 100,
          max_building_coverage_pct: 35,
          max_impervious_coverage_pct: 65,
          max_height_ft: 30,
        },
        [
          "Lot area, width and side yards differ among one-family, two-family and other permitted uses; only standards common to the R-1 table are filled.",
        ]
      ),
      verifiedDistrict(
        "R-2",
        "Intermediate-Density Residential",
        {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 30,
          min_lot_depth_ft: 100,
          max_building_coverage_pct: 35,
          max_impervious_coverage_pct: 65,
        },
        [
          "R-2 includes multiple building types with different lot, side-yard and height standards; only values common to its table are filled.",
        ]
      ),
      verifiedDistrict(
        "R-3",
        "Moderate-Density Residential",
        {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 30,
          min_lot_depth_ft: 100,
          max_building_coverage_pct: 35,
        },
        [
          "R-3 includes lower-density building types and multifamily or mid-rise development. Coverage, impervious coverage, lot, side-yard and height fields that vary by building type remain blank.",
        ]
      ),
      articleSpecificDistrict(
        "C-1",
        "General Business",
        "the C-1 district table and its separate commercial, residential, townhouse and institutional rows"
      ),
      articleSpecificDistrict(
        "C1-A",
        "Limited Mixed Use",
        "the C1-A provisions and the applicable C-1 use row"
      ),
      articleSpecificDistrict(
        "C1-B",
        "Limited Mixed Use, Bergenline Avenue",
        "the C1-B provisions and the applicable C-1 use row"
      ),
      articleSpecificDistrict(
        "C1-C",
        "Mixed Use",
        "the C1-C provisions and the applicable C-1 use row"
      ),
      articleSpecificDistrict(
        "C-2",
        "Highway Business",
        "the C-2 table, whose standards differ among commercial, hotel, office, shopping-center and other uses"
      ),
      verifiedDistrict("I", "Industrial", {
        front_yard_min_ft: 20,
        rear_yard_min_ft: 40,
        side_yard_one_min_ft: 15,
        min_lot_area_sqft: 20000,
        min_lot_width_ft: 150,
        min_lot_depth_ft: 100,
        max_building_coverage_pct: 30,
        max_impervious_coverage_pct: 90,
        max_height_ft: 40,
      }),
      articleSpecificDistrict(
        "P-1",
        "Waterfront/Riverside",
        "the P-1 waterfront table, which has separate standards by development and use type"
      ),
      articleSpecificDistrict(
        "P-2",
        "Waterfront/Edgecliff",
        "the P-2 waterfront table, which has separate standards by development and use type"
      ),
    ],
  },
  {
    municipality: "Union City",
    stateCode: "NJ",
    title: "Union City Code § 223-34 and Schedule of Bulk Regulations (§ 223-39)",
    sourceUrl: "https://ecode360.com/45711666",
    districts: [
      verifiedDistrict(
        "R",
        "Residential",
        {
          front_yard_min_ft: 7,
          rear_yard_min_ft: 20,
          side_yard_one_min_ft: 2,
          side_yard_total_min_ft: 5,
          min_lot_area_sqft: 2500,
          min_lot_width_ft: 25,
          min_lot_depth_ft: 100,
          front_yard_prevailing_rule: true,
          max_building_coverage_pct: 65,
          max_impervious_coverage_pct: 95,
          max_stories: 3,
          max_height_ft: 38,
        },
        [
          "The front yard is seven feet or the prevailing setback, whichever is greater.",
        ]
      ),
      verifiedDistrict(
        "C-N",
        "Neighborhood Commercial",
        {
          front_yard_min_ft: 0,
          rear_yard_min_ft: 20,
          min_lot_area_sqft: 2500,
          min_lot_width_ft: 25,
          min_lot_depth_ft: 100,
          max_building_coverage_pct: 80,
          max_impervious_coverage_pct: 100,
          max_stories: 4,
          max_height_ft: 45,
        },
        [
          "A side yard is zero feet, or five feet when one is provided; that conditional requirement remains blank.",
        ]
      ),
      verifiedDistrict(
        "MU",
        "Multiple Use",
        {
          front_yard_min_ft: 10,
          rear_yard_min_ft: 25,
          min_lot_depth_ft: 100,
          front_yard_prevailing_rule: true,
        },
        [
          "MU lot, width, side-yard, coverage, story and height standards differ among low-rise multifamily, four-to-six-story multifamily and other uses.",
        ]
      ),
      verifiedDistrict(
        "P",
        "Public",
        { front_yard_min_ft: 10, rear_yard_min_ft: 25 },
        [
          "Public, age-restricted and affordable-housing uses have different lot, side-yard, coverage and height standards; only their common front and rear setbacks are filled.",
        ]
      ),
      verifiedDistrict("P-A", "Parks-Air Rights", {
        front_yard_min_ft: 10,
        rear_yard_min_ft: 25,
        side_yard_one_min_ft: 10,
        side_yard_total_min_ft: 20,
        max_impervious_coverage_pct: 50,
        max_stories: 1,
        max_height_ft: 20,
      }),
      articleSpecificDistrict("D-BG", "Bus Garage Redevelopment", "the adopted Bus Garage redevelopment plan"),
      articleSpecificDistrict("D-RS-A", "Roosevelt Stadium Redevelopment", "the adopted Roosevelt Stadium redevelopment plan"),
      articleSpecificDistrict("D-RS-B", "Roosevelt Stadium Redevelopment", "the adopted Roosevelt Stadium redevelopment plan"),
      articleSpecificDistrict("D-RS-S", "Roosevelt Stadium Redevelopment", "the adopted Roosevelt Stadium redevelopment plan"),
      articleSpecificDistrict("D-ST", "Swiss Town Redevelopment", "the adopted Swiss Town redevelopment plan"),
      articleSpecificDistrict("D-Y", "Yardley Building Redevelopment", "the adopted Yardley Building redevelopment plan"),
      articleSpecificDistrict("8th Street", "Redevelopment", "the adopted 8th Street redevelopment plan"),
      articleSpecificDistrict("HPOD", "Historic Preservation Overlay District", "§ 223-34 and the underlying R District standards"),
      articleSpecificDistrict("PPOD", "Palisades Preservation Overlay District", "§ 223-42H and the underlying zoning district"),
    ],
  },
  {
    municipality: "Parsippany-Troy Hills",
    stateCode: "NJ",
    title: "Parsippany-Troy Hills Code § 430-4 and Schedule of Area, Yard and Building Requirements",
    sourceUrl: "https://ecode360.com/5102732",
    districts: [
      verifiedDistrict(
        "R-R",
        "Residential District",
        parsippanyBulkRules(80000, 200, 50, 20, 50, 20, 10, 2.5, 35, 20),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      verifiedDistrict(
        "R-1",
        "Residential District",
        parsippanyBulkRules(40000, 200, 50, 20, 50, 20, 10, 2.5, 35, 20),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      verifiedDistrict(
        "R-1M",
        "Residential Mixed Use Option District",
        parsippanyBulkRules(40000, 200, 50, 20, 50, 20, 10, 2.5, 35, 20),
        ["The base schedule permits 2.5 stories; mixed-use option standards and modifications must also be reviewed."]
      ),
      verifiedDistrict(
        "R-1M(r)",
        "Mixed Residential Option District",
        parsippanyBulkRules(40000, 200, 50, 20, 50, 20, 10, 2.5, 35, 20),
        ["The base schedule permits 2.5 stories; mixed-residential option standards and modifications must also be reviewed."]
      ),
      verifiedDistrict(
        "R-2",
        "Residential District",
        parsippanyBulkRules(30000, 150, 50, 12, 25, 20, 10, 2.5, 35, 20),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      verifiedDistrict(
        "R-2M",
        "Residential Mixed Use Option District",
        parsippanyBulkRules(30000, 150, 50, 12, 25, 20, 10, 2.5, 35, 20),
        ["The base schedule permits 2.5 stories; mixed-use option standards and modifications must also be reviewed."]
      ),
      verifiedDistrict(
        "R-3",
        "Residential District",
        parsippanyBulkRules(15000, 100, 40, 10, 20, 20, 15, 2.5, 35, 30),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      verifiedDistrict(
        "R-3 (RCA)",
        "Residential District",
        parsippanyBulkRules(6000, 60, 25, 6, 12, 20, 30, 2.5, 35, 40),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      verifiedDistrict(
        "R-3A (RCA)",
        "Residential District",
        parsippanyBulkRules(6000, 60, 25, 6, 12, 20, 30, 2.5, 35, 40),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      verifiedDistrict(
        "R-4",
        "Residential District",
        parsippanyBulkRules(6000, 60, 25, 6, 12, 20, 20, 2.5, 35, 40),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      verifiedDistrict("R-5", "Residential District", parsippanyBulkRules(217800, 200, 50, 25, 50, 20, 20, 2, 35, 75)),
      verifiedDistrict("B-1", "Highway Commercial District", parsippanyBulkRules(120000, 200, 80, 25, 50, 50, 20, 3, 35, 80)),
      verifiedDistrict("B-2", "Highway Development District", parsippanyBulkRules(40000, 200, 50, 10, 25, 30, 20, 2, 35, 90)),
      verifiedDistrict("B-2A", "Limited Highway Development District", parsippanyBulkRules(40000, 200, 50, 10, 25, 30, 20, 2, 35, 90)),
      verifiedDistrict("B-3", "Local Business District", parsippanyBulkRules(20000, 100, 50, 10, 25, 15, 25, 2, 35, 75)),
      verifiedDistrict("B-3A", "Local Business-A District", parsippanyBulkRules(20000, 100, 50, 10, 25, 15, 18, 2, 35, 54)),
      verifiedDistrict("B-4", "Local Business District", parsippanyBulkRules(8000, 80, 35, 5, 15, 15, 30, 2, 35, 80)),
      articleSpecificDistrict("B-5", "Local Business District", "the B-5 row of Attachment 2 and its use-specific footnotes"),
      verifiedDistrict("O-S", "Office-Service District", parsippanyBulkRules(8000, 80, 35, 5, 15, 15, 30, 2, 35, 80)),
      articleSpecificDistrict("SED", "Specialized Economic Development Districts 3, 5 and 10", "Article XXI and the separate SED-3, SED-3A, SED-5, SED-5A and SED-10 provisions"),
      verifiedDistrict("LIW-2", "Limited Industrial Wholesale District", parsippanyBulkRules(80000, 200, 50, 25, 50, 35, 35, 2, 35, 70)),
      verifiedDistrict("LIW-5", "Limited Industrial Wholesale District", parsippanyBulkRules(217800, 300, 50, 25, 50, 35, 35, 2, 35, 60)),
      verifiedDistrict("ROL", "Research, Office and Laboratory District", parsippanyBulkRules(217800, 300, 100, 50, 100, 40, 30, 3, 45, 70)),
      articleSpecificDistrict("POD", "Planned Office District", "§ 430-155 and the approved planned-office development"),
      verifiedDistrict("O-1", "Office Professional District", parsippanyBulkRules(40000, 200, 50, 20, 40, 25, 20, 2, 35, 75)),
      verifiedDistrict("O-2", "Office Professional District", parsippanyBulkRules(15000, 100, 25, 10, 20, 25, 20, 2, 35, 75)),
      verifiedDistrict("O-3", "Office Professional District", parsippanyBulkRules(120000, 250, 80, 25, 50, 25, 30, 3, 45, 75)),
      verifiedDistrict(
        "RCW",
        "Recreation, Conservation and Wildlife District",
        parsippanyBulkRules(217800, 250, 180, 20, 50, 100, 5, 2.5, 35, 15),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      articleSpecificDistrict("PRD", "Planned Residential Development District", "Article XXIX and the approved planned-residential development"),
      verifiedDistrict(
        "O-T",
        "Office Transitional District",
        parsippanyBulkRules(217800, 300, 50, 25, 50, 75, 15, 2.5, 35, 60),
        ["The schedule permits 2.5 stories. Max Stories remains blank; the 35-foot height is filled."]
      ),
      articleSpecificDistrict("PRD-2", "Planned Residential Development 2 District", "Article XXXI and the approved PRD-2 development"),
      articleSpecificDistrict("COD", "Corporation Office District", "Article XXXIII and § 430-236"),
      articleSpecificDistrict("AHD No. 1", "Affordable Housing District No. 1", "Article XXXIV and § 430-250"),
      articleSpecificDistrict("AHD No. 2", "Affordable Housing District No. 2", "Article XXXIV and § 430-250"),
      articleSpecificDistrict("PRD-3", "Planned Residential Development and Open Space District", "Article XLIV and the approved PRD-3 development"),
      articleSpecificDistrict("RC", "Planned Retail/Commercial District", "Article XLV"),
      articleSpecificDistrict("AHD-MU", "Affordable Housing Mixed Use District", "Article XLVII"),
      articleSpecificDistrict("AHD-MU2", "Affordable Housing Mixed Use District 2", "Article XLVIIA"),
      articleSpecificDistrict("AHD-3A", "Affordable Housing District", "Article XLVIII"),
      articleSpecificDistrict("AHD-3B", "Affordable Housing District", "Article XLIX"),
      articleSpecificDistrict("AHD-4", "Affordable Housing District", "Article L"),
      articleSpecificDistrict("AHD-5", "Affordable Housing District", "Article LI"),
      articleSpecificDistrict("AHD-6", "Affordable Housing District", "Article LII"),
      articleSpecificDistrict("AHD-7", "Affordable Housing District", "Article LIII"),
      articleSpecificDistrict("AHD-8", "Affordable Housing District", "Article LIIIA"),
      articleSpecificDistrict("AHD-9", "Affordable Housing District", "Article LIIIB"),
      articleSpecificDistrict("AHD-10", "Affordable Housing District", "Article LIIIC"),
      articleSpecificDistrict("AHD-11", "Affordable Housing District", "Article LIIID"),
      articleSpecificDistrict("AHD-12", "Affordable Housing District", "Article LIIIE"),
      articleSpecificDistrict("OVL-1", "Overlay District-1", "Article LIV and the underlying zoning district"),
      articleSpecificDistrict("OVL-2", "Overlay District", "Article LV and the underlying zoning district"),
      articleSpecificDistrict("OVL-3", "Overlay District", "Article LVI and the underlying zoning district"),
      articleSpecificDistrict("OVL-4", "Overlay District", "Article LVII and the underlying zoning district"),
      articleSpecificDistrict("OVL-5", "Overlay District", "Article LVIII and the underlying zoning district"),
      articleSpecificDistrict("OVL-6", "Overlay District", "Article LIX and the underlying zoning district"),
      articleSpecificDistrict("OVL-8A", "Affordable Housing District", "Article LXIIIA and the underlying zoning district"),
    ],
  },
];

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+(CITY|TWP|TOWNSHIP|BORO|BOROUGH|VILLAGE)$/, "");

export function municipalZoningCatalogFor(municipality, stateCode) {
  const name = normalize(municipality);
  const state = String(stateCode ?? "").trim().toUpperCase();
  return (
    CATALOGS.find(
      (catalog) => normalize(catalog.municipality) === name && catalog.stateCode === state
    ) ?? null
  );
}

export function catalogDistrictFor(municipality, stateCode, districtCode) {
  const catalog = municipalZoningCatalogFor(municipality, stateCode);
  const code = String(districtCode ?? "").trim().toUpperCase().replace(/[\s._\-/]+/g, "");
  return (
    catalog?.districts.find(
      (district) => district.code.toUpperCase().replace(/[\s._\-/]+/g, "") === code
    ) ?? null
  );
}
