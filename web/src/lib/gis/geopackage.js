// GeoPackage (.gpkg) → GeoJSON features.
//
// A GeoPackage is the OGC's answer to the shapefile: one SQLite file holding the
// geometry, the attributes, and the coordinate system definition together, with
// no three-file bundle to keep in sync and no 10-character limit on field names.
// Municipal open-data portals increasingly publish zoning this way.
//
// Three tables carry everything this importer needs. `gpkg_contents` lists the
// layers, `gpkg_geometry_columns` says which column of a layer holds geometry,
// and `gpkg_spatial_ref_sys` holds the WKT for the layer's projection — so a
// GeoPackage, unlike a bare shapefile, can always state its own CRS.
//
// Reference: OGC GeoPackage Encoding Standard 1.3, clauses 1.1.2 (contents),
// 2.1.3 (geometry columns) and 2.1.3.1 (the GeoPackageBinary header).

import { openSqlite } from "./sqlite.js";
import { parseWkb } from "./wkb.js";
import { reprojectGeometry, resolveCrs, WGS84 } from "./proj.js";

const ENVELOPE_DOUBLES = { 0: 0, 1: 4, 2: 6, 3: 6, 4: 8 };

/**
 * List the feature layers in a GeoPackage without decoding any geometry.
 *
 * A county-wide file can hold parcels, zoning, overlays and streets side by
 * side, so the wizard has to be able to ask which layer the operator means
 * before spending time reading one.
 */
export function geoPackageLayers(bytes) {
  const database = openSqlite(bytes);
  if (!database.tables.has("gpkg_contents")) {
    throw new Error(
      "This SQLite file has no gpkg_contents table, so it is not a GeoPackage."
    );
  }

  const geometryColumns = database.tables.has("gpkg_geometry_columns")
    ? database.readTable("gpkg_geometry_columns")
    : [];
  const byTable = new Map(geometryColumns.map((row) => [row.table_name, row]));

  return database
    .readTable("gpkg_contents")
    .filter((row) => row.data_type === "features")
    .map((row) => ({
      name: row.table_name,
      title: row.identifier || row.table_name,
      description: row.description || null,
      geometryColumn: byTable.get(row.table_name)?.column_name ?? "geom",
      geometryType: byTable.get(row.table_name)?.geometry_type_name ?? null,
      srsId: Number(byTable.get(row.table_name)?.srs_id ?? row.srs_id ?? 4326),
      bbox: [row.min_x, row.min_y, row.max_x, row.max_y].every((value) => Number.isFinite(value))
        ? [row.min_x, row.min_y, row.max_x, row.max_y]
        : null,
    }));
}

/**
 * Read one feature layer into WGS84 GeoJSON. With no layer named, the only
 * feature layer is used — and a file holding several is an error rather than a
 * silent pick, because "the first table" is not a choice anyone made.
 */
export function readGeoPackage(bytes, layerName = null) {
  const database = openSqlite(bytes);
  const layers = geoPackageLayers(bytes);
  if (layers.length === 0) {
    throw new Error("This GeoPackage contains no feature layers.");
  }

  const layer = layerName
    ? layers.find((entry) => entry.name === layerName)
    : layers.length === 1
      ? layers[0]
      : null;
  if (!layer) {
    throw new Error(
      layerName
        ? `This GeoPackage has no layer named "${layerName}".`
        : `This GeoPackage holds ${layers.length} layers (${layers
            .map((entry) => entry.name)
            .join(", ")}). Choose which one is the zoning layer.`
    );
  }

  const crs = crsForSrs(database, layer.srsId);
  const rows = database.readTable(layer.name);
  const features = [];
  let unreadable = 0;

  for (const row of rows) {
    const blob = row[layer.geometryColumn];
    let geometry = null;
    if (blob instanceof Uint8Array) {
      try {
        geometry = readGeoPackageBinary(blob);
      } catch {
        // One unreadable blob in a large layer should not lose the rest of it.
        // The count is surfaced so the gap is visible rather than silent.
        unreadable += 1;
      }
    }

    const properties = { ...row };
    delete properties[layer.geometryColumn];
    // Any remaining blob column (a photo, a stored PDF) cannot become a GeoJSON
    // property value, and is reported by size rather than dropped without trace.
    for (const [key, value] of Object.entries(properties)) {
      if (value instanceof Uint8Array) properties[key] = `<${value.byteLength} bytes>`;
      else if (typeof value === "bigint") properties[key] = value.toString();
    }

    features.push({
      type: "Feature",
      properties,
      geometry: geometry ? reprojectGeometry(geometry, crs) : null,
    });
  }

  return {
    features,
    crs,
    layerName: layer.title,
    layers,
    warnings: [
      ...crs.warnings,
      ...(unreadable
        ? [`${unreadable} row${unreadable === 1 ? "" : "s"} held geometry that could not be read.`]
        : []),
    ],
  };
}

/**
 * Strip the GeoPackageBinary header and decode the WKB inside it.
 *
 * The header states its own byte order, an optional cached envelope whose size
 * depends on a 3-bit indicator, and the SRS id. The envelope is skipped rather
 * than trusted: it is a cache, the geometry behind it is authoritative, and a
 * stale envelope in a hand-edited file would move a district.
 */
function readGeoPackageBinary(blob) {
  if (blob.byteLength < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) {
    throw new Error("This geometry value is not GeoPackage binary.");
  }
  const flags = blob[3];
  const envelopeIndicator = (flags >> 1) & 0x07;
  if (!(envelopeIndicator in ENVELOPE_DOUBLES)) {
    throw new Error("This geometry has an invalid envelope indicator.");
  }
  // Bit 4 marks an empty geometry: the header is present and there is nothing
  // after it worth reading.
  const isEmpty = (flags & 0x10) !== 0;
  const headerLength = 8 + ENVELOPE_DOUBLES[envelopeIndicator] * 8;
  if (isEmpty || blob.byteLength <= headerLength) return null;
  return parseWkb(blob, headerLength);
}

/**
 * The CRS for an SRS id, from the file's own definition when it has one.
 *
 * GeoPackage reserves two ids for "no CRS": -1 (undefined Cartesian) and 0
 * (undefined geographic). Both are treated as longitude/latitude with a warning,
 * since a zoning layer that declines to say where it is has to be checked on the
 * map either way.
 */
function crsForSrs(database, srsId) {
  if (srsId === 4326 || srsId === 4979) return WGS84;
  if (srsId === -1 || srsId === 0 || !Number.isFinite(srsId)) {
    return {
      ...WGS84,
      name: "undeclared",
      warnings: [
        "This GeoPackage declares no coordinate reference system for the layer. It is " +
          "being read as longitude/latitude; check the preview map before publishing.",
      ],
    };
  }

  const row = database.tables.has("gpkg_spatial_ref_sys")
    ? database
        .readTable("gpkg_spatial_ref_sys")
        .find((entry) => Number(entry.srs_id) === Number(srsId))
    : null;

  // Newer writers add `definition_12_063` holding WKT2 beside the WKT1
  // `definition`; either is readable, and "undefined" is the standard's
  // placeholder for a definition that was never filled in.
  const wkt = [row?.definition, row?.definition_12_063]
    .map((value) => String(value ?? "").trim())
    .find((value) => value && !/^undefined$/i.test(value));

  return resolveCrs(wkt ? { wkt } : { epsg: srsId });
}
