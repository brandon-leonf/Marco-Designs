// One entry point for every way a zoning layer can arrive.
//
// The setup wizard used to offer two options: draw the boundaries by hand, or
// upload a GeoJSON file. Drawing is the fallback of last resort — it is slow,
// it is only as accurate as the operator's mouse, and it produces a layer with
// no provenance beyond "someone traced this". Almost every municipality that
// publishes zoning at all publishes it as a service or a vector file, and this
// module reads those directly:
//
//   ArcGIS FeatureServer / MapServer layer   queried in place, no download
//   ArcGIS service or ArcGIS Online item     resolved to its layers first
//   OGC WFS endpoint                         queried in place, no download
//   GeoJSON                                  file or URL
//   Zipped shapefile                         file (.shp + .dbf + .prj)
//   KML / KMZ                                file
//   GeoPackage                               file
//
// What this module deliberately does not do is decide anything about zoning. It
// identifies a source, reads its polygons, converts them to WGS84, and proposes
// which attribute holds the district code — then stops. The operator confirms
// the field, confirms the mapping onto configured districts, tests an address,
// and publishes. An import is a faster way to get the boundaries onto the map,
// not a reason to trust them less carefully: `README.md` is explicit that zoning
// is never inferred, and a machine-read field name is still an inference until
// someone has looked at it.

import {
  describeArcgisLayer,
  describeArcgisService,
  parseArcgisUrl,
  readArcgisLayer,
  resolveArcgisItem,
} from "./gis/arcgis.js";
import { describeWfs, readWfsFeatureType } from "./gis/wfs.js";
import { readShapefileZip } from "./gis/shapefile.js";
import { readKml, readKmz } from "./gis/kml.js";
import { geoPackageLayers, readGeoPackage } from "./gis/geopackage.js";
import { featuresBbox, toPolygonal } from "./gis/geometry.js";
import { gisFetch, proxyRequestCount } from "./gis/http.js";
import { reprojectGeometry, resolveCrs } from "./gis/proj.js";
import { municipalGisSourceFor } from "./municipalGis.js";
import { municipalZoningCatalogFor } from "./municipalZoningCatalog.js";
import { njginMunicipalityExtent } from "./njgin.js";

/**
 * What a pasted URL looks like, without fetching anything.
 *
 * The wizard uses this to label the button and to explain what it is about to do
 * before it does it. A URL it cannot place is reported as `unknown` rather than
 * guessed at, because fetching an arbitrary URL the operator did not mean to
 * import is not a harmless mistake.
 */
export function classifyUrl(input) {
  const text = String(input ?? "").trim();
  if (!text) return { kind: "empty" };

  const arcgis = parseArcgisUrl(text);
  if (arcgis) {
    return {
      kind:
        arcgis.kind === "layer"
          ? "arcgis-layer"
          : arcgis.kind === "service"
            ? "arcgis-service"
            : "arcgis-item",
      label:
        arcgis.kind === "layer"
          ? "ArcGIS feature layer"
          : arcgis.kind === "service"
            ? "ArcGIS service"
            : "ArcGIS Online item",
      arcgis,
    };
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return { kind: "unknown" };
  }
  if (!/^https?:$/.test(url.protocol)) return { kind: "unknown" };

  const service = (url.searchParams.get("service") ?? "").toUpperCase();
  if (service === "WFS" || /\/(wfs|ows)\b/i.test(url.pathname)) {
    return { kind: "wfs", label: "OGC WFS service" };
  }
  if (/\.(geojson|json)$/i.test(url.pathname)) {
    return { kind: "geojson-url", label: "GeoJSON file" };
  }
  if (/\.(zip|kml|kmz|gpkg)$/i.test(url.pathname)) {
    // These are readable, but only after a cross-origin download that most
    // portals block. Saying so is more useful than a failed fetch.
    return {
      kind: "download-first",
      label: `${url.pathname.split(".").pop().toUpperCase()} download`,
    };
  }
  return { kind: "unknown" };
}

/**
 * Find a public polygon layer for a municipality and read the district codes it
 * actually contains. This is discovery, not publication: callers must label the
 * result for review, and no dimensional zoning rules are inferred from a code.
 *
 * Curated municipal adapters win. Otherwise ArcGIS Online is searched and each
 * promising public service is validated by loading polygons inside the NJGIN
 * municipality extent and finding a credible district-code attribute.
 */
export async function discoverMunicipalityZoningCodes(muni, { signal } = {}) {
  const name = String(muni?.name ?? "").trim();
  const stateCode = String(muni?.state_code ?? muni?.stateCode ?? "").trim().toUpperCase();
  if (!name || stateCode !== "NJ") return { status: "not_found" };

  const catalog = municipalZoningCatalogFor(name, stateCode);
  if (catalog) {
    return {
      status: "found",
      municipality: name,
      codes: catalog.districts.map((district) => ({
        code: district.code,
        name: district.name,
        count: null,
      })),
      codeField: "Official code",
      sourceTitle: catalog.title,
      sourceUrl: catalog.sourceUrl,
      layerUrl: null,
      provider: `${name} municipal code`,
      confidence: "ordinance_catalog",
    };
  }

  const bbox = await njginMunicipalityExtent(muni, signal);
  const curated = municipalGisSourceFor(name, stateCode);
  const candidates = curated
    ? [
        {
          title: `${name} official zoning layer`,
          url: curated.layerUrl,
          owner: curated.provider,
          where: curated.where ?? null,
          score: Number.POSITIVE_INFINITY,
          curated: true,
        },
      ]
    : await searchArcgisZoningCandidates({ name, bbox, signal });

  for (const candidate of candidates.slice(0, 8)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const source = await probeUrlSource(candidate.url, { signal });
      const layers = [...source.layers]
        .sort((a, b) => zoningLayerScore(b) - zoningLayerScore(a))
        .slice(0, 5);

      for (const layer of layers) {
        try {
          const loaded = await loadZoningLayer(layer.target, { bbox, signal });
          const features = filterFeaturesBySimpleWhere(loaded.features, candidate.where);
          const codeCandidate = rankCodeFields(features).find(
            (field) => field.score >= 48 && field.distinctCount >= 2 && field.distinctCount <= 180
          );
          if (!codeCandidate) continue;

          const nameCandidate = rankCodeFields(features, { namesInstead: true })[0] ?? null;
          const names = namesByCode(
            features,
            codeCandidate.name,
            nameCandidate?.score >= 45 ? nameCandidate.name : ""
          );
          const codes = distinctValues(features, codeCandidate.name)
            .filter(({ value }) => !/^(null|none|n\/a|not zoned|unclassified)$/i.test(value))
            .map(({ value, count }) => ({ code: value, name: names.get(value) ?? null, count }));
          if (codes.length < 2 || codes.length > 180 || !looksLikeDistrictCodeSet(codes)) continue;

          return {
            status: "found",
            municipality: name,
            codes,
            codeField: codeCandidate.name,
            sourceTitle: source.title || candidate.title,
            sourceUrl: source.sourceUrl || candidate.url,
            layerUrl: layer.target.layerUrl ?? candidate.url,
            provider: candidate.owner || source.attribution || null,
            confidence: candidate.curated ? "curated" : "detected",
          };
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          // A service often contains several layers. A non-polygon or empty
          // layer is not a failure until every promising layer has been tried.
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // ArcGIS search is fuzzy by design; an unreadable candidate is skipped.
    }
  }

  return { status: "not_found", municipality: name };
}

async function searchArcgisZoningCandidates({ name, bbox, signal }) {
  const place = name.replace(/["\\]/g, " ");
  const url = new URL("https://www.arcgis.com/sharing/rest/search");
  url.searchParams.set(
    "q",
    `("${place}" AND zoning) AND (type:"Feature Service" OR type:"Map Service")`
  );
  url.searchParams.set("f", "json");
  url.searchParams.set("num", "30");
  url.searchParams.set("sortField", "relevance");
  url.searchParams.set("sortOrder", "desc");
  if (bbox?.length === 4) url.searchParams.set("bbox", bbox.join(","));

  const { response } = await gisFetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`ArcGIS zoning search returned ${response.status}.`);
  const body = await response.json();
  if (body?.error) throw new Error(body.error.message ?? "ArcGIS zoning search failed.");

  return (body.results ?? [])
    .filter((item) => item.url)
    .map((item) => ({
      title: item.title ?? "ArcGIS zoning layer",
      url: item.url,
      owner: item.owner ?? null,
      score: arcgisZoningCandidateScore(item, name),
      curated: false,
    }))
    .filter((item) => Number.isFinite(item.score) && item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function arcgisZoningCandidateScore(item, municipality) {
  const title = String(item.title ?? "").toLowerCase();
  const titleWords = title.replace(/[_-]+/g, " ");
  const tags = (item.tags ?? []).join(" ").toLowerCase();
  const owner = String(item.owner ?? "").toLowerCase();
  const prose = `${title} ${tags} ${String(item.snippet ?? "").toLowerCase()}`;
  const place = municipality.toLowerCase();
  if (!/\bzoning\b|zoning[_-]|zone\s+district/.test(prose)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (title.includes(place)) score += 55;
  if (owner.replace(/[^a-z0-9]+/g, "").includes(place.replace(/[^a-z0-9]+/g, ""))) score += 30;
  if (/\bzoning\b/.test(titleWords)) score += 45;
  if (/\bzoning\b|zoning[_-]/.test(tags)) score += 18;
  if (/\b(final|official|online|districts?|map)\b/.test(titleWords)) score += 18;
  if (/authoritative/i.test(String(item.contentStatus ?? ""))) score += 25;
  if (/\b(test|in progress|inprogress|draft|school|parking|payment|flood|parcel)\b/.test(titleWords)) score -= 90;
  if (/\b(rehab|redevelopment|redev|project)\b/.test(titleWords)) score -= 65;
  return score;
}

function zoningLayerScore(layer) {
  const text = `${layer.label ?? ""} ${layer.detail ?? ""}`.toLowerCase();
  let score = 0;
  if (/\bzoning\b|zoning[_-]|zone\s+district/.test(text)) score += 50;
  if (/district|zone/.test(text)) score += 20;
  if (/label|line|point|annotation|address|parcel/.test(text)) score -= 30;
  return score;
}

function namesByCode(features, codeField, nameField) {
  const names = new Map();
  if (!nameField) return names;
  for (const feature of features) {
    const code = String(feature?.properties?.[codeField] ?? "").trim();
    const name = String(feature?.properties?.[nameField] ?? "").trim();
    if (code && name && !names.has(code)) names.set(code, name);
  }
  return names;
}

function filterFeaturesBySimpleWhere(features, where) {
  if (!where) return features;
  const match = String(where).match(/^\s*([A-Za-z0-9_]+)\s*=\s*'([^']*)'\s*$/);
  if (!match) return features;
  const [, field, expected] = match;
  return features.filter(
    (feature) =>
      String(feature?.properties?.[field] ?? "").trim().toLowerCase() === expected.toLowerCase()
  );
}

function looksLikeDistrictCodeSet(codes) {
  const codeLike = codes.filter(({ code }) => {
    const text = String(code).trim().toUpperCase();
    if (!text || text.length > 18) return false;
    // Codes are compact symbols (R1, C-2, I-1 (W), P/O), not neighborhood or
    // redevelopment subarea prose such as "Sunset Park" or "North Gateway".
    return /^[A-Z0-9./&-]+(?:\s+\([A-Z0-9./&-]+\))?$/.test(text);
  }).length;
  return codeLike / codes.length >= 0.7;
}

/**
 * Resolve a URL to the list of layers it offers.
 *
 * A layer URL resolves to itself, so the wizard can treat "one layer" and "pick
 * one of nine layers" identically and never has to special-case the common path.
 */
export async function probeUrlSource(input, { signal } = {}) {
  const classified = classifyUrl(input);
  const text = String(input ?? "").trim();

  switch (classified.kind) {
    case "arcgis-item": {
      const resolved = await resolveArcgisItem(classified.arcgis, signal);
      return probeUrlSource(resolved.layerUrl ?? resolved.serviceUrl, { signal });
    }
    case "arcgis-service": {
      const service = await describeArcgisService(classified.arcgis.serviceUrl, signal);
      const polygonLayers = service.layers.filter(
        (layer) => !layer.geometryType || layer.geometryType === "esriGeometryPolygon"
      );
      if (polygonLayers.length === 0) {
        throw new Error(
          `"${service.name}" publishes no polygon layers, so it holds no district boundaries.`
        );
      }
      return {
        kind: "arcgis",
        title: service.name,
        sourceUrl: service.serviceUrl,
        attribution: service.copyrightText,
        layers: polygonLayers.map((layer) => ({
          key: layer.layerUrl,
          label: layer.name,
          detail: `Layer ${layer.id}`,
          target: { kind: "arcgis", layerUrl: layer.layerUrl, sourceUrl: service.serviceUrl },
        })),
      };
    }
    case "arcgis-layer": {
      const layer = await describeArcgisLayer(classified.arcgis.layerUrl, signal);
      return {
        kind: "arcgis",
        title: layer.name,
        sourceUrl: layer.layerUrl,
        attribution: layer.copyrightText,
        layers: [
          {
            key: layer.layerUrl,
            label: layer.name,
            detail: `${layer.fields.length} fields`,
            target: { kind: "arcgis", layerUrl: layer.layerUrl, sourceUrl: layer.layerUrl, layer },
          },
        ],
      };
    }
    case "wfs": {
      const service = await describeWfs(text, signal);
      return {
        kind: "wfs",
        title: service.title,
        sourceUrl: service.endpoint,
        layers: service.featureTypes.map((type) => ({
          key: type.name,
          label: type.title,
          detail: type.name,
          target: { kind: "wfs", service, typeName: type.name, sourceUrl: service.endpoint },
        })),
      };
    }
    case "geojson-url":
      return {
        kind: "geojson",
        title: text.split("/").pop(),
        sourceUrl: text,
        layers: [
          {
            key: text,
            label: text.split("/").pop(),
            detail: "GeoJSON",
            target: { kind: "geojson-url", url: text, sourceUrl: text },
          },
        ],
      };
    case "download-first":
      throw new Error(
        `A ${classified.label} has to be downloaded before it can be read. Save the file, then ` +
          "upload it on the Upload file tab."
      );
    case "empty":
      throw new Error("Enter the URL of a zoning layer.");
    default:
      throw new Error(
        "This URL is not a zoning source this importer recognises. Paste an ArcGIS " +
          "FeatureServer or MapServer layer URL, an ArcGIS Online item link, a WFS endpoint, " +
          "or a link to a .geojson file."
      );
  }
}

/**
 * Resolve a dropped or chosen file to the list of layers it contains.
 *
 * The bytes are read once and carried in the target, so choosing a layer from a
 * multi-layer GeoPackage does not re-read the file.
 */
export async function probeFileSource(file) {
  const name = String(file?.name ?? "layer");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = (name.split(".").pop() ?? "").toLowerCase();

  if (extension === "gpkg") {
    const layers = geoPackageLayers(bytes);
    if (layers.length === 0) throw new Error("This GeoPackage contains no feature layers.");
    return {
      kind: "geopackage",
      title: name,
      sourceUrl: "",
      layers: layers.map((layer) => ({
        key: layer.name,
        label: layer.title,
        detail: [layer.geometryType, layer.description].filter(Boolean).join(" · ") || layer.name,
        target: { kind: "geopackage", bytes, layerName: layer.name, fileName: name },
      })),
    };
  }

  const kind =
    extension === "zip"
      ? "shapefile"
      : extension === "kmz"
        ? "kmz"
        : extension === "kml"
          ? "kml"
          : extension === "geojson" || extension === "json"
            ? "geojson-text"
            : null;
  if (!kind) {
    throw new Error(
      `"${name}" is not a format this importer reads. Upload a .geojson, zipped shapefile ` +
        "(.zip), .kml, .kmz or .gpkg file."
    );
  }

  return {
    kind,
    title: name,
    sourceUrl: "",
    layers: [
      { key: name, label: name, detail: describeExtension(extension), target: { kind, bytes, fileName: name } },
    ],
  };
}

/**
 * Read a probed layer into WGS84 polygons.
 *
 * Every source converges here, so the normalization every consumer depends on
 * happens exactly once: geometry reduced to Polygon/MultiPolygon with RFC 7946
 * winding, features without area dropped and counted, and the result checked
 * against the bounds it should be in.
 */
export async function loadZoningLayer(target, { bbox = null, signal, onProgress } = {}) {
  const proxyRequestsBefore = proxyRequestCount();
  const raw = await readTarget(target, { bbox, signal, onProgress });
  const viaProxy = proxyRequestCount() > proxyRequestsBefore;

  let dropped = 0;
  const features = [];
  for (const feature of raw.features) {
    const geometry = toPolygonal(feature.geometry);
    if (!geometry) {
      dropped += 1;
      continue;
    }
    features.push({ type: "Feature", properties: feature.properties ?? {}, geometry });
  }

  if (features.length === 0) {
    if (raw.features.length > 0) {
      throw new Error(
        `All ${raw.features.length} features in this layer are points or lines. A zoning ` +
          "layer has to carry district boundaries as polygons."
      );
    }
    // An empty result under a bounding-box filter is the ordinary outcome of
    // pointing at the wrong town's service, and saying "this layer is empty"
    // would send the operator to check the service instead of the URL.
    throw new Error(
      bbox
        ? "This layer has no boundaries near this municipality. Either the service covers a " +
          "different area, or the layer is filed under another town — switch off the " +
          "municipality filter to load it in full and check."
        : "This layer contains no features."
    );
  }

  const bounds = featuresBbox(features);
  const warnings = [
    ...(raw.warnings ?? []),
    ...(dropped > 0
      ? [
          `${dropped} feature${dropped === 1 ? "" : "s"} carried no polygon and ${
            dropped === 1 ? "was" : "were"
          } skipped.`,
        ]
      : []),
    ...outOfRangeWarnings(bounds),
  ];

  return {
    features,
    bbox: bounds,
    meta: {
      kind: target.kind,
      layerName: raw.layerName ?? target.layerName ?? target.fileName ?? "Imported layer",
      sourceUrl: target.sourceUrl ?? "",
      crsName: raw.crs?.name ?? "WGS 84",
      featureCount: features.length,
      droppedCount: dropped,
      viaProxy,
    },
    warnings,
  };
}

async function readTarget(target, { bbox, signal, onProgress }) {
  switch (target.kind) {
    case "arcgis": {
      const layer = target.layer ?? (await describeArcgisLayer(target.layerUrl, signal));
      return readArcgisLayer(layer, { bbox, signal, onProgress });
    }
    case "wfs":
      return readWfsFeatureType(target.service, target.typeName, { bbox, signal, onProgress });
    case "geojson-url": {
      const response = await fetchOrExplain(target.url, signal);
      return readGeoJson(await response.text(), target.url.split("/").pop());
    }
    case "geojson-text":
      return readGeoJson(new TextDecoder("utf-8").decode(target.bytes), target.fileName);
    case "shapefile":
      return readShapefileZip(target.bytes);
    case "kml":
      return readKml(new TextDecoder("utf-8").decode(target.bytes));
    case "kmz":
      return readKmz(target.bytes);
    case "geopackage":
      return readGeoPackage(target.bytes, target.layerName);
    default:
      throw new Error(`Unsupported zoning source "${target.kind}".`);
  }
}

/**
 * Parse GeoJSON, including the one non-standard thing real files do: a `crs`
 * member naming a projected system. RFC 7946 removed `crs` and declared GeoJSON
 * to be WGS84 always, but exports from older ArcGIS and GeoServer versions still
 * carry it — and when one says EPSG:3424, its coordinates really are in feet.
 */
function readGeoJson(text, fileName) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`"${fileName}" is not valid JSON: ${error.message}`);
  }

  const features =
    parsed?.type === "FeatureCollection" && Array.isArray(parsed.features)
      ? parsed.features
      : parsed?.type === "Feature"
        ? [parsed]
        : parsed?.type && Array.isArray(parsed.coordinates)
          ? [{ type: "Feature", properties: {}, geometry: parsed }]
          : null;
  if (!features) {
    throw new Error(`"${fileName}" is JSON but not GeoJSON: it has no FeatureCollection.`);
  }

  const declared = declaredGeoJsonCrs(parsed);
  const crs = declared ? resolveCrs(declared) : { isGeographic: true, name: "WGS 84", warnings: [] };

  return {
    features: features.map((feature) => ({
      type: "Feature",
      properties: feature?.properties ?? {},
      geometry: crs.isGeographic ? feature?.geometry : reprojectGeometry(feature?.geometry, crs),
    })),
    crs,
    layerName: parsed.name ?? fileName?.replace(/\.(geo)?json$/i, "") ?? "GeoJSON layer",
    warnings: [
      ...crs.warnings,
      ...(declared
        ? [`This file declares ${crs.name}, so its coordinates were converted to longitude/latitude.`]
        : []),
    ],
  };
}

function declaredGeoJsonCrs(parsed) {
  const name = parsed?.crs?.properties?.name ?? parsed?.crs?.properties?.href;
  const code = String(name ?? "").match(/(?:EPSG|epsg)[:/]{1,2}(\d{4,6})/)?.[1];
  if (!code) return null;
  // CRS84 and 4326 are the default and need no conversion.
  return /^(4326|4979)$/.test(code) ? null : { epsg: code };
}

async function fetchOrExplain(url, signal) {
  const { response } = await gisFetch(url, {
    headers: { Accept: "application/geo+json, application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response;
}

/**
 * A layer whose coordinates are not plausible longitude/latitude has been read
 * in the wrong projection, and the preview map would show an empty ocean rather
 * than an obvious error. Warn rather than refuse: the operator can see the map.
 */
function outOfRangeWarnings(bbox) {
  if (!bbox) return [];
  const [west, south, east, north] = bbox;
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return [
      "These coordinates are outside the valid range for longitude and latitude, so the layer's " +
        "projection was probably not read correctly. Do not publish it without checking the map.",
    ];
  }
  return [];
}

function describeExtension(extension) {
  const labels = {
    zip: "Zipped shapefile",
    kml: "KML",
    kmz: "KMZ",
    gpkg: "GeoPackage",
    geojson: "GeoJSON",
    json: "GeoJSON",
  };
  return labels[extension] ?? extension.toUpperCase();
}

/* ------------------------------------------------------- field identification */

// Field names that hold a district code, best first. A published layer uses one
// of these far more often than not: `ZONEDIST` is New York City's, `ZONE_CODE`
// and `ZONING` are the ArcGIS Living Atlas conventions, and `ZONE` is what most
// municipal exports settle on.
const CODE_FIELD_PATTERNS = [
  /^(zone|zoning)[_\s-]?(code|abbr\w*|class|dist\w*|sym\w*|id)?$/i,
  /^(zonedist\d*|zn[_\s-]?code|zoneclass|zone_type)$/i,
  /^(district|dist)[_\s-]?(code|abbr\w*|id)?$/i,
  /^(code|class|symbol|label|abbrev\w*)$/i,
];

// Fields that are structurally never a district code, however plausible their
// values look: identity, geometry measurements, and edit tracking.
const NEVER_CODE = /^(objectid|object_id|fid|gid|globalid|shape|shape_?(area|len\w*)|st_area|st_perimeter|area|acres?|perimeter|len\w*|created_?\w*|last_?edit\w*|editor|creator|x|y|lat\w*|lon\w*)$/i;

// Field names that hold the district's full name, for creating districts that
// are missing from the config with something better than a bare code.
const NAME_FIELD_PATTERNS = [
  /^(zone|zoning|district|dist)[_\s-]?(name|desc\w*|title|label|long\w*|full\w*)$/i,
  /^(name|description|descript|label|title|long_name)$/i,
];

/**
 * Rank the layer's attributes by how likely each is to hold the district code.
 *
 * The field name is the strongest signal but not a sufficient one — plenty of
 * layers call it `LABEL` or `SYMBOL`. So the values are scored too, against what
 * a set of district codes looks like: short, repeated across features, present on
 * nearly every feature, and not unique per row. A field that is unique per
 * feature is an identifier, and an identifier as the district code would make
 * every polygon its own district.
 */
export function rankCodeFields(features, { namesInstead = false } = {}) {
  const patterns = namesInstead ? NAME_FIELD_PATTERNS : CODE_FIELD_PATTERNS;
  const fields = new Map();

  for (const feature of features) {
    for (const [key, value] of Object.entries(feature?.properties ?? {})) {
      if (!fields.has(key)) fields.set(key, []);
      fields.get(key).push(value);
    }
  }

  const total = features.length;
  const candidates = [];

  for (const [name, values] of fields) {
    if (NEVER_CODE.test(name)) continue;
    const present = values.filter((value) => value != null && String(value).trim() !== "");
    if (present.length === 0) continue;

    const texts = present.map((value) => String(value).trim());
    const distinct = new Set(texts.map((text) => text.toUpperCase()));
    const coverage = present.length / total;
    const longest = Math.max(...texts.map((text) => text.length));
    const median = texts.map((text) => text.length).sort((a, b) => a - b)[Math.floor(texts.length / 2)];

    const nameRank = patterns.findIndex((pattern) => pattern.test(name));
    let score = nameRank >= 0 ? 60 - nameRank * 10 : 0;
    score += coverage * 20;

    if (namesInstead) {
      // A name is prose: longer than a code, and it may well be unique.
      if (median >= 4 && median <= 80) score += 10;
      if (texts.some((text) => /\s/.test(text))) score += 6;
    } else {
      // Codes are short, repeated, and drawn from a small vocabulary.
      if (longest <= 14) score += 12;
      if (median <= 8) score += 8;
      if (distinct.size > 1 && distinct.size <= Math.max(4, Math.min(80, total * 0.6))) score += 14;
      if (total > 5 && distinct.size === total) score -= 30;
      if (distinct.size === 1) score -= 8;
      // A pure number is a measurement or an id far more often than a zone code.
      if (texts.every((text) => /^-?\d+(\.\d+)?$/.test(text))) score -= 18;
      if (texts.some((text) => text.length > 40)) score -= 25;
    }

    candidates.push({
      name,
      score: Math.round(score),
      distinctCount: distinct.size,
      coverage: Math.round(coverage * 100),
      sample: [...distinct].slice(0, 6),
    });
  }

  return candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** The distinct non-empty values of one field, in display order. */
export function distinctValues(features, field) {
  const seen = new Map();
  for (const feature of features) {
    const raw = feature?.properties?.[field];
    const text = raw == null ? "" : String(raw).trim();
    if (!text) continue;
    if (!seen.has(text)) seen.set(text, 0);
    seen.set(text, seen.get(text) + 1);
  }
  return [...seen.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

/**
 * Compare a source code with a configured district code ignoring the
 * punctuation the two disagree about.
 *
 * A town's ordinance writes `R-1`, its GIS layer writes `R1`, and a third export
 * writes `R 1`. Those are the same district, and requiring the operator to
 * rename one to match the other would be busywork with a chance of introducing a
 * mistake. Case, whitespace and separators are therefore ignored — and nothing
 * else is: `R1` and `R1A` stay different districts.
 */
export function looseCodeKey(code) {
  return String(code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s._\-/]+/g, "");
}

/**
 * Propose a source-code → configured-district mapping.
 *
 * Exact matches are proposed first, then loose ones. A loose key that two
 * configured districts share is left unmapped rather than assigned to whichever
 * came first — if a town really has both `R-1` and `R1`, only the operator knows
 * which the layer means.
 */
export function matchDistrictCodes(sourceCodes, districts) {
  const exact = new Map();
  const loose = new Map();
  const ambiguous = new Set();

  for (const district of districts ?? []) {
    const code = String(district.code ?? "").trim();
    if (!code) continue;
    exact.set(code.toUpperCase(), code);
    const key = looseCodeKey(code);
    if (loose.has(key) && loose.get(key) !== code) ambiguous.add(key);
    else loose.set(key, code);
  }

  const mapping = {};
  const unmatched = [];
  const looseMatches = [];

  for (const sourceCode of sourceCodes) {
    const text = String(sourceCode ?? "").trim();
    if (!text) continue;
    const exactHit = exact.get(text.toUpperCase());
    if (exactHit) {
      mapping[text] = exactHit;
      continue;
    }
    const key = looseCodeKey(text);
    const looseHit = ambiguous.has(key) ? null : loose.get(key);
    if (looseHit) {
      mapping[text] = looseHit;
      looseMatches.push({ sourceCode: text, districtCode: looseHit });
      continue;
    }
    mapping[text] = "";
    unmatched.push(text);
  }

  return { mapping, unmatched, looseMatches };
}

/**
 * The districts a layer needs that the town's config does not have yet.
 *
 * Returned as `{ code, name }` so the wizard can offer to create them: the code
 * exactly as the source spells it, and a name from the layer's own name field
 * when one was identified. Creating a district here creates it with no rules,
 * which is the correct state — the polygon can be published and the parcel
 * resolver reports `rules_missing` until someone enters the ordinance's numbers.
 */
export function missingDistricts(features, codeField, nameField, districts) {
  const codes = distinctValues(features, codeField).map((entry) => entry.value);
  const { unmatched } = matchDistrictCodes(codes, districts);
  const names = new Map();

  if (nameField) {
    for (const feature of features) {
      const code = String(feature?.properties?.[codeField] ?? "").trim();
      const name = String(feature?.properties?.[nameField] ?? "").trim();
      if (code && name && !names.has(code)) names.set(code, name);
    }
  }
  return unmatched.map((code) => ({ code, name: names.get(code) ?? null }));
}
