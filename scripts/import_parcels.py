#!/usr/bin/env python3
"""
import_parcels.py -- import parcel polygons + MOD-IV lot info for one town
from NJGIN's public Cadastral service into the parcels table.

Source: https://maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer/0
(NJ Parcels and MOD-IV composite). The layer is served natively in EPSG:3424
(NJ State Plane, US survey feet) -- the exact SRID the parcels table stores,
so no reprojection happens anywhere in this pipeline.

Usage:
    python scripts/import_parcels.py union-city-nj
    DATABASE_URL=postgresql://... python scripts/import_parcels.py union-city-nj

What it does:
  1. Looks up the municipality by slug (must already be loaded by load_town.py)
     and its NJ municipality code from NJ_MUN_CODES below.
  2. Pages through the ArcGIS query endpoint (1000 features/request).
  3. Converts Esri ring geometry to GeoJSON (ring winding decides shells vs
     holes), inserts as MultiPolygon 3424 via ST_GeomFromGeoJSON + ST_MakeValid.
  4. Dedupes on PAMS_PIN keeping the largest polygon (the public data contains
     duplicate PINs -- see the note on the parcels table).
  5. Replaces any previously imported parcels for the town (idempotent reload).

Privacy: OWNER_NAME and owner mailing address fields are deliberately never
read. We keep only property-location and lot attributes.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit("Missing dependency: pip install psycopg2-binary")

LAYER_URL = "https://maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer/0/query"
PAGE_SIZE = 1000

# NJ municipality codes (county 2 digits + municipality 2 digits) per town slug.
# Add an entry when a new NJ town gets parcel import.
NJ_MUN_CODES = {
    "union-city-nj": "0910",
}

# MOD-IV attributes worth keeping for traceability / UI. No owner fields.
ATTRS = [
    "PAMS_PIN", "PCL_MUN", "PCLBLOCK", "PCLLOT", "PCLQCODE", "COUNTY",
    "MUN_NAME", "PROP_LOC", "PROP_CLASS", "PROP_USE", "BLDG_DESC",
    "LAND_DESC", "CALC_ACRE", "YR_CONSTR", "ZIP5",
]

SQFT_PER_ACRE = 43560.0
# LAND_DESC is frequently "25X100" (frontage x depth in feet).
LAND_DESC_DIMS = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)\s*$", re.I)


def fetch_page(where: str, offset: int) -> dict:
    params = {
        "where": where,
        "outFields": ",".join(ATTRS),
        "returnGeometry": "true",
        "outSR": "3424",
        "resultOffset": str(offset),
        "resultRecordCount": str(PAGE_SIZE),
        "orderByFields": "OBJECTID",
        "f": "json",
    }
    req = urllib.request.Request(
        LAYER_URL, data=urllib.parse.urlencode(params).encode(),
        headers={"User-Agent": "demarco-parcel-import"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    if "error" in data:
        sys.exit(f"ArcGIS error: {data['error']}")
    return data


def ring_area(ring) -> float:
    """Signed shoelace area. Esri convention: clockwise (negative) = shell."""
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        s += x1 * y2 - x2 * y1
    return s / 2.0


def esri_rings_to_geojson(rings) -> dict | None:
    """Esri polygon -> GeoJSON MultiPolygon. Shells are clockwise rings,
    holes counterclockwise; each hole belongs to the shell that contains it,
    which for parcel data we approximate as the most recent shell (NJGIN
    exports shells followed by their holes)."""
    polys = []
    for ring in rings:
        if len(ring) < 4:
            continue
        if ring_area(ring) <= 0:  # clockwise in screen coords = shell
            polys.append([ring])
        elif polys:
            polys[-1].append(ring)
        else:  # hole before any shell -- treat as shell, ST_MakeValid fixes
            polys.append([ring])
    if not polys:
        return None
    return {"type": "MultiPolygon", "coordinates": polys}


def parse_dims(land_desc):
    m = LAND_DESC_DIMS.match(land_desc or "")
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in NJ_MUN_CODES:
        known = ", ".join(sorted(NJ_MUN_CODES))
        sys.exit(f"Usage: import_parcels.py <slug>   (known slugs: {known})")
    slug = sys.argv[1]
    mun_code = NJ_MUN_CODES[slug]

    dsn = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/demarco")
    conn = psycopg2.connect(dsn)

    with conn.cursor() as cur:
        cur.execute("SELECT id, county FROM municipalities WHERE slug = %s", (slug,))
        row = cur.fetchone()
        if not row:
            sys.exit(f"Municipality '{slug}' not in DB -- run load_town.py first.")
        muni_id, county = row

    where = f"PCL_MUN='{mun_code}'"
    print(f"{slug}: importing parcels where {where}")

    # Dedupe on PAMS_PIN keeping the largest |area|; pinless features all kept.
    best: dict[str, tuple] = {}
    pinless: list[tuple] = []
    offset = 0
    while True:
        data = fetch_page(where, offset)
        feats = data.get("features", [])
        for f in feats:
            attrs = f["attributes"]
            gj = esri_rings_to_geojson((f.get("geometry") or {}).get("rings", []))
            if gj is None:
                continue
            area_hint = abs(sum(ring_area(p[0]) for p in gj["coordinates"]))
            rec = (attrs, gj, area_hint)
            pin = attrs.get("PAMS_PIN")
            if not pin:
                pinless.append(rec)
            elif pin not in best or area_hint > best[pin][2]:
                best[pin] = rec
        offset += len(feats)
        print(f"  fetched {offset}", end="\r")
        if not data.get("exceededTransferLimit") and len(feats) < PAGE_SIZE:
            break
    records = list(best.values()) + pinless
    print(f"  fetched {offset} features -> {len(records)} after PIN dedup")

    rows = []
    for attrs, gj, _ in records:
        acres = attrs.get("CALC_ACRE")
        frontage, depth = parse_dims(attrs.get("LAND_DESC"))
        mod_iv = {k: attrs.get(k) for k in ATTRS if attrs.get(k) not in (None, "")}
        rows.append((
            attrs.get("PAMS_PIN"),
            muni_id,
            attrs.get("COUNTY") or county,
            json.dumps(gj),
            acres * SQFT_PER_ACRE if acres else None,
            frontage,
            depth,
            json.dumps(mod_iv),
        ))

    with conn.cursor() as cur:
        cur.execute("DELETE FROM parcels WHERE municipality_id = %s", (muni_id,))
        print(f"  cleared {cur.rowcount} previously imported parcel(s)")
        psycopg2.extras.execute_batch(cur, """
            INSERT INTO parcels
                (pams_pin, municipality_id, county, geom,
                 lot_area_sqft, lot_frontage_ft, lot_depth_ft, mod_iv)
            VALUES (%s, %s, %s,
                    ST_Multi(ST_CollectionExtract(ST_MakeValid(
                        ST_SetSRID(ST_GeomFromGeoJSON(%s), 3424)), 3)),
                    %s::numeric, %s::numeric, %s::numeric, %s)
            """, rows, page_size=200)
        # Fill lot_area_sqft from the polygon where MOD-IV had no acreage.
        cur.execute("""
            UPDATE parcels SET lot_area_sqft = round(ST_Area(geom)::numeric, 1)
            WHERE municipality_id = %s AND lot_area_sqft IS NULL
        """, (muni_id,))
        computed = cur.rowcount
    conn.commit()

    with conn.cursor() as cur:
        cur.execute("""
            SELECT count(*), round(avg(lot_area_sqft)::numeric)
            FROM parcels WHERE municipality_id = %s
        """, (muni_id,))
        n, avg_area = cur.fetchone()
    conn.close()
    print(f"  imported {n} parcels (area from polygon for {computed}); avg lot {avg_area} sqft")


if __name__ == "__main__":
    main()
