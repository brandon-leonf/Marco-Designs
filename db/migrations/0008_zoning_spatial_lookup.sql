-- 0008_zoning_spatial_lookup.sql
-- Municipal zoning polygons and authoritative parcel-to-zone resolution.
--
-- A parcel's district must come from a spatial intersection with the zoning
-- layer. A manual dropdown is never authoritative for a parcel found through
-- public property data. The resolver uses the zone covering the dominant
-- share of the parcel and flags boundary conflicts instead of guessing.

CREATE TABLE IF NOT EXISTS zoning_areas (
    id                  bigserial PRIMARY KEY,
    municipality_id     integer NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
    district_id         integer REFERENCES zoning_districts(id) ON DELETE SET NULL,
    district_code       text NOT NULL,
    geom                geometry(MultiPolygon, 3424) NOT NULL,
    is_overlay          boolean NOT NULL DEFAULT false,
    source_feature_id   text,
    source_map_url      text NOT NULL,
    source_map_date     date,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    imported_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zoning_areas_geom
    ON zoning_areas USING gist (geom);
CREATE INDEX IF NOT EXISTS idx_zoning_areas_muni
    ON zoning_areas (municipality_id);
CREATE INDEX IF NOT EXISTS idx_zoning_areas_district
    ON zoning_areas (district_id);

ALTER TABLE zoning_areas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'zoning_areas'
          AND policyname = 'read_only_api'
    ) THEN
        CREATE POLICY read_only_api
            ON zoning_areas FOR SELECT TO public USING (true);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT SELECT ON zoning_areas TO anon, authenticated;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION resolve_parcel_zoning(p_parcel_id bigint)
RETURNS TABLE (
    status              text,
    district_id         integer,
    district_code       text,
    district_name       text,
    overlap_area_sqft   numeric,
    overlap_pct         numeric,
    competing_codes     text[],
    source_map_url      text,
    source_map_date     date
)
LANGUAGE sql STABLE
AS $$
    WITH parcel AS (
        SELECT p.id, p.municipality_id, p.geom, ST_Area(p.geom) AS parcel_area
        FROM parcels p
        WHERE p.id = p_parcel_id
    ),
    zone_intersections AS (
        SELECT
            za.district_id,
            za.district_code,
            zd.name AS district_name,
            za.source_map_url,
            za.source_map_date,
            ST_Area(ST_Intersection(p.geom, za.geom)) AS overlap_area,
            ST_Area(ST_Intersection(p.geom, za.geom))
                / NULLIF(p.parcel_area, 0) * 100.0 AS overlap_percent
        FROM parcel p
        JOIN zoning_areas za
          ON za.municipality_id = p.municipality_id
         AND za.is_overlay = false
         AND ST_Intersects(p.geom, za.geom)
        LEFT JOIN zoning_districts zd ON zd.id = za.district_id
        WHERE ST_Area(ST_Intersection(p.geom, za.geom)) > 0
    ),
    ranked AS (
        SELECT *, row_number() OVER (ORDER BY overlap_area DESC, district_code) AS rank
        FROM zone_intersections
    ),
    summary AS (
        SELECT
            count(*) AS match_count,
            max(district_id) FILTER (WHERE rank = 1) AS top_district_id,
            max(district_code) FILTER (WHERE rank = 1) AS top_code,
            max(district_name) FILTER (WHERE rank = 1) AS top_name,
            max(overlap_area) FILTER (WHERE rank = 1) AS top_area,
            max(overlap_percent) FILTER (WHERE rank = 1) AS top_pct,
            max(overlap_percent) FILTER (WHERE rank = 2) AS second_pct,
            max(source_map_url) FILTER (WHERE rank = 1) AS top_source_url,
            max(source_map_date) FILTER (WHERE rank = 1) AS top_source_date,
            COALESCE(
                array_agg(district_code ORDER BY overlap_area DESC)
                    FILTER (WHERE district_code IS NOT NULL),
                ARRAY[]::text[]
            ) AS codes
        FROM ranked
    )
    SELECT
        CASE
            WHEN NOT EXISTS (
                SELECT 1 FROM zoning_areas za
                JOIN parcel p ON p.municipality_id = za.municipality_id
                WHERE za.is_overlay = false
            ) THEN 'no_layer'
            WHEN s.match_count = 0 THEN 'unmapped'
            WHEN s.top_pct < 80 OR COALESCE(s.second_pct, 0) >= 20 THEN 'boundary_conflict'
            WHEN s.top_district_id IS NULL THEN 'rules_missing'
            ELSE 'matched'
        END,
        s.top_district_id,
        s.top_code,
        s.top_name,
        round(s.top_area::numeric, 1),
        round(s.top_pct::numeric, 2),
        s.codes,
        s.top_source_url,
        s.top_source_date
    FROM summary s;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT EXECUTE ON FUNCTION resolve_parcel_zoning(bigint) TO anon, authenticated;
    END IF;
END $$;
