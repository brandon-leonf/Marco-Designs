-- 0005_geometry_functions.sql
-- Reference geometry functions. Their job in THIS phase is to prove the
-- PostGIS pipeline is wired up and returns correct answers -- they are the
-- "PostGIS is configured and ready" deliverable, not the finished rules
-- engine (that's week 2, and largely Jorge's piece).
--
-- SCOPE NOTE: buildable_envelope() below uses a single uniform inset. Real
-- setbacks differ per edge (front vs side vs rear), which needs per-edge
-- offsetting and is the engine's job. Using the SMALLEST setback here is the
-- conservative choice -- it never overstates buildable area -- and it's enough
-- to validate that the geometry, projection, and units are all correct.

-- Inset a parcel polygon uniformly by `inset_ft` feet.
-- Because parcels are stored in EPSG:3424 (US survey feet), the negative
-- buffer distance is already in feet -- no reprojection needed.
CREATE OR REPLACE FUNCTION buildable_envelope(parcel_geom geometry, inset_ft double precision)
RETURNS geometry
LANGUAGE sql IMMUTABLE
AS $$
    SELECT ST_Buffer(parcel_geom, -inset_ft);
$$;

-- Max footprint = the SMALLER of:
--   (a) the buildable envelope's area, and
--   (b) lot area * max building coverage %.
-- Whichever binds first wins -- straight from the kickoff's core algorithm.
CREATE OR REPLACE FUNCTION max_footprint_sqft(
    envelope_geom            geometry,
    lot_area_sqft            double precision,
    max_building_coverage_pct double precision
)
RETURNS double precision
LANGUAGE sql IMMUTABLE
AS $$
    SELECT LEAST(
        ST_Area(envelope_geom),
        lot_area_sqft * (max_building_coverage_pct / 100.0)
    );
$$;

-- Max buildable SF = max footprint * allowable stories.
-- (Height cap and FAR are applied in the engine; this is the multiplier step.)
CREATE OR REPLACE FUNCTION max_buildable_sqft(
    footprint_sqft double precision,
    max_stories    integer
)
RETURNS double precision
LANGUAGE sql IMMUTABLE
AS $$
    SELECT footprint_sqft * COALESCE(max_stories, 1);
$$;
