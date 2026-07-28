-- 0015_link_zoning_districts.sql
-- Keep zoning_areas linked to zoning_districts by municipality + code.
--
-- The editor can create a district after its polygon was imported. Previously
-- that left zoning_areas.district_id NULL forever, so the public map displayed
-- "no rules loaded" even though the matching district now existed. These
-- triggers repair existing rows and keep both import orders synchronized.

CREATE OR REPLACE FUNCTION zoning_district_rules_complete(p_district_id integer)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((
        SELECT
            zd.front_yard_min_ft IS NOT NULL
            AND zd.rear_yard_min_ft IS NOT NULL
            AND zd.max_building_coverage_pct IS NOT NULL
            AND zd.max_stories IS NOT NULL
            AND (
                zd.side_yard_one_min_ft IS NOT NULL
                OR zd.side_yard_total_min_ft IS NOT NULL
            )
        FROM zoning_districts zd
        WHERE zd.id = p_district_id
    ), false);
$$;

CREATE OR REPLACE FUNCTION link_zoning_areas_after_district_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- If a code changes, do not leave polygons attached to the old code.
    UPDATE zoning_areas
       SET district_id = NULL
     WHERE district_id = NEW.id
       AND (
           municipality_id <> NEW.municipality_id
           OR upper(btrim(district_code)) <> upper(btrim(NEW.code))
       );

    UPDATE zoning_areas
       SET district_id = NEW.id
     WHERE municipality_id = NEW.municipality_id
       AND upper(btrim(district_code)) = upper(btrim(NEW.code))
       AND district_id IS DISTINCT FROM NEW.id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_zoning_areas_after_district_write ON zoning_districts;
CREATE TRIGGER trg_link_zoning_areas_after_district_write
AFTER INSERT OR UPDATE OF municipality_id, code ON zoning_districts
FOR EACH ROW EXECUTE FUNCTION link_zoning_areas_after_district_write();

CREATE OR REPLACE FUNCTION link_district_before_zoning_area_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    SELECT zd.id
      INTO NEW.district_id
      FROM zoning_districts zd
     WHERE zd.municipality_id = NEW.municipality_id
       AND upper(btrim(zd.code)) = upper(btrim(NEW.district_code))
     LIMIT 1;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_district_before_zoning_area_write ON zoning_areas;
CREATE TRIGGER trg_link_district_before_zoning_area_write
BEFORE INSERT OR UPDATE OF municipality_id, district_code ON zoning_areas
FOR EACH ROW EXECUTE FUNCTION link_district_before_zoning_area_write();

-- Repair polygons imported before their district was created.
UPDATE zoning_areas za
   SET district_id = zd.id
  FROM zoning_districts zd
 WHERE za.municipality_id = zd.municipality_id
   AND upper(btrim(za.district_code)) = upper(btrim(zd.code))
   AND za.district_id IS DISTINCT FROM zd.id;

-- The map must distinguish "district row exists" from "enough rules have
-- been published to calculate safely".
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
        zoning_district_rules_complete(zd.id),
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

-- Recreate the parcel resolver with the same spatial safeguards, plus the
-- complete-rules check used by the frontend map.
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
            zoning_district_rules_complete(za.district_id) AS rules_complete,
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
            bool_or(rules_complete) FILTER (WHERE rank = 1) AS top_rules_complete,
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
            WHEN s.top_district_id IS NULL OR NOT COALESCE(s.top_rules_complete, false) THEN 'rules_missing'
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

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT EXECUTE ON FUNCTION municipality_zoning_geojson(text) TO anon, authenticated;
        GRANT EXECUTE ON FUNCTION resolve_parcel_zoning(bigint) TO anon, authenticated;
    END IF;
END
$do$;
