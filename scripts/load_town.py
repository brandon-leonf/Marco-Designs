#!/usr/bin/env python3
"""
load_town.py -- validate a town config (+ its rate card) and upsert it into Postgres.

This is the "add a town = a config edit, not a code change" path, and the thing
the final demo shows off ("load a brand-new town live from a config file").

Usage:
    python scripts/load_town.py union-city-nj
    python scripts/load_town.py --all
    DATABASE_URL=postgresql://user:pass@host/db python scripts/load_town.py union-city-nj

It:
  1. loads config/towns/<slug>.json and validates it against config/schema/town.schema.json
  2. loads config/rates/<slug>.rates.json (proprietary, git-ignored) if present and
     validates it against config/schema/rates.schema.json
  3. upserts state -> municipality -> zoning_districts, and (if rates present)
     build_cost_models -> build_cost_tiers

Every write is an upsert, so re-running is safe and idempotent.
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
RATES_DIR = ROOT / "config" / "rates"
SCHEMA_DIR = ROOT / "config" / "schema"


def load_json(path: Path):
    with open(path) as f:
        return json.load(f)


def validate(instance, schema_path: Path, label: str):
    schema = load_json(schema_path)
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=lambda e: e.path)
    if errors:
        print(f"\n  {label} FAILED validation ({len(errors)} error(s)):")
        for e in errors:
            loc = "/".join(str(p) for p in e.path) or "(root)"
            print(f"    - {loc}: {e.message}")
        raise SystemExit(1)
    print(f"  {label}: valid")


def upsert_town(cur, town: dict, rates: dict | None):
    m = town["municipality"]

    # state
    cur.execute(
        "INSERT INTO states (code, name) VALUES (%s, %s) "
        "ON CONFLICT (code) DO NOTHING",
        (m["state"], m["state"]),
    )

    # municipality
    cur.execute(
        """
        INSERT INTO municipalities
            (state_code, name, slug, county, last_updated, source_url, overlays)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (slug) DO UPDATE SET
            state_code = EXCLUDED.state_code,
            name       = EXCLUDED.name,
            county     = EXCLUDED.county,
            last_updated = EXCLUDED.last_updated,
            source_url = EXCLUDED.source_url,
            overlays   = EXCLUDED.overlays
        RETURNING id
        """,
        (
            m["state"], m["name"], m["slug"], m.get("county"),
            m.get("last_updated"), m.get("source_url"),
            json.dumps(m.get("overlays", {})),
        ),
    )
    muni_id = cur.fetchone()[0]

    # zoning districts
    for d in town["zoning_districts"]:
        lot = d.get("lot_minimums", {})
        sb = d["setbacks_ft"]
        h = d.get("max_height", {})
        cov = d["max_coverage_pct"]
        cur.execute(
            """
            INSERT INTO zoning_districts (
                municipality_id, code, name, permitted_uses, notes,
                min_lot_area_sqft, min_lot_width_ft, min_lot_depth_ft,
                front_yard_min_ft, front_yard_prevailing_rule,
                side_yard_one_min_ft, side_yard_total_min_ft, rear_yard_min_ft,
                max_height_ft, max_stories,
                max_building_coverage_pct, max_impervious_coverage_pct,
                max_far, extra_rules
            ) VALUES (
                %s,%s,%s,%s,%s,
                %s,%s,%s,
                %s,%s,
                %s,%s,%s,
                %s,%s,
                %s,%s,
                %s,%s
            )
            ON CONFLICT (municipality_id, code) DO UPDATE SET
                name = EXCLUDED.name,
                permitted_uses = EXCLUDED.permitted_uses,
                notes = EXCLUDED.notes,
                min_lot_area_sqft = EXCLUDED.min_lot_area_sqft,
                min_lot_width_ft = EXCLUDED.min_lot_width_ft,
                min_lot_depth_ft = EXCLUDED.min_lot_depth_ft,
                front_yard_min_ft = EXCLUDED.front_yard_min_ft,
                front_yard_prevailing_rule = EXCLUDED.front_yard_prevailing_rule,
                side_yard_one_min_ft = EXCLUDED.side_yard_one_min_ft,
                side_yard_total_min_ft = EXCLUDED.side_yard_total_min_ft,
                rear_yard_min_ft = EXCLUDED.rear_yard_min_ft,
                max_height_ft = EXCLUDED.max_height_ft,
                max_stories = EXCLUDED.max_stories,
                max_building_coverage_pct = EXCLUDED.max_building_coverage_pct,
                max_impervious_coverage_pct = EXCLUDED.max_impervious_coverage_pct,
                max_far = EXCLUDED.max_far,
                extra_rules = EXCLUDED.extra_rules
            """,
            (
                muni_id, d["code"], d.get("name"), d.get("permitted_uses", []), d.get("notes"),
                lot.get("area_sqft"), lot.get("width_ft"), lot.get("depth_ft"),
                sb.get("front_yard_min"), sb.get("front_yard_prevailing_rule", False),
                sb.get("side_yard_one_min"), sb.get("side_yard_total_min"), sb.get("rear_yard_min"),
                h.get("feet"), h.get("stories"),
                cov.get("building"), cov.get("lot_impervious"),
                d.get("max_far"), json.dumps(d.get("extra_rules", {})),
            ),
        )
    n_districts = len(town["zoning_districts"])

    # cost model + tiers (only if a rate card was supplied)
    if rates is None:
        return muni_id, n_districts, 0

    prov = rates["provenance"]
    cur.execute(
        """
        INSERT INTO build_cost_models
            (municipality_id, provenance, regional_baseline_per_sqft, local_cost_factor)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (municipality_id) DO UPDATE SET
            provenance = EXCLUDED.provenance,
            regional_baseline_per_sqft = EXCLUDED.regional_baseline_per_sqft,
            local_cost_factor = EXCLUDED.local_cost_factor
        RETURNING id
        """,
        (muni_id, prov, rates.get("regional_baseline_per_sqft"), rates.get("local_cost_factor")),
    )
    model_id = cur.fetchone()[0]

    for tier_name, tier in rates["tiers"].items():
        cur.execute(
            """
            INSERT INTO build_cost_tiers
                (cost_model_id, tier, rate_per_sqft, provenance, formula_reference)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (cost_model_id, tier) DO UPDATE SET
                rate_per_sqft = EXCLUDED.rate_per_sqft,
                provenance = EXCLUDED.provenance,
                formula_reference = EXCLUDED.formula_reference
            """,
            (model_id, tier_name, tier["rate_per_sqft"], prov, tier.get("formula_reference")),
        )
    return muni_id, n_districts, len(rates["tiers"])


def process(slug: str, conn):
    town_path = TOWNS_DIR / f"{slug}.json"
    rates_path = RATES_DIR / f"{slug}.rates.json"

    if not town_path.exists():
        sys.exit(f"No town config at {town_path}")

    print(f"\n{slug}")
    town = load_json(town_path)
    validate(town, SCHEMA_DIR / "town.schema.json", "town config")

    rates = None
    if rates_path.exists():
        rates = load_json(rates_path)
        validate(rates, SCHEMA_DIR / "rates.schema.json", "rate card")
        if rates["slug"] != slug:
            sys.exit(f"  rate card slug '{rates['slug']}' != '{slug}'")
    else:
        print("  rate card: none found (zoning-only load) -- cost model skipped")

    with conn.cursor() as cur:
        muni_id, n_districts, n_tiers = upsert_town(cur, town, rates)
    conn.commit()
    print(f"  loaded: municipality id={muni_id}, {n_districts} district(s), {n_tiers} tier(s)")


def main():
    ap = argparse.ArgumentParser(description="Load a town config into Postgres.")
    ap.add_argument("slug", nargs="?", help="town slug, e.g. union-city-nj")
    ap.add_argument("--all", action="store_true", help="load every town in config/towns/")
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/demarco")
    conn = psycopg2.connect(dsn)

    try:
        if args.all:
            slugs = sorted(p.stem for p in TOWNS_DIR.glob("*.json"))
            if not slugs:
                sys.exit("No town configs found.")
            for s in slugs:
                process(s, conn)
        elif args.slug:
            process(args.slug, conn)
        else:
            ap.error("provide a slug or --all")
    finally:
        conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
