// Well-Known Binary → GeoJSON geometry.
//
// GeoPackage stores each feature's geometry as WKB, so the importer needs a
// reader for it. Z and M ordinates are parsed and dropped: the zoning layer is
// consumed as a plan-view polygon, PostGIS receives 2D GeoJSON, and carrying an
// elevation through would only invite it to be mistaken for one.

const GEOJSON_TYPES = {
  1: "Point",
  2: "LineString",
  3: "Polygon",
  4: "MultiPoint",
  5: "MultiLineString",
  6: "MultiPolygon",
  7: "GeometryCollection",
};

/**
 * Decode one WKB geometry. Handles both ISO WKB (type codes offset by 1000 for
 * Z, 2000 for M, 3000 for ZM) and PostGIS EWKB (high bits flagging Z, M and an
 * embedded SRID), because exports written by different tools use both.
 */
export function parseWkb(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor = { at: offset, view };
  return readGeometry(cursor);
}

function readGeometry(cursor) {
  const littleEndian = cursor.view.getUint8(cursor.at) === 1;
  cursor.at += 1;

  const raw = cursor.view.getUint32(cursor.at, littleEndian);
  cursor.at += 4;

  // EWKB flags live in the high bits; ISO WKB encodes the same information by
  // adding thousands to the base type. Both reduce to a base type plus a
  // dimension count.
  const hasEwkbZ = (raw & 0x80000000) !== 0;
  const hasEwkbM = (raw & 0x40000000) !== 0;
  const hasSrid = (raw & 0x20000000) !== 0;
  const base = raw & 0x0fffffff;
  const isoModifier = Math.floor(base / 1000);
  const type = base % 1000;

  const dimensions =
    2 +
    (hasEwkbZ || isoModifier === 1 || isoModifier === 3 ? 1 : 0) +
    (hasEwkbM || isoModifier === 2 || isoModifier === 3 ? 1 : 0);

  if (hasSrid) cursor.at += 4;

  const geometryType = GEOJSON_TYPES[type];
  if (!geometryType) throw new Error(`Unsupported WKB geometry type ${type}.`);

  const readUint32 = () => {
    const value = cursor.view.getUint32(cursor.at, littleEndian);
    cursor.at += 4;
    return value;
  };
  const readPoint = () => {
    const x = cursor.view.getFloat64(cursor.at, littleEndian);
    const y = cursor.view.getFloat64(cursor.at + 8, littleEndian);
    cursor.at += 8 * dimensions;
    return [x, y];
  };
  const readRing = () => {
    const count = readUint32();
    const ring = [];
    for (let index = 0; index < count; index += 1) ring.push(readPoint());
    return ring;
  };

  switch (geometryType) {
    case "Point": {
      const point = readPoint();
      // WKB spells an empty point as NaN coordinates.
      return Number.isNaN(point[0]) ? null : { type: "Point", coordinates: point };
    }
    case "LineString":
      return { type: "LineString", coordinates: readRing() };
    case "Polygon": {
      const ringCount = readUint32();
      const rings = [];
      for (let index = 0; index < ringCount; index += 1) rings.push(readRing());
      return { type: "Polygon", coordinates: rings };
    }
    case "MultiPoint":
    case "MultiLineString":
    case "MultiPolygon": {
      const count = readUint32();
      const parts = [];
      for (let index = 0; index < count; index += 1) {
        // Each member carries its own byte order and type header.
        const child = readGeometry(cursor);
        if (child) parts.push(child.coordinates);
      }
      return { type: geometryType, coordinates: parts };
    }
    case "GeometryCollection": {
      const count = readUint32();
      const geometries = [];
      for (let index = 0; index < count; index += 1) {
        const child = readGeometry(cursor);
        if (child) geometries.push(child);
      }
      return { type: "GeometryCollection", geometries };
    }
    default:
      throw new Error(`Unsupported WKB geometry type ${type}.`);
  }
}
