// ArcGIS REST services — the preferred route for importing a zoning layer.
//
// When a municipality publishes zoning through ArcGIS (which most that publish
// it at all do), the layer is queryable directly and needs no download, no
// re-export, and no manual step that can be done differently next time. The
// service also states its own field names, geometry type and record limit, so
// the wizard can describe what it is about to import before importing it.
//
// Four URL shapes are accepted, because that is what an operator actually has
// on the clipboard: a layer URL, a service URL, an ArcGIS Online item page, and
// a bare item id. Everything resolves to a layer URL before any features move.
//
// Reference: https://developers.arcgis.com/rest/services-reference/enterprise/
// query-feature-service-layer.htm

import { polygonsFromFlatRings } from "./geometry.js";
import { gisFetch } from "./http.js";

/** Everything a query needs to know about one layer, from its own metadata. */
export async function describeArcgisLayer(layerUrl, signal) {
  const metadata = await fetchArcgis(layerUrl, { f: "json" }, signal);
  const formats = String(metadata.supportedQueryFormats ?? "").toLowerCase();

  return {
    layerUrl,
    id: metadata.id ?? null,
    name: metadata.name ?? "Layer",
    geometryType: metadata.geometryType ?? null,
    fields: (metadata.fields ?? [])
      .filter((field) => !/^esriFieldTypeGeometry$/i.test(field.type ?? ""))
      .map((field) => ({ name: field.name, alias: field.alias ?? field.name, type: field.type })),
    objectIdField:
      (metadata.fields ?? []).find((field) => field.type === "esriFieldTypeOID")?.name ??
      "OBJECTID",
    // A service's own page size is a ceiling, not a suggestion: asking for more
    // returns the ceiling anyway, and asking blind hides that the layer was cut
    // off at 1000 features.
    maxRecordCount: Number(metadata.maxRecordCount) || 1000,
    supportsGeojson: formats.includes("geojson"),
    supportsPagination: Boolean(
      metadata.advancedQueryCapabilities?.supportsPagination ?? metadata.supportsPagination
    ),
    canQuery: /query/i.test(String(metadata.capabilities ?? "Query")),
    extent: metadata.extent ?? null,
    copyrightText: metadata.copyrightText || null,
  };
}

/** The feature layers of a FeatureServer or MapServer, for the layer picker. */
export async function describeArcgisService(serviceUrl, signal) {
  const metadata = await fetchArcgis(serviceUrl, { f: "json" }, signal);
  const layers = (metadata.layers ?? [])
    // Group layers have no geometry of their own; they exist to nest others.
    .filter((layer) => layer.type !== "Group Layer" && layer.subLayerIds == null)
    .map((layer) => ({
      id: layer.id,
      name: layer.name,
      layerUrl: `${trimTrailingSlash(serviceUrl)}/${layer.id}`,
      geometryType: layer.geometryType ?? null,
    }));

  return {
    serviceUrl,
    name: metadata.mapName ?? metadata.serviceDescription ?? serviceName(serviceUrl),
    layers,
    copyrightText: metadata.copyrightText || null,
  };
}

/**
 * Read every feature of a layer as WGS84 GeoJSON.
 *
 * Two paging strategies, because service capabilities differ: modern services accept
 * `resultOffset`, and older ones have to be walked by object id. Both are needed
 * — a layer that supports neither cannot be imported completely, and returning
 * the first 1000 polygons of a 3000-polygon town silently would be the worst
 * outcome available.
 */
export async function readArcgisLayer(layer, { bbox = null, signal, onProgress } = {}) {
  if (!layer.canQuery) {
    throw new Error(
      `The layer "${layer.name}" does not allow queries, so its features cannot be read. ` +
        "Ask the municipality for a download of the layer, or for query access to be enabled."
    );
  }
  if (layer.geometryType && layer.geometryType !== "esriGeometryPolygon") {
    throw new Error(
      `The layer "${layer.name}" holds ${geometryTypeLabel(layer.geometryType)}, not polygons. ` +
        "Pick the layer that holds the district boundaries."
    );
  }

  const spatialFilter = bbox ? envelopeParams(bbox) : {};
  const total = await countArcgisFeatures(layer, spatialFilter, signal);
  const features = [];
  const report = () => onProgress?.({ loaded: features.length, total });
  report();

  if (layer.supportsPagination) {
    for (let offset = 0; ; offset += layer.maxRecordCount) {
      const page = await queryPage(
        layer,
        { ...spatialFilter, resultOffset: offset, resultRecordCount: layer.maxRecordCount },
        signal
      );
      features.push(...page.features);
      report();
      // A short page or an unset transfer-limit flag both mean the end. Checking
      // both matters: some services stop setting the flag on the final page and
      // others never set it at all.
      if (page.features.length === 0 || !page.exceededTransferLimit) break;
      if (total != null && features.length >= total) break;
    }
    return finish(features, total, layer);
  }

  // No pagination: ask for the ids, then fetch them in service-sized batches.
  const ids = await fetchObjectIds(layer, spatialFilter, signal);
  if (ids == null) {
    // Neither strategy is available. One unpaged request is still correct when
    // the layer is smaller than its own page limit, and a refusal otherwise.
    const page = await queryPage(layer, spatialFilter, signal);
    if (page.exceededTransferLimit || page.features.length >= layer.maxRecordCount) {
      throw new Error(
        `"${layer.name}" returns at most ${layer.maxRecordCount} features per request and ` +
          "supports neither paging nor id queries, so it cannot be read completely. " +
          "Download the layer as GeoJSON or a shapefile and upload the file instead."
      );
    }
    features.push(...page.features);
    return finish(features, total, layer);
  }

  for (let start = 0; start < ids.length; start += layer.maxRecordCount) {
    const batch = ids.slice(start, start + layer.maxRecordCount);
    const page = await queryPage(layer, { ...spatialFilter, objectIds: batch.join(",") }, signal);
    features.push(...page.features);
    report();
  }
  return finish(features, ids.length, layer);
}

function finish(features, total, layer) {
  return {
    features,
    crs: { isGeographic: true, name: "WGS 84 (requested from the service)", warnings: [] },
    layerName: layer.name,
    warnings:
      total != null && features.length !== total
        ? [
            `The service reported ${total} features and returned ${features.length}. ` +
              "Confirm the boundaries are complete before publishing.",
          ]
        : [],
  };
}

async function queryPage(layer, extra, signal) {
  const params = {
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    // Seven decimal places is about a centimetre — below the accuracy of any
    // zoning boundary, and a large saving on a county-sized payload.
    geometryPrecision: "7",
    f: layer.supportsGeojson ? "geojson" : "json",
    ...extra,
  };
  const body = await fetchArcgis(`${trimTrailingSlash(layer.layerUrl)}/query`, params, signal);

  if (layer.supportsGeojson && Array.isArray(body.features) && body.type === "FeatureCollection") {
    return {
      features: body.features.map((feature) => ({
        type: "Feature",
        properties: feature.properties ?? {},
        geometry: feature.geometry ?? null,
      })),
      exceededTransferLimit: Boolean(body.properties?.exceededTransferLimit ?? body.exceededTransferLimit),
    };
  }
  return {
    features: (body.features ?? []).map((feature) => ({
      type: "Feature",
      properties: feature.attributes ?? {},
      geometry: esriGeometryToGeoJson(feature.geometry),
    })),
    exceededTransferLimit: Boolean(body.exceededTransferLimit),
  };
}

async function countArcgisFeatures(layer, spatialFilter, signal) {
  try {
    const body = await fetchArcgis(
      `${trimTrailingSlash(layer.layerUrl)}/query`,
      { where: "1=1", returnCountOnly: "true", f: "json", ...spatialFilter },
      signal
    );
    return Number.isFinite(Number(body.count)) ? Number(body.count) : null;
  } catch {
    // The count is only used for the progress line and the completeness check.
    // A service that refuses it can still be read.
    return null;
  }
}

async function fetchObjectIds(layer, spatialFilter, signal) {
  try {
    const body = await fetchArcgis(
      `${trimTrailingSlash(layer.layerUrl)}/query`,
      { where: "1=1", returnIdsOnly: "true", f: "json", ...spatialFilter },
      signal
    );
    const ids = body.objectIds ?? body.properties?.objectIds;
    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ url shapes */

const ITEM_ID = /^[0-9a-f]{32}$/i;

/**
 * Work out what kind of ArcGIS URL this is without fetching it.
 *
 * `layer` can be queried immediately; `service` needs a layer chosen first;
 * `item` is an ArcGIS Online item that has to be resolved to a service URL.
 */
export function parseArcgisUrl(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  if (ITEM_ID.test(text)) return { kind: "item", itemId: text, portal: "https://www.arcgis.com" };

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  // An item page carries its id in the query string, and the portal it belongs
  // to in its own origin — an ArcGIS Enterprise portal is not arcgis.com.
  const itemId = url.searchParams.get("id");
  if (itemId && ITEM_ID.test(itemId) && /\/home\/item\.html$/i.test(url.pathname)) {
    return { kind: "item", itemId, portal: `${url.origin}${url.pathname.replace(/\/home\/item\.html$/i, "")}` };
  }
  const restItem = url.pathname.match(/\/sharing\/rest\/content\/items\/([0-9a-f]{32})/i);
  if (restItem) {
    return {
      kind: "item",
      itemId: restItem[1],
      portal: `${url.origin}${url.pathname.slice(0, url.pathname.indexOf("/sharing/rest"))}`,
    };
  }

  const server = url.pathname.match(/^(.*\/(?:Feature|Map)Server)(?:\/(\d+))?/i);
  if (server) {
    const base = `${url.origin}${server[1]}`;
    return server[2] == null
      ? { kind: "service", serviceUrl: base }
      : { kind: "layer", layerUrl: `${base}/${server[2]}`, serviceUrl: base };
  }
  return null;
}

/**
 * Resolve an ArcGIS Online / Enterprise item to the service behind it.
 *
 * The item is the shape of URL a person lands on from a search or a "view item"
 * link, and it is not queryable itself. Hosted feature layers point at a
 * service; a GeoJSON or shapefile item points at a file, which the operator
 * should download and upload rather than have this importer fetch blind.
 */
export async function resolveArcgisItem({ itemId, portal }, signal) {
  const base = `${trimTrailingSlash(portal || "https://www.arcgis.com")}/sharing/rest/content/items/${itemId}`;
  const item = await fetchArcgis(base, { f: "json" }, signal);
  const type = String(item.type ?? "");

  if (item.url && /Feature Service|Map Service/i.test(type)) {
    const parsed = parseArcgisUrl(item.url);
    if (parsed) return { ...parsed, title: item.title ?? null, snippet: item.snippet ?? null };
  }
  throw new Error(
    `ArcGIS item "${item.title ?? itemId}" is ${type || "an unsupported type"}, not a feature ` +
      "service. Open the item, download it as GeoJSON or a shapefile, and upload that file."
  );
}

/* ----------------------------------------------------------------- esri json */

/**
 * ArcGIS JSON geometry → GeoJSON.
 *
 * The important difference is polygons: `rings` is one flat list in which a
 * clockwise ring is an outer boundary and a counter-clockwise ring is a hole in
 * the one before it, exactly as in a shapefile. Reading that list as if each ring
 * were its own polygon turns every courtyard, lake and interior exclusion in the
 * layer into solid land.
 */
export function esriGeometryToGeoJson(geometry) {
  if (!geometry) return null;
  if (Array.isArray(geometry.rings)) {
    return polygonsFromFlatRings(geometry.rings.map(stripExtraOrdinates));
  }
  if (Array.isArray(geometry.paths)) {
    const paths = geometry.paths.map(stripExtraOrdinates).filter((path) => path.length >= 2);
    if (paths.length === 0) return null;
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0] }
      : { type: "MultiLineString", coordinates: paths };
  }
  if (Array.isArray(geometry.points)) {
    const points = stripExtraOrdinates(geometry.points);
    return points.length ? { type: "MultiPoint", coordinates: points } : null;
  }
  if (Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    return { type: "Point", coordinates: [geometry.x, geometry.y] };
  }
  return null;
}

function stripExtraOrdinates(points) {
  return (points ?? [])
    .filter((point) => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]))
    .map((point) => [point[0], point[1]]);
}

function geometryTypeLabel(type) {
  const labels = {
    esriGeometryPoint: "points",
    esriGeometryMultipoint: "points",
    esriGeometryPolyline: "lines",
    esriGeometryEnvelope: "rectangles",
  };
  return labels[type] ?? type;
}

/* ------------------------------------------------------------------- transport */

function envelopeParams(bbox) {
  return {
    geometry: JSON.stringify({
      xmin: bbox[0],
      ymin: bbox[1],
      xmax: bbox[2],
      ymax: bbox[3],
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  };
}

/**
 * One ArcGIS REST request.
 *
 * Requests go out as form-encoded POSTs. A `where`, an id list or an envelope can
 * push a GET past the URL length some servers accept, and ArcGIS has supported
 * POST on every query endpoint for far longer than any service still running.
 *
 * `gisFetch` handles the transport, including the fallback to the zoning proxy
 * for a service that sends no CORS headers. The error handling left here is the
 * part specific to ArcGIS: it reports failure in a 200 response body, so the
 * body has to be inspected rather than the status.
 */
async function fetchArcgis(endpoint, params, signal) {
  const body = new URLSearchParams({ f: "json", ...params });
  const { response } = await gisFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `The ArcGIS service returned HTTP ${response.status} for ${endpoint}.` +
        (response.status === 403 ? " The layer may require a sign-in or an API key." : "")
    );
  }

  const payload = await response.json();
  if (payload?.error) {
    const details = Array.isArray(payload.error.details) ? payload.error.details.join(" ") : "";
    throw new Error(
      `The ArcGIS service rejected the request: ${payload.error.message ?? "unknown error"}. ${details}`.trim()
    );
  }
  return payload;
}

function trimTrailingSlash(url) {
  return String(url).replace(/\/+$/, "");
}

function serviceName(serviceUrl) {
  const parts = trimTrailingSlash(serviceUrl).split("/");
  return parts[parts.length - 2] ?? "ArcGIS service";
}
