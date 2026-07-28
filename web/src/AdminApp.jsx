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
  municipalityImpact,
  deleteMunicipality,
  deleteDistrict,
} from "./lib/adminApi.js";
import Logo from "./components/Logo.jsx";
import { computeBuildable } from "./lib/envelope.js";

// Drafts live in this browser only (localStorage, keyed by district). Nothing
// touches the live database until Publish.
const draftKey = (districtId) => `demarco-config-draft-${districtId}`;
function loadLocalDraft(districtId) {
  try {
    const raw = localStorage.getItem(draftKey(districtId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

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
  // Destructive actions confirm by typing the name back, and state their
  // blast radius first — parcels are an NJGIN re-import, not an undo.
  const [deleteMuni, setDeleteMuni] = useState(null); // null | {typed, impact|null}
  const [deleteDist, setDeleteDist] = useState(null); // null | {id, code, typed}
  const [draftInfo, setDraftInfo] = useState(null); // {savedAt} when an unpublished local draft is loaded
  const [validation, setValidation] = useState(null); // {issues: [], ok: []}
  const [testLot, setTestLot] = useState({ width: 25, depth: 102, area: 2548 });
  const [testResult, setTestResult] = useState(null); // {lines: [], summary: {}}
  const [pdfImport, setPdfImport] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState("");
  const [pdfImportedKeys, setPdfImportedKeys] = useState([]);

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
  // An unpublished local draft for the district wins over the published values.
  useEffect(() => {
    if (!district) {
      setDraft(null);
      setDraftInfo(null);
      return;
    }
    const stored = loadLocalDraft(district.id);
    if (stored?.draft) {
      setDraft(stored.draft);
      if (stored.costDraft) setCostDraft(stored.costDraft);
      setDraftInfo({ savedAt: stored.savedAt });
    } else {
      setDraft(draftFromDistrict(district));
      setDraftInfo(null);
    }
    setSaveState(null);
    setValidation(null);
    setTestResult(null);
    setPdfImport(null);
    setPdfProgress("");
    setPdfImportedKeys([]);
  }, [district]);
  useEffect(() => {
    if (!muni) {
      setCostDraft(null);
      return;
    }
    const stored = district ? loadLocalDraft(district.id) : null;
    if (!stored?.costDraft) setCostDraft(draftFromCostModel(costModel));
  }, [muni, costModel, district]);

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

  const saveDraftLocal = () => {
    if (!district) return;
    const savedAt = new Date().toISOString();
    localStorage.setItem(draftKey(district.id), JSON.stringify({ draft, costDraft, savedAt }));
    setDraftInfo({ savedAt });
    setSaveState({
      kind: "ok",
      text: "Draft saved in this browser only. The live site is untouched until you publish.",
    });
  };

  /** Every check the loader/DB would enforce, run client-side on the draft. */
  const collectValidation = () => {
    const issues = [];
    const ok = [];
    const sideOne = numOrNull(draft.side_yard_one_min_ft);
    const sideTotal = numOrNull(draft.side_yard_total_min_ft);
    if (sideOne != null && sideTotal != null && sideTotal < 2 * sideOne) {
      issues.push(
        `Side yard total (${sideTotal} ft) is less than 2 × side yard one (${sideOne} ft) — both side yards cannot be met.`
      );
    } else if (sideOne != null || sideTotal != null) {
      ok.push("Side yard minimums are consistent.");
    }
    const cov = numOrNull(draft.max_building_coverage_pct);
    if (cov != null && (cov < 0 || cov > 100)) issues.push("Max building coverage must be between 0 and 100%.");
    const imp = numOrNull(draft.max_impervious_coverage_pct);
    if (imp != null && (imp < 0 || imp > 100)) issues.push("Max impervious coverage must be between 0 and 100%.");
    const stories = numOrNull(draft.max_stories);
    if (stories != null && stories < 1) issues.push("Max stories must be at least 1.");
    ok.push(
      draft.max_far === ""
        ? "Max FAR is blank → stored as null (no FAR cap). Blank is never treated as 0."
        : `Max FAR = ${draft.max_far} → buildable area capped at lot area × ${draft.max_far}.`
    );
    for (const name of TIER_ORDER) {
      const t = costDraft.tiers[name];
      if (estimated) {
        if (t.min === "") issues.push(`${TIER_LABELS[name]}: estimated rate is missing.`);
      } else {
        if (t.min === "" || t.max === "") issues.push(`${TIER_LABELS[name]}: verified tiers need both min and max.`);
        else if (Number(t.max) < Number(t.min)) issues.push(`${TIER_LABELS[name]}: max ($${t.max}) is below min ($${t.min}).`);
      }
    }
    if (estimated && (costDraft.regional_baseline_per_sqft === "" || costDraft.local_cost_factor === "")) {
      issues.push("Estimated cost models must carry the regional baseline and local cost factor they derive from.");
    }
    if (issues.length === 0) ok.unshift("All checks passed — safe to publish.");
    return { issues, ok };
  };

  const runValidation = () => setValidation(collectValidation());

  /** District-shaped object from the DRAFT values, exactly as publish would store them. */
  const districtFromDraft = () => ({
    front_yard_min_ft: numOrNull(draft.front_yard_min_ft),
    rear_yard_min_ft: numOrNull(draft.rear_yard_min_ft),
    side_yard_one_min_ft: numOrNull(draft.side_yard_one_min_ft),
    side_yard_total_min_ft: numOrNull(draft.side_yard_total_min_ft),
    max_building_coverage_pct: numOrNull(draft.max_building_coverage_pct),
    max_stories: numOrNull(draft.max_stories),
    max_far: numOrNull(draft.max_far),
  });

  const runTest = () => {
    const d = districtFromDraft();
    const lot = {
      width_ft: Number(testLot.width) || 0,
      depth_ft: Number(testLot.depth) || 0,
      area_sqft: Number(testLot.area) || 0,
    };
    let res;
    try {
      res = computeBuildable(lot, d);
    } catch (err) {
      setTestResult(null);
      setSaveState({ kind: "error", text: err.message ?? String(err) });
      return;
    }
    const num = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

    // The full calculation trace: every input and intermediate, in order.
    const lines = [];
    lines.push(`INPUT  lot: ${num(lot.width_ft)} ft × ${num(lot.depth_ft)} ft, recorded area ${num(res.lotArea)} sq ft`);
    lines.push(
      `INPUT  setbacks (ft): front ${d.front_yard_min_ft ?? 0}, rear ${d.rear_yard_min_ft ?? 0}, side one ${d.side_yard_one_min_ft ?? 0}, side total ${d.side_yard_total_min_ft ?? 0}`
    );
    const ins = res.envelope.insets;
    lines.push(`STEP   effective side inset = max(side total, 2 × side one) = ${num(ins.sideTotal)} ft across both sides`);
    lines.push(`STEP   envelope width = ${num(lot.width_ft)} − ${num(ins.sideTotal)} = ${num(res.envelope.widthFt)} ft`);
    lines.push(`STEP   envelope depth = ${num(lot.depth_ft)} − ${num(ins.front)} − ${num(ins.rear)} = ${num(res.envelope.depthFt)} ft`);
    lines.push(`STEP   envelope area = ${num(res.envelope.widthFt)} × ${num(res.envelope.depthFt)} = ${num(res.envelope.areaSqft)} sq ft`);
    const covCap = d.max_building_coverage_pct != null ? res.lotArea * (d.max_building_coverage_pct / 100) : null;
    lines.push(
      covCap != null
        ? `STEP   coverage cap = ${num(res.lotArea)} × ${d.max_building_coverage_pct}% = ${num(covCap)} sq ft`
        : "INPUT  coverage: none set → no coverage cap"
    );
    lines.push(`STEP   max footprint = min(envelope, coverage cap) = ${num(res.footprint)} sq ft  [${res.binding} bind]`);
    lines.push(`INPUT  stories = ${res.stories}`);
    lines.push(
      d.max_far == null
        ? "INPUT  max FAR = null → no FAR cap (blank is stored as null, never 0)"
        : `INPUT  max FAR = ${d.max_far} → cap = ${num(res.lotArea)} × ${d.max_far} = ${num(res.lotArea * d.max_far)} sq ft`
    );
    lines.push(
      `STEP   total buildable = ${num(res.footprint)} × ${res.stories}${res.farLimited ? ", capped by FAR" : ""} = ${num(res.buildable)} sq ft`
    );
    for (const name of TIER_ORDER) {
      const t = costDraft.tiers[name];
      if (t.min === "") continue;
      if (!estimated && t.max !== "") {
        lines.push(
          `COST   ${TIER_LABELS[name]}: ${num(res.buildable)} × $${num(t.min)}–$${num(t.max)} = $${num(res.buildable * Number(t.min))} – $${num(res.buildable * Number(t.max))}`
        );
      } else {
        lines.push(`COST   ${TIER_LABELS[name]}: ${num(res.buildable)} × $${num(t.min)} = $${num(res.buildable * Number(t.min))}`);
      }
    }
    setTestResult({ lines, summary: res });
  };

  const previewCalculation = () => {
    runTest();
    document.getElementById("test-config")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const save = async () => {
    if (!district || !draft) return;
    const check = collectValidation();
    setValidation(check);
    if (check.issues.length > 0) {
      setSaveState({ kind: "error", text: "Fix the validation issues below before publishing." });
      return;
    }
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
      localStorage.removeItem(draftKey(district.id));
      setDraftInfo(null);
      await reload();
      setSaveState({
        kind: "ok",
        text: "Published. Changes are live for every visitor.",
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

  /** Open the municipality delete confirm and load what it would take with it. */
  const startDeleteMuni = async () => {
    setDeleteMuni({ typed: "", impact: null });
    setSaveState(null);
    try {
      setDeleteMuni({ typed: "", impact: await municipalityImpact(muni.id) });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
      setDeleteMuni(null);
    }
  };

  const submitDeleteMuni = async () => {
    if (deleteMuni?.typed.trim() !== muni.name) return;
    setSaving(true);
    setSaveState(null);
    try {
      const removed = muni.name;
      await deleteMunicipality(muni.id);
      localStorage.removeItem(draftKey(districtId));
      const data = await reload();
      const next = data?.[0] ?? null;
      setMuniId(next?.id ?? null);
      setDistrictId(next?.zoning_districts[0]?.id ?? null);
      setDeleteMuni(null);
      setSaveState({ kind: "ok", text: `${removed} deleted. It no longer appears in the public app.` });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  const submitDeleteDistrict = async () => {
    if (!deleteDist || deleteDist.typed.trim().toUpperCase() !== deleteDist.code) return;
    setSaving(true);
    setSaveState(null);
    try {
      const removed = deleteDist.code;
      await deleteDistrict(deleteDist.id);
      localStorage.removeItem(draftKey(deleteDist.id));
      const data = await reload();
      const nextMuni = data?.find((m) => m.id === muni.id);
      setDistrictId(nextMuni?.zoning_districts[0]?.id ?? null);
      setDeleteDist(null);
      setSaveState({
        kind: "ok",
        text: `District ${removed} deleted. Any zoning polygons that pointed at it now resolve as “rules not loaded” rather than to other rules.`,
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

  const importPdf = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !district) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setSaveState({ kind: "error", text: "Choose a PDF file." });
      return;
    }
    setPdfBusy(true);
    setPdfImport(null);
    setSaveState(null);
    setPdfProgress("Opening PDF…");
    try {
      // PDF.js is large and only admins importing a document need it. Keep it
      // out of the public calculator's initial bundle.
      const { parseZoningPdf } = await import("./lib/pdfImport.js");
      const result = await parseZoningPdf(file, district.code, (page, total) =>
        setPdfProgress(`Reading page ${page} of ${total}…`)
      );
      setPdfImport({
        ...result,
        fileName: file.name,
        selected: Object.fromEntries(result.fields.map((field) => [field.key, true])),
      });
      setPdfProgress("");
    } catch (err) {
      setSaveState({
        kind: "error",
        text: `Could not read ${file.name}: ${err.message ?? String(err)}`,
      });
      setPdfProgress("");
    } finally {
      setPdfBusy(false);
    }
  };

  const applyPdfImport = () => {
    const selectedFields = pdfImport?.fields.filter((field) => pdfImport.selected[field.key]) ?? [];
    if (!selectedFields.length) return;
    setDraft((current) => ({
      ...current,
      ...Object.fromEntries(selectedFields.map((field) => [field.key, field.value])),
    }));
    setPdfImportedKeys(selectedFields.map((field) => field.key));
    setPdfImport(null);
    setValidation(null);
    setTestResult(null);
    setSaveState({
      kind: "ok",
      text: `${selectedFields.length} value${selectedFields.length === 1 ? "" : "s"} imported into the draft. Review them, then validate before publishing.`,
    });
    requestAnimationFrame(() =>
      document.querySelector(".admin-fields .pdf-imported")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      })
    );
  };

  if (loadError) return <div className="card error">Failed to load data: {loadError}</div>;
  if (!munis || !draft || !costDraft)
    return <div className="card loading-card">Loading configuration…</div>;

  const setField = (key) => (value) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setPdfImportedKeys((keys) => keys.filter((item) => item !== key));
  };
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
          <i aria-hidden="true">✓</i> Active municipality
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
        ) : deleteMuni ? (
          <div className="danger-confirm" role="group" aria-label="Delete municipality">
            <strong>Delete {muni?.name}?</strong>
            {deleteMuni.impact ? (
              <ul>
                <li>{deleteMuni.impact.districts} zoning district(s) and their rules</li>
                <li>the cost model and all three tier rates</li>
                <li>{deleteMuni.impact.zoningAreas} zoning polygon(s)</li>
                <li>
                  {deleteMuni.impact.parcels.toLocaleString()} imported parcel(s)
                  {deleteMuni.impact.parcels > 0 && " — restoring these means re-running the NJGIN import"}
                </li>
              </ul>
            ) : (
              <p className="admin-side-note">Checking what this would remove…</p>
            )}
            <label>
              <span>
                Type <code>{muni?.name}</code> to confirm
              </span>
              <input
                type="text"
                value={deleteMuni.typed}
                onChange={(e) => setDeleteMuni({ ...deleteMuni, typed: e.target.value })}
              />
            </label>
            <div className="inline-create-actions">
              <button type="button" className="secondary compact" onClick={() => setDeleteMuni(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger compact"
                disabled={saving || deleteMuni.typed.trim() !== muni?.name}
                onClick={submitDeleteMuni}
              >
                {saving ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        ) : (
          <div className="admin-muni-actions">
            <button
              type="button"
              className="secondary compact"
              disabled={!ready}
              onClick={() => setNewMuni({ name: "", state: "NJ", county: "", district: "R" })}
            >
              ＋ New municipality
            </button>
            <button
              type="button"
              className="text-danger compact"
              disabled={!ready || !muni}
              onClick={startDeleteMuni}
            >
              Delete {muni?.name ?? "municipality"}
            </button>
          </div>
        )}
        <div className="admin-about">
          <strong>About this editor</strong>
          <p>
            Update zoning rules, dimensional standards, ADU policies, and cost model assumptions for
            the selected municipality.
          </p>
          <p>
            <strong>Save draft</strong> keeps changes in this browser only. Nothing reaches the live
            database used by the public calculator until you <strong>Publish configuration</strong>.
          </p>
          <p>
            After publishing, run <code>scripts/export_town.py</code> and commit the diff — the
            config file stays the source of truth, and the next town load would otherwise revert
            what you changed here.
          </p>
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
        ) : deleteDist ? (
          <div className="danger-confirm" role="group" aria-label="Delete district">
            <strong>Delete district {deleteDist.code}?</strong>
            <p className="admin-side-note">
              Its rules and any draft are removed. Zoning polygons mapped to it stop resolving —
              parcels there report “rules not loaded” instead of falling back to another district’s
              rules.
            </p>
            <label>
              <span>
                Type <code>{deleteDist.code}</code> to confirm
              </span>
              <input
                type="text"
                value={deleteDist.typed}
                onChange={(e) => setDeleteDist({ ...deleteDist, typed: e.target.value })}
              />
            </label>
            <div className="inline-create-actions">
              <button type="button" className="secondary compact" onClick={() => setDeleteDist(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger compact"
                disabled={saving || deleteDist.typed.trim().toUpperCase() !== deleteDist.code}
                onClick={submitDeleteDistrict}
              >
                {saving ? "Deleting…" : "Delete district"}
              </button>
            </div>
          </div>
        ) : (
          <div className="admin-muni-actions">
            <button
              type="button"
              className="secondary compact"
              disabled={!ready}
              onClick={() => setNewDistrict({ code: "", name: "" })}
            >
              ＋ Add district
            </button>
            {/* A municipality with no districts is the empty-shell state the
                public app already refuses to calculate on. Keep the last one. */}
            <button
              type="button"
              className="text-danger compact"
              disabled={!ready || !district || (muni?.zoning_districts.length ?? 0) < 2}
              title={
                (muni?.zoning_districts.length ?? 0) < 2
                  ? "A municipality needs at least one district — delete the municipality instead."
                  : undefined
              }
              onClick={() => setDeleteDist({ id: district.id, code: district.code, typed: "" })}
            >
              Delete {district?.code ?? "district"}
            </button>
          </div>
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
          {draftInfo && (
            <span className="draft-badge" title={`Draft saved ${draftInfo.savedAt}`}>
              ● Unpublished draft
            </span>
          )}
        </div>

        <fieldset className="admin-section pdf-import-section" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">PDF</span> Import zoning PDF
          </legend>
          <div className="pdf-import-head">
            <div>
              <strong>Populate this district from an ordinance or zoning schedule</strong>
              <p className="admin-hint">
                Select the PDF for <strong>{district.code}</strong>. The file stays in this browser.
                Detected values are never applied until you review and confirm them.
              </p>
            </div>
            <label className={pdfBusy ? "secondary compact file-button disabled" : "secondary compact file-button"}>
              {pdfBusy ? "Parsing…" : "Choose PDF"}
              <input type="file" accept="application/pdf,.pdf" onChange={importPdf} disabled={pdfBusy} />
            </label>
          </div>
          {pdfProgress && <p className="status-line">{pdfProgress}</p>}
          {pdfImport && (
            <div className="pdf-import-results">
              <div className="pdf-import-summary">
                <strong>{pdfImport.fileName}</strong>
                <span>{pdfImport.pageCount} pages</span>
              </div>
              {pdfImport.scanned ? (
                <div className="validate-panel bad" role="alert">
                  <strong>Scanned PDF detected</strong>
                  <p>
                    This file has little or no selectable text. Run OCR on it, then upload the
                    searchable PDF. No values were guessed.
                  </p>
                </div>
              ) : pdfImport.fields.length === 0 ? (
                <div className="validate-panel bad" role="alert">
                  <strong>No labeled rules were found for district {district.code}</strong>
                  <p>
                    The PDF may use a table layout or different terminology. Enter the setbacks
                    manually and verify them against the official document.
                  </p>
                </div>
              ) : (
                <>
                  <p className="admin-hint">
                    Check every value against the cited page. Setbacks are highlighted first because
                    they directly control the buildable envelope.
                  </p>
                  <div className="pdf-field-list">
                    {pdfImport.fields.map((field) => (
                      <label
                        className={field.key.includes("yard") ? "pdf-field setback" : "pdf-field"}
                        key={field.key}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(pdfImport.selected[field.key])}
                          onChange={(event) =>
                            setPdfImport((current) => ({
                              ...current,
                              selected: { ...current.selected, [field.key]: event.target.checked },
                            }))
                          }
                        />
                        <span className="pdf-field-copy">
                          <span>
                            <strong>{field.label}</strong>
                            <b>{field.value}</b>
                            <em>page {field.page} · {field.confidence === "high" ? `${district.code} nearby` : "review district"}</em>
                          </span>
                          <small>{field.excerpt}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="inline-create-actions">
                    <button type="button" className="secondary compact" onClick={() => setPdfImport(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary compact"
                      disabled={!Object.values(pdfImport.selected).some(Boolean)}
                      onClick={applyPdfImport}
                    >
                      Import selected into draft
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="admin-section" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">📏</span> A. Setbacks &amp; Dimensional Rules
          </legend>
          <div className="admin-fields five">
            <Num label="Front Yard Min (ft)" value={draft.front_yard_min_ft} onChange={setField("front_yard_min_ft")} imported={pdfImportedKeys.includes("front_yard_min_ft")} />
            <Num label="Rear Yard Min (ft)" value={draft.rear_yard_min_ft} onChange={setField("rear_yard_min_ft")} imported={pdfImportedKeys.includes("rear_yard_min_ft")} />
            <Num label="Side Yard One Min (ft)" value={draft.side_yard_one_min_ft} onChange={setField("side_yard_one_min_ft")} imported={pdfImportedKeys.includes("side_yard_one_min_ft")} />
            <Num label="Side Yard Total Min (ft)" value={draft.side_yard_total_min_ft} onChange={setField("side_yard_total_min_ft")} imported={pdfImportedKeys.includes("side_yard_total_min_ft")} />
            <Num label="Min Lot Area (sq ft)" value={draft.min_lot_area_sqft} onChange={setField("min_lot_area_sqft")} imported={pdfImportedKeys.includes("min_lot_area_sqft")} />
            <Num label="Min Lot Width (ft)" value={draft.min_lot_width_ft} onChange={setField("min_lot_width_ft")} imported={pdfImportedKeys.includes("min_lot_width_ft")} />
            <Num label="Min Lot Depth (ft)" value={draft.min_lot_depth_ft} onChange={setField("min_lot_depth_ft")} imported={pdfImportedKeys.includes("min_lot_depth_ft")} />
            <Toggle
              label="Prevailing Front Yard Rule"
              checked={draft.front_yard_prevailing_rule}
              onChange={setField("front_yard_prevailing_rule")}
              imported={pdfImportedKeys.includes("front_yard_prevailing_rule")}
            />
          </div>
        </fieldset>

        <fieldset className="admin-section" disabled={!ready || saving}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">🏗</span> B. Build Limits
          </legend>
          <div className="admin-fields four">
            <Num label="Max Building Coverage (%)" value={draft.max_building_coverage_pct} onChange={setField("max_building_coverage_pct")} imported={pdfImportedKeys.includes("max_building_coverage_pct")} />
            <Num label="Max Stories" value={draft.max_stories} onChange={setField("max_stories")} step="0.5" imported={pdfImportedKeys.includes("max_stories")} />
            <Num label="Max FAR" value={draft.max_far} onChange={setField("max_far")} step="0.05" />
            <Num label="Max Height (ft)" value={draft.max_height_ft} onChange={setField("max_height_ft")} imported={pdfImportedKeys.includes("max_height_ft")} />
            <Num label="Max Impervious Coverage (%)" value={draft.max_impervious_coverage_pct} onChange={setField("max_impervious_coverage_pct")} imported={pdfImportedKeys.includes("max_impervious_coverage_pct")} />
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

        <fieldset className="admin-section" id="test-config" disabled={!ready}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">▶</span> F. Test This Configuration
          </legend>
          <p className="admin-hint">
            Runs the calculator against the current draft values — published data is not consulted.
            Defaults match the 508 40th St case (25′ × 102′, 2,548 sq ft).
          </p>
          <div className="admin-fields four">
            <Num label="Test lot width (ft)" value={testLot.width} onChange={(v) => setTestLot({ ...testLot, width: v })} />
            <Num label="Test lot depth (ft)" value={testLot.depth} onChange={(v) => setTestLot({ ...testLot, depth: v })} />
            <Num label="Test lot area (sq ft)" value={testLot.area} onChange={(v) => setTestLot({ ...testLot, area: v })} />
          </div>
          <button type="button" className="secondary compact" onClick={runTest}>
            ▶ Run test calculation
          </button>
          {testResult && (
            <>
              <div className="test-summary">
                <div><span>Envelope</span><strong>{Number(testResult.summary.envelope.areaSqft).toLocaleString()} sq ft</strong></div>
                <div><span>Max footprint</span><strong>{Number(testResult.summary.footprint).toLocaleString()} sq ft</strong></div>
                <div><span>Total buildable</span><strong>{Number(testResult.summary.buildable).toLocaleString()} sq ft</strong></div>
              </div>
              <pre className="json-preview test-log"><code>{testResult.lines.join("\n")}</code></pre>
            </>
          )}
        </fieldset>

        {validation && (
          <div
            className={validation.issues.length ? "validate-panel bad" : "validate-panel good"}
            role={validation.issues.length ? "alert" : "status"}
          >
            <strong>
              {validation.issues.length
                ? `✕ ${validation.issues.length} issue${validation.issues.length > 1 ? "s" : ""} must be fixed before publishing`
                : "✓ Configuration passes validation"}
            </strong>
            <ul>
              {validation.issues.map((text) => (
                <li className="validate-bad" key={text}>✕ {text}</li>
              ))}
              {validation.ok.map((text) => (
                <li key={text}>✓ {text}</li>
              ))}
            </ul>
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
              localStorage.removeItem(draftKey(district.id));
              setDraftInfo(null);
              setDraft(draftFromDistrict(district));
              setCostDraft(draftFromCostModel(costModel));
              setSaveState(null);
              setValidation(null);
              setTestResult(null);
              setPdfImportedKeys([]);
            }}
          >
            ⟲ Discard draft
          </button>
          <button type="button" className="secondary" disabled={saving || !ready} onClick={saveDraftLocal}>
            Save draft
          </button>
          <button type="button" className="secondary" disabled={saving || !ready} onClick={runValidation}>
            Validate
          </button>
          <button type="button" className="secondary" disabled={saving || !ready} onClick={previewCalculation}>
            Preview calculation
          </button>
          <button type="button" className="primary" disabled={saving || !ready} onClick={save}>
            {saving ? "Publishing…" : "Publish configuration"}
          </button>
        </div>
      </div>
    </section>
  );
}

function Num({ label, value, onChange, step = "1", imported = false }) {
  return (
    <label className={imported ? "pdf-imported" : undefined}>
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

function Toggle({ label, checked, onChange, imported = false }) {
  return (
    <label className={imported ? "admin-toggle pdf-imported" : "admin-toggle"}>
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
