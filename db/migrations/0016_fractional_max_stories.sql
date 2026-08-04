-- Zoning ordinances commonly allow a half story (for example, 2.5 stories).
-- The admin and calculation engine already accept fractional values, so keep
-- the database and reference SQL function aligned with that domain model.

ALTER TABLE zoning_districts
    ALTER COLUMN max_stories TYPE numeric
    USING max_stories::numeric;

DROP FUNCTION IF EXISTS max_buildable_sqft(double precision, integer);

CREATE OR REPLACE FUNCTION max_buildable_sqft(
    footprint_sqft double precision,
    max_stories    numeric
)
RETURNS double precision
LANGUAGE sql IMMUTABLE
AS $$
    SELECT footprint_sqft * COALESCE(max_stories, 1)::double precision;
$$;
