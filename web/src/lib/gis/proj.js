// Coordinate reference systems for imported zoning layers.
//
// A municipal vector file almost never arrives in longitude/latitude. New
// Jersey layers are published in EPSG:3424 (NJ State Plane, US survey feet) —
// the same projection this application stores parcels in — and neighbouring
// states use their own State Plane zones or UTM. The database's publish RPC
// only accepts 4326 or 3424 GeoJSON, and the setup wizard has to draw the layer
// on a Leaflet map and point-test an address against it, so an imported file has
// to be converted to longitude/latitude before any of that can happen.
//
// Rather than depend on a full projection library, this module reads the CRS
// definition the file already carries (a shapefile's `.prj`, a GeoPackage's
// `gpkg_spatial_ref_sys.definition`) and inverts the four projection families
// those definitions actually use: Transverse Mercator (every State Plane TM
// zone and all of UTM), Lambert Conformal Conic (the State Plane LCC zones),
// Albers Equal Area (statewide layers), and spherical Mercator (web tiles).
// Anything else is refused by name, which is a diagnosable failure rather than
// a layer silently drawn in the wrong hemisphere.
//
// Formulas are the standard inverses from Snyder, *Map Projections — A Working
// Manual* (USGS Professional Paper 1395), chapters 8, 14 and 15.

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const US_SURVEY_FOOT = 1200 / 3937;

/** Longitude/latitude passthrough, used when a source is already geographic. */
export const WGS84 = {
  kind: "geographic",
  name: "WGS 84",
  isGeographic: true,
  warnings: [],
  inverse: (x, y) => [x, y],
};

/**
 * Well-known EPSG codes, for sources that report a code instead of a definition.
 *
 * Services are always asked for 4326 directly, so this table only has to cover
 * what a *file* can declare in place of full WKT: the geographic codes, web
 * Mercator, and the State Plane / UTM zones covering the region this tool
 * operates in. An unlisted code is an error, never an assumption.
 */
const EPSG_WKT = {
  4326: null,
  4269: null, // NAD83 geographic — within a metre of WGS84 for our purposes.
  4152: null, // NAD83(HARN) geographic.
  6318: null, // NAD83(2011) geographic.
  3857: webMercatorWkt(),
  900913: webMercatorWkt(),
  102100: webMercatorWkt(),
  3424: statePlaneTmWkt("NAD83 / New Jersey (ftUS)", -74.5, 38.83333333333333, 0.9999, 492125, 0, "US survey foot"),
  32111: statePlaneTmWkt("NAD83 / New Jersey", -74.5, 38.83333333333333, 0.9999, 150000, 0, "metre"),
  2263: statePlaneLccWkt("NAD83 / New York Long Island (ftUS)", -74, 40.16666666666667, 40.66666666666667, 41.03333333333333, 984250, 0, "US survey foot"),
  32118: statePlaneLccWkt("NAD83 / New York Long Island", -74, 40.16666666666667, 40.66666666666667, 41.03333333333333, 300000, 0, "metre"),
  2272: statePlaneLccWkt("NAD83 / Pennsylvania South (ftUS)", -77.75, 39.33333333333333, 39.93333333333333, 40.96666666666667, 1968500, 0, "US survey foot"),
  26918: utmWkt(18),
  26919: utmWkt(19),
  32618: utmWkt(18),
  32619: utmWkt(19),
};

/**
 * Resolve a CRS from whatever the source could tell us about it.
 *
 * `wkt` wins when present: it is the file's own statement about its coordinates,
 * parameters included, and needs no lookup table to be trusted. A bare code is
 * only usable if it is one we hold a definition for.
 */
export function resolveCrs({ wkt, epsg } = {}) {
  const text = String(wkt ?? "").trim();
  if (text) return crsFromWkt(text);

  const declared = String(epsg ?? "")
    .replace(/^\s*(?:urn:ogc:def:crs:)?epsg:+/i, "")
    .trim();
  const code = Number(declared);
  // An absent code is not code zero: `Number("")` is 0, and treating that as an
  // EPSG code would report a missing CRS as an unsupported one.
  if (!declared || !Number.isFinite(code)) {
    return {
      ...WGS84,
      warnings: [
        "This source declares no coordinate reference system. It is being read as " +
          "longitude/latitude; confirm on the map that the boundaries land on the town.",
      ],
    };
  }
  if (!(code in EPSG_WKT)) {
    throw new Error(
      `This layer is in EPSG:${code}, which this importer does not know how to convert. ` +
        "Re-export it as GeoJSON in WGS84 (EPSG:4326), or as a shapefile whose .prj file " +
        "carries the full projection definition."
    );
  }
  const definition = EPSG_WKT[code];
  return definition ? crsFromWkt(definition) : { ...WGS84, name: `EPSG:${code}` };
}

/** Build a CRS from an OGC WKT string (WKT1 or WKT2). */
export function crsFromWkt(wkt) {
  const root = parseWkt(wkt);
  const keyword = root.keyword.toUpperCase();
  const warnings = datumWarnings(wkt);

  if (/^(GEOGCS|GEOGCRS|GEODCRS|BASEGEOGCRS)$/.test(keyword)) {
    return { ...WGS84, name: root.name || "Geographic", warnings };
  }
  if (!/^(PROJCS|PROJCRS)$/.test(keyword)) {
    throw new Error(`Unsupported coordinate system definition "${root.keyword}".`);
  }

  const method = projectionMethod(root);
  const params = collectParameters(root);
  const ellipsoid = readEllipsoid(root);
  const unit = readLinearUnit(root);
  const inverse = inverseFor(method, params, ellipsoid, unit, root.name || "this layer");

  return {
    kind: "projected",
    name: root.name || method,
    method,
    unit: unit.name,
    isGeographic: false,
    warnings,
    inverse,
  };
}

/** Convert every coordinate of a GeoJSON geometry through a CRS's inverse. */
export function reprojectGeometry(geometry, crs) {
  if (!geometry || crs?.isGeographic) return geometry;
  const convert = (coords) =>
    typeof coords[0] === "number"
      ? crs.inverse(coords[0], coords[1])
      : coords.map(convert);

  if (geometry.type === "GeometryCollection") {
    return {
      type: "GeometryCollection",
      geometries: (geometry.geometries ?? []).map((child) => reprojectGeometry(child, crs)),
    };
  }
  if (!Array.isArray(geometry.coordinates)) return geometry;
  return { ...geometry, coordinates: convert(geometry.coordinates) };
}

/* ------------------------------------------------------------------ inverses */

function inverseFor(method, params, ellipsoid, unit, label) {
  const normalized = method.toLowerCase().replace(/[^a-z]/g, "");
  const toMeters = (value) => value * unit.toMeters;

  const x0 = toMeters(params.falseeasting ?? 0);
  const y0 = toMeters(params.falsenorthing ?? 0);
  const lon0 = (params.centralmeridian ?? params.longitudeofnaturalorigin ?? params.longitudeofcenter ?? 0) * RAD;
  const lat0 = (params.latitudeoforigin ?? params.latitudeofnaturalorigin ?? params.latitudeoffalseorigin ?? params.latitudeofcenter ?? 0) * RAD;
  const k0 = params.scalefactor ?? params.scalefactoratnaturalorigin ?? 1;

  if (normalized === "transversemercator" || normalized === "transversemercatorsouthorientated") {
    const tm = transverseMercator(ellipsoid, { lon0, lat0, k0 });
    return (x, y) => tm(toMeters(x) - x0, toMeters(y) - y0);
  }
  if (normalized === "mercatorauxiliarysphere" || normalized === "popularvisualisationpseudomercator" || normalized === "mercator1sp" || normalized === "mercator") {
    // Web Mercator is defined on a sphere of the ellipsoid's semi-major axis.
    const radius = ellipsoid.a;
    return (x, y) => [
      normalizeLongitude((toMeters(x) - x0) / radius * DEG + lon0 * DEG),
      (Math.PI / 2 - 2 * Math.atan(Math.exp(-(toMeters(y) - y0) / radius))) * DEG,
    ];
  }
  if (normalized.startsWith("lambertconformalconic")) {
    const lat1 = (params.standardparallel1 ?? params.latitudeof1ststandardparallel ?? lat0 * DEG) * RAD;
    const lat2 = (params.standardparallel2 ?? params.latitudeof2ndstandardparallel ?? lat1 * DEG) * RAD;
    const lcc = lambertConformalConic(ellipsoid, { lon0, lat0, lat1, lat2, k0 });
    return (x, y) => lcc(toMeters(x) - x0, toMeters(y) - y0);
  }
  if (normalized.startsWith("albers")) {
    const lat1 = (params.standardparallel1 ?? params.latitudeof1ststandardparallel ?? lat0 * DEG) * RAD;
    const lat2 = (params.standardparallel2 ?? params.latitudeof2ndstandardparallel ?? lat1 * DEG) * RAD;
    const aea = albersEqualArea(ellipsoid, { lon0, lat0, lat1, lat2 });
    return (x, y) => aea(toMeters(x) - x0, toMeters(y) - y0);
  }

  throw new Error(
    `${label} uses the "${method}" projection, which this importer cannot convert. ` +
      "Re-export the layer in WGS84 (EPSG:4326) and import that instead."
  );
}

function transverseMercator({ a, e2 }, { lon0, lat0, k0 }) {
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const ep2 = e2 / (1 - e2);
  const m0 = meridianArc(lat0, a, e2);

  return (x, y) => {
    const m = m0 + y / k0;
    const mu = m / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
    const phi1 =
      mu +
      ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
      ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
      ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
      ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = Math.tan(phi1);
    const c1 = ep2 * cosPhi1 * cosPhi1;
    const t1 = tanPhi1 * tanPhi1;
    const n1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
    const r1 = (a * (1 - e2)) / (1 - e2 * sinPhi1 * sinPhi1) ** 1.5;
    const d = x / (n1 * k0);

    const lat =
      phi1 -
      ((n1 * tanPhi1) / r1) *
        ((d * d) / 2 -
          ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
          ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);
    const lon =
      lon0 +
      (d -
        ((1 + 2 * t1 + c1) * d ** 3) / 6 +
        ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
        cosPhi1;

    return [normalizeLongitude(lon * DEG), lat * DEG];
  };
}

function lambertConformalConic({ a, e2 }, { lon0, lat0, lat1, lat2, k0 }) {
  const e = Math.sqrt(e2);
  const t = (phi) =>
    Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);

  const t1 = t(lat1);
  const t2 = t(lat2);
  const t0 = t(lat0);
  const m1 = m(lat1);
  // A one-standard-parallel definition sets both parallels to the origin
  // latitude, where the two-parallel formula for n degenerates to sin(lat0).
  const n =
    Math.abs(lat1 - lat2) < 1e-12
      ? Math.sin(lat1)
      : Math.log(m1 / m(lat2)) / Math.log(t1 / t2);
  const f = m1 / (n * t1 ** n);
  const rho0 = a * f * t0 ** n * k0;
  const scaledAf = a * f * k0;

  return (x, y) => {
    const dy = rho0 - y;
    const rho = Math.sign(n) * Math.sqrt(x * x + dy * dy);
    const theta = Math.atan2(Math.sign(n) * x, Math.sign(n) * dy);
    const tValue = (rho / scaledAf) ** (1 / n);
    return [normalizeLongitude((theta / n + lon0) * DEG), latitudeFromT(tValue, e) * DEG];
  };
}

function albersEqualArea({ a, e2 }, { lon0, lat0, lat1, lat2 }) {
  const e = Math.sqrt(e2);
  const q = (phi) => {
    const sinPhi = Math.sin(phi);
    return (
      (1 - e2) *
      (sinPhi / (1 - e2 * sinPhi * sinPhi) -
        (1 / (2 * e)) * Math.log((1 - e * sinPhi) / (1 + e * sinPhi)))
    );
  };
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);

  const m1 = m(lat1);
  const q1 = q(lat1);
  const n =
    Math.abs(lat1 - lat2) < 1e-12
      ? Math.sin(lat1)
      : (m1 * m1 - m(lat2) ** 2) / (q(lat2) - q1);
  const c = m1 * m1 + n * q1;
  const rho0 = (a * Math.sqrt(c - n * q(lat0))) / n;

  return (x, y) => {
    const dy = rho0 - y;
    const rho = Math.sqrt(x * x + dy * dy);
    const qValue = (c - (rho * rho * n * n) / (a * a)) / n;
    const theta = Math.atan2(Math.sign(n) * x, Math.sign(n) * dy);
    return [normalizeLongitude((lon0 + theta / n) * DEG), latitudeFromQ(qValue, e, e2) * DEG];
  };
}

function meridianArc(phi, a, e2) {
  return (
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi))
  );
}

/** Snyder 7-9: latitude from the isometric parameter t, by fixed-point iteration. */
function latitudeFromT(t, e) {
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let step = 0; step < 20; step += 1) {
    const sinPhi = Math.sin(phi);
    const next =
      Math.PI / 2 - 2 * Math.atan(t * ((1 - e * sinPhi) / (1 + e * sinPhi)) ** (e / 2));
    if (Math.abs(next - phi) < 1e-12) return next;
    phi = next;
  }
  return phi;
}

/** Snyder 3-16: latitude from the authalic parameter q, by Newton iteration. */
function latitudeFromQ(q, e, e2) {
  let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
  for (let step = 0; step < 20; step += 1) {
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const factor = 1 - e2 * sinPhi * sinPhi;
    const delta =
      ((factor * factor) / (2 * cosPhi)) *
      (q / (1 - e2) -
        sinPhi / factor +
        (1 / (2 * e)) * Math.log((1 - e * sinPhi) / (1 + e * sinPhi)));
    phi += delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return phi;
}

function normalizeLongitude(degrees) {
  if (degrees >= -180 && degrees <= 180) return degrees;
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/* ----------------------------------------------------------------- WKT input */

/**
 * Parse one WKT node into `{ keyword, name, values, children }`.
 *
 * WKT is a small nested-list grammar, and both bracket styles (`[]` and `()`)
 * are legal. Numbers stay numbers so parameters can be read without a second
 * conversion pass.
 */
function parseWkt(text) {
  let index = 0;
  const source = String(text);

  const skipSpace = () => {
    while (index < source.length && /[\s\n\r\t]/.test(source[index])) index += 1;
  };

  const parseNode = () => {
    skipSpace();
    const keywordStart = index;
    while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index += 1;
    const keyword = source.slice(keywordStart, index);
    skipSpace();

    const node = { keyword, name: "", values: [], children: [] };
    if (source[index] !== "[" && source[index] !== "(") return node;
    const close = source[index] === "[" ? "]" : ")";
    index += 1;

    for (;;) {
      skipSpace();
      if (index >= source.length) break;
      if (source[index] === close) {
        index += 1;
        break;
      }
      if (source[index] === ",") {
        index += 1;
        continue;
      }
      if (source[index] === '"') {
        index += 1;
        const start = index;
        while (index < source.length && source[index] !== '"') index += 1;
        const value = source.slice(start, index);
        index += 1;
        if (!node.name && node.values.length === 0) node.name = value;
        else node.values.push(value);
        continue;
      }
      if (/[-+0-9.]/.test(source[index])) {
        const start = index;
        while (index < source.length && /[-+0-9.eE]/.test(source[index])) index += 1;
        node.values.push(Number(source.slice(start, index)));
        continue;
      }
      if (/[A-Za-z]/.test(source[index])) {
        node.children.push(parseNode());
        continue;
      }
      index += 1;
    }
    return node;
  };

  const root = parseNode();
  if (!root.keyword) throw new Error("This coordinate system definition could not be read.");
  return root;
}

function findNode(node, keywords, depth = 0) {
  const wanted = keywords.map((keyword) => keyword.toUpperCase());
  if (wanted.includes(node.keyword.toUpperCase())) return node;
  if (depth > 8) return null;
  for (const child of node.children) {
    const found = findNode(child, keywords, depth + 1);
    if (found) return found;
  }
  return null;
}

function projectionMethod(root) {
  // WKT1 states the method as PROJECTION["..."]; WKT2 nests it in
  // CONVERSION[..., METHOD["..."]].
  const node = findNode(root, ["PROJECTION", "METHOD"]);
  if (!node?.name) throw new Error("This projected coordinate system names no projection method.");
  return node.name;
}

function collectParameters(node, into = {}, depth = 0) {
  if (node.keyword.toUpperCase() === "PARAMETER" && node.name) {
    const key = node.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const value = node.values.find((entry) => typeof entry === "number");
    if (typeof value === "number" && !(key in into)) into[key] = value;
  }
  // Do not descend into the base geographic CRS: its PRIMEM/UNIT nodes are not
  // projection parameters and WKT2 nests a whole GEOGCRS inside the PROJCRS.
  if (depth > 0 && /^(BASEGEOGCRS|GEOGCS|GEOGCRS)$/i.test(node.keyword)) return into;
  for (const child of node.children) collectParameters(child, into, depth + 1);
  return into;
}

function readEllipsoid(root) {
  const node = findNode(root, ["SPHEROID", "ELLIPSOID"]);
  const a = Number(node?.values?.find((value) => typeof value === "number"));
  const numbers = (node?.values ?? []).filter((value) => typeof value === "number");
  const invFlattening = Number(numbers[1]);
  if (!Number.isFinite(a) || a <= 0) {
    throw new Error("This coordinate system definition has no usable ellipsoid.");
  }
  // An inverse flattening of 0 is how WKT spells a sphere.
  const f = Number.isFinite(invFlattening) && invFlattening !== 0 ? 1 / invFlattening : 0;
  return { a, e2: 2 * f - f * f };
}

function readLinearUnit(root) {
  // The projected system's own UNIT is the first one at the top level; the
  // GEOGCS below it declares degrees, which must not be mistaken for it.
  const node = (root.children ?? []).find((child) =>
    /^(UNIT|LENGTHUNIT)$/i.test(child.keyword)
  );
  const factor = Number((node?.values ?? []).find((value) => typeof value === "number"));
  if (Number.isFinite(factor) && factor > 0) {
    return { name: node.name || "unit", toMeters: factor };
  }
  // Fall back on the name when the factor is missing, then on metres, which is
  // what an unqualified projected system means.
  if (/foot|feet/i.test(node?.name ?? "")) {
    return { name: node.name, toMeters: /us/i.test(node.name) ? US_SURVEY_FOOT : 0.3048 };
  }
  return { name: "metre", toMeters: 1 };
}

/**
 * NAD27 differs from WGS84 by up to about 100 metres in this region — enough to
 * move a zoning boundary across a street. The importer does not carry the datum
 * shift grids needed to correct it, so the operator is told plainly instead of
 * being handed a layer that is quietly offset.
 */
function datumWarnings(wkt) {
  if (/NAD[_\s]?27|Clarke[_\s]?1866/i.test(wkt)) {
    return [
      "This layer is on the NAD27 datum. Converting it without a datum shift leaves " +
        "boundaries up to roughly 100 metres off. Re-project it to NAD83 or WGS84 " +
        "before publishing.",
    ];
  }
  return [];
}

/* ---------------------------------------------------- built-in definitions */

function webMercatorWkt() {
  return (
    'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
    'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],' +
    'UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],' +
    'PARAMETER["central_meridian",0],PARAMETER["false_easting",0],' +
    'PARAMETER["false_northing",0],UNIT["metre",1]]'
  );
}

function nad83Geogcs() {
  return (
    'GEOGCS["NAD83",DATUM["North_American_Datum_1983",' +
    'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],' +
    'UNIT["degree",0.0174532925199433]]'
  );
}

function unitWkt(name) {
  return name === "metre"
    ? 'UNIT["metre",1]'
    : `UNIT["US survey foot",${US_SURVEY_FOOT}]`;
}

function statePlaneTmWkt(name, lon0, lat0, k0, x0, y0, unit) {
  return (
    `PROJCS["${name}",${nad83Geogcs()},PROJECTION["Transverse_Mercator"],` +
    `PARAMETER["latitude_of_origin",${lat0}],PARAMETER["central_meridian",${lon0}],` +
    `PARAMETER["scale_factor",${k0}],PARAMETER["false_easting",${x0}],` +
    `PARAMETER["false_northing",${y0}],${unitWkt(unit)}]`
  );
}

function statePlaneLccWkt(name, lon0, lat0, lat1, lat2, x0, y0, unit) {
  return (
    `PROJCS["${name}",${nad83Geogcs()},PROJECTION["Lambert_Conformal_Conic_2SP"],` +
    `PARAMETER["standard_parallel_1",${lat1}],PARAMETER["standard_parallel_2",${lat2}],` +
    `PARAMETER["latitude_of_origin",${lat0}],PARAMETER["central_meridian",${lon0}],` +
    `PARAMETER["false_easting",${x0}],PARAMETER["false_northing",${y0}],${unitWkt(unit)}]`
  );
}

function utmWkt(zone) {
  return statePlaneTmWkt(
    `UTM zone ${zone}N`,
    -183 + 6 * zone,
    0,
    0.9996,
    500000,
    0,
    "metre"
  );
}
