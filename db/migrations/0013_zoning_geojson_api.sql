-- 0013_zoning_geojson_api.sql
-- Serve a municipality's zoning polygons to the browser map.
--
-- Geometry is stored in EPSG:3424 (NJ State Plane feet) because that is the
-- projection the envelope math needs. Web maps speak EPSG:4326, so the
-- transform happens here rather than in the client: one place, using PostGIS,
-- instead of a hand-rolled reprojection per caller.
--
-- The polygons are simplified before transforming. Union City's R district is
-- "municipal boundary minus every other district", which carries far more
-- vertices than a screen can resolve; 2 ft of tolerance in State Plane is
-- sub-pixel at any zoom a client would use and keeps the payload small.
-- PreserveTopology so shared district edges do not tear apart.
--
-- Read-only and SECURITY INVOKER: it reads a table whose RLS policy already
-- allows public SELECT, so it grants nothing new.

CREATE OR REPLACE FUNCTION municipality_zoning_geojson(p_muni_slug text)
RETURNS TABLE (
    district_code text,
    district_name text,
    is_overlay    boolean,
    has_rules     boolean,
    geojson       jsonb
)
LANGUAGE sql STABLE
AS $$
    SELECT
        za.district_code,
        zd.name,
        za.is_overlay,
        -- A polygon whose code has no rules row still draws; the app already
        -- reports that parcel state as `rules_missing` rather than guessing.
        (zd.id IS NOT NULL) AS has_rules,
        ST_AsGeoJSON(
            ST_Transform(
                ST_SimplifyPreserveTopology(za.geom, 2.0),
                4326
            )
        )::jsonb
    FROM zoning_areas za
    JOIN municipalities m ON m.id = za.municipality_id
    LEFT JOIN zoning_districts zd ON zd.id = za.district_id
    WHERE m.slug = p_muni_slug
    ORDER BY za.is_overlay, za.district_code;
$$;

-- What the layer does and does not represent. Union City's map exists only as
-- a PDF, so its polygons are derived from citable sources rather than an
-- official GIS layer — the map must say so rather than imply authority.
CREATE OR REPLACE FUNCTION municipality_zoning_provenance(p_muni_slug text)
RETURNS TABLE (
    source_map_url  text,
    source_map_date date,
    method_note     text,
    limitations     text
)
LANGUAGE sql STABLE
AS $$
    SELECT
        za.source_map_url,
        za.source_map_date,
        za.metadata ->> 'method_note',
        za.metadata ->> 'limitations'
    FROM zoning_areas za
    JOIN municipalities m ON m.id = za.municipality_id
    WHERE m.slug = p_muni_slug
    LIMIT 1;
$$;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT EXECUTE ON FUNCTION municipality_zoning_geojson(text) TO anon, authenticated;
        GRANT EXECUTE ON FUNCTION municipality_zoning_provenance(text) TO anon, authenticated;
    END IF;
END
$do$;
