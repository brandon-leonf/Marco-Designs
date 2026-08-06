#!/usr/bin/env bash
# Regenerate the zoning-importer fixtures in scripts/fixtures.
#
# The readers in src/lib/gis are written from the format specifications, so they
# are verified against files written by a reference implementation rather than by
# themselves. GDAL is that reference: every fixture here is `ogr2ogr` output from
# one committed GeoJSON file, and verify-gis-import.mjs asserts that reading each
# container back reproduces it.
#
# Only needed when a fixture has to change. `npm run test:gis` needs Node alone,
# which is why the generated files are committed.
#
# Requires GDAL:  brew install gdal
#
# Usage: scripts/build-gis-fixtures.sh

set -euo pipefail

cd "$(dirname "$0")"
FIXTURES="fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v ogr2ogr >/dev/null || { echo "ogr2ogr not found; install GDAL first." >&2; exit 1; }

# EPSG:4269 (NAD83 geographic) on the source side and EPSG:3424 (NAD83 / NJ State
# Plane) on the target: both are NAD83, so no datum shift is folded into the
# expected coordinates and the round trip is a pure projection test. Declaring
# the source as EPSG:4326 instead would bake GDAL's WGS84->NAD83 transformation
# into the fixture, and the readers — which do not shift datums — would then look
# about 4 cm wrong for a reason that is not their doing.
SRC="$FIXTURES/zoning-source.geojson"
BIG="$WORK/big-source.geojson"

# A 150-vertex polygon with a 9.5 KB text attribute: one row larger than a
# SQLite page, which is what makes the GeoPackage overflow-page path run.
python3 - "$BIG" <<'PY'
import json, math, random, sys

random.seed(7)
points = [[-74.13 + 0.02 * random.random(), 41.04 + 0.02 * random.random()] for _ in range(150)]
cx = sum(p[0] for p in points) / len(points)
cy = sum(p[1] for p in points) / len(points)
points.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
points = [[round(x, 7), round(y, 7)] for x, y in points]
points.append(points[0])

json.dump(
    {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"ZONE": "R-1", "LONGNOTE": "overflow padding " * 560},
                "geometry": {"type": "Polygon", "coordinates": [points]},
            }
        ],
    },
    open(sys.argv[1], "w"),
)
PY

mkdir -p "$WORK/shp" "$WORK/kml"

ogr2ogr -f "ESRI Shapefile" -s_srs EPSG:4269 -t_srs EPSG:3424 "$WORK/shp/zoning.shp" "$SRC" -nln zoning
( cd "$WORK/shp" && zip -q -X zoning.zip zoning.shp zoning.shx zoning.dbf zoning.prj )
cp "$WORK/shp/zoning.zip" "$FIXTURES/zoning-3424.shp.zip"

ogr2ogr -f KML "$WORK/kml/zoning.kml" "$SRC" -nln zoning
cp "$WORK/kml/zoning.kml" "$FIXTURES/zoning.kml"
( cd "$WORK/kml" && zip -q -X zoning.kmz zoning.kml )
cp "$WORK/kml/zoning.kmz" "$FIXTURES/zoning.kmz"

ogr2ogr -f GPKG -s_srs EPSG:4269 -t_srs EPSG:3424 "$WORK/zoning.gpkg" "$SRC" -nln zoning_districts
ogr2ogr -f GPKG -update -append -s_srs EPSG:4269 -t_srs EPSG:3424 -nln big_overflow "$WORK/zoning.gpkg" "$BIG"
# Committed compressed: an empty GeoPackage is still ~100 KB of SQLite pages.
gzip -9 -c "$WORK/zoning.gpkg" > "$FIXTURES/zoning-3424.gpkg.gz"

# The overflow layer's expected output, back in NAD83 longitude/latitude.
rm -f "$FIXTURES/big-overflow-source.geojson"
ogr2ogr -f GeoJSON -s_srs EPSG:3424 -t_srs EPSG:4269 -lco COORDINATE_PRECISION=10 \
  "$FIXTURES/big-overflow-source.geojson" "$WORK/zoning.gpkg" big_overflow

echo "Fixtures written to $FIXTURES:"
ls -l "$FIXTURES"
