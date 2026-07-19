#!/usr/bin/env python3
"""
validate_configs.py -- validate every town config and rate card against the
JSON schemas. No database needed, so CI can fail fast before spinning up Postgres.

Also runs as a pre-commit check. Exits non-zero on the first invalid file.
"""

import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit("Missing dependency: pip install jsonschema")

ROOT = Path(__file__).resolve().parent.parent
TOWNS_DIR = ROOT / "config" / "towns"
RATES_DIR = ROOT / "config" / "rates"
SCHEMA_DIR = ROOT / "config" / "schema"


def check(instance_path: Path, schema_path: Path) -> int:
    schema = json.load(open(schema_path))
    instance = json.load(open(instance_path))
    errors = sorted(Draft202012Validator(schema).iter_errors(instance),
                    key=lambda e: list(e.path))
    if errors:
        print(f"FAIL  {instance_path.relative_to(ROOT)}")
        for e in errors:
            loc = "/".join(str(p) for p in e.path) or "(root)"
            print(f"        {loc}: {e.message}")
        return len(errors)
    print(f"ok    {instance_path.relative_to(ROOT)}")
    return 0


def main():
    town_schema = SCHEMA_DIR / "town.schema.json"
    rates_schema = SCHEMA_DIR / "rates.schema.json"
    total = 0

    towns = sorted(TOWNS_DIR.glob("*.json"))
    if not towns:
        print("No town configs found.")
    for t in towns:
        total += check(t, town_schema)

    # Rate cards: validate both real (.rates.json, git-ignored locally) and
    # committed .example templates so structure stays correct in the repo.
    rate_files = sorted(RATES_DIR.glob("*.rates.json")) + sorted(RATES_DIR.glob("*.rates.example.json"))
    for r in rate_files:
        total += check(r, rates_schema)

    if total:
        print(f"\n{total} validation error(s).")
        sys.exit(1)
    print("\nAll configs valid.")


if __name__ == "__main__":
    main()
