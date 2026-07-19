-- 0004_parcels.sql
-- Parcel polygons from NJGIN "Parcels and MOD-IV Composite of NJ".
--
-- SRID choice -- this matters a lot
-- --------------------------------
-- We store the working geometry in EPSG:3424 (NAD83 / New Jersey State Plane,
-- US survey FEET), NOT in 4326 (lat/lon degrees).
--
-- Why: the core algorithm is "inset the polygon by the setbacks in feet."
-- In a feet-based projected CRS that is literally ST_Buffer(geom, -setback_ft)
-- with no reprojection, and ST_Area(geom) comes back in square feet -- the
-- exact units zoning uses. If we stored 4326 we'd be transforming on every
-- calculation and doing area math in degrees. Store projected, compute cheap.
--
-- For web display we expose a 4326 version via ST_Transform in the API layer;
-- we don't store it.
--
-- (For an out-of-state town like Palm Beach Gardens, FL you'd load its parcels
--  in the appropriate state plane, e.g. EPSG:2236, and store the SRID per row.
--  Keeping `geom` generic-SRID-aware via the srid column keeps us nationwide-safe.)
--
-- Privacy: owner names are redacted in the public NJGIN release under Daniel's
-- Law. We don't need them and we do not store them. Do not add an owner column.

CREATE TABLE IF NOT EXISTS parcels (
    id                  bigserial PRIMARY KEY,

    -- PAMS_PIN links a parcel polygon to its MOD-IV tax record. NOTE: the
    -- public data contains duplicate PINs, so this is intentionally NOT unique.
    -- Dedup happens in the import step (scripts/), not via a DB constraint.
    pams_pin            text,

    municipality_id     integer REFERENCES municipalities(id),
    county              text,

    -- Working geometry in NJ State Plane feet (see header). MultiPolygon
    -- because some parcels come through as multipart.
    geom                geometry(MultiPolygon, 3424),

    -- Lot metrics. lot_area_sqft is authoritative from MOD-IV when present,
    -- otherwise computed from the polygon on import.
    lot_area_sqft       numeric,
    lot_frontage_ft     numeric,
    lot_depth_ft        numeric,

    -- If a client uploads a real survey we let them override the derived
    -- dimensions and mark the answer survey-confirmed in the UI.
    is_survey_confirmed boolean NOT NULL DEFAULT false,

    -- Raw MOD-IV attributes (minus anything redacted) kept for traceability.
    mod_iv              jsonb NOT NULL DEFAULT '{}'::jsonb,

    imported_at         timestamptz NOT NULL DEFAULT now()
);

-- Spatial index -- required for any real query performance on geometry.
CREATE INDEX IF NOT EXISTS idx_parcels_geom ON parcels USING gist (geom);
-- PIN is a lookup key even though it's non-unique.
CREATE INDEX IF NOT EXISTS idx_parcels_pin  ON parcels (pams_pin);
CREATE INDEX IF NOT EXISTS idx_parcels_muni ON parcels (municipality_id);
