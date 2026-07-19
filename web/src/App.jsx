import { useEffect, useMemo, useState } from "react";
import { supabase, fetchMunicipalities } from "./lib/supabase.js";
import { computeBuildable } from "./lib/envelope.js";

const TIER_LABELS = {
  builder_grade: "Builder grade",
  mid_level: "Mid level",
  high_end: "High end",
};
const TIER_ORDER = ["builder_grade", "mid_level", "high_end"];

const fmt = (n, digits = 0) =>
  n == null || !isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { maximumFractionDigits: digits });

export default function App() {
  const [munis, setMunis] = useState(null);
  const [error, setError] = useState(null);
  const [muniId, setMuniId] = useState(null);
  const [districtId, setDistrictId] = useState(null);
  const [lot, setLot] = useState({ width_ft: 25, depth_ft: 100 });

  useEffect(() => {
    if (!supabase) return;
    fetchMunicipalities()
      .then((data) => {
        setMunis(data);
        if (data.length) {
          setMuniId(data[0].id);
          setDistrictId(data[0].zoning_districts[0]?.id ?? null);
        }
      })
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  const muni = munis?.find((m) => m.id === muniId) ?? null;
  const district =
    muni?.zoning_districts.find((d) => d.id === districtId) ?? null;
  const costModel = muni?.build_cost_models?.[0] ?? null;

  const result = useMemo(
    () =>
      district && lot.width_ft > 0 && lot.depth_ft > 0
        ? computeBuildable(lot, district)
        : null,
    [district, lot]
  );

  if (!supabase) {
    return (
      <main className="shell">
        <h1>Demarco</h1>
        <div className="card">
          <p>
            Supabase is not configured. Copy <code>web/.env.example</code> to{" "}
            <code>web/.env</code>, fill in <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code> from Project Settings → API,
            then restart <code>npm run dev</code>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header>
        <h1>Demarco</h1>
        <p className="sub">Buildable envelope &amp; build-cost configurator</p>
      </header>

      {error && <div className="card error">Failed to load data: {error}</div>}
      {!error && !munis && <div className="card">Loading zoning data…</div>}

      {munis && (
        <>
          <section className="card">
            <div className="row">
              <label>
                Municipality
                <select
                  value={muniId ?? ""}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setMuniId(id);
                    const m = munis.find((x) => x.id === id);
                    setDistrictId(m?.zoning_districts[0]?.id ?? null);
                  }}
                >
                  {munis.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}, {m.state_code}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Zoning district
                <select
                  value={districtId ?? ""}
                  onChange={(e) => setDistrictId(Number(e.target.value))}
                >
                  {muni?.zoning_districts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} {d.name ? `— ${d.name}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Lot width (ft)
                <input
                  type="number"
                  min="0"
                  value={lot.width_ft}
                  onChange={(e) =>
                    setLot({ ...lot, width_ft: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Lot depth (ft)
                <input
                  type="number"
                  min="0"
                  value={lot.depth_ft}
                  onChange={(e) =>
                    setLot({ ...lot, depth_ft: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            {muni?.source_url && (
              <p className="fine">
                Zoning source:{" "}
                <a href={muni.source_url} target="_blank" rel="noreferrer">
                  {muni.source_url}
                </a>{" "}
                (verified {muni.last_updated ?? "n/a"})
              </p>
            )}
          </section>

          {district && result && (
            <section className="grid">
              <div className="card">
                <h2>Buildable envelope</h2>
                <LotDiagram lot={lot} result={result} />
                <table>
                  <tbody>
                    <tr>
                      <td>Lot area</td>
                      <td>{fmt(result.lotArea)} sq ft</td>
                    </tr>
                    <tr>
                      <td>
                        Envelope after setbacks (front{" "}
                        {fmt(result.envelope.insets.front)}′ · rear{" "}
                        {fmt(result.envelope.insets.rear)}′ · sides{" "}
                        {fmt(result.envelope.insets.sideTotal)}′ total)
                      </td>
                      <td>{fmt(result.envelope.areaSqft)} sq ft</td>
                    </tr>
                    <tr>
                      <td>
                        Max footprint{" "}
                        <span className="fine">
                          (binds on {result.binding}
                          {district.max_building_coverage_pct != null
                            ? `, coverage ${district.max_building_coverage_pct}%`
                            : ""}
                          )
                        </span>
                      </td>
                      <td>{fmt(result.footprint)} sq ft</td>
                    </tr>
                    <tr className="total">
                      <td>
                        Max buildable × {result.stories}{" "}
                        {result.stories === 1 ? "story" : "stories"}
                        {result.farLimited ? " (FAR-capped)" : ""}
                      </td>
                      <td>{fmt(result.buildable)} sq ft</td>
                    </tr>
                  </tbody>
                </table>
                {district.front_yard_prevailing_rule && (
                  <p className="fine">
                    ⚠ Front setback uses the block’s prevailing average; the
                    minimum shown is the floor.
                  </p>
                )}
              </div>

              <div className="card">
                <h2>
                  Build cost{" "}
                  {costModel && (
                    <span className={`badge ${costModel.provenance}`}>
                      {costModel.provenance}
                    </span>
                  )}
                </h2>
                {!costModel && (
                  <p className="fine">
                    No rate card loaded for this town yet — zoning-only.
                  </p>
                )}
                {costModel && (
                  <table>
                    <thead>
                      <tr>
                        <th>Tier</th>
                        <th>$/sq ft</th>
                        <th>Estimate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {TIER_ORDER.map((t) => {
                        const tier = costModel.build_cost_tiers.find(
                          (x) => x.tier === t
                        );
                        if (!tier) return null;
                        return (
                          <tr key={t}>
                            <td>{TIER_LABELS[t]}</td>
                            <td>${fmt(tier.rate_per_sqft, 2)}</td>
                            <td>
                              ${fmt(result.buildable * tier.rate_per_sqft)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {costModel?.provenance === "estimated" && (
                  <p className="fine">
                    Estimated from a regional baseline of $
                    {fmt(costModel.regional_baseline_per_sqft, 2)}/sq ft ×
                    local factor {costModel.local_cost_factor} — not a quote.
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

/** SVG plan view: lot outline with the buildable envelope inset inside it. */
function LotDiagram({ lot, result }) {
  const pad = 12;
  const maxDim = 240;
  const scale = maxDim / Math.max(lot.width_ft, lot.depth_ft);
  const w = lot.width_ft * scale;
  const d = lot.depth_ft * scale;
  const { insets } = result.envelope;
  const ew = result.envelope.widthFt * scale;
  const ed = result.envelope.depthFt * scale;

  return (
    <svg
      viewBox={`0 0 ${w + pad * 2} ${d + pad * 2}`}
      className="diagram"
      role="img"
      aria-label="Lot with buildable envelope"
    >
      <rect x={pad} y={pad} width={w} height={d} className="lot" />
      {ew > 0 && ed > 0 && (
        <rect
          x={pad + (insets.sideTotal / 2) * scale}
          y={pad + insets.front * scale}
          width={ew}
          height={ed}
          className="envelope"
        />
      )}
      <text x={pad + w / 2} y={pad - 3} textAnchor="middle" className="dim">
        {lot.width_ft}′
      </text>
      <text
        x={pad - 4}
        y={pad + d / 2}
        textAnchor="middle"
        className="dim"
        transform={`rotate(-90 ${pad - 4} ${pad + d / 2})`}
      >
        {lot.depth_ft}′
      </text>
    </svg>
  );
}
