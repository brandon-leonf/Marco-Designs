import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchZoningGeojson, fetchZoningProvenance } from "../lib/supabase.js";

/**
 * Interactive municipal zoning map.
 *
 * Shows the whole municipality's districts when one is selected, then zooms to
 * the parcel once an address is chosen. Polygons come from PostGIS as GeoJSON
 * (migration 0013) rather than a bundled file, so any town loaded into the
 * database gets a map without a code change — the same "add a town = a config
 * edit" property the rest of the tool has.
 *
 * The layer is drawn as what it is. Union City publishes its zoning only as a
 * PDF, so these polygons are derived from citable sources, and districts the
 * derivation could not reach (P-A, the redevelopment areas, HPOD/PPOD) are
 * absent. The caveat is rendered with the map, not buried in a doc.
 */

// Approximates the published Union City map so the two are recognisably the
// same document. Unknown codes fall back to a neutral grey rather than
// borrowing a colour that means something else.
const DISTRICT_COLORS = {
  "C-N": "#c0504d",
  "MU": "#cc66cc",
  "P-A": "#a6a6a6",
  "P": "#4f7942",
  "R": "#f2e34c",
  "R-1": "#f7ef9e",
  "R-2": "#efd97a",
};
const FALLBACK_COLORS = ["#2f6f4e", "#b45f36", "#4f67a8", "#9a5a9e", "#a07b16", "#287d89", "#8b4b55"];
const normalizeCode = (code) => String(code ?? "").trim().toUpperCase();
const districtColor = (code) => {
  const normalized = normalizeCode(code);
  if (DISTRICT_COLORS[normalized]) return DISTRICT_COLORS[normalized];
  let hash = 0;
  for (const character of normalized) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
};

// Matches the calculation guard in lib/envelope.js. Merely creating a
// district row makes it visible, but does not imply that enough rules have
// been published to calculate a buildable envelope safely.
function districtHasRules(district) {
  if (!district) return false;
  return (
    district.front_yard_min_ft != null &&
    district.rear_yard_min_ft != null &&
    district.max_building_coverage_pct != null &&
    district.max_stories != null &&
    (district.side_yard_one_min_ft != null || district.side_yard_total_min_ft != null)
  );
}

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export default function ZoningMap({
  muniSlug,
  muniName,
  districts = [],
  selectedDistrictCode = null,
  parcelGeojson,
  parcelLabel,
  // A lon/lat point for a property we could locate but have no parcel polygon
  // for — a geocoded address. Drawn as a pin so the map can still answer
  // "where is this", which is all the geocoder established.
  focusPoint = null,
  // The located property sits outside the zoning Marco Designs has imported,
  // so no district applies to it. Raises the red flag above the legend.
  unverified = false,
  // The published outline of the building standing on the parcel, drawn inside
  // it so the client can see what the detected footprint was measured from.
  buildingGeojson = null,
  // Click-to-identify. Given a handler, clicking anywhere on the map reports
  // the clicked lat/lon so the caller can look up whatever parcel is there.
  onPickPoint = null,
  // True while that lookup is in flight, so the map can say so and refuse to
  // stack a second query on top of the first.
  picking = false,
  pickError = null,
  headingLabel = "Property preview",
  note,
  onExpand,
  expanded = false,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const zoningLayerRef = useRef(null);
  const parcelLayerRef = useRef(null);
  const pointLayerRef = useRef(null);
  const buildingLayerRef = useRef(null);
  const muniBoundsRef = useRef(null);
  const pickMarkerRef = useRef(null);
  // The map is built once, so its click handler would capture the first render's
  // props forever. Route the click through a ref that every render refreshes.
  const pickRef = useRef({ onPickPoint, picking });
  pickRef.current = { onPickPoint, picking };

  const [zoning, setZoning] = useState(null);
  const [provenance, setProvenance] = useState(null);
  const [error, setError] = useState(null);
  const [zoomedToParcel, setZoomedToParcel] = useState(false);
  const districtByCode = new Map(
    districts.map((district) => [normalizeCode(district.code), district])
  );
  // The admin configuration is the public catalog of supported districts.
  // Imported polygons whose code has not been defined there stay hidden
  // instead of appearing as an unsupported "rules not published" district.
  const visibleZoning = (zoning ?? []).filter((area) =>
    districtByCode.has(normalizeCode(area.district_code))
  );

  // Create the map once; React never re-renders into this container.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = L.map(containerRef.current, {
      scrollWheelZoom: false, // a page-scroll trap otherwise; click to enable
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.on("click", () => map.scrollWheelZoom.enable());
    map.on("mouseout", () => map.scrollWheelZoom.disable());

    // Click-to-identify listens on the container, not on the map's own `click`.
    // Leaflet delivers a click to the topmost interactive layer and only falls
    // back to the map when nothing was hit — so with zoning polygons covering
    // the town, `map.on("click")` never fires where it matters most.
    const container = map.getContainer();
    const onContainerClick = (event) => {
      // Zoom buttons, attribution links and popup chrome are controls, not lots.
      if (event.target?.closest?.(".leaflet-control, .leaflet-popup")) return;
      // A pan ends in a click event; choosing a property does not.
      if (map.dragging?.moved()) return;
      const { onPickPoint: pick, picking: busy } = pickRef.current;
      if (!pick || busy) return;
      const { lat, lng } = map.mouseEventToLatLng(event);
      // Mark the spot straight away. The lookup takes a second or two, and the
      // click should be acknowledged where it landed, not after the answer.
      pickMarkerRef.current?.remove();
      pickMarkerRef.current = L.circleMarker([lat, lng], {
        radius: 6,
        color: "#8a6d1f",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 0.9,
        interactive: false,
      }).addTo(map);
      pick(lat, lng);
    };
    container.addEventListener("click", onContainerClick);
    map.setView([40.7795, -74.0246], 13); // Union City, until bounds arrive
    mapRef.current = map;
    return () => {
      container.removeEventListener("click", onContainerClick);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!muniSlug) return;
    let stale = false;
    setZoning(null);
    setError(null);
    Promise.all([fetchZoningGeojson(muniSlug), fetchZoningProvenance(muniSlug)])
      .then(([areas, prov]) => {
        if (stale) return;
        setZoning(areas);
        setProvenance(prov);
      })
      .catch((e) => !stale && setError(e.message ?? String(e)));
    return () => {
      stale = true;
    };
  }, [muniSlug]);

  // Draw the district polygons and remember the municipality's extent.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !zoning) return;

    zoningLayerRef.current?.remove();
    if (visibleZoning.length === 0) {
      zoningLayerRef.current = null;
      muniBoundsRef.current = null;
      return;
    }

    const layer = L.geoJSON(
      visibleZoning.map((area) => ({
        type: "Feature",
        geometry: area.geojson,
        properties: area,
      })),
      {
        style: (feature) => {
          const { district_code: code, is_overlay: overlay } = feature.properties;
          return {
            color: districtColor(code),
            weight: overlay ? 2 : 1,
            opacity: parcelGeojson ? 0 : 1,
            // Overlays sit on top of a base district, so they are outlined
            // rather than filled — the district underneath stays readable.
            fillOpacity: parcelGeojson ? 0 : overlay ? 0.05 : 0.45,
            dashArray: overlay ? "5 4" : undefined,
          };
        },
        onEachFeature: (feature, lyr) => {
          // With click-to-identify armed, a click means "what property is
          // this?" — a district popup would open over the parcel it just
          // selected, and the district is already named in the panel and the
          // legend. Leave the click to the lookup.
          if (pickRef.current.onPickPoint) return;
          const p = feature.properties;
          // A newly-created district may exist before an older polygon has
          // been backfilled with its district_id. Match by normalized code as
          // an immediate UI fallback; migration 0015 repairs the DB link.
          const district = districtByCode.get(normalizeCode(p.district_code));
          const districtName = p.district_name ?? district?.name;
          const name = districtName ? ` — ${escapeHtml(districtName)}` : "";
          const rules = p.has_rules || districtHasRules(district)
            ? ""
            : "<br><em>Rules have not been published for this district yet.</em>";
          lyr.bindPopup(
            `<strong>${escapeHtml(p.district_code)}${name}</strong>${p.is_overlay ? " (overlay)" : ""}${rules}`
          );
        },
      }
    ).addTo(map);

    zoningLayerRef.current = layer;
    muniBoundsRef.current = layer.getBounds();
    if (!parcelGeojson && !focusPoint) map.fitBounds(layer.getBounds(), { padding: [12, 12] });
  }, [zoning, districts, parcelGeojson]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom to the chosen property — its parcel polygon when one exists, otherwise
  // the geocoded point — and fall back to the whole town when cleared.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    parcelLayerRef.current?.remove();
    parcelLayerRef.current = null;
    pointLayerRef.current?.remove();
    pointLayerRef.current = null;

    // An out-of-coverage property is outlined in the same red as its flag, so
    // the map and the warning under it read as one statement.
    const outlineColor = unverified
      ? "#b3261e"
      : selectedDistrictCode
        ? districtColor(selectedDistrictCode)
        : "#2b2b2b";

    if (parcelGeojson) {
      const layer = L.geoJSON(parcelGeojson, {
        style: {
          color: outlineColor,
          weight: 3,
          fillColor: outlineColor,
          fillOpacity: unverified ? 0.12 : 0.36,
        },
      }).addTo(map);
      parcelLayerRef.current = layer;
      map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 19 });
      setZoomedToParcel(true);
      return;
    }

    // The detected building is drawn by its own effect below, since it can
    // appear and disappear without the parcel changing.

    if (focusPoint) {
      // A circle marker rather than L.marker: no icon asset to resolve through
      // the bundler, and a point is honestly a point, not a parcel.
      const marker = L.circleMarker([focusPoint.lat, focusPoint.lon], {
        radius: 9,
        color: outlineColor,
        weight: 3,
        fillColor: outlineColor,
        fillOpacity: 0.35,
      }).addTo(map);
      if (focusPoint.label) marker.bindPopup(escapeHtml(focusPoint.label));
      pointLayerRef.current = marker;
      map.setView([focusPoint.lat, focusPoint.lon], 18);
      setZoomedToParcel(true);
      return;
    }

    setZoomedToParcel(false);
    if (muniBoundsRef.current) map.fitBounds(muniBoundsRef.current, { padding: [12, 12] });
  }, [parcelGeojson, focusPoint, selectedDistrictCode, unverified]);

  // The detected building footprint, drawn over the parcel. Hatched rather
  // than solid: it is a published outline, not a surveyed one, and should not
  // read with the same authority as the parcel boundary.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    buildingLayerRef.current?.remove();
    buildingLayerRef.current = null;
    if (!buildingGeojson) return;
    buildingLayerRef.current = L.geoJSON(buildingGeojson, {
      interactive: false,
      style: {
        color: "#8a6d1f",
        weight: 2,
        dashArray: "4 3",
        fillColor: "#c8a94a",
        fillOpacity: 0.42,
      },
    }).addTo(map);
  }, [buildingGeojson]);

  // Union the polygon layer with the municipality's configured districts.
  // A configured district without geometry still belongs in the legend; it
  // is labelled honestly as not mapped rather than silently disappearing.
  const legendByCode = new Map();
  for (const area of visibleZoning) {
    const code = normalizeCode(area.district_code);
    const district = districtByCode.get(code);
    legendByCode.set(code, {
      ...area,
      district_code: code,
      district_name: area.district_name ?? district?.name ?? null,
      has_rules: Boolean(area.has_rules || districtHasRules(district)),
      has_polygon: true,
    });
  }
  for (const district of districts) {
    const code = normalizeCode(district.code);
    if (!legendByCode.has(code)) {
      legendByCode.set(code, {
        district_code: code,
        district_name: district.name,
        has_rules: districtHasRules(district),
        has_polygon: false,
      });
    }
  }
  const legend = [...legendByCode.values()].sort((a, b) =>
    a.district_code.localeCompare(b.district_code)
  );

  return (
    <div className={`zoning-map${expanded ? " expanded" : ""}`}>
      <div className="zoning-map-head">
        <div>
          <p className="eyebrow">{headingLabel}</p>
          <h3>
            {zoomedToParcel
              ? parcelLabel || "Selected property"
              : `${muniName ?? "Municipality"} districts`}
          </h3>
          {note && <p className="zoning-map-note">{note}</p>}
        </div>
        {zoomedToParcel && muniBoundsRef.current && (
          <div className="zoning-map-actions">
            <button
              type="button"
              className="text-button compact"
              onClick={() => mapRef.current?.fitBounds(muniBoundsRef.current, { padding: [12, 12] })}
            >
              View all {muniName ?? "town"}
            </button>
          </div>
        )}
      </div>

      <div className="zoning-map-canvas-shell">
        <div
          ref={containerRef}
          className={`zoning-map-canvas${onPickPoint ? " pickable" : ""}${picking ? " picking" : ""}`}
          role="application"
          aria-label={
            onPickPoint
              ? "Municipal zoning map — click a property to identify its address"
              : "Municipal zoning map"
          }
        />
        {onExpand && (
          <button
            type="button"
            className="boundary-map-expand zoning-map-expand"
            aria-label="Expand property map"
            title="Expand"
            onClick={onExpand}
          >
            ⛶
          </button>
        )}
      </div>

      {onPickPoint && (
        <p className={picking ? "map-pick-hint busy" : "map-pick-hint"} role="status">
          {picking ? (
            <>
              <span className="map-pick-spinner" aria-hidden="true" />
              Identifying the property you clicked…
            </>
          ) : (
            <>
              <span aria-hidden="true">✛</span>
              Click any property on the map to look up its address.
            </>
          )}
        </p>
      )}
      {pickError && !picking && <p className="status-line error-text">{pickError}</p>}

      {error && <p className="status-line error-text">Zoning layer failed to load: {error}</p>}
      {zoning && visibleZoning.length === 0 && (
        <p className="fine">
          No admin-defined zoning polygons are loaded for {muniName ?? "this municipality"}, so
          only the parcel boundary can be drawn.
        </p>
      )}

      {/* Sits with the legend deliberately: the legend is the claim that a
          colour means a district, and this is where that claim stops holding. */}
      {unverified && (
        <p className="zoning-unverified" role="status">
          <span className="unverified-flag" aria-hidden="true">
            ⚑
          </span>
          <strong>Zoning district not verified</strong>
        </p>
      )}

      {legend.length > 0 && (
        <ul className={unverified ? "zoning-legend dimmed" : "zoning-legend"}>
          {legend.map((a) => (
            <li key={a.district_code}>
              <i style={{ background: districtColor(a.district_code) }} aria-hidden="true" />
              <span>
                {a.district_code}
                {a.district_name ? ` — ${a.district_name}` : ""}
                {!a.has_polygon && <em> (no mapped polygon)</em>}
                {!a.has_rules && <em> (rules not published)</em>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {provenance?.limitations && (
        <p className="fine zoning-map-caveat">
          Derived zoning layer, not the municipal GIS record. {provenance.limitations}{" "}
          {provenance.source_map_url && (
            <a href={provenance.source_map_url} target="_blank" rel="noreferrer">
              Official zoning map →
            </a>
          )}
        </p>
      )}
    </div>
  );
}
