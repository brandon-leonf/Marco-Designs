// KML / KMZ → GeoJSON features.
//
// Towns that publish their zoning through Google Earth or a "download as KML"
// button on a web map produce these. KML coordinates are longitude/latitude on
// WGS84 by specification, so unlike a shapefile there is no projection to
// resolve — but the attributes hide in three different places depending on which
// tool wrote the file, and all three have to be read or the polygons arrive
// without their zone codes.

import { findZipEntry, readZip } from "./zip.js";
import { closeRing, normalizeWinding } from "./geometry.js";
import { childNamed, childrenNamed, findAll, parseXml, textOf } from "./xml.js";

/** Read a `.kmz` archive: a zip whose first `.kml` entry is the document. */
export async function readKmz(bytes) {
  const entries = await readZip(bytes);
  const doc = findZipEntry(entries, ".kml");
  if (!doc) throw new Error("This .kmz archive contains no .kml document.");
  return readKml(new TextDecoder("utf-8").decode(await doc.read()));
}

/**
 * Read a KML document. Every `Placemark` holding an area geometry becomes one
 * feature; folders are flattened, but the folder path is kept as a property
 * because some towns file each district in its own named folder and that folder
 * name is the only place the district code appears.
 */
export function readKml(text) {
  const root = parseXml(text);
  const document = childNamed(root, "kml") ?? root;
  const schemas = readSchemas(document);

  const features = [];
  let skipped = 0;

  for (const placemark of findAll(document, "Placemark")) {
    const geometry = geometryOf(placemark);
    if (!geometry) {
      skipped += 1;
      continue;
    }
    features.push({
      type: "Feature",
      properties: {
        ...propertiesOf(placemark, schemas),
        ...(textOf(placemark, "name") ? { name: textOf(placemark, "name") } : {}),
        ...(folderPath(placemark, document) ? { folder: folderPath(placemark, document) } : {}),
      },
      geometry,
    });
  }

  if (features.length === 0) {
    throw new Error(
      "This KML contains no polygon placemarks. A zoning layer has to carry district " +
        "boundaries as polygons, not as pins or paths."
    );
  }

  return {
    features,
    crs: { isGeographic: true, name: "WGS 84 (KML)", warnings: [] },
    layerName: textOf(childNamed(document, "Document"), "name") ?? "KML layer",
    warnings: skipped
      ? [
          `${skipped} placemark${skipped === 1 ? "" : "s"} carried no polygon and ${
            skipped === 1 ? "was" : "were"
          } skipped.`,
        ]
      : [],
  };
}

/**
 * KML nests attributes in one of three shapes, and a file can use more than one:
 *
 *   ExtendedData > SchemaData > SimpleData name="ZONE"   (ogr2ogr, ArcGIS)
 *   ExtendedData > Data name="ZONE" > value              (Google Earth)
 *   description containing an HTML attribute table       (Google My Maps)
 *
 * The first two are read as real fields. The third is left in `description`
 * rather than scraped: guessing at table cells would invent field names that
 * look authoritative, and the operator can still map on the placemark name.
 */
function propertiesOf(placemark, schemas) {
  const properties = {};
  const extended = childNamed(placemark, "ExtendedData");
  if (extended) {
    for (const schemaData of childrenNamed(extended, "SchemaData")) {
      const schemaId = String(schemaData.attributes.schemaUrl ?? "").replace(/^#/, "");
      const fieldTypes = schemas[schemaId] ?? {};
      for (const simple of childrenNamed(schemaData, "SimpleData")) {
        const name = simple.attributes.name;
        if (name) properties[name] = castValue(simple.text.trim(), fieldTypes[name]);
      }
    }
    for (const data of childrenNamed(extended, "Data")) {
      const name = data.attributes.name;
      if (name) properties[name] = textOf(data, "value") ?? "";
    }
  }
  const description = textOf(placemark, "description");
  if (description) properties.description = description;
  return properties;
}

/** `Schema > SimpleField` declares each field's type, keyed by schema id. */
function readSchemas(document) {
  const schemas = {};
  for (const schema of findAll(document, "Schema")) {
    const id = schema.attributes.id ?? schema.attributes.name;
    if (!id) continue;
    const fields = {};
    for (const field of childrenNamed(schema, "SimpleField")) {
      if (field.attributes.name) fields[field.attributes.name] = field.attributes.type;
    }
    schemas[id] = fields;
  }
  return schemas;
}

function castValue(raw, type) {
  if (raw === "") return null;
  if (/^(int|uint|short|ushort|float|double)$/i.test(String(type ?? ""))) {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  if (/^bool$/i.test(String(type ?? ""))) return raw === "1" || /^true$/i.test(raw);
  return raw;
}

function geometryOf(placemark) {
  const polygons = [];
  for (const polygon of findAll(placemark, "Polygon")) {
    const rings = [];
    const outer = childNamed(polygon, "outerBoundaryIs");
    const outerRing = coordinatesOf(outer);
    if (!outerRing) continue;
    rings.push(outerRing);
    for (const inner of childrenNamed(polygon, "innerBoundaryIs")) {
      const hole = coordinatesOf(inner);
      if (hole) rings.push(hole);
    }
    polygons.push(rings);
  }
  if (polygons.length === 0) return null;

  return normalizeWinding(
    polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons }
  );
}

function coordinatesOf(boundary) {
  const ring = childNamed(boundary, "LinearRing");
  const text = textOf(ring, "coordinates");
  if (!text) return null;

  // "lon,lat[,alt]" tuples separated by any whitespace. Altitude is discarded:
  // the zoning layer is a plan-view boundary, and PostGIS receives 2D geometry.
  const points = text
    .trim()
    .split(/\s+/)
    .map((tuple) => {
      const [lon, lat] = tuple.split(",").map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    })
    .filter(Boolean);
  return points.length >= 3 ? closeRing(points) : null;
}

/** The names of the Folder elements enclosing a placemark, outermost first. */
function folderPath(placemark, document) {
  const path = [];
  const walk = (node, trail) => {
    for (const child of node.children) {
      if (child === placemark) {
        path.push(...trail);
        return true;
      }
      const nextTrail =
        child.name === "Folder" ? [...trail, textOf(child, "name") ?? ""] : trail;
      if (walk(child, nextTrail)) return true;
    }
    return false;
  };
  walk(document, []);
  return path.filter(Boolean).join(" / ") || null;
}
