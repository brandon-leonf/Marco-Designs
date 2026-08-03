-- Publish a reviewed GeoJSON zoning layer from the authenticated admin setup
-- wizard. The function owns the replace operation so the browser never gets
-- broad direct write access to spatial tables.

CREATE OR REPLACE FUNCTION admin_publish_zoning_layer(
    p_municipality_id integer,
    p_features        jsonb,
    p_source_url      text,
    p_source_date     date DEFAULT NULL,
    p_srid            integer DEFAULT 4326
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    inserted_count integer;
BEGIN
    IF NOT public.is_config_admin() THEN
        RAISE EXCEPTION 'Not authorized to publish zoning layers';
    END IF;
    IF p_srid NOT IN (3424, 4326) THEN
        RAISE EXCEPTION 'Unsupported zoning-layer SRID: %', p_srid;
    END IF;
    IF jsonb_typeof(p_features) <> 'array' OR jsonb_array_length(p_features) = 0 THEN
        RAISE EXCEPTION 'At least one zoning polygon is required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM municipalities WHERE id = p_municipality_id) THEN
        RAISE EXCEPTION 'Municipality % does not exist', p_municipality_id;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_features) AS feature
        LEFT JOIN zoning_districts district
          ON district.municipality_id = p_municipality_id
         AND upper(btrim(district.code)) = upper(btrim(feature ->> 'district_code'))
        WHERE district.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Every polygon must match a configured district';
    END IF;

    DELETE FROM zoning_areas WHERE municipality_id = p_municipality_id;

    INSERT INTO zoning_areas (
        municipality_id,
        district_id,
        district_code,
        geom,
        is_overlay,
        source_feature_id,
        source_map_url,
        source_map_date,
        metadata
    )
    SELECT
        p_municipality_id,
        district.id,
        district.code,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(
            ST_Transform(
                ST_SetSRID(ST_GeomFromGeoJSON((feature -> 'geometry')::text), p_srid),
                3424
            )
        ), 3)),
        false,
        coalesce(feature ->> 'source_feature_id', ordinal::text),
        coalesce(nullif(p_source_url, ''), 'Admin zoning setup'),
        p_source_date,
        coalesce(feature -> 'properties', '{}'::jsonb)
    FROM jsonb_array_elements(p_features) WITH ORDINALITY AS source(feature, ordinal)
    JOIN zoning_districts district
      ON district.municipality_id = p_municipality_id
     AND upper(btrim(district.code)) = upper(btrim(feature ->> 'district_code'));

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    UPDATE municipalities SET last_updated = current_date WHERE id = p_municipality_id;
    RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION admin_publish_zoning_layer(integer, jsonb, text, date, integer)
    FROM PUBLIC;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT EXECUTE ON FUNCTION admin_publish_zoning_layer(integer, jsonb, text, date, integer)
            TO authenticated;
    END IF;
END
$do$;
