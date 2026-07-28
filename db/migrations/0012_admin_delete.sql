-- 0012_admin_delete.sql
-- Let config admins remove a municipality or a zoning district.
--
-- The editor can create both, so it needs to undo both — a town typed by
-- mistake otherwise sits in the public dropdown forever, and the calculator
-- refuses to run on it (migration 0009 / the rules gate), which is honest but
-- not a fix.
--
-- What the cascades do, and what they deliberately do not:
--   zoning_districts, build_cost_models, build_cost_tiers, zoning_areas
--     -> ON DELETE CASCADE from municipalities. Removed with the town.
--   parcels
--     -> plain REFERENCES, no cascade. Deleting a town with imported parcels
--        raises a foreign-key violation, so the app removes them first and
--        states the count up front. Re-importing is an NJGIN round trip, not
--        a click, which is exactly why it should be said out loud.
--   zoning_areas.district_id
--     -> ON DELETE SET NULL. Deleting one district leaves its polygons
--        pointing at nothing, and resolve_parcel_zoning already reports that
--        as `rules_missing`. Degrades to "we don't know" rather than to wrong
--        rules, which is the behaviour we want.
--
-- Guarded like 0009/0010 so it stays a no-op on plain Postgres in CI.

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
        RETURN;
    END IF;

    GRANT DELETE ON municipalities, zoning_districts, parcels TO authenticated;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'municipalities'
          AND policyname = 'admin_delete'
    ) THEN
        EXECUTE 'CREATE POLICY admin_delete ON municipalities
                 FOR DELETE TO authenticated USING (public.is_config_admin())';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'zoning_districts'
          AND policyname = 'admin_delete'
    ) THEN
        EXECUTE 'CREATE POLICY admin_delete ON zoning_districts
                 FOR DELETE TO authenticated USING (public.is_config_admin())';
    END IF;

    -- Only ever exercised as the first step of deleting the town that owns them.
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'parcels'
          AND policyname = 'admin_delete'
    ) THEN
        EXECUTE 'CREATE POLICY admin_delete ON parcels
                 FOR DELETE TO authenticated USING (public.is_config_admin())';
    END IF;
END
$do$;
