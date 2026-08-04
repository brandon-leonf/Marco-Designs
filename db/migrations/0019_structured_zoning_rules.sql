-- 0019_structured_zoning_rules.sql
-- Normalized, auditable zoning rules with applicability, conditions,
-- formulas, combination behavior, priority, and source provenance.

CREATE TABLE IF NOT EXISTS zoning_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    municipality_id     integer NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
    district_id         integer NOT NULL REFERENCES zoning_districts(id) ON DELETE CASCADE,
    category            text NOT NULL CHECK (category IN (
        'SETBACK', 'FAR', 'BUILDING_COVERAGE', 'IMPERVIOUS_COVERAGE',
        'HEIGHT', 'STORIES', 'LOT_AREA', 'LOT_WIDTH', 'LOT_DEPTH', 'PERMITTED_USE'
    )),
    applies_to          text NOT NULL CHECK (applies_to IN (
        'PRINCIPAL_BUILDING', 'ACCESSORY_BUILDING', 'GARAGE', 'DECK',
        'POOL', 'ALL_STRUCTURES'
    )),
    side                text CHECK (side IS NULL OR side IN (
        'FRONT', 'REAR', 'LEFT', 'RIGHT', 'EACH_SIDE', 'COMBINED_SIDE'
    )),
    rule_type           text NOT NULL CHECK (rule_type IN (
        'FIXED', 'PERCENTAGE', 'FORMULA', 'CONDITIONAL', 'PIECEWISE', 'NEIGHBOR_AVERAGE'
    )),
    condition           jsonb,
    calculation         jsonb NOT NULL,
    combine_method      text NOT NULL CHECK (combine_method IN ('MAX', 'MIN', 'REPLACE', 'ADD')),
    priority            integer NOT NULL DEFAULT 100,
    source_section      text NOT NULL,
    source_url          text,
    effective_date      date,
    expiration_date     date,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(calculation) = 'object'),
    CHECK (calculation ? 'unit'),
    CHECK (calculation ? 'value' OR calculation ? 'formula'),
    CHECK (calculation ->> 'unit' IN ('FT', 'SQFT', 'PERCENT', 'RATIO', 'STORIES')),
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
    CHECK (condition IS NULL OR (
        condition ? 'metric' AND condition ? 'operator' AND condition ? 'value'
        AND condition ->> 'operator' IN ('>', '>=', '<', '<=', '=', 'BETWEEN')
        AND (
            condition ->> 'operator' <> 'BETWEEN'
            OR condition ? 'secondValue'
        )
    )),
    CHECK ((category = 'SETBACK' AND side IS NOT NULL) OR (category <> 'SETBACK' AND side IS NULL)),
    CHECK (expiration_date IS NULL OR effective_date IS NULL OR expiration_date >= effective_date)
);

CREATE OR REPLACE FUNCTION enforce_zoning_rule_district_municipality()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM zoning_districts d
        WHERE d.id = NEW.district_id
          AND d.municipality_id = NEW.municipality_id
    ) THEN
        RAISE EXCEPTION 'District % does not belong to municipality %',
            NEW.district_id, NEW.municipality_id;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS zoning_rule_district_municipality ON zoning_rules;
CREATE TRIGGER zoning_rule_district_municipality
BEFORE INSERT OR UPDATE OF municipality_id, district_id ON zoning_rules
FOR EACH ROW EXECUTE FUNCTION enforce_zoning_rule_district_municipality();

CREATE INDEX IF NOT EXISTS idx_zoning_rules_district_priority
    ON zoning_rules (district_id, priority, id);

ALTER TABLE zoning_rules ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT SELECT ON zoning_rules TO anon, authenticated;
        GRANT INSERT, UPDATE, DELETE ON zoning_rules TO authenticated;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'zoning_rules'
          AND policyname = 'read_only_api'
    ) THEN
        EXECUTE 'CREATE POLICY read_only_api ON zoning_rules
                 FOR SELECT TO public USING (true)';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'zoning_rules'
              AND policyname = 'admin_insert'
        ) THEN
            EXECUTE 'CREATE POLICY admin_insert ON zoning_rules
                     FOR INSERT TO authenticated
                     WITH CHECK (public.is_config_admin())';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'zoning_rules'
              AND policyname = 'admin_write'
        ) THEN
            EXECUTE 'CREATE POLICY admin_write ON zoning_rules
                     FOR UPDATE TO authenticated
                     USING (public.is_config_admin()) WITH CHECK (public.is_config_admin())';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'zoning_rules'
              AND policyname = 'admin_delete'
        ) THEN
            EXECUTE 'CREATE POLICY admin_delete ON zoning_rules
                     FOR DELETE TO authenticated USING (public.is_config_admin())';
        END IF;
    END IF;
END
$do$;

-- Publish one district's normalized rule set atomically. A failed insert rolls
-- the delete back, so an admin can never lose the currently published rules
-- because one new row was malformed.
CREATE OR REPLACE FUNCTION admin_replace_zoning_rules(
    p_municipality_id integer,
    p_district_id integer,
    p_rules jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
    published_count integer;
BEGIN
    IF jsonb_typeof(COALESCE(p_rules, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION 'Rules must be a JSON array';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM zoning_districts
        WHERE id = p_district_id AND municipality_id = p_municipality_id
    ) THEN
        RAISE EXCEPTION 'District % does not belong to municipality %',
            p_district_id, p_municipality_id;
    END IF;

    DELETE FROM zoning_rules WHERE district_id = p_district_id;

    INSERT INTO zoning_rules (
        id, municipality_id, district_id, category, applies_to, side,
        rule_type, condition, calculation, combine_method, priority,
        source_section, source_url, effective_date, expiration_date
    )
    SELECT
        COALESCE(NULLIF(item ->> 'id', '')::uuid, gen_random_uuid()),
        p_municipality_id,
        p_district_id,
        item ->> 'category',
        item ->> 'applies_to',
        NULLIF(item ->> 'side', ''),
        item ->> 'rule_type',
        NULLIF(item -> 'condition', 'null'::jsonb),
        item -> 'calculation',
        item ->> 'combine_method',
        COALESCE((item ->> 'priority')::integer, 100),
        item ->> 'source_section',
        NULLIF(item ->> 'source_url', ''),
        NULLIF(item ->> 'effective_date', '')::date,
        NULLIF(item ->> 'expiration_date', '')::date
    FROM jsonb_array_elements(COALESCE(p_rules, '[]'::jsonb)) item;

    GET DIAGNOSTICS published_count = ROW_COUNT;
    RETURN published_count;
END
$function$;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT EXECUTE ON FUNCTION admin_replace_zoning_rules(integer, integer, jsonb)
            TO authenticated;
    END IF;
END
$do$;

-- Backfill every currently published flat rule into its normalized form.
INSERT INTO zoning_rules (
    municipality_id, district_id, category, applies_to, side, rule_type,
    calculation, combine_method, priority, source_section, source_url
)
SELECT d.municipality_id, d.id, seed.category, 'PRINCIPAL_BUILDING', seed.side,
       seed.rule_type, seed.calculation, seed.combine_method, seed.priority,
       'Published district dimensional rules', m.source_url
FROM zoning_districts d
JOIN municipalities m ON m.id = d.municipality_id
CROSS JOIN LATERAL (
    VALUES
      ('SETBACK', 'FRONT', CASE WHEN d.front_yard_prevailing_rule THEN 'NEIGHBOR_AVERAGE' ELSE 'FIXED' END,
       CASE WHEN d.front_yard_min_ft IS NULL THEN NULL ELSE jsonb_build_object('value', d.front_yard_min_ft, 'unit', 'FT') END, 'MAX', 100),
      ('SETBACK', 'REAR', 'FIXED',
       CASE WHEN d.rear_yard_min_ft IS NULL THEN NULL ELSE jsonb_build_object('value', d.rear_yard_min_ft, 'unit', 'FT') END, 'MAX', 100),
      ('SETBACK', 'EACH_SIDE', 'FIXED',
       CASE WHEN d.side_yard_one_min_ft IS NULL THEN NULL ELSE jsonb_build_object('value', d.side_yard_one_min_ft, 'unit', 'FT') END, 'MAX', 100),
      ('SETBACK', 'COMBINED_SIDE', 'FIXED',
       CASE WHEN d.side_yard_total_min_ft IS NULL THEN NULL ELSE jsonb_build_object('value', d.side_yard_total_min_ft, 'unit', 'FT') END, 'MAX', 100),
      ('FAR', NULL, 'PERCENTAGE',
       CASE WHEN d.max_far IS NULL THEN NULL ELSE jsonb_build_object('value', d.max_far, 'unit', 'RATIO') END, 'MIN', 100),
      ('BUILDING_COVERAGE', NULL, 'PERCENTAGE',
       CASE WHEN d.max_building_coverage_pct IS NULL THEN NULL ELSE jsonb_build_object('value', d.max_building_coverage_pct, 'unit', 'PERCENT') END, 'MIN', 100),
      ('IMPERVIOUS_COVERAGE', NULL, 'PERCENTAGE',
       CASE WHEN d.max_impervious_coverage_pct IS NULL THEN NULL ELSE jsonb_build_object('value', d.max_impervious_coverage_pct, 'unit', 'PERCENT') END, 'MIN', 100),
      ('HEIGHT', NULL, 'FIXED',
       CASE WHEN d.max_height_ft IS NULL THEN NULL ELSE jsonb_build_object('value', d.max_height_ft, 'unit', 'FT') END, 'MIN', 100),
      ('STORIES', NULL, 'FIXED',
       CASE WHEN d.max_stories IS NULL THEN NULL ELSE jsonb_build_object('value', d.max_stories, 'unit', 'STORIES') END, 'MIN', 100),
      ('LOT_AREA', NULL, 'FIXED',
       CASE WHEN d.min_lot_area_sqft IS NULL THEN NULL ELSE jsonb_build_object('value', d.min_lot_area_sqft, 'unit', 'SQFT') END, 'MAX', 100),
      ('LOT_WIDTH', NULL, 'FIXED',
       CASE WHEN d.min_lot_width_ft IS NULL THEN NULL ELSE jsonb_build_object('value', d.min_lot_width_ft, 'unit', 'FT') END, 'MAX', 100),
      ('LOT_DEPTH', NULL, 'FIXED',
       CASE WHEN d.min_lot_depth_ft IS NULL THEN NULL ELSE jsonb_build_object('value', d.min_lot_depth_ft, 'unit', 'FT') END, 'MAX', 100)
) AS seed(category, side, rule_type, calculation, combine_method, priority)
WHERE seed.calculation IS NOT NULL;

-- Allendale AAA: side yard is the greatest applicable result among the base,
-- gross-area formula, and the over-5,000-square-foot minimum.
INSERT INTO zoning_rules (
    municipality_id, district_id, category, applies_to, side, rule_type,
    condition, calculation, combine_method, priority, source_section, source_url
)
SELECT m.id, d.id, 'SETBACK', 'PRINCIPAL_BUILDING', 'EACH_SIDE', 'CONDITIONAL',
       jsonb_build_object('metric', 'GROSS_BUILDING_AREA', 'operator', '>', 'value', 3000),
       jsonb_build_object('formula', 'grossBuildingArea * 0.008', 'unit', 'FT'),
       'MAX', 200, 'AAA side-yard gross-area rule', m.source_url
FROM municipalities m
JOIN zoning_districts d ON d.municipality_id = m.id AND upper(d.code) = 'AAA'
WHERE upper(m.name) LIKE 'ALLENDALE%';

INSERT INTO zoning_rules (
    municipality_id, district_id, category, applies_to, side, rule_type,
    condition, calculation, combine_method, priority, source_section, source_url
)
SELECT m.id, d.id, 'SETBACK', 'PRINCIPAL_BUILDING', 'EACH_SIDE', 'CONDITIONAL',
       jsonb_build_object('metric', 'GROSS_BUILDING_AREA', 'operator', '>', 'value', 5000),
       jsonb_build_object('value', 40, 'unit', 'FT'),
       'MAX', 300, 'AAA side-yard over-5,000-sq-ft minimum', m.source_url
FROM municipalities m
JOIN zoning_districts d ON d.municipality_id = m.id AND upper(d.code) = 'AAA'
WHERE upper(m.name) LIKE 'ALLENDALE%';

COMMENT ON TABLE zoning_rules IS
    'Normalized zoning rules evaluated by applicability, condition, formula, combination method, and priority.';
