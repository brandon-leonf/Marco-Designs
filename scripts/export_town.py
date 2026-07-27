#!/usr/bin/env python3
"""
export_town.py -- write a town's live database rows back out as a config file.

The config file is the source of truth: "adding a town = a config edit, not a
code change" is the architectural claim the final demo rests on. The in-app
config editor writes straight to Postgres, which is fast for the person
maintaining rates but creates a second source of truth -- a town can exist in
the live database with no file in config/towns/ (and edits to an existing town
can drift away from its committed file).

This closes that loop. It reads the database and emits exactly what
load_town.py expects, so the round trip holds:

    config file --load_town.py--> database --export_town.py--> config file

Usage:
    python scripts/export_town.py union-city-nj          # write the file
    python scripts/export_town.py union-city-nj --stdout # print, don't write
    python scripts/export_town.py --all
    python scripts/export_town.py --all --check          # CI: fail on drift

--check writes nothing and exits non-zero if any town's committed file differs
from the live database, which is the signal that someone edited config in the
app and has not committed the result.

Rates are deliberately NOT exported: they are proprietary and git-ignored
(kickoff section 9). Use the config editor or edit the rate card by hand.
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit("Missing dependency: pip install psycopg2-binary")

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit("Missing dependency: pip install jsonschema")

ROOT = Path(__file__).resolve().parent.parent
TOWNS_DIR = ROOT / "config" / "towns"
SCHEMA_DIR = ROOT / "config" / "schema"


def num(value):
    """Postgres numeric -> int when whole, else float. Keeps files readable."""
    if value is None:
        return None
    f = float(value)
    return int(f) if f.is_integer() else f


def drop_nulls(d):
    """Omit keys the database has no value for, rather than emitting nulls."""
    return {k: v for k, v in d.items() if v is not None}


def build_district(row):
    lot = drop_nulls({
        "area_sqft": num(row["min_lot_area_sqft"]),
        "width_ft": num(row["min_lot_width_ft"]),
        "depth_ft": num(row["min_lot_depth_ft"]),
    })
    setbacks = drop_nulls({
        "front_yard_min": num(row["front_yard_min_ft"]),
        "side_yard_one_min": num(row["side_yard_one_min_ft"]),
        "side_yard_total_min": num(row["side_yard_total_min_ft"]),
        "rear_yard_min": num(row["rear_yard_min_ft"]),
    })
    # Always emit the prevailing-rule flag: false is meaningful, not missing.
    setbacks["front_yard_prevailing_rule"] = bool(row["front_yard_prevailing_rule"])

    district = {
        "code": row["code"],
        "name": row["name"],
        "permitted_uses": list(row["permitted_uses"] or []),
        "notes": row["notes"],
        "lot_minimums": lot,
        "setbacks_ft": setbacks,
        "max_height": drop_nulls({
            "stories": num(row["max_stories"]),
            "feet": num(row["max_height_ft"]),
        }),
        "max_coverage_pct": drop_nulls({
            "building": num(row["max_building_coverage_pct"]),
            "lot_impervious": num(row["max_impervious_coverage_pct"]),
        }),
        "max_far": num(row["max_far"]),
        "extra_rules": row["extra_rules"] or {},
    }
    # name/notes are optional; drop them when empty, but keep max_far: null,
    # which explicitly means "this town has no FAR cap" (never 0).
    for key in ("name", "notes"):
        if district[key] is None:
            district.pop(key)
    return district


def export_town(cur, slug):
    cur.execute(
        """
        SELECT id, name, slug, county, state_code, last_updated, source_url, overlays
        FROM municipalities WHERE slug = %s
        """,
        (slug,),
    )
    muni = cur.fetchone()
    if muni is None:
        sys.exit(f"No municipality with slug '{slug}' in the database.")

    cur.execute(
        "SELECT * FROM zoning_districts WHERE municipality_id = %s ORDER BY code",
        (muni["id"],),
    )
    districts = [build_district(r) for r in cur.fetchall()]

    payload = {
        "municipality": drop_nulls({
            "name": muni["name"],
            "state": muni["state_code"],
            "county": muni["county"],
            "slug": muni["slug"],
            "last_updated": muni["last_updated"].isoformat() if muni["last_updated"] else None,
            "source_url": muni["source_url"],
        }),
        "zoning_districts": districts,
    }
    payload["municipality"]["overlays"] = muni["overlays"] or {}
    return payload


def validate(payload, label):
    schema = json.load(open(SCHEMA_DIR / "town.schema.json"))
    errors = sorted(Draft202012Validator(schema).iter_errors(payload), key=lambda e: list(e.path))
    if not errors:
        return True
    print(f"  {label}: INVALID against town.schema.json ({len(errors)} error(s))")
    for e in errors:
        loc = "/".join(str(p) for p in e.path) or "(root)"
        print(f"    - {loc}: {e.message}")
    print("    The live database is missing rules this town needs. Fill them in")
    print("    in the config editor (or the file) before committing.")
    return False


def serialize(payload):
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Export live town config back to a file.")
    ap.add_argument("slug", nargs="?", help="town slug, e.g. union-city-nj")
    ap.add_argument("--all", action="store_true", help="export every town in the database")
    ap.add_argument("--stdout", action="store_true", help="print instead of writing")
    ap.add_argument("--check", action="store_true",
                    help="write nothing; exit 1 if a committed file differs from the database")
    args = ap.parse_args()

    if not args.slug and not args.all:
        ap.error("give a slug or --all")

    dsn = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/demarco")
    conn = psycopg2.connect(dsn, cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        with conn.cursor() as cur:
            if args.all:
                cur.execute("SELECT slug FROM municipalities ORDER BY slug")
                slugs = [r["slug"] for r in cur.fetchall()]
                if not slugs:
                    sys.exit("No municipalities in the database.")
            else:
                slugs = [args.slug]

            drifted, invalid = [], []
            for slug in slugs:
                with conn.cursor() as c2:
                    payload = export_town(c2, slug)
                text = serialize(payload)
                path = TOWNS_DIR / f"{slug}.json"

                if not validate(payload, slug):
                    invalid.append(slug)
                    if not args.check:
                        print(f"  {slug}: not written")
                    continue

                if args.stdout:
                    print(text, end="")
                    continue

                current = path.read_text() if path.exists() else None
                if current == text:
                    print(f"  {slug}: up to date ({path.relative_to(ROOT)})")
                    continue

                if args.check:
                    drifted.append(slug)
                    state = "differs from the database" if current else "does not exist"
                    print(f"  {slug}: {path.relative_to(ROOT)} {state}")
                    continue

                path.write_text(text)
                print(f"  {slug}: {'updated' if current else 'created'} {path.relative_to(ROOT)}")

            if args.check and (drifted or invalid):
                print("\nLive database and committed configs are out of sync.")
                print("Run: python scripts/export_town.py --all   then commit the result.")
                sys.exit(1)
            if invalid and not args.check:
                sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
