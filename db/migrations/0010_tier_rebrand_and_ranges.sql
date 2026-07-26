-- 0010_tier_rebrand_and_ranges.sql
-- Marco Designs tier rebrand + verified price ranges.
--
-- 1. Tier names become Marco's client-facing names:
--      builder_grade -> essential, mid_level -> signature, high_end -> premium
-- 2. Verified rates are a RANGE (min/max $/sq ft) with marketing notes;
--    estimated rates stay a single derived number (max/notes NULL).
--      rate_per_sqft      = the rate (estimated) or the range minimum (verified)
--      rate_per_sqft_max  = the range maximum (verified only)
-- 3. Admins can create municipalities from the config editor, so the
--    whitelist write policies (0009) gain INSERT on states, municipalities
--    and zoning_districts.
--
-- Like 0006/0009, Supabase-only pieces are guarded so this also applies
-- cleanly on plain Postgres in CI.

-- ---------------------------------------------------------------- tier names

ALTER TABLE build_cost_tiers DROP CONSTRAINT IF EXISTS build_cost_tiers_tier_check;

UPDATE build_cost_tiers SET tier = 'essential' WHERE tier = 'builder_grade';
UPDATE build_cost_tiers SET tier = 'signature' WHERE tier = 'mid_level';
UPDATE build_cost_tiers SET tier = 'premium'   WHERE tier = 'high_end';

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'build_cost_tiers_tier_check'
          AND conrelid = 'build_cost_tiers'::regclass
    ) THEN
        ALTER TABLE build_cost_tiers
            ADD CONSTRAINT build_cost_tiers_tier_check
            CHECK (tier IN ('essential', 'signature', 'premium'));
    END IF;
END
$do$;

-- ------------------------------------------------------------- range + notes

ALTER TABLE build_cost_tiers ADD COLUMN IF NOT EXISTS rate_per_sqft_max numeric;
ALTER TABLE build_cost_tiers ADD COLUMN IF NOT EXISTS notes text;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'build_cost_tiers_range_check'
          AND conrelid = 'build_cost_tiers'::regclass
    ) THEN
        ALTER TABLE build_cost_tiers
            ADD CONSTRAINT build_cost_tiers_range_check
            CHECK (rate_per_sqft_max IS NULL OR rate_per_sqft_max >= rate_per_sqft);
    END IF;
END
$do$;

-- ------------------------------------------- admin INSERT for new towns (UI)

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
        RETURN;  -- plain Postgres (CI): no API roles, nothing to open up
    END IF;

    GRANT INSERT ON states, municipalities, zoning_districts TO authenticated;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'states'
          AND policyname = 'admin_insert'
    ) THEN
        EXECUTE 'CREATE POLICY admin_insert ON states
                 FOR INSERT TO authenticated WITH CHECK (public.is_config_admin())';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'municipalities'
          AND policyname = 'admin_insert'
    ) THEN
        EXECUTE 'CREATE POLICY admin_insert ON municipalities
                 FOR INSERT TO authenticated WITH CHECK (public.is_config_admin())';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'zoning_districts'
          AND policyname = 'admin_insert'
    ) THEN
        EXECUTE 'CREATE POLICY admin_insert ON zoning_districts
                 FOR INSERT TO authenticated WITH CHECK (public.is_config_admin())';
    END IF;
END
$do$;
