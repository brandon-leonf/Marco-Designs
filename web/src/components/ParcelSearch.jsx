import { useEffect, useRef, useState } from "react";
import { searchParcels } from "../lib/supabase.js";

const fmt = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Address search over the imported NJGIN parcels for one municipality.
 * Debounced; calls onSelect(parcelRow) when a result is picked.
 */
export default function ParcelSearch({ muniSlug, selected, onSelect, onClear }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    setQuery("");
    setResults(null);
    setError(null);
  }, [muniSlug]);

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
      searchParcels(muniSlug, q)
        .then((rows) => {
          setResults(rows);
          setError(null);
        })
        .catch((e) => setError(e.message ?? String(e)))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query, muniSlug]);

  return (
    <div className="parcel-search">
      <div className="row">
        <label style={{ flex: 1 }}>
          Property address (public NJGIN parcel data)
          <input
            type="search"
            placeholder="e.g. 3901 PALISADE"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {selected && (
          <button type="button" className="ghost" onClick={onClear}>
            Choose a different property
          </button>
        )}
      </div>

      {error && <p className="fine">Search failed: {error}</p>}
      {searching && <p className="fine">Searching…</p>}
      {results && !searching && results.length === 0 && (
        <p className="fine">No parcels match “{query.trim()}”.</p>
      )}
      {results && results.length > 0 && !selected && (
        <ul className="results">
          {results.map((r) => (
            <li key={r.parcel_id}>
              <button
                type="button"
                className={selected?.parcel_id === r.parcel_id ? "hit active" : "hit"}
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
