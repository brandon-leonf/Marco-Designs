#!/usr/bin/env python3
"""Import a municipal zoning polygon GeoJSON layer into PostGIS.

The input must be a FeatureCollection in EPSG:3424 (NJ State Plane feet) or
EPSG:4326. Each feature needs a district code property (default: ``code``).
Unknown codes are retained with a null district_id so the resolver can return
``rules_missing`` instead of silently assigning the wrong rules.

Usage:
    python scripts/import_zoning.py union-city-nj zoning.geojson \
      --source-url https://www.ucnj.com/_Content/pdf/ordinances/ATTACHMENT-A-Zoning-Map-July-2019.pdf \
      --source-date 2019-07-01

The official Union City zoning map is currently a static PDF. It must be
professionally digitized/georeferenced or supplied by the municipality before
running this importer; do not infer zones from tax use or parcel class.
"""

import argparse
import json
import os
from pathlib import Path

import psycopg2
import psycopg2.extras


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("slug")
    parser.add_argument("geojson", type=Path)
    parser.add_argument("--code-field", default="code")
    parser.add_argument("--overlay-field", default="is_overlay")
    parser.add_argument("--source-id-field", default="id")
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--source-date")
    parser.add_argument("--srid", type=int, choices=(3424, 4326), default=3424)
    return parser.parse_args()


def main():
    args = parse_args()
    payload = json.loads(args.geojson.read_text())
    if payload.get("type") != "FeatureCollection":
        raise SystemExit("Input must be a GeoJSON FeatureCollection.")

    dsn = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/demarco")
    conn = psycopg2.connect(dsn)
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM municipalities WHERE slug = %s", (args.slug,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"Municipality '{args.slug}' is not loaded.")
        municipality_id = row[0]
        cur.execute(
            "SELECT upper(code), id FROM zoning_districts WHERE municipality_id = %s",
            (municipality_id,),
        )
        district_ids = dict(cur.fetchall())

    rows = []
    for index, feature in enumerate(payload.get("features", []), start=1):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry")
        code = str(props.get(args.code_field) or "").strip().upper()
        if not code or not geometry:
            raise SystemExit(f"Feature {index} is missing geometry or '{args.code_field}'.")
        rows.append((
            municipality_id,
            district_ids.get(code),
            code,
            json.dumps(geometry),
            args.srid,
            bool(props.get(args.overlay_field, False)),
            str(props.get(args.source_id_field) or index),
            args.source_url,
            args.source_date,
            json.dumps(props),
        ))

    with conn.cursor() as cur:
        cur.execute("DELETE FROM zoning_areas WHERE municipality_id = %s", (municipality_id,))
        psycopg2.extras.execute_batch(cur, """
            INSERT INTO zoning_areas
                (municipality_id, district_id, district_code, geom, is_overlay,
                 source_feature_id, source_map_url, source_map_date, metadata)
            VALUES (
                %s, %s, %s,
                ST_Multi(ST_CollectionExtract(ST_MakeValid(
                    ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), %s), 3424)
                ), 3)),
                %s, %s, %s, %s::date, %s::jsonb
            )
        """, rows, page_size=200)
    conn.commit()
    conn.close()

    missing = sorted({row[2] for row in rows if row[1] is None})
    print(f"Imported {len(rows)} zoning polygon(s) for {args.slug}.")
    if missing:
        print("Rules still missing for district code(s): " + ", ".join(missing))


if __name__ == "__main__":
    main()
