-- 0002_core_zoning.sql
-- The "one common schema any town loads into" that the kickoff calls the
-- highest-leverage decision in the project.
--
-- Design notes
-- ------------
-- 1. A town has MANY zoning districts (R, R-1, C, ...). Rules live at the
--    district level, not the town level, so the buildability check is always
--    run against a specific district.
-- 2. The columns below are the COMMON fields the rules engine always reads:
--    setbacks, coverage %, height, stories, min lot size, FAR. The engine
--    contains zero town-specific logic -- it just reads these columns.
-- 3. Real ordinances have oddities that don't fit fixed columns (prevailing
--    front-yard rules, NJ Highlands Act overlays, corner-lot exceptions).
--    Rather than let one weird town break the schema, those go in the
--    `extra_rules` JSONB escape hatch. This is exactly what lets Bryan's
--    "discover what the schema is missing" work land without a migration
--    every time a strange town shows up.

CREATE TABLE IF NOT EXISTS states (
    code  char(2) PRIMARY KEY,          -- 'NJ', 'FL'
    name  text NOT NULL
);

CREATE TABLE IF NOT EXISTS municipalities (
    id           serial PRIMARY KEY,
    state_code   char(2) NOT NULL REFERENCES states(code),
    name         text NOT NULL,          -- 'Union City'
    slug         text NOT NULL,          -- 'union-city-nj'  (matches config filename)
    county       text,                   -- 'Hudson'
    last_updated date,                   -- when the zoning data was last verified
    source_url   text,                   -- link to the ordinance we transcribed
    -- Overlay flags for things like the NJ Highlands Act that layer on top of
    -- local zoning. Kept as JSONB so Sparta/Hopatcong don't need new columns.
    overlays     jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (state_code, name),
    UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS zoning_districts (
    id                  serial PRIMARY KEY,
    municipality_id     integer NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
    code                text NOT NULL,          -- 'R'
    name                text,                   -- 'Residential District'
    permitted_uses      text[] NOT NULL DEFAULT '{}',
    notes               text,

    -- Lot minimums
    min_lot_area_sqft   numeric,
    min_lot_width_ft    numeric,
    min_lot_depth_ft    numeric,

    -- Setbacks (feet). front_yard_prevailing_rule means the required front
    -- setback is the prevailing average of the block, not a fixed number --
    -- the engine treats `front_yard_min_ft` as the floor in that case.
    front_yard_min_ft            numeric,
    front_yard_prevailing_rule   boolean NOT NULL DEFAULT false,
    side_yard_one_min_ft         numeric,   -- minimum for a single side yard
    side_yard_total_min_ft       numeric,   -- minimum for both sides combined
    rear_yard_min_ft             numeric,

    -- Height
    max_height_ft       numeric,
    max_stories         integer,

    -- Coverage (percent of lot area, 0-100)
    max_building_coverage_pct     numeric CHECK (max_building_coverage_pct BETWEEN 0 AND 100),
    max_impervious_coverage_pct   numeric CHECK (max_impervious_coverage_pct BETWEEN 0 AND 100),

    -- Floor Area Ratio -- null where the town doesn't use it
    max_far             numeric,

    -- Escape hatch for town-specific rules that don't fit above.
    extra_rules         jsonb NOT NULL DEFAULT '{}'::jsonb,

    UNIQUE (municipality_id, code)
);

CREATE INDEX IF NOT EXISTS idx_zoning_districts_muni
    ON zoning_districts (municipality_id);
