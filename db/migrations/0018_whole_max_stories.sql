-- Max Stories is a count of whole floors. A separate max_height_ft field is
-- the total permitted building height, so fractional story counts add an
-- unnecessary second interpretation of the same vertical limit.

UPDATE zoning_districts
SET
    max_stories = CEIL(
        COALESCE(
            NULLIF(extra_rules ->> 'max_stories_exact', '')::numeric,
            max_stories
        )
    ),
    extra_rules = extra_rules - 'max_stories_exact'
WHERE
    max_stories IS NOT NULL
    OR NULLIF(extra_rules ->> 'max_stories_exact', '') IS NOT NULL;

ALTER TABLE zoning_districts
    DROP CONSTRAINT IF EXISTS zoning_districts_max_stories_whole;

ALTER TABLE zoning_districts
    ADD CONSTRAINT zoning_districts_max_stories_whole
    CHECK (max_stories IS NULL OR max_stories = TRUNC(max_stories));

COMMENT ON COLUMN zoning_districts.max_stories IS
    'Maximum whole floors; max_height_ft is the total building-height limit.';
