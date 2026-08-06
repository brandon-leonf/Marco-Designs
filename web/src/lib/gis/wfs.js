// OGC Web Feature Service — the standards-track equivalent of an ArcGIS layer.
//
// Towns running GeoServer, MapServer or QGIS Server publish through WFS rather
// than through ArcGIS REST. The shape of the exchange is the same: ask the
// service to describe itself, choose a feature type, then read its features.
//
// Only the GeoJSON output format is read. Every WFS implementation in current
// use offers it, and the alternative — GML — is a large XML dialect whose
// polygon encoding varies by version and by server; a half-understood GML parser
// producing plausible-looking boundaries is exactly the failure this importer
// must not have. A service offering no JSON output is reported as such, with the
// suggestion that turns it into a supported case.

import { childNamed, childrenNamed, findAll, parseXml, textOf } from "./xml.js";
import { gisFetch } from "./http.js";

const JSON_FORMAT = /^(application\/(geo\+)?json|geojson|json)$/i;

/** The feature types a service advertises, from GetCapabilities. */
export async function describeWfs(endpoint, signal) {
  const url = serviceUrl(endpoint, { service: "WFS", request: "GetCapabilities" });
  const text = await fetchText(url, signal);
  const root = parseXml(text);
  const capabilities = childNamed(root, "WFS_Capabilities") ?? root.children[0] ?? root;

  const version = capabilities.attributes?.version ?? "2.0.0";
  const outputFormats = findAll(capabilities, "Parameter")
    .filter((parameter) => parameter.attributes?.name === "outputFormat")
    .flatMap((parameter) => findAll(parameter, "Value").map((value) => value.text.trim()))
    .filter(Boolean);

  const featureTypes = findAll(capabilities, "FeatureType")
    .map((node) => {
      const name = textOf(node, "Name");
      if (!name) return null;
      return {
        name,
        title: textOf(node, "Title") ?? name,
        abstract: textOf(node, "Abstract"),
        // WFS 2.0 spells it DefaultCRS, 1.1.0 DefaultSRS, 1.0.0 SRS.
        defaultCrs: textOf(node, "DefaultCRS") ?? textOf(node, "DefaultSRS") ?? textOf(node, "SRS"),
        bbox: wgs84Bbox(node),
      };
    })
    .filter(Boolean);

  if (featureTypes.length === 0) {
    throw new Error(
      "This WFS advertises no feature types. Check the URL points at the service endpoint " +
        "(usually ending in /wfs or /ows)."
    );
  }

  return {
    endpoint: baseEndpoint(endpoint),
    version,
    featureTypes,
    jsonFormat: outputFormats.find((format) => JSON_FORMAT.test(format)) ?? null,
    outputFormats,
    title: textOf(childNamed(capabilities, "ServiceIdentification"), "Title") ??
      textOf(childNamed(capabilities, "Service"), "Title") ??
      "WFS service",
  };
}

/**
 * Read one feature type as WGS84 GeoJSON, paging until the service stops
 * returning features.
 *
 * The axis-order trap is the thing to know here. `EPSG:4326` formally declares
 * latitude first, and WFS 2.0 honours that in GML — so a service asked for
 * "EPSG:4326" may answer in latitude/longitude while GeoJSON requires
 * longitude/latitude. `CRS84` is the same datum with the axis order GeoJSON
 * needs and is what gets requested; the result is then checked, because a
 * service that ignores the request and answers in the other order would put New
 * Jersey in the Indian Ocean, and that is worth catching before it reaches a map.
 */
export async function readWfsFeatureType(service, typeName, { bbox = null, signal, onProgress } = {}) {
  if (!service.jsonFormat) {
    throw new Error(
      `This WFS offers no JSON output format (it advertises ${
        service.outputFormats.join(", ") || "none"
      }). Download the layer from the service as GeoJSON or a shapefile and upload the file.`
    );
  }

  const isWfs2 = String(service.version).startsWith("2");
  const typeParameter = isWfs2 ? "typeNames" : "typeName";
  const countParameter = isWfs2 ? "count" : "maxFeatures";
  const pageSize = 1000;

  const features = [];
  for (let startIndex = 0; ; startIndex += pageSize) {
    const url = serviceUrl(service.endpoint, {
      service: "WFS",
      version: service.version,
      request: "GetFeature",
      [typeParameter]: typeName,
      outputFormat: service.jsonFormat,
      srsName: "urn:ogc:def:crs:OGC:1.3:CRS84",
      [countParameter]: String(pageSize),
      startIndex: String(startIndex),
      ...(bbox ? { bbox: `${bbox.join(",")},urn:ogc:def:crs:OGC:1.3:CRS84` } : {}),
    });

    const body = JSON.parse(await fetchText(url, signal));
    if (body?.exceptions?.length) {
      throw new Error(`The WFS rejected the request: ${body.exceptions[0].text ?? "unknown error"}.`);
    }
    const page = Array.isArray(body?.features) ? body.features : [];
    features.push(
      ...page.map((feature) => ({
        type: "Feature",
        properties: feature.properties ?? {},
        geometry: feature.geometry ?? null,
      }))
    );
    onProgress?.({ loaded: features.length, total: numberOr(body?.totalFeatures, null) });

    if (page.length < pageSize) break;
    // A service that ignores startIndex would otherwise return the first page
    // forever. Stop when the count stops growing.
    if (features.length < startIndex + page.length) break;
  }

  assertLonLatOrder(features, typeName);
  return {
    features,
    crs: { isGeographic: true, name: "CRS84 (requested from the service)", warnings: [] },
    layerName: typeName,
    warnings: [],
  };
}

/**
 * Refuse a layer whose coordinates are latitude-first.
 *
 * Every longitude in the continental United States is outside the ±90 range a
 * latitude can occupy, so a swapped layer is detectable rather than merely
 * suspected. Only that unambiguous case is rejected.
 */
function assertLonLatOrder(features, typeName) {
  let sampled = 0;
  let suspicious = 0;
  const visit = (coords) => {
    if (sampled >= 200) return;
    if (typeof coords[0] === "number") {
      sampled += 1;
      if (Math.abs(coords[0]) <= 90 && Math.abs(coords[1]) > 90) suspicious += 1;
      return;
    }
    coords.forEach(visit);
  };
  for (const feature of features) {
    if (Array.isArray(feature.geometry?.coordinates)) visit(feature.geometry.coordinates);
  }

  if (sampled > 0 && suspicious === sampled) {
    throw new Error(
      `"${typeName}" came back with latitude before longitude, which this importer cannot ` +
        "correct safely. Request the layer in CRS84, or download it as GeoJSON and upload the file."
    );
  }
}

function wgs84Bbox(node) {
  const box = childNamed(node, "WGS84BoundingBox");
  if (box) {
    const lower = (textOf(box, "LowerCorner") ?? "").split(/\s+/).map(Number);
    const upper = (textOf(box, "UpperCorner") ?? "").split(/\s+/).map(Number);
    if (lower.length === 2 && upper.length === 2 && [...lower, ...upper].every(Number.isFinite)) {
      return [lower[0], lower[1], upper[0], upper[1]];
    }
  }
  // WFS 1.x uses an attribute-carrying element instead.
  const legacy = childrenNamed(node, "LatLongBoundingBox")[0];
  if (legacy) {
    const values = ["minx", "miny", "maxx", "maxy"].map((key) => Number(legacy.attributes[key]));
    if (values.every(Number.isFinite)) return values;
  }
  return null;
}

function serviceUrl(endpoint, params) {
  const url = new URL(baseEndpoint(endpoint));
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

/** The endpoint without any request parameters a pasted URL brought with it. */
function baseEndpoint(endpoint) {
  const url = new URL(String(endpoint).trim());
  for (const key of [...url.searchParams.keys()]) {
    if (/^(service|request|version|typenames?|outputformat|srsname|count|maxfeatures|startindex|bbox)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

async function fetchText(url, signal) {
  const { response } = await gisFetch(url, {
    headers: { Accept: "application/json, application/xml" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`The WFS returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  // An OGC service reports errors as an XML ExceptionReport, with a 200 status.
  if (/<(\w+:)?ExceptionReport/i.test(text)) {
    const message = text.match(/<(?:\w+:)?ExceptionText[^>]*>([\s\S]*?)<\//i)?.[1]?.trim();
    throw new Error(`The WFS returned an error: ${message || "unspecified exception"}.`);
  }
  return text;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
