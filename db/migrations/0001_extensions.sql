-- 0001_extensions.sql
-- Enable the extensions the project depends on.
--
-- postgis      : geometry types + spatial functions (ST_Buffer, ST_Area, ...)
--                This is what lets us inset a parcel polygon by the setbacks
--                to get the buildable envelope, entirely in the database.
-- pgcrypto     : gen_random_uuid(), in case we want UUID keys later.
--
-- Everything here is idempotent, so re-running a migration set on a database
-- that already has some of this (Brandon's earlier setup) is safe.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A tiny table we use to record which migrations have run.
-- The loader/CI check this so we never apply a file twice.
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);
