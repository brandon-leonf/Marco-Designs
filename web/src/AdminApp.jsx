import { useEffect, useMemo, useState } from "react";
import { supabase, fetchMunicipalities } from "./lib/supabase.js";
import {
  getSession,
  onAuthChange,
  signIn,
  signOut,
  checkIsAdmin,
  saveDistrict,
  touchMunicipality,
  saveCostModel,
} from "./lib/adminApi.js";
import Logo from "./components/Logo.jsx";

const TIER_ORDER = ["builder_grade", "mid_level", "high_end"];
const TIER_LABELS = {
  builder_grade: "Builder Grade ($/sq ft)",
  mid_level: "Mid Level ($/sq ft)",
  high_end: "High End ($/sq ft)",
};

/** "" in a form field means "not set" and is stored as NULL. */
const numOrNull = (value) => (value === "" || value == null ? null : Number(value));
const numOrEmpty = (value) => (value == null ? "" : value);

export default function AdminApp() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [isAdmin, setIsAdmin] = useState(null);

  useEffect(() => {
    if (!supabase) return;
    getSession().then(setSession).catch(() => setSession(null));
    return onAuthChange(setSession);
  }, []);

  useEffect(() => {
    if (!session?.user?.email) {
      setIsAdmin(null);
      return;
    }
    let stale = false;
    checkIsAdmin(session.user.email)
      .then((ok) => !stale && setIsAdmin(ok))
      .catch(() => !stale && setIsAdmin(false));
    return () => {
      stale = true;
    };
  }, [session]);

  return (
    <>
      <nav className="top-nav">
        <div className="top-nav-inner">
          <Logo className="nav-logo" />
          <span className="admin-nav-title">Config Editor</span>
          <span className="nav-tagline">
            <a className="nav-link" href="#/">
              ← Back to app
            </a>
            {session && (
              <button type="button" className="nav-link nav-signout" onClick={() => signOut()}>
                Sign out
              </button>
            )}
          </span>
        </div>
      </nav>
      <main className="shell">
        {!supabase ? (
          <div className="card setup-card">
            <p>
              Supabase is not configured. Copy <code>web/.env.example</code> to <code>web/.env</code>,
              fill in <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then
              restart <code>npm run dev</code>.
            </p>
          </div>
        ) : session === undefined ? (
          <div className="card loading-card">Checking session…</div>
        ) : !session ? (
          <LoginCard />
        ) : isAdmin === false ? (
          <div className="card error">
            <strong>{session.user.email}</strong> is signed in but is not authorized to edit
            configuration. Add the email to the <code>admin_users</code> table in Supabase to grant
            access.
          </div>
        ) : (
          <ConfigEditor adminEmail={session.user.email} ready={isAdmin === true} />
        )}
      </main>
    </>
  );
}

function LoginCard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card login-card">
      <div className="section-heading">
        <span className="section-icon" aria-hidden="true">
          <LockIcon />
        </span>
        <div>
          <p className="eyebrow">Owner access</p>
          <h2>Sign in to edit configuration</h2>
          <p>Zoning rules and pricing changes go live for every visitor. Authorized accounts only.</p>
        </div>
      </div>
      <form onSubmit={submit} className="login-form">
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="status-line error-text">{error}</p>}
        <button type="submit" className="primary full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/** Build the editable draft for one district row + the muni's cost model. */
function draftFromDistrict(district) {
  const adu = district.extra_rules?.adu ?? {};
  return {
    front_yard_min_ft: numOrEmpty(district.front_yard_min_ft),
    rear_yard_min_ft: numOrEmpty(district.rear_yard_min_ft),
    side_yard_one_min_ft: numOrEmpty(district.side_yard_one_min_ft),
    side_yard_total_min_ft: numOrEmpty(district.side_yard_total_min_ft),
    min_lot_area_sqft: numOrEmpty(district.min_lot_area_sqft),
    min_lot_width_ft: numOrEmpty(district.min_lot_width_ft),
    min_lot_depth_ft: numOrEmpty(district.min_lot_depth_ft),
    front_yard_prevailing_rule: Boolean(district.front_yard_prevailing_rule),
    max_building_coverage_pct: numOrEmpty(district.max_building_coverage_pct),
    max_impervious_coverage_pct: numOrEmpty(district.max_impervious_coverage_pct),
    max_stories: numOrEmpty(district.max_stories),
    max_far: numOrEmpty(district.max_far),
    max_height_ft: numOrEmpty(district.max_height_ft),
    adu_allowed: Boolean(adu.allowed),
    adu_detached_allowed: Boolean(adu.detached_allowed),
    adu_max_size_sqft: numOrEmpty(adu.max_size_sqft),
    adu_parking_required: Boolean(adu.parking_required),
  };
}

function draftFromCostModel(costModel) {
  const tiers = {};
  for (const name of TIER_ORDER) {
    const tier = costModel?.build_cost_tiers?.find((item) => item.tier === name);
    tiers[name] = numOrEmpty(tier?.rate_per_sqft);
  }
  return {
    provenance: costModel?.provenance ?? "estimated",
    regional_baseline_per_sqft: numOrEmpty(costModel?.regional_baseline_per_sqft),
    local_cost_factor: numOrEmpty(costModel?.local_cost_factor),
    tiers,
  };
}

function ConfigEditor({ adminEmail, ready }) {
  const [munis, setMunis] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [muniId, setMuniId] = useState(null);
  const [districtId, setDistrictId] = useState(null);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState(null);
  const [costDraft, setCostDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState(null); // {kind: "ok"|"error", text}
  const [copied, setCopied] = useState(false);

  const reload = () =>
    fetchMunicipalities()
      .then((data) => {
        setMunis(data);
        setLoadError(null);
        return data;
      })
      .catch((e) => setLoadError(e.message ?? String(e)));

  useEffect(() => {
    reload().then((data) => {
      if (data?.length) {
        setMuniId((current) => current ?? data[0].id);
        setDistrictId((current) => current ?? data[0].zoning_districts[0]?.id ?? null);
      }
    });
  }, []);

  const muni = munis?.find((m) => m.id === muniId) ?? null;
  const district = muni?.zoning_districts.find((d) => d.id === districtId) ?? null;
  const rawCostModel = muni?.build_cost_models;
  const costModel = (Array.isArray(rawCostModel) ? rawCostModel[0] : rawCostModel) ?? null;

  // Re-seed the drafts whenever the selected district (or fresh data) changes.
  useEffect(() => {
    setDraft(district ? draftFromDistrict(district) : null);
    setSaveState(null);
  }, [district]);
  useEffect(() => {
    setCostDraft(muni ? draftFromCostModel(costModel) : null);
  }, [muni, costModel]);

  const districts = useMemo(() => {
    const list = muni?.zoning_districts ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (d) => d.code.toLowerCase().includes(q) || (d.name ?? "").toLowerCase().includes(q)
    );
  }, [muni, filter]);

  const jsonPreview = useMemo(() => {
    if (!draft || !muni || !district) return "";
    return JSON.stringify(
      {
        municipality: muni.name,
        district: district.code,
        setbacks: {
          front_yard_min_ft: numOrNull(draft.front_yard_min_ft),
          rear_yard_min_ft: numOrNull(draft.rear_yard_min_ft),
          side_yard_one_min_ft: numOrNull(draft.side_yard_one_min_ft),
          side_yard_total_min_ft: numOrNull(draft.side_yard_total_min_ft),
          front_yard_prevailing_rule: draft.front_yard_prevailing_rule,
        },
        lot_minimums: {
          area_sqft: numOrNull(draft.min_lot_area_sqft),
          width_ft: numOrNull(draft.min_lot_width_ft),
          depth_ft: numOrNull(draft.min_lot_depth_ft),
        },
        build_limits: {
          max_building_coverage_pct: numOrNull(draft.max_building_coverage_pct),
          max_impervious_coverage_pct: numOrNull(draft.max_impervious_coverage_pct),
          max_stories: numOrNull(draft.max_stories),
          max_far: numOrNull(draft.max_far),
          max_height_ft: numOrNull(draft.max_height_ft),
        },
        adu: {
          allowed: draft.adu_allowed,
          detached_allowed: draft.adu_detached_allowed,
          max_size_sqft: numOrNull(draft.adu_max_size_sqft),
          parking_required: draft.adu_parking_required,
        },
        cost_model: costDraft && {
          provenance: costDraft.provenance,
          regional_baseline_per_sqft: numOrNull(costDraft.regional_baseline_per_sqft),
          local_cost_factor: numOrNull(costDraft.local_cost_factor),
          tiers: Object.fromEntries(
            TIER_ORDER.map((name) => [name, numOrNull(costDraft.tiers[name])])
          ),
        },
      },
      null,
      2
    );
  }, [draft, costDraft, muni, district]);

  const estimated = costDraft?.provenance === "estimated";
  const costModelComplete =
    costDraft &&
    TIER_ORDER.every((name) => costDraft.tiers[name] !== "") &&
    (!estimated ||
      (costDraft.regional_baseline_per_sqft !== "" && costDraft.local_cost_factor !== ""));

  const save = async () => {
    if (!district || !draft) return;
    setSaving(true);
    setSaveState(null);
    try {
      await saveDistrict(district.id, {
        front_yard_min_ft: numOrNull(draft.front_yard_min_ft),
        rear_yard_min_ft: numOrNull(draft.rear_yard_min_ft),
        side_yard_one_min_ft: numOrNull(draft.side_yard_one_min_ft),
        side_yard_total_min_ft: numOrNull(draft.side_yard_total_min_ft),
        min_lot_area_sqft: numOrNull(draft.min_lot_area_sqft),
        min_lot_width_ft: numOrNull(draft.min_lot_width_ft),
        min_lot_depth_ft: numOrNull(draft.min_lot_depth_ft),
        front_yard_prevailing_rule: draft.front_yard_prevailing_rule,
        max_building_coverage_pct: numOrNull(draft.max_building_coverage_pct),
        max_impervious_coverage_pct: numOrNull(draft.max_impervious_coverage_pct),
        max_stories: numOrNull(draft.max_stories),
        max_far: numOrNull(draft.max_far),
        max_height_ft: numOrNull(draft.max_height_ft),
        extra_rules: {
          ...(district.extra_rules ?? {}),
          adu: {
            allowed: draft.adu_allowed,
            detached_allowed: draft.adu_detached_allowed,
            max_size_sqft: numOrNull(draft.adu_max_size_sqft),
            parking_required: draft.adu_parking_required,
          },
        },
      });

      if (costModelComplete) {
        await saveCostModel(
          muni.id,
          costModel?.id ?? null,
          {
            provenance: costDraft.provenance,
            regional_baseline_per_sqft: estimated
              ? numOrNull(costDraft.regional_baseline_per_sqft)
              : null,
            local_cost_factor: estimated ? numOrNull(costDraft.local_cost_factor) : null,
          },
          Object.fromEntries(TIER_ORDER.map((name) => [name, Number(costDraft.tiers[name])]))
        );
      }

      await touchMunicipality(muni.id);
      await reload();
      setSaveState({
        kind: "ok",
        text: costModelComplete
          ? "Saved. Changes are live for every visitor."
          : "District saved. Cost model skipped — fill in every tier rate (and baseline + factor for estimated) to save it.",
      });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setSaveState({ kind: "error", text: "Could not copy to the clipboard." });
    }
  };

  if (loadError) return <div className="card error">Failed to load data: {loadError}</div>;
  if (!munis || !draft || !costDraft)
    return <div className="card loading-card">Loading configuration…</div>;

  const setField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
  const setCostField = (key) => (value) => setCostDraft((d) => ({ ...d, [key]: value }));

  return (
    <section className="admin-grid">
      <aside className="card admin-side">
        <label>
          Municipality
          <select value={muniId ?? ""} onChange={(e) => {
            const id = Number(e.target.value);
            setMuniId(id);
            const next = munis.find((item) => item.id === id);
            setDistrictId(next?.zoning_districts[0]?.id ?? null);
          }}>
            {munis.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}, {item.state_code}
              </option>
            ))}
          </select>
        </label>
        <span className="admin-badge">
          <i aria-hidden="true">✓</i> Active municipality
        </span>
        <p className="admin-side-note">This editor loads municipal zoning and pricing configuration.</p>
        <div className="admin-about">
          <strong>About this editor</strong>
          <p>
            Update zoning rules, dimensional standards, ADU policies, and cost model assumptions for
            the selected municipality.
          </p>
          <p>Saving publishes directly to the live database used by the public calculator.</p>
        </div>
        <p className="admin-side-note admin-signed-in">
          Signed in as <strong>{adminEmail}</strong>
        </p>
      </aside>

      <aside className="card admin-districts">
        <h3>Zoning Districts</h3>
        <p className="admin-side-note">Select a district to load and edit its config file.</p>
        <input
          type="search"
          placeholder="Filter districts…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul className="district-list">
          {districts.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={item.id === districtId ? "district-item selected" : "district-item"}
                onClick={() => setDistrictId(item.id)}
              >
                <span className="district-code">{item.code}</span>
                <span className="district-name">{item.name ?? "—"}</span>
                {item.id === districtId && <span className="district-check">✓</span>}
              </button>
            </li>
          ))}
          {districts.length === 0 && <li className="admin-side-note">No districts match.</li>}
        </ul>
        <p className="district-count">{muni?.zoning_districts.length ?? 0} districts total</p>
      </aside>

      <div className="card admin-editor">
        <div className="admin-editor-head">
          <div>
            <h2>Edit Config File</h2>
            <p>
              {muni?.name}, {muni?.state_code} · {district?.code} — {district?.name ?? "District"}
            </p>
          </div>
          <span className="admin-updated">
            Last updated: {muni?.last_updated ?? "—"}
          </span>
        </div>

        <fieldset className="admin-section" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">📏</span> A. Setbacks &amp; Dimensional Rules
          </legend>
          <div className="admin-fields five">
            <Num label="Front Yard Min (ft)" value={draft.front_yard_min_ft} onChange={setField("front_yard_min_ft")} />
            <Num label="Rear Yard Min (ft)" value={draft.rear_yard_min_ft} onChange={setField("rear_yard_min_ft")} />
            <Num label="Side Yard One Min (ft)" value={draft.side_yard_one_min_ft} onChange={setField("side_yard_one_min_ft")} />
            <Num label="Side Yard Total Min (ft)" value={draft.side_yard_total_min_ft} onChange={setField("side_yard_total_min_ft")} />
            <Num label="Min Lot Area (sq ft)" value={draft.min_lot_area_sqft} onChange={setField("min_lot_area_sqft")} />
            <Num label="Min Lot Width (ft)" value={draft.min_lot_width_ft} onChange={setField("min_lot_width_ft")} />
            <Num label="Min Lot Depth (ft)" value={draft.min_lot_depth_ft} onChange={setField("min_lot_depth_ft")} />
            <Toggle
              label="Prevailing Front Yard Rule"
              checked={draft.front_yard_prevailing_rule}
              onChange={setField("front_yard_prevailing_rule")}
            />
          </div>
        </fieldset>

        <fieldset className="admin-section" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">🏗</span> B. Build Limits
          </legend>
          <div className="admin-fields four">
            <Num label="Max Building Coverage (%)" value={draft.max_building_coverage_pct} onChange={setField("max_building_coverage_pct")} />
            <Num label="Max Stories" value={draft.max_stories} onChange={setField("max_stories")} step="0.5" />
            <Num label="Max FAR" value={draft.max_far} onChange={setField("max_far")} step="0.05" />
            <Num label="Max Height (ft)" value={draft.max_height_ft} onChange={setField("max_height_ft")} />
            <Num label="Max Impervious Coverage (%)" value={draft.max_impervious_coverage_pct} onChange={setField("max_impervious_coverage_pct")} />
          </div>
        </fieldset>

        <fieldset className="admin-section" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">🏠</span> C. ADU Rules
          </legend>
          <div className="admin-fields four">
            <Toggle label="ADU Allowed" checked={draft.adu_allowed} onChange={setField("adu_allowed")} />
            <Toggle label="Detached ADU Allowed" checked={draft.adu_detached_allowed} onChange={setField("adu_detached_allowed")} />
            <Num label="ADU Max Size (sq ft)" value={draft.adu_max_size_sqft} onChange={setField("adu_max_size_sqft")} />
            <Toggle label="Parking Required" checked={draft.adu_parking_required} onChange={setField("adu_parking_required")} />
          </div>
          <p className="admin-hint">
            ADU rules are stored in the district’s <code>extra_rules</code> and shown as guidance; the
            calculator’s ADU math does not consume them yet.
          </p>
        </fieldset>

        <fieldset className="admin-section" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">$</span> D. Cost Model
          </legend>
          <div className="admin-fields four">
            {TIER_ORDER.map((name) => (
              <Num
                key={name}
                label={TIER_LABELS[name]}
                value={costDraft.tiers[name]}
                onChange={(value) => setCostDraft((d) => ({ ...d, tiers: { ...d.tiers, [name]: value } }))}
                step="0.01"
              />
            ))}
            <label>
              Provenance
              <select value={costDraft.provenance} onChange={(e) => setCostField("provenance")(e.target.value)}>
                <option value="verified">Verified</option>
                <option value="estimated">Estimated</option>
              </select>
            </label>
            {estimated && (
              <>
                <Num
                  label="Regional Baseline ($/sq ft)"
                  value={costDraft.regional_baseline_per_sqft}
                  onChange={setCostField("regional_baseline_per_sqft")}
                  step="0.01"
                />
                <Num
                  label="Local Cost Factor"
                  value={costDraft.local_cost_factor}
                  onChange={setCostField("local_cost_factor")}
                  step="0.01"
                />
              </>
            )}
          </div>
          <p className="admin-hint">
            Verified rates are Marco’s real figures. Estimated models must carry the regional baseline
            and local factor they were derived from, and every visitor sees the provenance label.
          </p>
        </fieldset>

        <fieldset className="admin-section" disabled={!ready}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">&lt;/&gt;</span> E. Notes / JSON Summary
          </legend>
          <div className="json-summary">
            <p className="admin-hint">Compact JSON preview of the current configuration for this district.</p>
            <pre className="json-preview"><code>{jsonPreview}</code></pre>
            <button type="button" className="secondary compact" onClick={copyJson}>
              {copied ? "Copied ✓" : "Copy JSON"}
            </button>
          </div>
        </fieldset>

        {saveState && (
          <p className={saveState.kind === "ok" ? "status-line save-ok" : "status-line error-text"} role="status">
            {saveState.text}
          </p>
        )}
        <div className="actions admin-actions">
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={() => {
              setDraft(draftFromDistrict(district));
              setCostDraft(draftFromCostModel(costModel));
              setSaveState(null);
            }}
          >
            ⟲ Reset
          </button>
          <button type="button" className="primary" disabled={saving || !ready} onClick={save}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </section>
  );
}

function Num({ label, value, onChange, step = "1" }) {
  return (
    <label>
      {label}
      <input
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="admin-toggle">
      {label}
      <span className="toggle-row">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          className={checked ? "toggle on" : "toggle"}
          onClick={() => onChange(!checked)}
        >
          <i />
        </button>
        <span className="toggle-state">{checked ? "On" : "Off"}</span>
      </span>
    </label>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
