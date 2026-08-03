import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { booleanPointInPolygon, point } from "@turf/turf";
import {
  supabase,
  fetchMunicipalities,
  fetchZoningGeojson,
  fetchZoningProvenance,
} from "./lib/supabase.js";
import { geocodeAddress } from "./lib/geocode.js";
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
  zoningAreaCounts,
  publishZoningLayer,
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

const TIER_ORDER = ["essential", "signature", "premium"];
const TIER_LABELS = {
  essential: "Essential",
  signature: "Signature",
  premium: "Premium",
};
/** "" in a form field means "not set" and is stored as NULL. */
const numOrNull = (value) => (value === "" || value == null ? null : Number(value));
const numOrEmpty = (value) => (value == null ? "" : value);
const mapSearchCache = new Map();
const BOUNDARY_COLORS = [
  "#2f6f4e",
  "#b45f36",
  "#4f67a8",
  "#9a5a9e",
  "#a07b16",
  "#287d89",
  "#8b4b55",
];
let boundaryIdSequence = 0;
const newBoundaryId = (prefix = "boundary") =>
  `${prefix}-${Date.now()}-${++boundaryIdSequence}`;
const withBoundaryIds = (features, prefix) =>
  (features ?? []).map((feature) => ({
    ...feature,
    id: feature.id ?? newBoundaryId(prefix),
  }));

async function searchMapLocation(value) {
  const query = String(value ?? "").trim();
  if (query.length < 2) return null;
  const cacheKey = query.toLowerCase();
  if (mapSearchCache.has(cacheKey)) return mapSearchCache.get(cacheKey);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("polygon_threshold", "0.0001");
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Map search is temporarily unavailable.");
  const row = (await response.json())?.[0] ?? null;
  const result = row
    ? {
        lat: Number(row.lat),
        lon: Number(row.lon),
        label: row.display_name,
        bounds: Array.isArray(row.boundingbox) ? row.boundingbox.map(Number) : null,
        geometry: row.geojson ?? null,
      }
    : null;
  mapSearchCache.set(cacheKey, result);
  return result;
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
  const hasPricing = TIER_ORDER.every((name) =>
    tiers.some(
      (tier) =>
        tier?.tier === name &&
        Number(tier?.rate_per_sqft) > 0 &&
        (tier?.rate_per_sqft_max == null ||
          Number(tier.rate_per_sqft_max) >= Number(tier.rate_per_sqft))
    )
  );

  if (districts.length === 0) return { key: "districts", label: "Needs districts" };
  if (!hasPricing) return { key: "pricing", label: "Needs pricing" };
  if (districts.some((district) => missingDistrictRules(district).length > 0)) {
    return { key: "draft", label: "Draft" };
  }
  // Completed rules and geographic coverage are separate readiness facts.
  // Missing polygons must not make a completed rule set look unfinished.
  if (zoningAreas === 0) {
    return {
      key: "map-missing",
      label: "Rules complete",
      detail: "Map boundary missing",
      setupAction: true,
    };
  }
  // null means the count could not be read. Unknown is not the same as zero,
  // and reporting a missing layer on a failed query would be a lie.
  if (zoningAreas == null) {
    return { key: "map-unknown", label: "Rules complete", detail: "Map status unavailable" };
  }
  return { key: "active", label: "Active" };
}

/**
 * The trail through the Municipalities section, shown on every screen in it.
 *
 * Each crumb is labelled with its subject rather than its screen — "Union City,
 * NJ" rather than "Zoning Districts" — because the subject is what the user is
 * tracking; the heading underneath already says what kind of screen it is. The
 * last crumb is where you are and is not a link.
 */
function AdminCrumbs({ items }) {
  return (
    <nav className="admin-crumbs" aria-label="Breadcrumb">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`}>
            {index > 0 && (
              <span className="admin-crumb-sep" aria-hidden="true">
                ›
              </span>
            )}
            {last || !item.onClick ? (
              <span className="admin-crumb current" aria-current={last ? "page" : undefined}>
                {item.label}
              </span>
            ) : (
              <button type="button" className="admin-crumb" onClick={item.onClick}>
                {item.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
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

function MunicipalityCard({ item, status, selected = false, onOpen, onSetup, compact = false }) {
  return (
    <li>
      <div className={selected ? "muni-card selected" : "muni-card"}>
        <button type="button" className="muni-card-open" onClick={() => onOpen(item.id)}>
          <span className="muni-avatar" aria-hidden="true">{initialsFor(item.name)}</span>
          <span className="muni-card-body">
            <span className="muni-card-title">
              <strong>{item.name}, {item.state_code}</strong>
              <span className="muni-readiness">
                <em className={`muni-status ${status.key}`}>{status.label}</em>
                {status.detail && (
                  <em className={`muni-status ${status.key}-detail`}>{status.detail}</em>
                )}
              </span>
            </span>
            <span className="muni-card-meta">
              {!compact && (
                <>
                  {item.zoning_districts.length}{" "}
                  {item.zoning_districts.length === 1 ? "district" : "districts"} · {" "}
                </>
              )}
              Updated {formatUpdated(item.last_updated)}
            </span>
          </span>
          <span className="muni-card-chevron" aria-hidden="true">›</span>
        </button>
        {status.setupAction && (
          <button
            type="button"
            className="secondary compact muni-setup-action"
            onClick={() => onSetup(item.id)}
          >
            Set up zoning layer
          </button>
        )}
      </div>
    </li>
  );
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
  { id: "zoning-setup", label: "Zoning setup", opensView: true },
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
  onSetup,
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
        <div>
          <AdminCrumbs items={[{ label: "Municipalities" }]} />
          <h2>Municipalities</h2>
        </div>
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
            <MunicipalityCard
              key={item.id}
              item={item}
              status={status}
              selected={item.id === muniId}
              onOpen={onSelect}
              onSetup={onSetup}
            />
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
    // The editor publishes one honest client-facing mode: regional projection.
    // Legacy verified rows are loaded into the same range fields, then become
    // estimated when the admin publishes them with a baseline and local factor.
    provenance: "estimated",
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
  // Which sidebar section is showing. The list opens first: picking the town
  // is the decision every other section depends on.
  const [view, setView] = useState("municipalities");
  const [muniQuery, setMuniQuery] = useState("");
  const [zoningCounts, setZoningCounts] = useState(null);
  const [zoningSetupDirty, setZoningSetupDirty] = useState(false);
  const [pendingSetupView, setPendingSetupView] = useState(null);

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

  const openZoningSetup = (id) => {
    setMuniId(id);
    setDistrictId(null);
    setZoningSetupDirty(false);
    setPendingSetupView(null);
    setView("zoning-setup");
  };

  const requestView = (nextView) => {
    if (view === "zoning-setup" && zoningSetupDirty && nextView !== "zoning-setup") {
      setPendingSetupView(nextView);
      return;
    }
    setView(nextView);
  };

  const finishSetupNavigation = () => {
    const nextView = pendingSetupView;
    setPendingSetupView(null);
    setZoningSetupDirty(false);
    if (nextView === "__back_to_app__") {
      window.location.hash = "#/";
    } else if (nextView === "__sign_out__") {
      signOut();
    } else if (nextView) {
      setView(nextView);
    }
  };

  useEffect(() => {
    if (view !== "zoning-setup" || !zoningSetupDirty) return undefined;
    const interceptTopNavigation = (event) => {
      const target = event.target;
      const backToApp = target?.closest?.('a[href="#/"]');
      const signOutButton = target?.closest?.(".nav-signout");
      if (!backToApp && !signOutButton) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingSetupView(backToApp ? "__back_to_app__" : "__sign_out__");
    };
    document.addEventListener("click", interceptTopNavigation, true);
    return () => document.removeEventListener("click", interceptTopNavigation, true);
  }, [view, zoningSetupDirty]);

  // Districts, rules and pricing are all inside the Municipalities section, so
  // the rail stays lit on Municipalities however deep the drill-down goes.
  const activeNav = view === "dashboard" ? "dashboard" : "municipalities";

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
      if (stored.costDraft) setCostDraft({ ...stored.costDraft, provenance: "estimated" });
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
          provenance: "estimated",
          regional_baseline_per_sqft: numOrNull(costDraft.regional_baseline_per_sqft),
          local_cost_factor: numOrNull(costDraft.local_cost_factor),
          tiers: Object.fromEntries(
            TIER_ORDER.map((name) => [
              name,
              {
                rate_per_sqft: {
                  min: numOrNull(costDraft.tiers[name].min),
                  max: numOrNull(costDraft.tiers[name].max),
                },
                notes: costDraft.tiers[name].notes || null,
              },
            ])
          ),
        },
      },
      null,
      2
    );
  }, [draft, costDraft, muni, district]);

  const costModelComplete =
    costDraft &&
    TIER_ORDER.every(
      (name) => costDraft.tiers[name].min !== "" && costDraft.tiers[name].max !== ""
    );

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
    if (stories != null && stories < 1) issues.push("Max Stories must be at least 1.");
    if (stories != null && !Number.isInteger(stories)) {
      issues.push("Max Stories must be a whole number, such as 2 or 3.");
    }
    ok.push(
      draft.max_far === ""
        ? "Max FAR is blank → stored as null (no FAR cap). Blank is never treated as 0."
        : `Max FAR = ${draft.max_far} → buildable area capped at lot area × ${draft.max_far}.`
    );
    for (const name of TIER_ORDER) {
      const t = costDraft.tiers[name];
      if (t.min === "" || t.max === "") {
        issues.push(`${TIER_LABELS[name]}: projected tiers need both min and max.`);
      } else if (Number(t.max) < Number(t.min)) {
        issues.push(`${TIER_LABELS[name]}: max ($${t.max}) is below min ($${t.min}).`);
      }
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
      if (t.max !== "") {
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
      const maxStories = numOrNull(draft.max_stories);
      const { max_stories_exact: _oldMaxStoriesExact, ...existingExtraRules } =
        district.extra_rules ?? {};
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
        max_stories: maxStories,
        max_far: numOrNull(draft.max_far),
        max_height_ft: numOrNull(draft.max_height_ft),
        extra_rules: {
          ...existingExtraRules,
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
            provenance: "estimated",
            // The deployed database still requires these fields for estimated
            // rows. Preserve existing metadata; older verified rows use the
            // Signature minimum as a neutral internal baseline with factor 1.
            // Pricing itself always comes from the three admin-entered ranges.
            regional_baseline_per_sqft:
              numOrNull(costDraft.regional_baseline_per_sqft) ??
              Number(costDraft.tiers.signature.min),
            local_cost_factor: numOrNull(costDraft.local_cost_factor) ?? 1,
          },
          TIER_ORDER.map((name) => ({
            tier: name,
            rate_per_sqft: Number(costDraft.tiers[name].min),
            rate_per_sqft_max: Number(costDraft.tiers[name].max),
            notes: costDraft.tiers[name].notes || null,
            formula_reference: "admin_entered_regional_projection_range",
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
        text: "Municipality created. Fill in the district rules and cost model, then publish the configuration.",
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
      // A newly created district always opens on its own blank zoning-rule
      // form. Clearing a same-id local entry is defensive (Postgres sequences
      // normally never reuse ids) and prevents any stale browser draft from
      // making a new district look as though it inherited another one's data.
      localStorage.removeItem(draftKey(id));
      setDistrictId(id);
      setRuleTab("setbacks");
      setView("rules");
      setNewDistrict(null);
      setSaveState({
        kind: "ok",
        text: "District added with blank rules. Enter this district’s values, then Save draft or Publish configuration.",
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
  const setTierField = (name, key) => (value) =>
    setCostDraft((d) => ({
      ...d,
      tiers: { ...d.tiers, [name]: { ...d.tiers[name], [key]: value } },
    }));

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
      <AdminSidebar view={activeNav} onView={requestView} adminEmail={adminEmail} />

      {view === "municipalities" ? (
        <MunicipalitiesPanel
          munis={munis}
          muniId={muniId}
          zoningCounts={zoningCounts}
          ready={ready}
          query={muniQuery}
          onQuery={setMuniQuery}
          onSelect={openMunicipality}
          onSetup={openZoningSetup}
          onNew={() => setNewMuni({ name: "", state: "NJ", county: "", district: "R" })}
        >
          {muniForms}
        </MunicipalitiesPanel>
      ) : view === "dashboard" ? (
        <AdminDashboard
          munis={munis}
          zoningCounts={zoningCounts}
          onOpen={openMunicipality}
          onSetup={openZoningSetup}
          onView={setView}
        />
      ) : view === "zoning-setup" ? (
        <ZoningLayerSetup
          muni={muni}
          zoningAreaCount={zoningCounts?.get(muni?.id) ?? 0}
          onBack={() => requestView("municipalities")}
          onEditRules={() => requestView(districtId ? "rules" : "districts")}
          dirty={zoningSetupDirty}
          pendingNavigation={pendingSetupView}
          onDirtyChange={setZoningSetupDirty}
          onCancelNavigation={() => setPendingSetupView(null)}
          onLeaveWithoutSaving={finishSetupNavigation}
          onSavedAndLeave={finishSetupNavigation}
          onPublished={async () => {
            await reload();
          }}
        />
      ) : view === "districts" ? (
        <div className="card admin-districts wide">
          <div className="admin-panel-head">
            <div>
              {/* The trail replaces the old "All municipalities" button — it
                  goes to the same place and says where you are as well. */}
              <AdminCrumbs
                items={[
                  { label: "Municipalities", onClick: () => setView("municipalities") },
                  { label: `${muni?.name ?? "Municipality"}, ${muni?.state_code ?? ""}`.trim() },
                ]}
              />
              <h2>Zoning Districts</h2>
              <p className="admin-side-note">Select a district to edit its rules.</p>
            </div>
          </div>
        {muniForms}
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
            <AdminCrumbs
              items={[
                { label: "Municipalities", onClick: () => setView("municipalities") },
                {
                  label: `${muni?.name ?? "Municipality"}, ${muni?.state_code ?? ""}`.trim(),
                  onClick: () => setView("districts"),
                },
                { label: district?.code ?? "District" },
              ]}
            />
            <h2>District Rules</h2>
            <p>
              {district?.code} — {district?.name ?? "District"}
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

        <div className="rule-tabs" role="tablist" aria-label="Rule groups">
          {RULE_TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              key={tab.id}
              className={ruleTab === tab.id ? "rule-tab active" : "rule-tab"}
              aria-selected={ruleTab === tab.id}
              onClick={() => {
                if (tab.opensView) {
                  setView("zoning-setup");
                  return;
                }
                setRuleTab(tab.id);
              }}
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
            <Num
              label="Max Stories (whole floors)"
              value={draft.max_stories}
              onChange={setField("max_stories")}
              step="1"
              hint="Enter a whole number. The total building height is controlled by Max Total Building Height."
              imported={pdfImportedKeys.includes("max_stories")}
            />
            <Num
              label="Max FAR (0.00)"
              value={draft.max_far}
              onChange={setField("max_far")}
              step="0.01"
              hint="Example: 0.19 = 19% of the lot area."
            />
            <Num label="Max Total Building Height (ft)" value={draft.max_height_ft} onChange={setField("max_height_ft")} imported={pdfImportedKeys.includes("max_height_ft")} />
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
          <div className="admin-fields pricing-provenance">
            <div className="admin-static-field">
              <span>Provenance</span>
              <strong>Estimated — Regional Projection</strong>
            </div>
          </div>
          {TIER_ORDER.map((name) => (
            <div className="tier-editor" key={name}>
              <span className="tier-editor-name">{TIER_LABELS[name]}</span>
              <div className="admin-fields four">
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
              </div>
              <label className="tier-notes-field">
                Client-facing notes
                <input
                  type="text"
                  value={costDraft.tiers[name].notes}
                  placeholder="e.g. Our most popular level — semi-custom homes with real character."
                  onChange={(e) => setTierField(name, "notes")(e.target.value)}
                />
              </label>
            </div>
          ))}
          <p className="admin-hint">
            Enter Marco’s figures for Essential, Signature, and Premium, including each range and
            client-facing description.
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
          <button type="button" className="secondary compact admin-test-run" onClick={runTest}>
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

function ZoningLayerSetup({
  muni,
  zoningAreaCount,
  onBack,
  onEditRules,
  onPublished,
  dirty,
  pendingNavigation,
  onDirtyChange,
  onCancelNavigation,
  onLeaveWithoutSaving,
  onSavedAndLeave,
}) {
  const [sourceMode, setSourceMode] = useState("draw");
  const [layer, setLayer] = useState(null);
  const [layerBusy, setLayerBusy] = useState(true);
  const [layerName, setLayerName] = useState("");
  const [layerError, setLayerError] = useState("");
  const [codeField, setCodeField] = useState("");
  const [mapping, setMapping] = useState({});
  const [sourceUrl, setSourceUrl] = useState("");
  const [testAddress, setTestAddress] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setBoundaryTestResult] = useState(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishState, setPublishState] = useState(null);
  const [hasUnfinishedBoundary, setHasUnfinishedBoundary] = useState(false);

  const districts = muni?.zoning_districts ?? [];
  const incompleteDistrictCount = districts.filter(
    (district) => missingDistrictRules(district).length > 0
  ).length;
  const features = layer?.features ?? [];

  // Drawing is incremental. Load the published polygons first so adding one
  // more district cannot silently replace boundaries from an earlier session.
  useEffect(() => {
    if (!muni?.slug) return undefined;
    let stale = false;
    onDirtyChange(false);
    setLayerBusy(true);
    setLayerError("");
    Promise.all([
      fetchZoningGeojson(muni.slug),
      fetchZoningProvenance(muni.slug),
    ])
      .then(([areas, provenance]) => {
        if (stale) return;
        if (areas.length) {
          setLayer({
            type: "FeatureCollection",
            features: areas.map((area, index) => ({
              type: "Feature",
              id: newBoundaryId(`published-${index + 1}`),
              properties: { district_code: area.district_code },
              geometry: area.geojson,
            })),
          });
          setLayerName(
            `${areas.length} published boundar${areas.length === 1 ? "y" : "ies"} loaded`
          );
          setCodeField("district_code");
        } else {
          setLayer(null);
          setLayerName("");
        }
        if (/^https?:\/\//i.test(provenance?.source_map_url ?? "")) {
          setSourceUrl(provenance.source_map_url);
        }
      })
      .catch((error) => {
        if (!stale) {
          setLayerError(
            `Published boundaries could not be loaded: ${error.message ?? String(error)}`
          );
        }
      })
      .finally(() => {
        if (!stale) setLayerBusy(false);
      });
    return () => {
      stale = true;
    };
  }, [muni?.slug]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);
  const propertyFields = useMemo(() => {
    const names = new Set();
    for (const feature of features) {
      Object.keys(feature?.properties ?? {}).forEach((name) => names.add(name));
    }
    return [...names].sort();
  }, [features]);

  useEffect(() => {
    if (!propertyFields.length) {
      setCodeField("");
      return;
    }
    const preferred = ["district_code", "code", "district", "zone", "zoning"]
      .find((name) => propertyFields.some((field) => field.toLowerCase() === name));
    setCodeField((current) =>
      propertyFields.includes(current)
        ? current
        : propertyFields.find((field) => field.toLowerCase() === preferred) ?? propertyFields[0]
    );
  }, [propertyFields]);

  const sourceCodes = useMemo(() => {
    if (!codeField) return [];
    return [...new Set(
      features
        .map((feature) => String(feature?.properties?.[codeField] ?? "").trim())
        .filter(Boolean)
    )].sort();
  }, [features, codeField]);

  useEffect(() => {
    const districtCodes = new Map(
      districts.map((district) => [String(district.code).trim().toUpperCase(), district.code])
    );
    setMapping((current) => {
      const next = {};
      for (const sourceCode of sourceCodes) {
        next[sourceCode] =
          current[sourceCode] ?? districtCodes.get(sourceCode.toUpperCase()) ?? "";
      }
      return next;
    });
  }, [districts, sourceCodes]);

  if (!muni) {
    return <div className="card admin-setup-page">Municipality not found.</div>;
  }

  const validGeometry = (geometry) =>
    geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";

  const uploadLayer = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setLayerError("");
    setPublishState(null);
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
        throw new Error("Upload a GeoJSON FeatureCollection.");
      }
      if (!parsed.features.length || parsed.features.some((feature) => !validGeometry(feature.geometry))) {
        throw new Error("Every zoning feature must contain a Polygon or MultiPolygon geometry.");
      }
      setLayer({
        ...parsed,
        features: withBoundaryIds(parsed.features, "uploaded"),
      });
      setLayerName(file.name);
      onDirtyChange(true);
    } catch (error) {
      setLayer(null);
      setLayerName("");
      setLayerError(error.message ?? String(error));
    } finally {
      event.target.value = "";
    }
  };

  const addDrawnBoundary = (feature) => {
    setLayer((current) => ({
      type: "FeatureCollection",
      features: [
        ...(current?.features ?? []),
        { ...feature, id: feature.id ?? newBoundaryId("drawn") },
      ],
    }));
    setLayerName("Boundaries drawn in the setup map");
    setCodeField("district_code");
    setLayerError("");
    setPublishState(null);
    onDirtyChange(true);
  };

  const removeBoundary = (featureId) => {
    setLayer((current) => ({
      type: "FeatureCollection",
      features: (current?.features ?? []).filter(
        (feature) => String(feature.id) !== String(featureId)
      ),
    }));
    setBoundaryTestResult(null);
    setPublishState({
      kind: "ok",
      text: "Boundary removed from this draft. Publish the municipality to save the deletion.",
    });
    onDirtyChange(true);
  };

  const allMatched =
    features.length > 0 &&
    features.every((feature) => {
      const sourceCode = String(feature?.properties?.[codeField] ?? "").trim();
      return Boolean(sourceCode && mapping[sourceCode]);
    });
  const mappedFeatures = allMatched
    ? features.map((feature, index) => ({
        district_code: mapping[String(feature?.properties?.[codeField] ?? "").trim()],
        geometry: feature.geometry,
        source_feature_id: String(feature.id ?? index + 1),
        properties: feature.properties ?? {},
      }))
    : [];
  const unmatchedCodes = sourceCodes.filter((sourceCode) => !mapping[sourceCode]);

  const testBoundary = async () => {
    if (!testAddress.trim() || !allMatched) return;
    setTestBusy(true);
    setBoundaryTestResult(null);
    try {
      const matches = await geocodeAddress(testAddress, 1);
      if (!matches.length) throw new Error("No matching address was found.");
      const match = matches[0];
      const location = point([match.lon, match.lat]);
      const featureIndex = features.findIndex((feature) =>
        booleanPointInPolygon(location, feature)
      );
      if (featureIndex < 0) {
        setBoundaryTestResult({
          kind: "error",
          text: `${match.full_label ?? match.address} is outside the uploaded boundaries.`,
        });
        return;
      }
      const sourceCode = String(features[featureIndex]?.properties?.[codeField] ?? "").trim();
      setBoundaryTestResult({
        kind: "ok",
        text: `${match.full_label ?? match.address} matches district ${mapping[sourceCode]}.`,
      });
    } catch (error) {
      setBoundaryTestResult({ kind: "error", text: error.message ?? String(error) });
    } finally {
      setTestBusy(false);
    }
  };

  const publish = async () => {
    if (!mappedFeatures.length || hasUnfinishedBoundary) return false;
    setPublishBusy(true);
    setPublishState(null);
    try {
      const count = await publishZoningLayer(muni.id, mappedFeatures, {
        sourceUrl: sourceUrl.trim() || "Admin zoning setup",
        srid: 4326,
      });
      await onPublished();
      setPublishState({ kind: "ok", text: `Published ${count} zoning polygon${count === 1 ? "" : "s"}.` });
      onDirtyChange(false);
      return true;
    } catch (error) {
      const raw = error.message ?? String(error);
      setPublishState({
        kind: "error",
        text: /admin_publish_zoning_layer/i.test(raw)
          ? "Zoning-layer publishing is not enabled in the connected database yet. Deploy the pending database migrations, then publish again."
          : raw,
      });
      return false;
    } finally {
      setPublishBusy(false);
    }
  };

  const saveAndLeave = async () => {
    const saved = await publish();
    if (saved) onSavedAndLeave();
  };

  return (
    <div className="card admin-setup-page">
      <div className="admin-panel-head">
        <div>
          <AdminCrumbs
            items={[
              { label: "Municipalities", onClick: onBack },
              { label: `${muni.name}, ${muni.state_code}` },
            ]}
          />
          <h2>Zoning Layer Setup</h2>
          <p className="admin-side-note">
            {incompleteDistrictCount > 0
              ? `${incompleteDistrictCount} district rule set${incompleteDistrictCount === 1 ? "" : "s"} incomplete`
              : "Rules complete"}
            {" · "}
            {zoningAreaCount > 0 ? `${zoningAreaCount} map boundaries published` : "Map boundary missing"}
          </p>
        </div>
        <button type="button" className="secondary compact" onClick={onEditRules}>Edit district rules</button>
      </div>

      <ol className="zoning-setup-steps">
        <li className={features.length ? "setup-step complete" : "setup-step current"}>
          <span className="setup-step-number">1</span>
          <div className="setup-step-content">
            <div className="setup-step-heading">
              <div><h3>Draw or upload zoning boundaries</h3><p>Add Polygon or MultiPolygon boundaries in WGS84 coordinates.</p></div>
              {features.length > 0 && <em>✓ {features.length} polygon{features.length === 1 ? "" : "s"}</em>}
            </div>
            <div className="setup-source-tabs" role="tablist" aria-label="Boundary source">
              <button type="button" className={sourceMode === "draw" ? "active" : ""} onClick={() => setSourceMode("draw")}>Draw boundaries</button>
              <button type="button" className={sourceMode === "upload" ? "active" : ""} onClick={() => setSourceMode("upload")}>Upload GeoJSON</button>
            </div>
            {sourceMode === "upload" ? (
              <div className="setup-upload-box">
                <label className="secondary compact file-button">
                  Choose GeoJSON
                  <input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={uploadLayer} />
                </label>
                <span>{layerName || "No boundary file selected"}</span>
              </div>
            ) : (
              layerBusy ? (
                <p className="status-line">Loading published zoning boundaries…</p>
              ) : (
                <BoundaryDrawMap
                  districts={districts}
                  features={features}
                  municipalityLabel={`${muni.name}, ${muni.state_code}`}
                  onFeature={addDrawnBoundary}
                  onRemoveFeature={removeBoundary}
                  onDrawingChange={(unfinished) => {
                    setHasUnfinishedBoundary(unfinished);
                    if (unfinished) onDirtyChange(true);
                  }}
                />
              )
            )}
            {layerError && <p className="status-line error-text">{layerError}</p>}
            {unmatchedCodes.length > 0 && (
              <p className="status-line error-text">
                No configured district matches {unmatchedCodes.join(", ")}. Add or rename the district rules before publishing.
              </p>
            )}
            <label className="setup-source-url">
              Source map URL <small>Recommended for provenance</small>
              <input
                type="url"
                value={sourceUrl}
                placeholder="https://municipality.gov/zoning-map"
                onChange={(event) => {
                  setSourceUrl(event.target.value);
                  onDirtyChange(true);
                }}
              />
            </label>
          </div>
        </li>

        <li className={testResult?.kind === "ok" ? "setup-step complete" : allMatched ? "setup-step current" : "setup-step locked"}>
          <span className="setup-step-number">2</span>
          <div className="setup-step-content">
            <div className="setup-step-heading"><div><h3>Test an address</h3><p>Confirm that a real address lands in the expected district polygon.</p></div>{testResult?.kind === "ok" && <em>✓ Passed</em>}</div>
            <div className="setup-test-row">
              <input type="search" value={testAddress} placeholder={`Address in ${muni.name}`} disabled={!allMatched || testBusy} onChange={(event) => setTestAddress(event.target.value)} />
              <button type="button" className="secondary compact" disabled={!allMatched || !testAddress.trim() || testBusy} onClick={testBoundary}>{testBusy ? "Testing…" : "Test address"}</button>
            </div>
            {testResult && <p className={testResult.kind === "ok" ? "status-line save-ok" : "status-line error-text"}>{testResult.text}</p>}
          </div>
        </li>

        <li className={allMatched ? "setup-step current" : "setup-step locked"}>
          <span className="setup-step-number">3</span>
          <div className="setup-step-content">
            <div className="setup-step-heading"><div><h3>Publish municipality</h3><p>Replace this municipality’s zoning layer with the reviewed boundaries.</p></div></div>
            <button
              type="button"
              className="primary"
              disabled={!allMatched || publishBusy || hasUnfinishedBoundary}
              onClick={publish}
            >
              {publishBusy ? "Publishing…" : "Publish municipality"}
            </button>
            {hasUnfinishedBoundary && (
              <p className="status-line error-text">
                Finish the polygon or undo its remaining points before publishing.
              </p>
            )}
            {publishState && <p className={publishState.kind === "ok" ? "status-line save-ok" : "status-line error-text"}>{publishState.text}</p>}
          </div>
        </li>
      </ol>
      {pendingNavigation && (
        <div className="unsaved-boundary-backdrop" role="presentation">
          <section
            className="unsaved-boundary-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-boundary-title"
          >
            <h3 id="unsaved-boundary-title">Save boundary changes before leaving?</h3>
            <p>
              Your added or deleted zoning boundaries have not been published to the database yet.
            </p>
            {hasUnfinishedBoundary && (
              <p className="status-line error-text">
                One polygon is unfinished. Stay here to finish it before saving.
              </p>
            )}
            <div className="unsaved-boundary-actions">
              <button type="button" className="secondary" onClick={onCancelNavigation}>
                Stay here
              </button>
              <button type="button" className="text-danger" onClick={onLeaveWithoutSaving}>
                Leave without saving
              </button>
              <button
                type="button"
                className="primary"
                disabled={publishBusy || !mappedFeatures.length || hasUnfinishedBoundary}
                onClick={saveAndLeave}
              >
                {publishBusy ? "Saving…" : "Save & publish, then leave"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function BoundaryDrawMap({
  districts,
  features = [],
  municipalityLabel,
  onFeature,
  onRemoveFeature,
  onDrawingChange,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const lineRef = useRef(null);
  const boundariesLayerRef = useRef(null);
  const lastFittedViewRef = useRef("");
  const searchHighlightRef = useRef(null);
  const callbackRef = useRef(onFeature);
  callbackRef.current = onFeature;
  const [districtCode, setDistrictCode] = useState(districts[0]?.code ?? "");
  const [points, setPoints] = useState([]);
  const [searchText, setSearchText] = useState(municipalityLabel ?? "");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchState, setSearchState] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [showAllDistricts, setShowAllDistricts] = useState(false);
  const [selectedBoundaryId, setSelectedBoundaryId] = useState(null);
  const colorByCode = useMemo(
    () =>
      new Map(
        districts.map((district, index) => [
          String(district.code ?? "").trim().toUpperCase(),
          BOUNDARY_COLORS[index % BOUNDARY_COLORS.length],
        ])
      ),
    [districts]
  );
  const selectedFeatures = useMemo(() => {
    const selected = String(districtCode ?? "").trim().toUpperCase();
    return features.filter(
      (feature) =>
        String(feature?.properties?.district_code ?? "").trim().toUpperCase() === selected
    );
  }, [districtCode, features]);
  const displayedFeatures = showAllDistricts ? features : selectedFeatures;
  const selectedBoundary = features.find(
    (feature) => String(feature.id) === String(selectedBoundaryId)
  ) ?? null;
  const districtCounts = useMemo(() => {
    const counts = new Map();
    for (const feature of features) {
      const code = String(feature?.properties?.district_code ?? "").trim().toUpperCase();
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return counts;
  }, [features]);

  useEffect(() => {
    // Unfinished corners belong to the district that was selected when they
    // were placed. Clear them on a switch so they cannot be saved under the
    // newly selected district by accident.
    setPoints([]);
    setSelectedBoundaryId(null);
  }, [districtCode]);

  useEffect(() => {
    onDrawingChange?.(points.length > 0);
  }, [onDrawingChange, points.length]);

  useEffect(() => {
    if (
      selectedBoundaryId != null &&
      !features.some((feature) => String(feature.id) === String(selectedBoundaryId))
    ) {
      setSelectedBoundaryId(null);
    }
  }, [features, selectedBoundaryId]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current).setView([40.25, -74.55], 9);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 20,
    }).addTo(map);
    map.on("click", (event) => {
      setPoints((current) => [...current, [event.latlng.lng, event.latlng.lat]]);
    });
    mapRef.current = map;
    const timer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    if (lineRef.current) lineRef.current.remove();
    if (!points.length) {
      lineRef.current = null;
      return;
    }
    lineRef.current = L.polyline(points.map(([lng, lat]) => [lat, lng]), {
      color: "#9a7617",
      weight: 3,
    }).addTo(mapRef.current);
  }, [points]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    boundariesLayerRef.current?.remove();
    boundariesLayerRef.current = null;
    if (!displayedFeatures.length) return;

    const layer = L.geoJSON(
      { type: "FeatureCollection", features: displayedFeatures },
      {
        style: (feature) => {
          const code = String(feature?.properties?.district_code ?? "").trim().toUpperCase();
          const color = colorByCode.get(code) ?? BOUNDARY_COLORS[0];
          const selected = String(feature?.id) === String(selectedBoundaryId);
          return {
            color,
            weight: selected ? 6 : 3,
            fillColor: color,
            fillOpacity: selected ? 0.34 : 0.16,
          };
        },
        onEachFeature: (feature, polygon) => {
          const code = String(feature?.properties?.district_code ?? "").trim();
          if (code) polygon.bindTooltip(`District ${code} · click to select`);
          polygon.on("click", (event) => {
            L.DomEvent.stopPropagation(event.originalEvent ?? event);
            setSelectedBoundaryId(feature.id);
          });
        },
      }
    ).addTo(map);
    boundariesLayerRef.current = layer;
    const viewKey = `${showAllDistricts ? "all" : districtCode}:${displayedFeatures
      .map((feature) => feature.id)
      .join("|")}`;
    if (lastFittedViewRef.current !== viewKey && layer.getBounds().isValid()) {
      map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 17 });
      lastFittedViewRef.current = viewKey;
    }
  }, [colorByCode, displayedFeatures, districtCode, selectedBoundaryId, showAllDistricts]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setExpanded(false);
    };
    if (expanded) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", onKeyDown);
    }
    const timer = window.setTimeout(() => mapRef.current?.invalidateSize(), 80);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  const finishPolygon = () => {
    if (points.length < 3 || !districtCode) return;
    const ring = [...points, points[0]];
    callbackRef.current({
      type: "Feature",
      properties: { district_code: districtCode },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
    setPoints([]);
  };

  const searchTown = async (event) => {
    event.preventDefault();
    if (!searchText.trim() || !mapRef.current) return;
    setSearchBusy(true);
    setSearchState(null);
    try {
      const result = await searchMapLocation(searchText);
      if (!result || !Number.isFinite(result.lat) || !Number.isFinite(result.lon)) {
        setSearchState({ kind: "error", text: "No matching town or address was found." });
        return;
      }
      if (searchHighlightRef.current) searchHighlightRef.current.remove();
      const hasAreaBoundary =
        result.geometry?.type === "Polygon" || result.geometry?.type === "MultiPolygon";
      searchHighlightRef.current = hasAreaBoundary
        ? L.geoJSON(result.geometry, {
            style: {
              color: "#d84a3a",
              weight: 3,
              dashArray: "7 5",
              fillColor: "#d84a3a",
              fillOpacity: 0.08,
            },
          }).addTo(mapRef.current)
        : L.circleMarker([result.lat, result.lon], {
            radius: 7,
            color: "#2f6f4e",
            fillColor: "#fff",
            fillOpacity: 1,
            weight: 3,
          }).addTo(mapRef.current);
      if (result.bounds?.length === 4 && result.bounds.every(Number.isFinite)) {
        const [south, north, west, east] = result.bounds;
        mapRef.current.fitBounds([[south, west], [north, east]], { padding: [24, 24], maxZoom: 17 });
      } else {
        mapRef.current.setView([result.lat, result.lon], 15);
      }
      setSearchState({
        kind: "ok",
        text: `${hasAreaBoundary ? "Boundary highlighted" : "Location marked"}: ${result.label}`,
      });
    } catch (error) {
      setSearchState({ kind: "error", text: error.message ?? String(error) });
    } finally {
      setSearchBusy(false);
    }
  };

  return (
    <div
      className={expanded ? "boundary-draw-workspace expanded" : "boundary-draw-workspace"}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? "true" : undefined}
      aria-label={expanded ? "Expanded zoning boundary drawing map" : undefined}
    >
      {expanded && (
        <button
          type="button"
          className="boundary-expanded-close"
          aria-label="Close expanded map"
          title="Close expanded map"
          onClick={() => setExpanded(false)}
        >
          ×
        </button>
      )}
      <form className="boundary-search-row" onSubmit={searchTown}>
        <label>
          Search town or address
          <input
            type="search"
            value={searchText}
            placeholder="Town, ZIP code, or street address"
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>
        <button type="submit" className="secondary compact" disabled={searchBusy || searchText.trim().length < 2}>
          {searchBusy ? "Searching…" : "Search map"}
        </button>
      </form>
      {searchState && (
        <p className={searchState.kind === "ok" ? "boundary-search-result" : "status-line error-text"}>
          {searchState.text}
        </p>
      )}
      <div className="boundary-draw-toolbar">
        <label>
          Draw for district
          <select value={districtCode} onChange={(event) => setDistrictCode(event.target.value)}>
            {districts.map((district) => <option value={district.code} key={district.id}>{district.code}</option>)}
          </select>
        </label>
        <span>
          Click the map to place corners · {points.length} points · {selectedFeatures.length} saved for {districtCode || "this district"} · {features.length} total
        </span>
        <button
          type="button"
          className={showAllDistricts ? "secondary compact active" : "secondary compact"}
          onClick={() => {
            setShowAllDistricts((value) => !value);
            setSelectedBoundaryId(null);
          }}
        >
          {showAllDistricts ? "View selected district" : "View all districts"}
        </button>
        <button type="button" className="secondary compact" disabled={!points.length} onClick={() => setPoints((current) => current.slice(0, -1))}>Undo point</button>
        <button type="button" className="primary compact" disabled={points.length < 3 || !districtCode} onClick={finishPolygon}>Finish polygon</button>
      </div>
      {!showAllDistricts && districtCode && selectedFeatures.length === 0 && (
        <p className="boundary-search-result">
          No saved boundary for district {districtCode} yet. Draw and finish its first polygon below.
        </p>
      )}
      {features.length > 0 && (
        <div className="boundary-district-legend" aria-label="Registered zoning districts">
          {districts.map((district) => {
            const code = String(district.code ?? "").trim().toUpperCase();
            const count = districtCounts.get(code) ?? 0;
            return (
              <button
                type="button"
                className={districtCode === district.code && !showAllDistricts ? "active" : ""}
                onClick={() => {
                  setDistrictCode(district.code);
                  setShowAllDistricts(false);
                }}
                key={district.id}
              >
                <i style={{ background: colorByCode.get(code) }} aria-hidden="true" />
                {district.code} · {count} boundar{count === 1 ? "y" : "ies"}
              </button>
            );
          })}
        </div>
      )}
      {selectedBoundary && (
        <div className="boundary-selection" role="status">
          <span>
            Selected boundary · District <strong>{selectedBoundary.properties?.district_code}</strong>
          </span>
          <button
            type="button"
            className="text-danger compact"
            onClick={() => {
              onRemoveFeature?.(selectedBoundary.id);
              setSelectedBoundaryId(null);
            }}
          >
            Delete selected boundary
          </button>
        </div>
      )}
      <div className="boundary-map-shell">
        <div className="boundary-draw-map" ref={containerRef} />
        {!expanded && (
          <button
            type="button"
            className="boundary-map-expand"
            aria-label="Expand map"
            title="Expand map"
            onClick={() => setExpanded(true)}
          >
            ⛶
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Landing view: where every configured town stands, and the shortest route to
 * whatever is still missing.
 */
function AdminDashboard({ munis, zoningCounts, onOpen, onSetup, onView }) {
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
            <MunicipalityCard
              key={item.id}
              item={item}
              status={status}
              onOpen={onOpen}
              onSetup={onSetup}
              compact
            />
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
      </div>
    </div>
  );
}

function Num({ label, value, onChange, step = "1", imported = false, hint = null }) {
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
      {hint && <small>{hint}</small>}
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
