// Zipped ESRI Shapefile → GeoJSON features.
//
// A shapefile is three files that have to be read together: `.shp` holds the
// geometry, `.dbf` holds the attribute table one record per shape in the same
// order, and `.prj` states the coordinate system the geometry is in. Municipal
// portals distribute them zipped, which is the only form this reader accepts —
// a lone `.shp` has no zone codes and no projection, and importing it would
// produce unlabelled polygons somewhere off the coast of Africa.
//
// Reference: ESRI Shapefile Technical Description (July 1998) for `.shp`, and
// the dBASE III/IV table format for `.dbf`.

import { findZipEntry, readZip } from "./zip.js";
import { closeRing, polygonsFromFlatRings } from "./geometry.js";
import { resolveCrs, reprojectGeometry } from "./proj.js";

// Shape types that enclose area. Z and M variants carry extra ordinates after
// the 2D ones, which are skipped: the record's own point count still describes
// the x/y block, so the same reader handles all three.
const POLYGON_TYPES = new Set([5, 15, 25]);
const NULL_SHAPE = 0;

/**
 * Read a zipped shapefile into WGS84 GeoJSON features.
 *
 * Returns the CRS that was applied and any warning it raised, so the wizard can
 * tell the operator what the file said about itself rather than presenting a
 * reprojection as if it were free.
 */
export async function readShapefileZip(bytes) {
  const entries = await readZip(bytes);
  const shp = findZipEntry(entries, ".shp");
  if (!shp) {
    throw new Error(
      "This archive contains no .shp file. Zip the whole shapefile — .shp, .dbf and " +
        ".prj together — and try again."
    );
  }

  const dbfEntry = findZipEntry(entries, ".dbf");
  const prjEntry = findZipEntry(entries, ".prj");
  const cpgEntry = findZipEntry(entries, ".cpg");

  const shapes = readShp(await shp.read());
  const attributes = dbfEntry
    ? readDbf(await dbfEntry.read(), cpgEntry ? decodeAscii(await cpgEntry.read()) : null)
    : [];

  // Without a .prj the numbers in the .shp are unlabelled. Reading them as
  // longitude/latitude is right for a WGS84 export and catastrophic for a State
  // Plane one, but the difference is unmissable on the preview map, so the layer
  // loads with the assumption stated rather than being refused outright.
  const crs = resolveCrs(prjEntry ? { wkt: decodeAscii(await prjEntry.read()) } : {});

  const features = shapes.map((geometry, index) => ({
    type: "Feature",
    properties: attributes[index] ?? {},
    geometry: geometry ? reprojectGeometry(geometry, crs) : null,
  }));

  return {
    features,
    crs,
    layerName: (shp.name.split("/").pop() ?? "").replace(/\.shp$/i, ""),
    warnings: [
      ...crs.warnings,
      ...(dbfEntry
        ? []
        : ["This archive has no .dbf attribute table, so the polygons carry no district codes."]),
      ...(prjEntry
        ? []
        : [
            "This archive has no .prj file, so its coordinates are being read as " +
              "longitude/latitude. Check the preview map before publishing.",
          ]),
    ],
  };
}

/* ------------------------------------------------------------------- geometry */

function readShp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 100 || view.getInt32(0, false) !== 9994) {
    throw new Error("The .shp file's header is not a shapefile header.");
  }

  const fileType = view.getInt32(32, true);
  if (!POLYGON_TYPES.has(fileType) && fileType !== NULL_SHAPE) {
    throw new Error(
      `This shapefile holds ${shapeTypeName(fileType)} geometry. A zoning layer has to be ` +
        "polygons; export the district boundaries rather than their labels or centrelines."
    );
  }

  const shapes = [];
  // The header records the file length in 16-bit words, including itself.
  const declaredEnd = Math.min(view.getInt32(24, false) * 2, view.byteLength);
  let cursor = 100;

  while (cursor + 12 <= declaredEnd) {
    // Record headers are big-endian; the shape content that follows is little.
    const contentLength = view.getInt32(cursor + 4, false) * 2;
    const contentStart = cursor + 8;
    if (contentLength <= 0 || contentStart + contentLength > view.byteLength) break;

    const shapeType = view.getInt32(contentStart, true);
    if (shapeType === NULL_SHAPE) {
      // A null shape is a real record with no geometry. It keeps its place so
      // the attribute rows stay aligned with the shapes.
      shapes.push(null);
    } else if (POLYGON_TYPES.has(shapeType)) {
      shapes.push(readPolygonRecord(view, contentStart));
    } else {
      shapes.push(null);
    }
    cursor = contentStart + contentLength;
  }
  return shapes;
}

function readPolygonRecord(view, start) {
  // 4 type + 32 bounding box, then the part index and point count.
  const partCount = view.getInt32(start + 36, true);
  const pointCount = view.getInt32(start + 40, true);
  const partsAt = start + 44;
  const pointsAt = partsAt + partCount * 4;

  const partStarts = [];
  for (let index = 0; index < partCount; index += 1) {
    partStarts.push(view.getInt32(partsAt + index * 4, true));
  }

  const rings = [];
  for (let part = 0; part < partCount; part += 1) {
    const from = partStarts[part];
    const to = part + 1 < partCount ? partStarts[part + 1] : pointCount;
    const ring = [];
    for (let point = from; point < to; point += 1) {
      const at = pointsAt + point * 16;
      ring.push([view.getFloat64(at, true), view.getFloat64(at + 8, true)]);
    }
    if (ring.length >= 3) rings.push(closeRing(ring));
  }
  return polygonsFromFlatRings(rings);
}

function shapeTypeName(type) {
  const names = {
    1: "point",
    3: "polyline",
    8: "multipoint",
    11: "point",
    13: "polyline",
    18: "multipoint",
    21: "point",
    23: "polyline",
    28: "multipoint",
    31: "multipatch",
  };
  return names[type] ?? `type ${type}`;
}

/* ----------------------------------------------------------------- attributes */

function readDbf(bytes, declaredEncoding) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 32) return [];

  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const decode = textDecoder(declaredEncoding, view.getUint8(29));

  const fields = [];
  for (let at = 32; at + 32 <= headerLength; at += 32) {
    // 0x0D terminates the field descriptor array.
    if (view.getUint8(at) === 0x0d) break;
    const nameBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + at, 11);
    const end = nameBytes.indexOf(0);
    fields.push({
      name: decode(nameBytes.subarray(0, end === -1 ? 11 : end)).trim(),
      type: String.fromCharCode(view.getUint8(at + 11)),
      length: view.getUint8(at + 16),
    });
  }

  const rows = [];
  for (let index = 0; index < recordCount; index += 1) {
    const recordStart = headerLength + index * recordLength;
    if (recordStart + recordLength > view.byteLength) break;
    // 0x2A marks a record deleted but leaves it in the file. The .shp keeps its
    // shape either way, so the row stays to preserve alignment.
    const deleted = view.getUint8(recordStart) === 0x2a;

    const row = {};
    let at = recordStart + 1;
    for (const field of fields) {
      const raw = decode(bytes.subarray(at, at + field.length)).trim();
      row[field.name] = deleted ? null : convertField(raw, field.type);
      at += field.length;
    }
    rows.push(row);
  }
  return rows;
}

function convertField(raw, type) {
  if (raw === "") return null;
  if (type === "N" || type === "F" || type === "O" || type === "B") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  if (type === "L") {
    if (/^[YyTt]$/.test(raw)) return true;
    if (/^[NnFf]$/.test(raw)) return false;
    return null;
  }
  if (type === "D") {
    // Stored as YYYYMMDD; anything else is passed through as written.
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : raw;
  }
  return raw;
}

/**
 * DBF predates Unicode. The language-driver byte names a code page, and a `.cpg`
 * sidecar overrides it — but the field that matters here is a short zone code,
 * so the practical requirement is that UTF-8 exports (now the common case) are
 * not mangled into mojibake. UTF-8 is therefore tried strictly first, and
 * windows-1252 catches the legacy files it rejects.
 */
function textDecoder(declaredEncoding, languageDriver) {
  const declared = String(declaredEncoding ?? "").trim().toLowerCase();
  if (declared) {
    const label = /utf-?8|65001/.test(declared)
      ? "utf-8"
      : /1252|ansi|latin1|iso-?8859-?1/.test(declared)
        ? "windows-1252"
        : declared;
    const decoder = tryDecoder(label);
    if (decoder) return (bytes) => decoder.decode(bytes);
  }
  // 0x57 is ANSI; the OEM code pages are all single-byte and windows-1252 is the
  // closest universally available approximation.
  const fallback = new TextDecoder(languageDriver === 0x57 ? "windows-1252" : "windows-1252");
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  return (bytes) => {
    try {
      return strictUtf8.decode(bytes);
    } catch {
      return fallback.decode(bytes);
    }
  };
}

function tryDecoder(label) {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

function decodeAscii(bytes) {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "").trim();
}
