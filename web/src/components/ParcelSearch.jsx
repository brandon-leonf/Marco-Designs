import { useEffect, useRef, useState } from "react";
import { searchParcels } from "../lib/supabase.js";
import { searchNjginParcels } from "../lib/njgin.js";

const fmt = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Address search over NJGIN parcels for one municipality. `source` picks where
 * the records come from: "db" for the local import (PostGIS geometry, zoning
 * verifiable) or "njgin" for the live statewide service. Both return the same
 * row shape. Debounced; calls onSelect(parcelRow) when a result is picked.
 */
export default function ParcelSearch({ muni, source = "db", selected, onSelect, onClear }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const live = source === "njgin";

  useEffect(() => {
    setQuery("");
    setResults(null);
    setError(null);
  }, [muni?.slug, source]);

  useEffect(() => {
    clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 3) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(() => {
      const request = live ? searchNjginParcels(muni, q) : searchParcels(muni.slug, q);
      request
        .then((rows) => {
          setResults(rows);
          setError(null);
        })
        .catch((e) => setError(e.message ?? String(e)))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query, muni, live]);

  const clearSelection = () => {
    setQuery("");
    setResults(null);
    setError(null);
    onClear();
  };

  if (selected) {
    return (
      <div className="parcel-search selected-mode">
        <button type="button" className="ghost" onClick={clearSelection}>
          Choose a different property
        </button>
      </div>
    );
  }

  return (
    <div className="parcel-search">
      <div className="row">
        <label style={{ flex: 1 }}>
          Property address ({live ? "live NJGIN parcel service" : "imported NJGIN parcel data"})
          <input
            type="search"
            placeholder="e.g. 3901 PALISADE"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="fine">Search failed: {error}</p>}
      {searching && <p className="fine">Searching…</p>}
      {results && !searching && results.length === 0 && (
        <p className="fine">No parcels match “{query.trim()}”.</p>
      )}
      {results && results.length > 0 && (
        <ul className="results">
          {results.map((r) => (
            <li key={r.pams_pin}>
              <button
                type="button"
                className={selected?.pams_pin === r.pams_pin ? "hit active" : "hit"}
                onClick={() => onSelect(r)}
              >
                <strong>{r.address ?? "(no address)"}</strong>
                <span>
                  Block {r.block ?? "—"} / Lot {r.lot ?? "—"} ·{" "}
                  {fmt(r.lot_area_sqft)} sq ft
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
