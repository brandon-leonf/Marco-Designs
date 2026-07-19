-- 0006_api_read_access.sql
-- Read-only API access for the React app (Supabase PostgREST / supabase-js).
--
-- Enable row-level security on every table the frontend reads and add a
-- SELECT-only policy. With RLS on and no INSERT/UPDATE/DELETE policies, the
-- anon key can read zoning and cost data but can never write anything --
-- all writes keep going through scripts/load_town.py as the postgres owner
-- (table owners bypass RLS, so the loader and CI are unaffected).
--
-- `TO public` makes this valid on plain Postgres in CI too, where Supabase's
-- anon/authenticated roles don't exist.

ALTER TABLE states            ENABLE ROW LEVEL SECURITY;
ALTER TABLE municipalities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoning_districts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_cost_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_cost_tiers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE parcels           ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'states', 'municipalities', 'zoning_districts',
        'build_cost_models', 'build_cost_tiers', 'parcels'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = t AND policyname = 'read_only_api'
        ) THEN
            EXECUTE format(
                'CREATE POLICY read_only_api ON %I FOR SELECT TO public USING (true)', t
            );
        END IF;
    END LOOP;
END $$;
