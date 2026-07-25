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
  createMunicipality,
  createDistrict,
} from "./lib/adminApi.js";
import Logo from "./components/Logo.jsx";
import { computeBuildable } from "./lib/envelope.js";

const TIER_ORDER = ["essential", "signature", "premium"];
const TIER_LABELS = {
  essential: "Essential",
  signature: "Signature",
  premium: "Premium",
};
// Fixed multipliers behind Marco's estimated model: baseline x factor x multiplier.
const TIER_MULTIPLIERS = { essential: 0.75, signature: 1.0, premium: 1.4 };

/** "" in a form field means "not set" and is stored as NULL. */
const numOrNull = (value) => (value === "" || value == null ? null : Number(value));
const numOrEmpty = (value) => (value == null ? "" : value);
const draftKey = (municipalityId, districtId) =>
  `marco-config-draft:${municipalityId}:${districtId}`;

function validateConfiguration(draft, costDraft) {
  const errors = [];
  const required = [
    ["Front yard", draft.front_yard_min_ft],
    ["Rear yard", draft.rear_yard_min_ft],
    ["One-side yard", draft.side_yard_one_min_ft],
    ["Total side yard", draft.side_yard_total_min_ft],
    ["Building coverage", draft.max_building_coverage_pct],
    ["Max stories", draft.max_stories],
  ];
  for (const [label, value] of required) {
    if (value === "" || value == null || !Number.isFinite(Number(value))) {
      errors.push(`${label} must have a numeric value.`);
    }
  }
  if (Number(draft.side_yard_total_min_ft) < Number(draft.side_yard_one_min_ft) * 2) {
    errors.push("Total side yard must be at least twice the one-side minimum.");
  }
  if (Number(draft.max_building_coverage_pct) > 100) {
    errors.push("Building coverage cannot exceed 100%.");
  }
  if (draft.max_far !== "" && Number(draft.max_far) <= 0) {
    errors.push("Max FAR must be blank or greater than zero.");
  }

  const estimated = costDraft.provenance === "estimated";
  for (const name of TIER_ORDER) {
    if (costDraft.tiers[name].min === "") errors.push(`${TIER_LABELS[name]} needs a rate.`);
    if (!estimated && costDraft.tiers[name].max === "") {
      errors.push(`${TIER_LABELS[name]} needs a maximum rate.`);
    }
  }
  if (
    estimated &&
    (costDraft.regional_baseline_per_sqft === "" || costDraft.local_cost_factor === "")
  ) {
    errors.push("Estimated pricing needs a regional baseline and local cost factor.");
  }
  return errors;
}

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
    tiers[name] = {
      min: numOrEmpty(tier?.rate_per_sqft),
      max: numOrEmpty(tier?.rate_per_sqft_max),
      notes: tier?.notes ?? "",
    };
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
  const [newMuni, setNewMuni] = useState(null); // null | {name, state, county, district}
  const [newDistrict, setNewDistrict] = useState(null); // null | {code, name}
  const [validation, setValidation] = useState(null);
  const [testLot, setTestLot] = useState({ width_ft: 25, depth_ft: 102, area_sqft: 2548 });
  const [testResult, setTestResult] = useState(null);

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
    if (!district || !muni) {
      setDraft(null);
      return;
    }
    const stored = localStorage.getItem(draftKey(muni.id, district.id));
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setDraft(parsed.draft);
        setCostDraft(parsed.costDraft);
      } catch {
        setDraft(draftFromDistrict(district));
        setCostDraft(draftFromCostModel(costModel));
        localStorage.removeItem(draftKey(muni.id, district.id));
      }
    } else {
      setDraft(draftFromDistrict(district));
    }
    setSaveState(null);
    setValidation(null);
    setTestResult(null);
  }, [district, muni, costModel]);
  useEffect(() => {
    if (!muni || !district) return;
    const stored = localStorage.getItem(draftKey(muni.id, district.id));
    if (!stored) setCostDraft(draftFromCostModel(costModel));
  }, [muni, district, costModel]);

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
            TIER_ORDER.map((name) => [
              name,
              costDraft.provenance === "verified"
                ? {
                    rate_per_sqft: {
                      min: numOrNull(costDraft.tiers[name].min),
                      max: numOrNull(costDraft.tiers[name].max),
                    },
                    notes: costDraft.tiers[name].notes || null,
                  }
                : { rate_per_sqft: numOrNull(costDraft.tiers[name].min) },
            ])
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
    TIER_ORDER.every(
      (name) =>
        costDraft.tiers[name].min !== "" && (estimated || costDraft.tiers[name].max !== "")
    ) &&
    (!estimated ||
      (costDraft.regional_baseline_per_sqft !== "" && costDraft.local_cost_factor !== ""));

  const runValidation = () => {
    const errors = validateConfiguration(draft, costDraft);
    setValidation(errors);
    setSaveState({
      kind: errors.length ? "error" : "ok",
      text: errors.length
        ? `Validation found ${errors.length} issue${errors.length === 1 ? "" : "s"}.`
        : "Validation passed. This draft is ready to test and publish.",
    });
    return errors;
  };

  const saveDraft = () => {
    localStorage.setItem(draftKey(muni.id, district.id), JSON.stringify({ draft, costDraft }));
    setSaveState({ kind: "ok", text: "Draft saved in this browser. The public calculator is unchanged." });
  };

  const runTest = () => {
    const errors = runValidation();
    if (errors.length) {
      setTestResult(null);
      return;
    }
    const result = computeBuildable(testLot, {
      ...draft,
      max_far: numOrNull(draft.max_far),
    });
    setTestResult(result);
  };

  const publish = async () => {
    if (!district || !draft) return;
    const errors = runValidation();
    if (errors.length) return;
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
          TIER_ORDER.map((name) => ({
            tier: name,
            rate_per_sqft: Number(costDraft.tiers[name].min),
            rate_per_sqft_max: estimated ? null : Number(costDraft.tiers[name].max),
            notes: estimated ? null : costDraft.tiers[name].notes || null,
            formula_reference: estimated
              ? `regional_baseline * local_factor * ${TIER_MULTIPLIERS[name]}`
              : "authoritative_historical_rate",
          }))
        );
      }

      await touchMunicipality(muni.id);
      await reload();
      localStorage.removeItem(draftKey(muni.id, district.id));
      setSaveState({
        kind: "ok",
        text: "Published. The validated configuration is now live for every visitor.",
      });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  const slugFor = (name, state) =>
    `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${state
      .trim()
      .toLowerCase()}`;

  const submitNewMuni = async () => {
    if (!newMuni?.name.trim() || newMuni.state.trim().length !== 2 || !newMuni.district.trim()) {
      setSaveState({ kind: "error", text: "A new municipality needs a name, a 2-letter state, and a starting district code." });
      return;
    }
    setSaving(true);
    setSaveState(null);
    try {
      const id = await createMunicipality({
        name: newMuni.name.trim(),
        stateCode: newMuni.state.trim(),
        county: newMuni.county.trim(),
        slug: slugFor(newMuni.name, newMuni.state),
        districtCode: newMuni.district.trim().toUpperCase(),
      });
      const data = await reload();
      setMuniId(id);
      setDistrictId(data?.find((m) => m.id === id)?.zoning_districts[0]?.id ?? null);
      setNewMuni(null);
      setSaveState({
        kind: "ok",
        text: "Municipality created. Fill in the district rules and cost model, then Save Changes.",
      });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  const submitNewDistrict = async () => {
    if (!newDistrict?.code.trim()) {
      setSaveState({ kind: "error", text: "A new district needs a code (e.g. R-2)." });
      return;
    }
    setSaving(true);
    setSaveState(null);
    try {
      const id = await createDistrict(
        muni.id,
        newDistrict.code.trim().toUpperCase(),
        newDistrict.name.trim()
      );
      await reload();
      setDistrictId(id);
      setNewDistrict(null);
      setSaveState({ kind: "ok", text: "District added. Fill in its rules, then Save Changes." });
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
  const setTierField = (name, key) => (value) =>
    setCostDraft((d) => ({
      ...d,
      tiers: { ...d.tiers, [name]: { ...d.tiers[name], [key]: value } },
    }));

  const deriveEstimatedRates = () => {
    const base = Number(costDraft.regional_baseline_per_sqft);
    const factor = Number(costDraft.local_cost_factor);
    if (!base || !factor) {
      setSaveState({ kind: "error", text: "Enter the regional baseline and local cost factor first." });
      return;
    }
    setCostDraft((d) => ({
      ...d,
      tiers: Object.fromEntries(
        TIER_ORDER.map((name) => [
          name,
          {
            ...d.tiers[name],
            min: Math.round(base * factor * TIER_MULTIPLIERS[name] * 100) / 100,
            max: "",
          },
        ])
      ),
    }));
    setSaveState(null);
  };

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
          <i aria-hidden="true">●</i> Draft workspace
        </span>
        <p className="admin-side-note">This editor loads municipal zoning and pricing configuration.</p>
        {newMuni ? (
          <div className="inline-create" role="group" aria-label="New municipality">
            <label>
              Town name
              <input
                type="text"
                value={newMuni.name}
                placeholder="e.g. Hoboken"
                onChange={(e) => setNewMuni({ ...newMuni, name: e.target.value })}
              />
            </label>
            <div className="inline-create-row">
              <label>
                State
                <input
                  type="text"
                  maxLength={2}
                  value={newMuni.state}
                  onChange={(e) => setNewMuni({ ...newMuni, state: e.target.value.toUpperCase() })}
                />
              </label>
              <label>
                County
                <input
                  type="text"
                  value={newMuni.county}
                  placeholder="optional"
                  onChange={(e) => setNewMuni({ ...newMuni, county: e.target.value })}
                />
              </label>
            </div>
            <label>
              First district code
              <input
                type="text"
                value={newMuni.district}
                placeholder="e.g. R"
                onChange={(e) => setNewMuni({ ...newMuni, district: e.target.value })}
              />
            </label>
            {newMuni.name.trim() && newMuni.state.trim().length === 2 && (
              <p className="admin-side-note">
                Config id: <code>{slugFor(newMuni.name, newMuni.state)}</code>
              </p>
            )}
            <div className="inline-create-actions">
              <button type="button" className="secondary compact" onClick={() => setNewMuni(null)}>
                Cancel
              </button>
              <button type="button" className="primary compact" disabled={saving} onClick={submitNewMuni}>
                Create
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="secondary compact"
            disabled={!ready}
            onClick={() => setNewMuni({ name: "", state: "NJ", county: "", district: "R" })}
          >
            ＋ New municipality
          </button>
        )}
        <div className="admin-about">
          <strong>About this editor</strong>
          <p>
            Update zoning rules, dimensional standards, ADU policies, and cost model assumptions for
            the selected municipality.
          </p>
          <p>Save drafts privately, validate and test them, then publish explicitly to the live calculator.</p>
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
        {newDistrict ? (
          <div className="inline-create" role="group" aria-label="New district">
            <div className="inline-create-row">
              <label>
                Code
                <input
                  type="text"
                  value={newDistrict.code}
                  placeholder="e.g. R-2"
                  onChange={(e) => setNewDistrict({ ...newDistrict, code: e.target.value })}
                />
              </label>
              <label>
                Name
                <input
                  type="text"
                  value={newDistrict.name}
                  placeholder="optional"
                  onChange={(e) => setNewDistrict({ ...newDistrict, name: e.target.value })}
                />
              </label>
            </div>
            <div className="inline-create-actions">
              <button type="button" className="secondary compact" onClick={() => setNewDistrict(null)}>
                Cancel
              </button>
              <button type="button" className="primary compact" disabled={saving} onClick={submitNewDistrict}>
                Add
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="secondary compact"
            disabled={!ready}
            onClick={() => setNewDistrict({ code: "", name: "" })}
          >
            ＋ Add district
          </button>
        )}
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
            <label>
              Provenance
              <select value={costDraft.provenance} onChange={(e) => setCostField("provenance")(e.target.value)}>
                <option value="verified">Verified — Marco’s real figures</option>
                <option value="estimated">Estimated — regional projection</option>
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
          {estimated ? (
            <div className="provenance-note estimated" role="note">
              <strong>✕ Clients will see a red warning</strong>
              <span>
                “Rough estimate based on regional variables — actual costs may include expenses not
                accounted for.” Each tier is one derived rate: baseline × factor × multiplier
                (0.75 / 1.0 / 1.4).
              </span>
            </div>
          ) : (
            <div className="provenance-note verified" role="note">
              <strong>✓ Clients will see “Verified Price”</strong>
              <span>
                Verified pricing shows a min–max range per tier, with your client-facing notes under
                each level.
              </span>
            </div>
          )}
          {TIER_ORDER.map((name) => (
            <div className="tier-editor" key={name}>
              <span className="tier-editor-name">{TIER_LABELS[name]}</span>
              <div className="admin-fields four">
                {estimated ? (
                  <Num
                    label="Rate ($/sq ft)"
                    value={costDraft.tiers[name].min}
                    onChange={(value) => setTierField(name, "min")(value)}
                    step="0.01"
                  />
                ) : (
                  <>
                    <Num
                      label="Min ($/sq ft)"
                      value={costDraft.tiers[name].min}
                      onChange={(value) => setTierField(name, "min")(value)}
                      step="0.01"
                    />
                    <Num
                      label="Max ($/sq ft)"
                      value={costDraft.tiers[name].max}
                      onChange={(value) => setTierField(name, "max")(value)}
                      step="0.01"
                    />
                  </>
                )}
              </div>
              {!estimated && (
                <label className="tier-notes-field">
                  Client-facing notes
                  <input
                    type="text"
                    value={costDraft.tiers[name].notes}
                    placeholder="e.g. Our most popular level — semi-custom homes with real character."
                    onChange={(e) => setTierField(name, "notes")(e.target.value)}
                  />
                </label>
              )}
            </div>
          ))}
          {estimated && (
            <button type="button" className="secondary compact" onClick={deriveEstimatedRates}>
              ⟳ Derive rates from baseline × factor
            </button>
          )}
          <p className="admin-hint">
            Every visitor sees the provenance label — verified prices with a green checkmark, estimates
            with a red warning. Switching to estimated requires the baseline and factor the derivation
            uses.
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

        <fieldset className="admin-section test-config" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">✓</span> F. Test this configuration
          </legend>
          <p className="admin-hint">
            Run the same rectangular fallback used by the public calculator before publishing.
          </p>
          <div className="admin-fields four test-inputs">
            <Num label="Lot width (ft)" value={testLot.width_ft} onChange={(value) => setTestLot((lot) => ({ ...lot, width_ft: value }))} />
            <Num label="Lot depth (ft)" value={testLot.depth_ft} onChange={(value) => setTestLot((lot) => ({ ...lot, depth_ft: value }))} />
            <Num label="Recorded area (sq ft)" value={testLot.area_sqft} onChange={(value) => setTestLot((lot) => ({ ...lot, area_sqft: value }))} />
          </div>
          <button type="button" className="secondary compact" onClick={runTest}>Preview calculation</button>
          {testResult && (
            <dl className="test-results">
              <div><dt>Envelope</dt><dd>{Math.round(testResult.envelope.areaSqft).toLocaleString()} sq ft</dd></div>
              <div><dt>Maximum footprint</dt><dd>{Math.round(testResult.footprint).toLocaleString()} sq ft</dd></div>
              <div><dt>Total building area</dt><dd>{Math.round(testResult.buildable).toLocaleString()} sq ft</dd></div>
              <div><dt>FAR limit</dt><dd>{testResult.farLimited ? "Applied" : "Not configured"}</dd></div>
            </dl>
          )}
        </fieldset>

        {validation?.length > 0 && (
          <div className="validation-panel" role="alert">
            <strong>Fix before publishing</strong>
            <ul>{validation.map((message) => <li key={message}>{message}</li>)}</ul>
          </div>
        )}
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
              setValidation(null);
              setTestResult(null);
              localStorage.removeItem(draftKey(muni.id, district.id));
            }}
          >
            ⟲ Reset
          </button>
          <button type="button" className="secondary" disabled={saving || !ready} onClick={saveDraft}>
            Save draft
          </button>
          <button type="button" className="secondary" disabled={saving || !ready} onClick={runValidation}>
            Validate
          </button>
          <button type="button" className="primary" disabled={saving || !ready} onClick={publish}>
            {saving ? "Publishing…" : "Publish configuration"}
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
