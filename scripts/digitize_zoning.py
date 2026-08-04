#!/usr/bin/env python3
"""
digitize_zoning.py -- digitize the official Union City zoning map into a
reviewable GeoJSON layer for scripts/import_zoning.py.

Union City publishes its zoning map only as a PDF (July 2019, Heyer Gruel &
Associates; ordinance 223-35). There is no municipal GIS layer to download,
so this script constructs one from official, citable sources:

  * Ordinance 223-36: district boundaries follow STREET CENTER LINES and LOT
    LINES. The C-N and MU districts are street corridors, so each is built as
    the union of NJGIN parcel polygons fronting the mapped streets, using the
    block ranges readable on the official map. Lot-line accuracy comes by
    construction, not by tracing pixels.
  * P (Public) is composed of school and public-property parcels
    (MOD-IV classes 15A/15B/15C). This IS an inference from property class --
    but it only ever WITHDRAWS land from R: P has no bulk rules loaded, so
    the resolver returns rules_missing and the app refuses to calculate.
    Leaving parks and schools inside R would falsely "verify" them as
    buildable residential lots, which is the worse error.
  * R (Residential) is the default fabric: the official municipal boundary
    (NJDCA Municipal Zoning layer, EPSG:3424) minus every other district.

NOT digitized (known limitations, carried in feature properties): the P-A
air-rights strip over Route 495, the redevelopment districts (8th Street,
D-BG, D-RS-A/B/S, D-ST, D-Y), and the HPOD/PPOD overlays. Parcels there
resolve to the underlying R or C-N polygon. Corner lots addressed on side
streets resolve R even where the official map shades them commercial.

The output is committed at data/zoning/union-city-nj.zoning.geojson so every
change to the digitization is a reviewable diff.

Usage (needs DATABASE_URL with imported parcels -- PostGIS does the geometry):
    python scripts/digitize_zoning.py union-city-nj
    python scripts/import_zoning.py union-city-nj data/zoning/union-city-nj.zoning.geojson \
      --source-url https://www.ucnj.com/_Content/pdf/misc/Zoning_Map_UC.pdf \
      --source-date 2019-07-01
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import psycopg2
except ImportError:
    sys.exit("Missing dependency: pip install psycopg2-binary")

SLUG = "union-city-nj"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "zoning" / f"{SLUG}.zoning.geojson"
ORDINANCE_URL = "https://ecode360.com/45711623"
SOURCE_MAP_URL = "https://www.ucnj.com/_Content/pdf/misc/Zoning_Map_UC.pdf"

# NJDCA Municipal Zoning layer: one boundary polygon per municipality, 3424.
BOUNDARY_LAYER = (
    "https://services.arcgis.com/Aur8tCo478N3VovT/arcgis/rest/services/"
    "Municipal_Zoning/FeatureServer/0/query"
)

# Corridors read off the official July 2019 map.
# (code, street as it appears in PROP_LOC after the house number,
#  min house number, max house number; None/None = full street)
CORRIDORS = [
    ("C-N", "BERGENLINE AVE", None, None),
    ("C-N", "BERGENLINE", None, None),        # MOD-IV spelling variant
    ("C-N", "SUMMIT AVE", 500, 1899),
    ("C-N", "NEW YORK AVE", 3300, 4899),
    ("C-N", "BROADWAY", None, None),
    ("C-N", "48TH ST", None, None),
    ("C-N", "BERGEN TPKE", None, None),
    ("C-N", "HACKENSACK PLANK RD", None, None),
    ("MU", "KERRIGAN AVE", 2000, 2499),
]

PUBLIC_CLASSES = ("15A", "15B", "15C")

LIMITATIONS = (
    "P-A air rights, redevelopment districts (8th St, D-BG, D-RS-A/B/S, "
    "D-ST, D-Y) and HPOD/PPOD overlays are not digitized; corner lots "
    "addressed on side streets resolve to R."
)

# Union of parcels fronting one corridor street segment.
#
# MOD-IV writes a multi-address property as a hyphenated range -- "1000-1008
# SUMMIT AVE" is one parcel, not one address. Matching only a single leading
# house number silently drops those parcels from the corridor, and because R is
# defined subtractively they fall through to R: a commercial lot returning a
# *matched* residential district, which is worse than any refusal. So accept a
# whole run of house numbers before the street name. The range test compares the
# LOW number, which is what the official map's block ranges are read against.
CORRIDOR_SQL = """
    SELECT p.geom
    FROM parcels p
    WHERE p.municipality_id = %(muni_id)s
      AND upper(trim(p.mod_iv->>'PROP_LOC')) ~
              ('^[0-9]+[A-Z]?(?:[\\s.-]+[0-9]+[A-Z]?)*[\\s.-]+' || %(street)s || '$')
      AND (%(lo)s::int IS NULL
           OR substring(trim(p.mod_iv->>'PROP_LOC') from '^[0-9]+')::int
                  BETWEEN %(lo)s AND %(hi)s)
"""

UNION_WRAP = """
    SELECT ST_AsGeoJSON(ST_Multi(ST_CollectionExtract(ST_MakeValid(
               ST_SimplifyPreserveTopology(ST_UnaryUnion(ST_Collect(geom)), 0.5)), 3)), 2)
    FROM ({inner}) src
"""


def fetch_boundary_geojson() -> str:
    params = {
        "where": "Muni='0910'",
        "outFields": "Muni",
        "returnGeometry": "true",
        "outSR": "3424",
        "f": "geojson",
    }
    req = urllib.request.Request(
        BOUNDARY_LAYER, data=urllib.parse.urlencode(params).encode(),
        headers={"User-Agent": "demarco-zoning-digitize"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    feats = data.get("features", [])
    if len(feats) != 1:
        sys.exit(f"Expected 1 Union City boundary feature, got {len(feats)}")
    return json.dumps(feats[0]["geometry"])


def main():
    if len(sys.argv) != 2 or sys.argv[1] != SLUG:
        sys.exit(f"Usage: digitize_zoning.py {SLUG}   (only Union City is implemented)")

    dsn = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/demarco")
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()

    cur.execute("SELECT id FROM municipalities WHERE slug = %s", (SLUG,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"Municipality '{SLUG}' not in DB -- run load_town.py first.")
    muni_id = row[0]
    cur.execute("SELECT count(*) FROM parcels WHERE municipality_id = %s", (muni_id,))
    if cur.fetchone()[0] == 0:
        sys.exit("No parcels imported -- run import_parcels.py first.")

    print("fetching municipal boundary (NJDCA, EPSG:3424)...")
    boundary = fetch_boundary_geojson()

    base_props = {
        "method_note": __doc__.split("\n\n")[1],
        "ordinance_url": ORDINANCE_URL,
        "source_map": SOURCE_MAP_URL,
        "limitations": LIMITATIONS,
        "is_overlay": False,
    }
    features = []

    def add_feature(code, geojson_str, fid, extra):
        if not geojson_str:
            print(f"{code}: no geometry -- skipped")
            return
        geom = json.loads(geojson_str)
        if not geom.get("coordinates"):
            print(f"{code}: empty geometry -- skipped")
            return
        features.append({
            "type": "Feature",
            "properties": {"code": code, "id": fid, **base_props, **extra},
            "geometry": geom,
        })
        print(f"{code}: ok")

    # Corridor districts, one merged multipolygon per code.
    for code in ("C-N", "MU"):
        parts = [c for c in CORRIDORS if c[0] == code]
        selects, params = [], {"muni_id": muni_id}
        for i, (_, street, lo, hi) in enumerate(parts):
            selects.append(
                CORRIDOR_SQL
                .replace("%(street)s", f"%(street_{i})s")
                .replace("%(lo)s", f"%(lo_{i})s")
                .replace("%(hi)s", f"%(hi_{i})s")
            )
            params[f"street_{i}"] = street.replace(" ", "[\\s.-]+")
            params[f"lo_{i}"], params[f"hi_{i}"] = lo, hi
        cur.execute(UNION_WRAP.format(inner=" UNION ALL ".join(selects)), params)
        add_feature(
            code, cur.fetchone()[0], f"corridors:{code}",
            {"corridors": [{"street": s, "range": [lo, hi]} for _, s, lo, hi in parts]},
        )

    # P (Public) from MOD-IV public property classes.
    cur.execute(
        UNION_WRAP.format(inner="""
            SELECT p.geom FROM parcels p
            WHERE p.municipality_id = %(muni_id)s
              AND p.mod_iv->>'PROP_CLASS' IN %(classes)s
        """),
        {"muni_id": muni_id, "classes": PUBLIC_CLASSES},
    )
    add_feature("P", cur.fetchone()[0], "prop_class:" + ",".join(PUBLIC_CLASSES),
                {"prop_classes": list(PUBLIC_CLASSES)})

    # R = boundary minus everything digitized above (computed in PostGIS,
    # read-only: the union of the features we just built is passed back in).
    others = json.dumps({
        "type": "GeometryCollection",
        "geometries": [f["geometry"] for f in features],
    })
    cur.execute(
        """
        SELECT ST_AsGeoJSON(ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Difference(
                   ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%(boundary)s), 3424)),
                   ST_UnaryUnion(ST_CollectionExtract(
                       ST_SetSRID(ST_GeomFromGeoJSON(%(others)s), 3424), 3))
               )), 3)), 2)
        """,
        {"boundary": boundary, "others": others},
    )
    add_feature("R", cur.fetchone()[0], "njdca_boundary_minus_districts",
                {"boundary_source": BOUNDARY_LAYER})
    conn.close()

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    collection = {
        "type": "FeatureCollection",
        "name": f"{SLUG} zoning digitization (EPSG:3424)",
        "features": features,
    }
    OUT_PATH.write_text(json.dumps(collection) + "\n")
    print(f"\nwrote {OUT_PATH.relative_to(OUT_PATH.parent.parent.parent)} "
          f"({OUT_PATH.stat().st_size // 1024} KB, {len(features)} feature(s))")


if __name__ == "__main__":
    main()
