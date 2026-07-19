-- 0007_parcel_api.sql
-- Read-only RPC functions the React app calls through PostgREST
-- (supabase.rpc(...)). Both run as the caller, so the RLS SELECT-only
-- policies from 0006 still govern what they can see.
--
-- Geometry is returned as GeoJSON in EPSG:3424 (feet). That is deliberate:
-- the UI draws a plan view in an SVG, where planar feet coordinates are
-- exactly what's needed -- true dimensions, no map projection. (A future
-- slippy-map view would ask for ST_Transform(geom, 4326) instead.)

-- Address search within one municipality. PROP_LOC is the MOD-IV property
-- location, e.g. '3901 PALISADE AVE'.
CREATE OR REPLACE FUNCTION search_parcels(p_muni_slug text, p_query text, p_limit int DEFAULT 15)
RETURNS TABLE (
    parcel_id      bigint,
    pams_pin       text,
    address        text,
    block          text,
    lot            text,
    prop_class     text,
    lot_area_sqft  numeric
)
LANGUAGE sql STABLE
AS $$
    SELECT p.id, p.pams_pin,
           p.mod_iv->>'PROP_LOC',
           p.mod_iv->>'PCLBLOCK',
           p.mod_iv->>'PCLLOT',
           p.mod_iv->>'PROP_CLASS',
           p.lot_area_sqft
    FROM parcels p
    JOIN municipalities m ON m.id = p.municipality_id
    WHERE m.slug = p_muni_slug
      AND p.mod_iv->>'PROP_LOC' ILIKE '%' || p_query || '%'
    ORDER BY p.mod_iv->>'PROP_LOC'
    LIMIT LEAST(p_limit, 50);
$$;

-- One parcel with its lot info and the buildable envelope at a uniform
-- inset. The inset the app passes is the LARGEST applicable setback, so the
-- preview never overstates buildable area; per-edge offsetting is the rules
-- engine's job (see the scope note in 0005).
CREATE OR REPLACE FUNCTION parcel_envelope(p_parcel_id bigint, p_inset_ft double precision)
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
    envelope_area_sqft numeric
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
           round(ST_Area(p.env)::numeric, 1)
    FROM p;
$$;
