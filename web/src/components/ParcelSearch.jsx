import { useCallback, useEffect, useId, useRef, useState } from "react";
import { geocodeAddress, locateCurrentPosition } from "../lib/geocode.js";
import {
  findNjginParcelAtPoint,
  searchNjginParcelsAnywhere,
} from "../lib/njgin.js";

const fmt = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Address-first property lookup with no municipality prerequisite.
 *
 * 1. Census geocodes the entered address and reports its jurisdiction.
 * 2. For a New Jersey point, NJGIN finds the containing statewide parcel.
 * 3. The selected row travels to App, which independently checks whether that
 *    municipality has local zoning rules and pricing.
 *
 * A statewide NJGIN address-text search is retained only as a last resort when
 * Census cannot match an otherwise valid New Jersey property address.
 */
/**
 * `alwaysShowForm` keeps the address field mounted even once a property is
 * selected. Step 1 collapses to a single button because the chosen property
 * already occupies that row; the expanded map dialog is a search surface in its
 * own right, so there the field has to stay usable.
 */
export default function ParcelSearch({
  selected,
  onSelect,
  onClear,
  alwaysShowForm = false,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [stage, setStage] = useState("geocode");
  const [error, setError] = useState(null);
  const [location, setLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(null);
  const controllerRef = useRef(null);
  const locationControllerRef = useRef(null);
  const addressInputId = useId();

  const clearSelection = () => {
    controllerRef.current?.abort();
    setQuery("");
    setResults(null);
    setError(null);
    onClear();
  };

  const requestCurrentLocation = useCallback(async () => {
    if (
      locationControllerRef.current &&
      !locationControllerRef.current.signal.aborted
    ) return;
    locationControllerRef.current?.abort();
    const controller = new AbortController();
    locationControllerRef.current = controller;
    setLocating(true);
    setLocationError(null);
    try {
      const position = await locateCurrentPosition(controller.signal);
      if (!controller.signal.aborted) setLocation(position);
    } catch (lookupError) {
      if (!controller.signal.aborted) {
        setLocationError(lookupError.message ?? String(lookupError));
      }
    } finally {
      if (locationControllerRef.current === controller) {
        locationControllerRef.current = null;
        if (!controller.signal.aborted) setLocating(false);
      }
    }
  }, []);

  // Ask as soon as the public property search appears. Browsers own the
  // permission prompt and remember the visitor's choice; a denial leaves the
  // normal full-address search available and the button below provides a retry.
  useEffect(() => {
    requestCurrentLocation();
    return () => {
      controllerRef.current?.abort();
      locationControllerRef.current?.abort();
    };
  }, [requestCurrentLocation]);

  const useCurrentLocation = () => {
    if (location) {
      locationControllerRef.current?.abort();
      setLocation(null);
      setLocationError(null);
      return;
    }
    requestCurrentLocation();
  };

  const submit = async (event) => {
    event.preventDefault();
    const address = query.trim();
    if (address.length < 5 || searching) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSearching(true);
    setStage("geocode");
    setError(null);
    setResults(null);

    try {
      const rows = await lookupAddress(
        address,
        (next) => !controller.signal.aborted && setStage(next),
        controller.signal,
        location
      );
      if (!controller.signal.aborted) setResults(rows);
    } catch (lookupError) {
      if (!controller.signal.aborted) {
        setError(lookupError.message ?? String(lookupError));
      }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };

  if (selected && !alwaysShowForm) {
    return (
      <div className="parcel-search selected-mode">
        <button type="button" className="ghost" onClick={clearSelection}>
          Choose a different property
        </button>
      </div>
    );
  }

  const parcelRows = (results ?? []).filter((row) => row.kind === "parcel");
  const addressRows = (results ?? []).filter((row) => row.kind === "place");

  return (
    <div className="parcel-search address-first-search">
      <form className="address-search-form" onSubmit={submit}>
        <div className="address-search-field">
          <span className="address-search-label-row">
            <label htmlFor={addressInputId}>Property address</label>
            <button
              type="button"
              className={location ? "location-button active" : "location-button"}
              onClick={useCurrentLocation}
              disabled={locating}
              aria-pressed={Boolean(location)}
            >
              {/* The button keeps one name in every state. Its active styling
                  and the status line below already say location is in use. */}
              <span aria-hidden="true">⌖</span>{" "}
              {locating ? "Allow location…" : "Use current location"}
            </button>
          </span>
          <input
            id={addressInputId}
            type="search"
            placeholder={
              location ? "Street address (nearby matches first)" : "Street, city, state, ZIP"
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="street-address"
          />
        </div>
        <button
          type="submit"
          className="primary"
          disabled={query.trim().length < 5 || searching}
        >
          {searching ? "Finding property…" : "Find property"}
        </button>
      </form>
      {location && (
        <p className="fine location-bias-status" role="status">
          <span aria-hidden="true">⌖</span> Nearby address matches will appear first.
        </p>
      )}
      {locationError && (
        <p className="fine location-error" role="status">
          {locationError} Entering the city, state, or ZIP still works.
        </p>
      )}

      {error && <p className="fine error-text">Property lookup failed: {error}</p>}
      {searching && (
        <p className="lookup-progress" role="status">
          <span className={stage === "geocode" ? "active" : "done"}>1. Geocoding address</span>
          <span className={stage === "fallback" ? "done" : stage === "parcel" ? "active" : ""}>
            2. Finding New Jersey parcel
          </span>
          <span className={stage === "fallback" ? "active" : ""}>
            3. Checking statewide address records
          </span>
        </p>
      )}
      {results && !searching && results.length === 0 && (
        <p className="fine">
          No address or New Jersey parcel matches “{query.trim()}”. Include the city, state, and ZIP
          and try again.
        </p>
      )}

      {parcelRows.length > 0 && (
        <div className="result-group">
          <p className="result-group-head parcel">
            <span aria-hidden="true">✓</span> Parcel boundary found · municipality identified
            automatically
          </p>
          <ResultList rows={parcelRows} selected={selected} onSelect={onSelect} />
        </div>
      )}

      {addressRows.length > 0 && (
        <div className="result-group">
          <p className="result-group-head geocode">
            <span aria-hidden="true">⚑</span> Address located · no New Jersey parcel polygon found
          </p>
          <ResultList rows={addressRows} selected={selected} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}

function ResultList({ rows, selected, onSelect }) {
  return (
    <ul className="results">
      {rows.map((row) => (
        <li key={`${row.kind}:${row.pams_pin}`}>
          <button
            type="button"
            className={selected?.pams_pin === row.pams_pin ? "hit active" : "hit"}
            onClick={() => onSelect(row)}
          >
            <strong>{row.matched_address ?? row.full_label ?? row.address ?? "(no address)"}</strong>
            <span>{resultDetail(row)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function resultDetail(row) {
  const where = [row.muni_name, row.county ? `${row.county} County` : null]
    .filter(Boolean)
    .join(", ");
  if (row.kind === "place") {
    return [where, row.in_new_jersey ? "Location only" : "Outside New Jersey"]
      .filter(Boolean)
      .join(" · ");
  }
  return `${where ? `${where} · ` : ""}Block ${row.block ?? "—"} / Lot ${row.lot ?? "—"} · ${fmt(row.lot_area_sqft)} sq ft`;
}

async function lookupAddress(address, onStage, signal, location) {
  const places = await geocodeAddress(address, 5, signal, location);
  if (places.length > 0) {
    onStage("parcel");
    const resolved = await Promise.all(
      places.map(async (place) => {
        if (!place.in_new_jersey) return [place];
        const parcels = await findNjginParcelAtPoint(
          place.lat,
          place.lon,
          5,
          signal,
          place.matched_address
        );
        if (parcels.length === 0) return [place];
        return parcels.map((parcel) => ({
          ...place,
          ...parcel,
          kind: "parcel",
          scope: "statewide",
          matched_address: place.matched_address,
          full_label: place.full_label,
          muni_name: parcel.muni_name ?? place.muni_name,
          county: parcel.county ?? place.county,
          state_code: place.state_code,
          state_fips: place.state_fips,
          in_new_jersey: true,
          lat: place.lat,
          lon: place.lon,
        }));
      })
    );
    return resolved.flat();
  }

  // Census sometimes misses locally formatted MOD-IV property locations.
  // Preserve statewide access with a text search, but only after the requested
  // coordinate-first path has returned no address match.
  onStage("fallback");
  return searchNjginParcelsAnywhere(address, 10, location);
}
