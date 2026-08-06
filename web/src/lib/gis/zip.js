// Minimal ZIP reader for the zoning-layer importer.
//
// Zipped shapefiles, KMZ and the occasional zipped GeoPackage all arrive as a
// single archive the operator downloaded from a municipal GIS portal, so the
// importer needs to open one without shipping a compression library. Browsers
// (and Node 18+) already contain an inflate implementation reachable through
// `DecompressionStream("deflate-raw")`, which is the only decoder a ZIP entry
// written by ArcGIS, ogr2ogr, QGIS or the OS archiver ever needs — those tools
// emit stored (method 0) or deflated (method 8) entries and nothing else.
//
// Only reading is supported, and only the parts of the format that identify and
// extract an entry. Anything outside that — encryption, ZIP64, unusual
// compression methods — is reported as an explicit error rather than guessed
// at, because a half-read zoning layer is worse than a refused one.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

// The end-of-central-directory record is 22 bytes plus a comment of up to
// 65535, so it can never start further back than this from the end.
const EOCD_MAX_SEARCH = 22 + 0xffff;

const STORED = 0;
const DEFLATED = 8;

/**
 * Open an archive and return its entries. Entry data is decompressed lazily:
 * a zipped shapefile carries `.shp`, `.dbf`, `.shx`, `.prj`, `.sbn` and often a
 * PDF of the map, and reading the ones we ignore would be wasted work on a
 * county-sized layer.
 */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);

  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error(
      "This archive uses the ZIP64 format, which this importer cannot read. " +
        "Re-export the layer as a plain zip, or upload the .shp/.dbf/.prj files' " +
        "GeoJSON equivalent instead."
    );
  }

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error("The archive's central directory is damaged or truncated.");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decodeName(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      // Bit 11 promises the name is UTF-8. Without it the format says CP437,
      // but every modern writer uses UTF-8 anyway and ASCII names — which is
      // what GIS exports have — decode identically under both.
      (flags & 0x800) !== 0
    );

    entries.push({
      name,
      // Directory members are recorded as zero-length names ending in "/".
      isDirectory: name.endsWith("/"),
      size: uncompressedSize,
      read: () =>
        readEntryData(bytes, view, {
          name,
          method,
          flags,
          localOffset,
          compressedSize,
          uncompressedSize,
        }),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries.filter((entry) => !entry.isDirectory);
}

/** Case-insensitive lookup by extension, ignoring any folder the export nested. */
export function findZipEntry(entries, extension) {
  const suffix = extension.toLowerCase();
  return (
    entries.find((entry) => {
      const base = entry.name.split("/").pop() ?? "";
      // macOS archives carry a parallel `__MACOSX/._name` resource fork for
      // every file. It has the right extension and none of the content.
      return !base.startsWith("._") && base.toLowerCase().endsWith(suffix);
    }) ?? null
  );
}

async function readEntryData(bytes, view, entry) {
  if ((entry.flags & 0x01) !== 0) {
    throw new Error(`"${entry.name}" is encrypted and cannot be read.`);
  }
  if (entry.localOffset + 30 > view.byteLength) {
    throw new Error(`"${entry.name}" points past the end of the archive.`);
  }
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    throw new Error(`"${entry.name}" has no local file header where the directory says it does.`);
  }

  // The local header repeats the name and extra fields with lengths of its own,
  // and the extra field is routinely a different length from the central
  // directory's copy, so the data offset has to come from this header.
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;

  if (entry.method === STORED) {
    return bytes.subarray(start, start + entry.uncompressedSize);
  }
  if (entry.method !== DEFLATED) {
    throw new Error(
      `"${entry.name}" uses ZIP compression method ${entry.method}, which this importer ` +
        "cannot read. Re-create the archive with standard deflate compression."
    );
  }
  return inflateRaw(bytes.subarray(start, start + entry.compressedSize));
}

/**
 * A streaming entry (bit 3) records its sizes in a trailing data descriptor
 * rather than in the header, so the compressed length can read as zero. Feeding
 * the decompressor everything from the start of the data is safe: the deflate
 * stream ends where it ends and the extra bytes are never consumed.
 */
export async function inflateRaw(compressed) {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "This browser cannot decompress zip archives. Upload the layer as GeoJSON instead."
    );
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(view) {
  const limit = Math.min(view.byteLength, EOCD_MAX_SEARCH);
  for (let back = 22; back <= limit; back += 1) {
    const offset = view.byteLength - back;
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      // A ZIP64 locator immediately before the record means the real directory
      // offsets live in the ZIP64 header, which readZip does not decode.
      const locator = offset - 20;
      if (locator >= 0 && view.getUint32(locator, true) === ZIP64_LOCATOR_SIGNATURE) {
        throw new Error(
          "This archive uses the ZIP64 format, which this importer cannot read. " +
            "Re-export the layer as a plain zip or as GeoJSON."
        );
      }
      return offset;
    }
  }
  throw new Error("This file is not a zip archive.");
}

function decodeName(bytes, isUtf8) {
  return new TextDecoder(isUtf8 ? "utf-8" : "windows-1252").decode(bytes);
}
