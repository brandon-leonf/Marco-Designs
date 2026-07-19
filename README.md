# Demarco — Buildable-Envelope & Build-Cost Configurator

Backend + data layer for Marco Design LLC's capstone tool. Given a lot and its
town's zoning, it computes the **maximum buildable square footage** and a
**tiered build-cost estimate** — with every number labelled by provenance.

This repo is the **schema, database, and config layer** (Brandon's ownership:
architecture, backend, schema, deployment). The rules engine and API build on
top of it.

## Architecture in one screen

**Zoning and cost live as data, never as code.** One town = one config file.
Adding a town or updating a price is a config edit, not a code change — which is
what makes the tool nationwide-ready and the final "load a brand-new town live"
demo possible.

The flow:

```
config/towns/<slug>.json        zoning rules (public, version controlled)
config/rates/<slug>.rates.json  tier rates (PROPRIETARY, git-ignored)
        │
        ▼   validated against config/schema/*.json
  scripts/load_town.py  ──upsert──►  Postgres / PostGIS
        │
        ▼
  states → municipalities → zoning_districts
                          → build_cost_models → build_cost_tiers
  parcels (NJGIN polygons, PostGIS geometry)
```

Three decisions worth knowing before you touch anything:

1. **Typed columns + a JSONB escape hatch.** The common zoning fields
   (setbacks, coverage, height, stories, min lot size, FAR) are real typed
   columns the engine reads directly. Anything a weird town does that doesn't
   fit — Highlands Act overlays, corner-lot exceptions — goes in the
   `extra_rules` / `overlays` JSONB columns, so one strange town never forces a
   migration.

2. **Parcels are stored in EPSG:3424 (NJ State Plane, US survey feet), not
   4326.** The core operation is "inset the polygon by the setbacks in feet."
   In a feet-based CRS that's `ST_Buffer(geom, -setback_ft)` with no
   reprojection, and `ST_Area` returns square feet directly. We reproject to
   4326 only for web display, in the API.

3. **Proprietary rates are physically separated.** Logically a town config is
   "zoning + rates," but the real rate figures live in a git-ignored
   `*.rates.json` file so zoning configs can be public while rates stay private
   (kickoff §9). Only the `*.rates.example.json` templates are committed. The
   loader merges the two by slug.

## Quickstart

```bash
# 1. Start Postgres + PostGIS
docker compose up -d

# 2. Python deps
pip install -r requirements.txt

# 3. Apply migrations
python scripts/migrate.py

# 4. Load a town (needs config/rates/union-city-nj.rates.json to exist locally;
#    copy it from the .example and fill in real figures)
python scripts/load_town.py union-city-nj      # one town
python scripts/load_town.py --all              # every town in config/towns/
```

Default `DATABASE_URL` is the docker-compose Postgres. For **Supabase**, set
`DATABASE_URL` to the connection string from Project Settings → Database
(`?sslmode=require`), then run the same migrate/load commands. CI can also
deploy migrations to Supabase automatically on pushes to `main` — set the
`SUPABASE_DB_URL` repo secret (Settings → Secrets and variables → Actions).

### React app

```bash
cd web
cp .env.example .env      # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

The app reads municipalities/districts/tiers through supabase-js. Migration
`0006_api_read_access.sql` makes the API strictly read-only (RLS, SELECT-only
policies), so the anon key in the browser can never write. Client-side
geometry mirrors the PostGIS functions for instant feedback
(`web/src/lib/envelope.js`); PostGIS stays authoritative, and Turf.js is the
chosen client library for real parcel polygons when those arrive.

### Deploy the frontend to GitHub Pages

The React app is static; GitHub Pages hosts it while Supabase remains the
database and API. The workflow in `.github/workflows/pages.yml` deploys the
`web/dist` build whenever `main` is updated.

One-time repository setup:

1. Open **Settings → Secrets and variables → Actions** and add repository
   secrets named `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` using the
   same public API values as `web/.env`.
2. Open **Settings → Pages → Build and deployment** and select **GitHub
   Actions** as the source.
3. Push to `main`, or open **Actions → Deploy web app to GitHub Pages** and
   choose **Run workflow**.

Never add `DATABASE_URL`, `SUPABASE_DB_URL`, or a Supabase service-role key to
the frontend build. Only the public project URL and anon key belong in Vite.
The Pages deployment will fail early if either required value is missing.

### Parcel zoning verification

Found parcels do **not** use the zoning dropdown. Migration
`0008_zoning_spatial_lookup.sql` stores municipal zoning polygons and exposes
`resolve_parcel_zoning(parcel_id)`, which intersects the parcel with the base
zoning layer, selects a district only when it covers at least 80% of the lot,
and returns explicit `boundary_conflict`, `unmapped`, `no_layer`, or
`rules_missing` statuses otherwise. The React app blocks the calculation for
all non-matched statuses.

Load a professionally georeferenced municipal GeoJSON layer with:

```bash
python scripts/import_zoning.py union-city-nj zoning.geojson \
  --source-url https://www.ucnj.com/_Content/pdf/ordinances/ATTACHMENT-A-Zoning-Map-July-2019.pdf \
  --source-date 2019-07-01
```

Union City's official July 2019 zoning map is currently published as a static
PDF, not a public feature service. Do not infer zoning from MOD-IV property use
or parcel class. Obtain GIS polygons from the municipality or professionally
digitize and QA the official map before importing. District polygons may be
loaded before all rule configs exist; those parcels safely return
`rules_missing` until the corresponding district rules are configured.

## Adding a new municipality

1. Copy an existing file in `config/towns/` to `config/towns/<slug>.json`.
   The slug is lowercase-hyphenated and must match the filename
   (e.g. `north-bergen-nj`).
2. Fill in the zoning districts. `scripts/validate_configs.py` (and CI) will
   tell you if a required field is missing.
3. If Marco Design has rates for the town, copy `<slug>.rates.example.json` to
   `<slug>.rates.json` and enter the figures (see below). If not, skip it — the
   town loads zoning-only and the cost model is added later.
4. `python scripts/load_town.py <slug>`.

No code changes. That's the point.

## Updating the rate card

Rates live in `config/rates/<slug>.rates.json` (git-ignored). Two cases:

- **Verified** (Marco Design builds in this town): set
  `"provenance": "verified"`, set `regional_baseline_per_sqft` and
  `local_cost_factor` to `null`, and hard-code each tier's `rate_per_sqft` from
  Marco Design's real figures.
- **Estimated** (no local figures): set `"provenance": "estimated"`, provide
  `regional_baseline_per_sqft` and `local_cost_factor`, and set each tier rate
  from the baseline × factor derivation.

The database enforces this contract: an estimated model must carry its
baseline+factor, a verified one must not. The provenance flag flows through to
the API so the UI can show the verified-vs-estimate badge.

Re-run `python scripts/load_town.py <slug>` after any edit — loads are
idempotent upserts.

## Layout

```
db/migrations/        ordered .sql migrations (run by scripts/migrate.py)
config/schema/        JSON Schemas that validate every config
config/towns/         per-town zoning (public)
config/rates/         per-town rates (proprietary, git-ignored; .example committed)
scripts/migrate.py        apply pending migrations
scripts/load_town.py      validate + upsert a town into the DB
scripts/validate_configs.py   schema-check all configs (CI fast-fail, pre-commit)
.github/workflows/ci.yml  validate configs, migrations+load+geometry checks on PostGIS,
                          React build, optional Supabase deploy on main
web/                  React (Vite) frontend: town/district picker, buildable-envelope
                      calculator with SVG plan view, tiered cost estimate with
                      verified/estimated badge
```

## What's here vs. what's next

**Here:** repo, CI, Postgres/PostGIS, the zoning+cost schema, config loader, and
reference geometry functions (`buildable_envelope`, `max_footprint_sqft`,
`max_buildable_sqft`) proving the geometry pipeline is wired up and unit-correct.

**Next (not this layer):** the parcel importer for NJGIN data, per-edge setback
offsetting in the rules engine (the reference functions use a single
conservative inset for now), the API, and the UI.
