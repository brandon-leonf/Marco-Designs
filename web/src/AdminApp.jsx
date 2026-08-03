import { useEffect, useMemo, useState } from "react";
import { supabase, fetchMunicipalities } from "./lib/supabase.js";
import {
  getSession,
  onAuthChange,
  signIn,
  signOut,
  checkIsAdmin,
  saveDistrict,
  saveMunicipalityMeta,
  saveCostModel,
  createMunicipality,
  createDistrict,
  municipalityImpact,
  deleteMunicipality,
  deleteDistrict,
  zoningAreaCounts,
} from "./lib/adminApi.js";
import Logo from "./components/Logo.jsx";
import { computeBuildable, missingDistrictRules } from "./lib/envelope.js";

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

/**
 * The public calculator, opened with one district applied to whatever address
 * is searched (App.jsx `PREVIEW_PARAM`). A district with no zoning polygons —
 * every newly added one — is unreachable through the normal address lookup,
 * so this is how its rules get exercised through the real client flow.
 *
 * Same document, different hash route, so the built site needs no extra page.
 */
const publicTestUrl = (districtId) =>
  `${window.location.origin}${window.location.pathname}${window.location.search}#/?preview_district=${districtId}`;

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

/**
 * What still has to happen before a municipality can answer a real enquiry.
 *
 * Derived, never stored: every one of these is a fact about the configuration
 * as it stands, so a town cannot be marked "Active" in the database while the
 * public calculator would refuse to run on it. The first unmet condition is
 * the one reported — it is the next thing to do.
 */
function municipalityStatus(muni, zoningAreas) {
  const districts = muni?.zoning_districts ?? [];
  const rawCostModel = muni?.build_cost_models;
  const costModel = (Array.isArray(rawCostModel) ? rawCostModel[0] : rawCostModel) ?? null;
  const tiers = costModel?.build_cost_tiers ?? [];
  const hasPricing = tiers.some((tier) => Number(tier?.rate_per_sqft) > 0);

  if (districts.length === 0) return { key: "districts", label: "Needs districts" };
  // null means the count could not be read. Unknown is not the same as zero,
  // and reporting a missing layer on a failed query would be a lie.
  if (zoningAreas === 0) return { key: "zoning", label: "Needs zoning layer" };
  if (!hasPricing) return { key: "pricing", label: "Needs pricing" };
  if (districts.some((district) => missingDistrictRules(district).length > 0)) {
    return { key: "draft", label: "Draft" };
  }
  return { key: "active", label: "Active" };
}

/** "UC" for Union City — the list's avatar, from the name we already have. */
function initialsFor(name) {
  const words = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "—";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// The rule groups, as tabs. Setbacks opens first because it is the section a
// district cannot be calculated without; Pricing is here rather than in its own
// nav section because it is edited in the same draft-and-publish cycle.
const RULE_TABS = [
  { id: "setbacks", label: "Setbacks & limits" },
  { id: "adu", label: "ADU" },
  { id: "pricing", label: "Pricing" },
  { id: "import", label: "Import PDF" },
  { id: "review", label: "Review & test" },
];

// Districts, rules and pricing are all reached by drilling into a town, so
// they are not listed here. A top-level "District Rules" would jump to
// whichever municipality happened to be selected — skipping the choice the
// whole section depends on.
const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: HomeIcon },
  { id: "municipalities", label: "Municipalities", icon: BuildingIcon },
];

function AdminSidebar({ view, onView, adminEmail }) {
  return (
    <nav className="admin-sidebar" aria-label="Admin sections">
      <p className="admin-sidebar-heading">Main</p>
      <ul>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={view === item.id ? "admin-nav-item active" : "admin-nav-item"}
                onClick={() => onView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <Icon />
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="admin-side-note admin-signed-in">
        Signed in as <strong>{adminEmail}</strong>
      </p>
    </nav>
  );
}

/**
 * The municipality list: search, readiness at a glance, and the way into a
 * town's configuration. Selecting one loads it and moves to its district rules.
 */
function MunicipalitiesPanel({
  munis,
  muniId,
  zoningCounts,
  ready,
  query,
  onQuery,
  onSelect,
  onNew,
  children,
}) {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? munis.filter((item) =>
        `${item.name} ${item.state_code} ${item.county ?? ""}`.toLowerCase().includes(needle)
      )
    : munis;

  return (
    <div className="card admin-municipalities">
      <div className="admin-panel-head">
        <h2>Municipalities</h2>
        <button type="button" className="primary compact" disabled={!ready} onClick={onNew}>
          ＋ New municipality
        </button>
      </div>

      <div className="admin-search">
        <span className="admin-search-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          type="search"
          value={query}
          placeholder="Search municipalities…"
          aria-label="Search municipalities"
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>

      {children}

      <ul className="muni-list">
        {matches.map((item) => {
          const status = municipalityStatus(
            item,
            zoningCounts ? zoningCounts.get(item.id) ?? 0 : null
          );
          return (
            <li key={item.id}>
              <button
                type="button"
                className={item.id === muniId ? "muni-card selected" : "muni-card"}
                onClick={() => onSelect(item.id)}
              >
                <span className="muni-avatar" aria-hidden="true">
                  {initialsFor(item.name)}
                </span>
                <span className="muni-card-body">
                  <span className="muni-card-title">
                    <strong>
                      {item.name}, {item.state_code}
                    </strong>
                    <em className={`muni-status ${status.key}`}>{status.label}</em>
                  </span>
                  <span className="muni-card-meta">
                    {item.zoning_districts.length}{" "}
                    {item.zoning_districts.length === 1 ? "district" : "districts"} · Updated{" "}
                    {formatUpdated(item.last_updated)}
                  </span>
                </span>
                <span className="muni-card-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          );
        })}
        {matches.length === 0 && (
          <li className="admin-side-note">No municipality matches “{query.trim()}”.</li>
        )}
      </ul>

      <p className="admin-list-footer">
        Showing {matches.length} of {munis.length}
      </p>
    </div>
  );
}

function formatUpdated(value) {
  if (!value) return "—";
  // `last_updated` is a calendar date, not an instant. `new Date("2026-07-26")`
  // reads it as UTC midnight, which renders as the 25th anywhere west of
  // Greenwich — so build the date in local time from its parts instead.
  const parts = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
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
  const [newMuni, setNewMuni] = useState(null); // null | {name, state, county, sourceUrl, lastUpdated, district}
  // Town-level provenance, edited in place on the districts panel. Held apart
  // from the district draft because it saves on its own button, not on Publish.
  const [muniMeta, setMuniMeta] = useState(null); // null | {sourceUrl, lastUpdated}
  const [metaSaving, setMetaSaving] = useState(false);
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
  // Which sidebar section is showing. The list opens first: picking the town
  // is the decision every other section depends on.
  const [view, setView] = useState("municipalities");
  const [muniQuery, setMuniQuery] = useState("");
  const [zoningCounts, setZoningCounts] = useState(null);

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

  // Readiness for the list. A failure here must not block the editor, so an
  // unavailable count is simply left unknown rather than reported as zero —
  // "Needs zoning layer" has to mean the layer is missing, not the query is.
  useEffect(() => {
    let stale = false;
    zoningAreaCounts()
      .then((counts) => !stale && setZoningCounts(counts))
      .catch(() => !stale && setZoningCounts(null));
    return () => {
      stale = true;
    };
  }, [munis]);

  // Which group of rules the district editor is showing. Reset on every
  // district change so a new district always opens on its setbacks.
  const [ruleTab, setRuleTab] = useState("setbacks");

  /**
   * Pick a town and show its districts. Deliberately no district is selected:
   * the drill-down is municipality → district → rules, and auto-opening one
   * district would hide that the town has others.
   */
  const openMunicipality = (id) => {
    setMuniId(id);
    setDistrictId(null);
    setView("districts");
  };

  const openDistrict = (id) => {
    setDistrictId(id);
    setRuleTab("setbacks");
    setView("rules");
  };

  // Districts, rules and pricing are all inside the Municipalities section, so
  // the rail stays lit on Municipalities however deep the drill-down goes.
  const activeNav = view === "dashboard" ? "dashboard" : "municipalities";

  const muni = munis?.find((m) => m.id === muniId) ?? null;

  // Reset the provenance form whenever the town changes or is reloaded, so it
  // always shows what is actually stored rather than a stale edit.
  useEffect(() => {
    setMuniMeta(
      muni
        ? { sourceUrl: muni.source_url ?? "", lastUpdated: muni.last_updated ?? "" }
        : null
    );
  }, [muni?.id, muni?.source_url, muni?.last_updated]);

  const metaDirty =
    muniMeta != null &&
    muni != null &&
    (muniMeta.sourceUrl !== (muni.source_url ?? "") ||
      muniMeta.lastUpdated !== (muni.last_updated ?? ""));

  const saveMeta = async () => {
    if (!muni || !muniMeta) return;
    setMetaSaving(true);
    setSaveState(null);
    try {
      await saveMunicipalityMeta(muni.id, muniMeta);
      await reload();
      setSaveState({ kind: "ok", text: "Municipality details saved." });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setMetaSaving(false);
    }
  };
  const district = muni?.zoning_districts.find((d) => d.id === districtId) ?? null;
  const rawCostModel = muni?.build_cost_models;
  const costModel = (Array.isArray(rawCostModel) ? rawCostModel[0] : rawCostModel) ?? null;
  // What the PUBLISHED row is still missing — the draft in this browser is not
  // what the public app will read, so the test-drive warning has to check the
  // stored district rather than the form.
  const publishedMissing = district ? missingDistrictRules(district) : [];

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

      // `last_updated` is not touched here on purpose — see saveMunicipalityMeta.
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
        sourceUrl: newMuni.sourceUrl.trim(),
        lastUpdated: newMuni.lastUpdated,
        districtCode: newMuni.district.trim().toUpperCase(),
      });
      const data = await reload();
      setMuniId(id);
      // Land on the starter district's rules — an empty town is not the useful
      // next screen, the district it was created with is.
      const firstDistrict = data?.find((m) => m.id === id)?.zoning_districts[0]?.id ?? null;
      setDistrictId(firstDistrict);
      setNewMuni(null);
      setRuleTab("setbacks");
      setView(firstDistrict ? "rules" : "districts");
      setSaveState({
        kind: "ok",
        text:
          "Municipality created. Fill in its setbacks, coverage and stories, then " +
          "Publish configuration.",
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
      // Straight into the new district's rules: it is created empty, so the
      // next action is always to fill it in — and until they are filled in and
      // published, neither the public app nor a test drive will calculate.
      openDistrict(id);
      setNewDistrict(null);
      setSaveState({
        kind: "ok",
        text:
          "District added. Fill in its setbacks, coverage and stories, then Publish — " +
          "“Review & test” can then run it on the public app.",
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
  // Only the municipality list is needed to render the shell. The drafts are
  // seeded from the selected district, and no district is selected until the
  // user drills into one — requiring them here would leave the municipality
  // and district screens stuck on "Loading". The rules view guards its own.
  if (!munis) return <div className="card loading-card">Loading configuration…</div>;

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

  // The create and delete flows are the same wherever a municipality is
  // managed from, so they are held as an element rather than a component —
  // a component redeclared each render would remount and drop input focus.
  const muniForms = (
      newMuni ? (
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
            Ordinance source URL
            <input
              type="url"
              value={newMuni.sourceUrl}
              placeholder="https://… (link to the zoning ordinance)"
              onChange={(e) => setNewMuni({ ...newMuni, sourceUrl: e.target.value })}
            />
          </label>
          <label>
            Zoning last verified
            <input
              type="date"
              value={newMuni.lastUpdated}
              onChange={(e) => setNewMuni({ ...newMuni, lastUpdated: e.target.value })}
            />
          </label>
          <p className="admin-side-note">
            Both are optional and can be filled in later, but they are the town’s provenance —
            the date is when the ordinance was <em>checked</em>, not when it was typed in here.
          </p>
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
        // Idle: nothing. Creating is the panel header's button and deleting
        // belongs inside the municipality you are looking at, so an idle
        // action row here would only duplicate both.
        null
      )
  );

  return (
    <section className="admin-shell">
      <AdminSidebar view={activeNav} onView={setView} adminEmail={adminEmail} />

      {view === "municipalities" ? (
        <MunicipalitiesPanel
          munis={munis}
          muniId={muniId}
          zoningCounts={zoningCounts}
          ready={ready}
          query={muniQuery}
          onQuery={setMuniQuery}
          onSelect={openMunicipality}
          onNew={() =>
            setNewMuni({
              name: "",
              state: "NJ",
              county: "",
              sourceUrl: "",
              lastUpdated: "",
              district: "R",
            })
          }
        >
          {muniForms}
        </MunicipalitiesPanel>
      ) : view === "dashboard" ? (
        <AdminDashboard
          munis={munis}
          zoningCounts={zoningCounts}
          onOpen={openMunicipality}
          onView={setView}
        />
      ) : view === "districts" ? (
        <div className="card admin-districts wide">
          <div className="admin-panel-head">
            <div>
              <h2>Zoning Districts</h2>
              <p className="admin-side-note">
                {muni?.name}, {muni?.state_code} — select a district to edit its rules.
              </p>
            </div>
            <button type="button" className="secondary compact" onClick={() => setView("municipalities")}>
              ← All municipalities
            </button>
          </div>
        {muniForms}
        {muniMeta && (
          <fieldset className="admin-section" disabled={!ready}>
            <legend>
              <span className="admin-section-icon" aria-hidden="true">ⓘ</span> Municipality details
            </legend>
            <p className="admin-hint">
              Where these rules came from. The public app labels every number by provenance, so a
              town with no source is a town whose figures cannot be traced back to an ordinance.
            </p>
            <label>
              Ordinance source URL
              <input
                type="url"
                value={muniMeta.sourceUrl}
                placeholder="https://… (link to the zoning ordinance)"
                onChange={(e) => setMuniMeta({ ...muniMeta, sourceUrl: e.target.value })}
              />
            </label>
            <label>
              Zoning last verified
              <input
                type="date"
                value={muniMeta.lastUpdated}
                onChange={(e) => setMuniMeta({ ...muniMeta, lastUpdated: e.target.value })}
              />
            </label>
            <p className="admin-side-note">
              This date is when someone last checked these rules against the ordinance — set it by
              hand. Publishing a rule change does not move it.
            </p>
            {/* The editor's shared status line lives in the rules view, which is
                not rendered here — this panel reports its own result. */}
            {saveState && (
              <p
                className={
                  saveState.kind === "ok" ? "status-line save-ok" : "status-line error-text"
                }
                role="status"
              >
                {saveState.text}
              </p>
            )}
            <div className="inline-create-actions">
              <button
                type="button"
                className="primary compact"
                disabled={!metaDirty || metaSaving}
                onClick={saveMeta}
              >
                {metaSaving ? "Saving…" : "Save details"}
              </button>
            </div>
          </fieldset>
        )}
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
                onClick={() => openDistrict(item.id)}
              >
                <span className="district-code">{item.code}</span>
                <span className="district-name">{item.name ?? "—"}</span>
                <span className="district-check" aria-hidden="true">›</span>
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
        </div>
      ) : !district || !draft || !costDraft ? (
        <div className="card admin-editor">
          <p className="admin-side-note">
            No district is selected.{" "}
            <button type="button" className="text-button compact" onClick={() => setView("districts")}>
              Choose one
            </button>{" "}
            to edit its rules.
          </p>
        </div>
      ) : (
        <div className="admin-grid solo">
      <div className="card admin-editor">
        <div className="admin-editor-head">
          <div>
            <p className="admin-crumbs">
              <button type="button" className="text-button compact" onClick={() => setView("municipalities")}>
                {muni?.name}, {muni?.state_code}
              </button>
              <span aria-hidden="true">›</span>
              <button type="button" className="text-button compact" onClick={() => setView("districts")}>
                Zoning Districts
              </button>
            </p>
            <h2>District Rules</h2>
            <p>
              {district?.code} — {district?.name ?? "District"}
            </p>
          </div>
          <span className="admin-updated">
            Zoning verified: {muni?.last_updated ?? "not recorded"}
            {muni?.source_url && (
              <>
                {" · "}
                <a href={muni.source_url} target="_blank" rel="noreferrer">
                  source
                </a>
              </>
            )}
          </span>
          {draftInfo && (
            <span className="draft-badge" title={`Draft saved ${draftInfo.savedAt}`}>
              ● Unpublished draft
            </span>
          )}
        </div>

        <div className="rule-tabs" role="tablist" aria-label="Rule groups">
          {RULE_TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              key={tab.id}
              className={ruleTab === tab.id ? "rule-tab active" : "rule-tab"}
              aria-selected={ruleTab === tab.id}
              onClick={() => setRuleTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {ruleTab === "import" && (
        <>
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
        </>
        )}

        {ruleTab === "setbacks" && (
        <>
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

        </>
        )}

        {ruleTab === "adu" && (
        <>
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
        </>
        )}

        {ruleTab === "pricing" && (
        <>
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
        </>
        )}

        {ruleTab === "review" && (
        <>
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

        <fieldset className="admin-section" disabled={!ready}>
          <legend>
            <span className="admin-section-icon" aria-hidden="true">↗</span> G. Test on the public app
          </legend>
          <p className="admin-hint">
            Opens the client-facing calculator with <strong>{district.code}</strong> applied to
            whatever address you search — the only way to run a district that has no zoning
            polygons yet, since the address lookup would never reach it. Every screen there is
            labelled as a test drive, so it can never be mistaken for a verified result.
          </p>
          <p className="admin-hint">
            It reads <strong>published</strong> rules, not the draft in this browser.
          </p>
          {draftInfo && (
            <p className="status-line error-text">
              This district has an unpublished draft. Publish first, or you will be testing the
              previously published values.
            </p>
          )}
          {publishedMissing.length > 0 && (
            <p className="status-line error-text">
              Published rules are incomplete — missing {publishedMissing.join(", ")}. The test drive
              opens and says so, but refuses to calculate until those are published.
            </p>
          )}
          <a
            className="secondary compact link-button"
            href={publicTestUrl(district.id)}
            target="_blank"
            rel="noreferrer"
          >
            ↗ Open the public app as {district.code}
          </a>
        </fieldset>
        </>
        )}

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
        </div>
      )}
    </section>
  );
}

/**
 * Landing view: where every configured town stands, and the shortest route to
 * whatever is still missing.
 */
function AdminDashboard({ munis, zoningCounts, onOpen, onView }) {
  const rows = munis.map((item) => ({
    muni: item,
    status: municipalityStatus(item, zoningCounts ? zoningCounts.get(item.id) ?? 0 : null),
  }));
  const ready = rows.filter((row) => row.status.key === "active");
  const pending = rows.filter((row) => row.status.key !== "active");

  return (
    <div className="card admin-dashboard">
      <div className="admin-panel-head">
        <h2>Dashboard</h2>
        <button type="button" className="secondary compact" onClick={() => onView("municipalities")}>
          All municipalities
        </button>
      </div>

      <div className="admin-stats">
        <div>
          <span>Municipalities</span>
          <strong>{munis.length}</strong>
        </div>
        <div>
          <span>Live for clients</span>
          <strong>{ready.length}</strong>
        </div>
        <div>
          <span>Districts configured</span>
          <strong>{munis.reduce((sum, item) => sum + item.zoning_districts.length, 0)}</strong>
        </div>
      </div>

      <h3>Needs attention</h3>
      {pending.length === 0 ? (
        <p className="admin-side-note">
          Every municipality has districts, a zoning layer, published rules, and pricing.
        </p>
      ) : (
        <ul className="muni-list">
          {pending.map(({ muni: item, status }) => (
            <li key={item.id}>
              <button type="button" className="muni-card" onClick={() => onOpen(item.id)}>
                <span className="muni-avatar" aria-hidden="true">{initialsFor(item.name)}</span>
                <span className="muni-card-body">
                  <span className="muni-card-title">
                    <strong>{item.name}, {item.state_code}</strong>
                    <em className={`muni-status ${status.key}`}>{status.label}</em>
                  </span>
                  <span className="muni-card-meta">
                    Updated {formatUpdated(item.last_updated)}
                  </span>
                </span>
                <span className="muni-card-chevron" aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
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
    </div>
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
