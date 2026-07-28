-- 0014_parcel_geojson_wgs84.sql
-- Give parcel_envelope a web-map projection alongside the working one.
--
-- The function returns geometry in EPSG:3424 (NJ State Plane feet), which is
-- what the envelope arithmetic and the SVG plan drawing need — 0007's own
-- comment noted that "a slippy-map view would ask for ST_Transform(geom, 4326)
-- instead". The zoning map is that view: handed State Plane coordinates it
-- reads 600000, 700000 as a latitude and longitude and flies off to open
-- water.
--
-- Rather than reproject in the browser, the function now returns both: feet
-- for the diagram, degrees for the map, from one round trip. The 3424 columns
-- are unchanged, so existing callers keep working.
--
-- CREATE OR REPLACE cannot alter a function's return type, so this drops and
-- recreates. Both statements run inside the migration's transaction, so no
-- request can observe the function missing.

DROP FUNCTION IF EXISTS parcel_envelope(bigint, double precision);

CREATE FUNCTION parcel_envelope(p_parcel_id bigint, p_inset_ft double precision)
RETURNS TABLE (
    parcel_id          bigint,
    pams_pin           text,
    address            text,
    block              text,
    lot                text,
    prop_class         text,
    year_built         text,
    land_desc          text,
    lot_area_sqft      numeric,
    lot_frontage_ft    numeric,
    lot_depth_ft       numeric,
    is_survey_confirmed boolean,
    parcel_geojson     json,   -- EPSG:3424, feet
    envelope_geojson   json,   -- EPSG:3424, feet; null when setbacks consume the lot
    envelope_area_sqft numeric,
    parcel_geojson_wgs84   json,  -- EPSG:4326, for the web map
    envelope_geojson_wgs84 json   -- EPSG:4326, for the web map
)
LANGUAGE sql STABLE
AS $$
    WITH p AS (
        SELECT *, buildable_envelope(geom, p_inset_ft) AS env
        FROM parcels WHERE id = p_parcel_id
    )
    SELECT p.id, p.pams_pin,
           p.mod_iv->>'PROP_LOC',
           p.mod_iv->>'PCLBLOCK',
           p.mod_iv->>'PCLLOT',
           p.mod_iv->>'PROP_CLASS',
           p.mod_iv->>'YR_CONSTR',
           p.mod_iv->>'LAND_DESC',
           p.lot_area_sqft,
           p.lot_frontage_ft,
           p.lot_depth_ft,
           p.is_survey_confirmed,
           ST_AsGeoJSON(p.geom, 2)::json,
           CASE WHEN ST_IsEmpty(p.env) THEN NULL
                ELSE ST_AsGeoJSON(p.env, 2)::json END,
           round(ST_Area(p.env)::numeric, 1),
           -- 7 decimal places is ~1 cm: past what a parcel boundary means.
           ST_AsGeoJSON(ST_Transform(p.geom, 4326), 7)::json,
           CASE WHEN ST_IsEmpty(p.env) THEN NULL
                ELSE ST_AsGeoJSON(ST_Transform(p.env, 4326), 7)::json END
    FROM p;
$$;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT EXECUTE ON FUNCTION parcel_envelope(bigint, double precision) TO anon, authenticated;
    END IF;
END
$do$;
