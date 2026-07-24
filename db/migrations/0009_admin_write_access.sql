-- 0009_admin_write_access.sql
-- Write access for the in-app config editor (web #/admin).
--
-- Model: Supabase Auth handles sign-in; authorization is a whitelist table.
-- A signed-in user may edit zoning and cost data only when their JWT email
-- appears in admin_users. Everyone else -- including any account created
-- through Supabase signups -- stays read-only, exactly as migration 0006
-- left them.
--
-- Like 0006, everything Supabase-specific is guarded so this migration also
-- applies cleanly on plain Postgres in CI (where the auth schema and the
-- anon/authenticated roles don't exist). There the whitelist table exists
-- but no write policies are created, and writes keep going through
-- scripts/load_town.py as the table owner.

CREATE TABLE IF NOT EXISTS admin_users (
    email       text PRIMARY KEY CHECK (email = lower(email)),
    added_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Seed the owner account. Adding another admin is one INSERT in Supabase.
INSERT INTO admin_users (email)
VALUES ('leonfloresbrandon@gmail.com')
ON CONFLICT (email) DO NOTHING;

-- Supabase only: helper + policies that read the JWT.
DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
        RETURN;  -- plain Postgres (CI): no API roles, nothing to open up
    END IF;

    -- SECURITY DEFINER (runs as the table owner, which bypasses RLS) so the
    -- whitelist lookup itself doesn't recurse into admin_users policies.
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.is_config_admin()
        RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public
        AS 'SELECT EXISTS (
                SELECT 1 FROM admin_users
                WHERE email = lower(coalesce(auth.jwt() ->> ''email'', ''''))
            )'
    $fn$;

    GRANT EXECUTE ON FUNCTION public.is_config_admin() TO authenticated;

    -- The editor needs to read the whitelist (to tell a signed-in non-admin
    -- why the form is locked) and to write config tables. anon gets nothing.
    GRANT SELECT ON admin_users TO authenticated;
    GRANT UPDATE ON municipalities, zoning_districts, build_cost_models, build_cost_tiers
        TO authenticated;
    GRANT INSERT ON build_cost_models, build_cost_tiers TO authenticated;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

    -- Admins can see the whitelist; everyone else sees an empty table.
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'admin_users'
          AND policyname = 'admin_read_whitelist'
    ) THEN
        EXECUTE 'CREATE POLICY admin_read_whitelist ON admin_users
                 FOR SELECT TO authenticated USING (public.is_config_admin())';
    END IF;

    -- Config writes: UPDATE on everything the editor touches, INSERT for
    -- municipalities that don't have a cost model row yet.
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'municipalities'
          AND policyname = 'admin_write'
    ) THEN
        EXECUTE 'CREATE POLICY admin_write ON municipalities
                 FOR UPDATE TO authenticated
                 USING (public.is_config_admin()) WITH CHECK (public.is_config_admin())';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'zoning_districts'
          AND policyname = 'admin_write'
    ) THEN
        EXECUTE 'CREATE POLICY admin_write ON zoning_districts
                 FOR UPDATE TO authenticated
                 USING (public.is_config_admin()) WITH CHECK (public.is_config_admin())';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'build_cost_models'
          AND policyname = 'admin_write'
    ) THEN
        EXECUTE 'CREATE POLICY admin_write ON build_cost_models
                 FOR UPDATE TO authenticated
                 USING (public.is_config_admin()) WITH CHECK (public.is_config_admin())';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'build_cost_models'
          AND policyname = 'admin_insert'
    ) THEN
        EXECUTE 'CREATE POLICY admin_insert ON build_cost_models
                 FOR INSERT TO authenticated WITH CHECK (public.is_config_admin())';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'build_cost_tiers'
          AND policyname = 'admin_write'
    ) THEN
        EXECUTE 'CREATE POLICY admin_write ON build_cost_tiers
                 FOR UPDATE TO authenticated
                 USING (public.is_config_admin()) WITH CHECK (public.is_config_admin())';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'build_cost_tiers'
          AND policyname = 'admin_insert'
    ) THEN
        EXECUTE 'CREATE POLICY admin_insert ON build_cost_tiers
                 FOR INSERT TO authenticated WITH CHECK (public.is_config_admin())';
    END IF;
END
$do$;
