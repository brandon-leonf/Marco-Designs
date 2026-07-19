#!/usr/bin/env python3
"""
migrate.py -- apply pending SQL migrations in filename order, once each.

Reads db/migrations/*.sql, checks the schema_migrations table, and applies any
file that hasn't run yet. Safe to run repeatedly and safe against Brandon's
partially-set-up database (already-applied files are skipped).

Usage:
    python scripts/migrate.py
    DATABASE_URL=postgresql://user:pass@host/db python scripts/migrate.py
"""

import os
import sys
from pathlib import Path

try:
    import psycopg2
except ImportError:
    sys.exit("Missing dependency: pip install psycopg2-binary")

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "db" / "migrations"


def applied_set(conn) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.schema_migrations')")
        if cur.fetchone()[0] is None:
            return set()  # first run, table doesn't exist yet
        cur.execute("SELECT filename FROM schema_migrations")
        return {r[0] for r in cur.fetchall()}


def main():
    dsn = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/demarco")
    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        sys.exit(f"No migrations in {MIGRATIONS}")

    done = applied_set(conn)
    pending = [f for f in files if f.name not in done]

    if not pending:
        print(f"Up to date ({len(files)} migration(s) already applied).")
        conn.close()
        return

    for f in pending:
        print(f"applying {f.name} ...", end=" ")
        with conn.cursor() as cur:
            cur.execute(f.read_text())
            cur.execute(
                "INSERT INTO schema_migrations (filename) VALUES (%s) "
                "ON CONFLICT (filename) DO NOTHING",
                (f.name,),
            )
        conn.commit()
        print("ok")

    conn.close()
    print(f"Applied {len(pending)} migration(s).")


if __name__ == "__main__":
    main()
