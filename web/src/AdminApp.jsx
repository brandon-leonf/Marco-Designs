import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { booleanPointInPolygon, point } from "@turf/turf";
import {
  supabase,
  fetchStates,
  fetchMunicipalities,
  fetchZoningGeojson,
  fetchZoningProvenance,
} from "./lib/supabase.js";
import { geocodeAddress } from "./lib/geocode.js";
import { STATE_NAMES, stateNameFor } from "./lib/states.js";
import {
  getSession,
  onAuthChange,
  signIn,
  signOut,
  checkIsAdmin,
  saveDistrict,
  replaceZoningRules,
  touchMunicipality,
  saveCostModel,
  createState,
  createMunicipality,
  updateMunicipality,
  createDistrict,
  municipalityImpact,
  deleteMunicipality,
  deleteDistrict,
  zoningAreaCounts,
  publishZoningLayer,
} from "./lib/adminApi.js";
import Logo from "./components/Logo.jsx";
import { computeBuildable, missingDistrictRules } from "./lib/envelope.js";
import {
  RULE_APPLIES_TO,
  applyZoningRules,
  normalizeZoningRule,
  synchronizeBaselineRules,
  validateZoningRule,
  zoningRuleNotes,
} from "./lib/zoningRules.js";

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
 * The state last worked in, remembered across visits.
 *
 * Configuration is done a state at a time over many sittings, so opening the
 * Municipalities section on the state picker every visit would be one click of
 * nothing on the way to the same place. Stored per browser like the drafts are,
 * and treated as a hint: it is verified against the states that actually exist
 * before it is used.
 */
const LAST_STATE_KEY = "demarco-config-last-state";
function loadLastState() {
  try {
    return localStorage.getItem(LAST_STATE_KEY) || null;
  } catch {
    return null;
  }
}
function rememberLastState(code) {
  try {
    if (code) localStorage.setItem(LAST_STATE_KEY, code);
  } catch {
    // A browser refusing storage is not a reason to fail navigation.
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

/**
 * Right-click menu state, shared by the municipality and district lists.
 *
 * Everything that would move the menu away from the row it points at closes it —
 * a pointer press elsewhere, Escape, any scroll, the window losing focus or
 * being resized — because the menu is positioned against the viewport and a
 * stale one would sit over an unrelated row. `itemCount` only sizes the flip
 * away from the bottom edge.
 */
function useContextMenu(itemCount = 2) {
  const [contextMenu, setContextMenu] = useState(null);
  const firstItemRef = useRef(null);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    firstItemRef.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const openContextMenu = (event, item) => {
    const menuWidth = 220;
    const menuHeight = itemCount * 44 + 12;
    setContextMenu({
      item,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  };

  return {
    contextMenu,
    openContextMenu,
    closeContextMenu: () => setContextMenu(null),
    firstItemRef,
  };
}

/**
 * The menu itself. `items` are `{label, onSelect, danger}` — selecting one
 * closes the menu first, so a handler that navigates does not leave it behind.
 */
function ContextMenu({ menu, label, items, firstItemRef, onClose }) {
  if (!menu) return null;
  return (
    <div
      className="municipality-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: menu.left, top: menu.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((entry, index) => (
        <button
          key={entry.label}
          ref={index === 0 ? firstItemRef : undefined}
          type="button"
          role="menuitem"
          className={entry.danger ? "menu-danger" : undefined}
          onClick={() => {
            const target = menu.item;
            onClose();
            entry.onSelect(target);
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Open a row's menu from the keyboard, at the row rather than at the pointer.
 * The Menu key and Shift+F10 are what a native context menu answers to.
 */
function contextMenuKeyHandler(open, item) {
  return (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    open({ clientX: bounds.left + Math.min(56, bounds.width), clientY: bounds.top + 44 }, item);
  };
}

function MunicipalityCard({
  item,
  status,
  selected = false,
  onOpen,
  onSetup,
  onContextMenu,
  compact = false,
}) {
  return (
    <li>
      <div
        className={selected ? "muni-card selected" : "muni-card"}
        onContextMenu={(event) => {
          if (!onContextMenu) return;
          event.preventDefault();
          onContextMenu(event, item);
        }}
        onKeyDown={onContextMenu ? contextMenuKeyHandler(onContextMenu, item) : undefined}
      >
        <button
          type="button"
          className="muni-card-open"
          aria-haspopup={onContextMenu ? "menu" : undefined}
          onClick={() => onOpen(item.id)}
        >
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
// No "Rule logic" tab. Normalized rules are still what the calculator reads,
// but they are derived from the Setbacks & limits numbers on publish rather
// than hand-authored — see `synchronizedRules`.
const RULE_TABS = [
  { id: "setbacks", label: "Setbacks & limits" },
  { id: "adu", label: "ADU" },
  { id: "pricing", label: "Pricing" },
  { id: "import", label: "Import PDF" },
  { id: "review", label: "Review & test" },
  { id: "zoning-setup", label: "Zoning setup", opensView: true },
];

function RuleTabBar({ activeTab, onSelect }) {
  return (
    <div className="rule-tabs" role="tablist" aria-label="Rule groups">
      {RULE_TABS.map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab.id}
          className={activeTab === tab.id ? "rule-tab active" : "rule-tab"}
          aria-selected={activeTab === tab.id}
          onClick={() => onSelect(tab)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

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
 * The state list: the level above municipalities.
 *
 * Towns are configured one state at a time, and once more than one state is on
 * file a single flat list stops saying which rules apply where. Picking the
 * state first makes that explicit, and keeps the town list to the towns whose
 * codes actually share a state.
 */
function StatesPanel({ states, stateCode, ready, newState, onNewState, onSelect, children }) {
  return (
    <div className="card admin-municipalities">
      <div className="admin-panel-head">
        <div>
          <AdminCrumbs items={[{ label: "States" }]} />
          <h2>States</h2>
          <p className="admin-side-note">Select a state to see the municipalities in it.</p>
        </div>
        {/* Municipalities are added from inside a state, where the state they
            land in is already settled — so this level adds states only. */}
        <button
          type="button"
          className="primary compact"
          disabled={!ready || !!newState}
          onClick={onNewState}
        >
          ＋ New state
        </button>
      </div>

      {children}

      <ul className="muni-list">
        {states.map((group) => (
          <li key={group.code}>
            <div className={group.code === stateCode ? "muni-card selected" : "muni-card"}>
              <button
                type="button"
                className="muni-card-open"
                onClick={() => onSelect(group.code)}
              >
                <span className="muni-avatar" aria-hidden="true">{group.code}</span>
                <span className="muni-card-body">
                  <span className="muni-card-title">
                    <strong>{group.name}</strong>
                    <span className="muni-readiness">
                      <em className={`muni-status ${group.live === group.munis.length ? "active" : "draft"}`}>
                        {group.live} of {group.munis.length} live
                      </em>
                    </span>
                  </span>
                  <span className="muni-card-meta">
                    {group.munis.length}{" "}
                    {group.munis.length === 1 ? "municipality" : "municipalities"}
                    {group.counties.length > 0 && ` · ${group.counties.join(", ")}`}
                  </span>
                </span>
                <span className="muni-card-chevron" aria-hidden="true">›</span>
              </button>
            </div>
          </li>
        ))}
        {states.length === 0 && (
          <li className="admin-side-note">No states yet. Add one to file municipalities under.</li>
        )}
      </ul>

      <p className="admin-list-footer">
        {states.length} {states.length === 1 ? "state" : "states"}
      </p>
    </div>
  );
}

/**
 * The municipality list: search, readiness at a glance, and the way into a
 * town's configuration. Selecting one loads it and moves to its district rules.
 */
function MunicipalitiesPanel({
  munis,
  muniId,
  stateName,
  zoningCounts,
  ready,
  query,
  onQuery,
  onBackToStates,
  onSelect,
  onSetup,
  onEdit,
  onDelete,
  onNew,
  children,
}) {
  const { contextMenu, openContextMenu, closeContextMenu, firstItemRef } = useContextMenu(2);

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
          {/* The state leads: this screen is the municipalities *of* it, and
              the state is the crumb that goes back to the picker. */}
          <AdminCrumbs
            items={[
              { label: stateName, onClick: onBackToStates },
              { label: "Municipalities" },
            ]}
          />
          <h2>{stateName}</h2>
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
          placeholder={`Search municipalities in ${stateName}…`}
          aria-label={`Search municipalities in ${stateName}`}
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
              onContextMenu={openContextMenu}
            />
          );
        })}
        {matches.length === 0 && (
          <li className="admin-side-note">
            {/* A state now scopes the list, so it can be empty with nothing
                typed — the search wording would be wrong there. */}
            {query.trim()
              ? `No municipality in ${stateName} matches “${query.trim()}”.`
              : `No municipalities in ${stateName} yet.`}
          </li>
        )}
      </ul>

      <p className="admin-list-footer">
        Showing {matches.length} of {munis.length}
      </p>

      <ContextMenu
        menu={contextMenu}
        label={contextMenu ? `${contextMenu.item.name} actions` : undefined}
        firstItemRef={firstItemRef}
        onClose={closeContextMenu}
        items={[
          { label: "Edit municipality", onSelect: onEdit },
          { label: "Delete municipality", onSelect: onDelete, danger: true },
        ]}
      />
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
    name: district.name ?? "",
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

const enumLabel = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

function ConfigEditor({ adminEmail, ready }) {
  const [munis, setMunis] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [muniId, setMuniId] = useState(null);
  const [districtId, setDistrictId] = useState(null);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState(null);
  const [ruleDraft, setRuleDraft] = useState([]);
  const [costDraft, setCostDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState(null); // {kind: "ok"|"error", text}
  const [copied, setCopied] = useState(false);
  // No `district` field: createMunicipality no longer inserts a starter
  // district, so the code for one is asked for on the districts panel instead.
  const [newMuni, setNewMuni] = useState(null); // null | {name, state, county, sourceUrl, lastUpdated}
  // Same identifying fields as the create form, reopened against a town that
  // already exists. Its slug rides along read-only so the form can say which
  // config id the edits are landing on.
  const [editMuni, setEditMuni] = useState(null); // null | {id, name, state, county, slug}
  const [newDistrict, setNewDistrict] = useState(null); // null | {code, name}
  const [editDist, setEditDist] = useState(null); // null | {id, code, name}
  // Destructive actions confirm by typing the name back, and state their
  // blast radius first — parcels are an NJGIN re-import, not an undo.
  const [deleteMuni, setDeleteMuni] = useState(null); // null | {id, name, typed, impact|null}
  const [deleteDist, setDeleteDist] = useState(null); // null | {id, code, typed}
  const [draftInfo, setDraftInfo] = useState(null); // {savedAt} when an unpublished local draft is loaded
  const [testLot, setTestLot] = useState({
    width: 25,
    depth: 102,
    area: 2548,
    grossBuildingArea: 4000,
    appliesTo: "PRINCIPAL_BUILDING",
  });
  const [testResult, setTestResult] = useState(null); // {lines: [], summary: {}}
  const [pdfImport, setPdfImport] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState("");
  const [pdfImportedKeys, setPdfImportedKeys] = useState([]);
  // Which sidebar section is showing. The drill-down is state → municipality →
  // district → rules, but it opens on the towns of the state last worked in
  // rather than at the top of it — the state picker is only worth showing when
  // there is no such state to return to.
  const [view, setView] = useState(() => (loadLastState() ? "municipalities" : "states"));
  // Which state the municipality list is showing. The remembered state is only
  // a starting point; it is replaced by the first town's state on load if the
  // one remembered no longer has anything in it.
  const [stateCode, setStateCode] = useState(loadLastState);
  const [stateRows, setStateRows] = useState([]); // [{code, name}] from the states table
  const [newState, setNewState] = useState(null); // null | {code, name}
  const {
    contextMenu: districtMenu,
    openContextMenu: openDistrictMenu,
    closeContextMenu: closeDistrictMenu,
    firstItemRef: districtMenuFirstItemRef,
  } = useContextMenu(2);
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

  // A state with no towns yet is still a state, so the list is read rather than
  // derived. A failure here is not fatal: the codes on the municipalities still
  // produce a usable list, so it falls back to those rather than blocking.
  const reloadStates = () =>
    fetchStates()
      .then((rows) => {
        setStateRows(rows);
        return rows;
      })
      .catch(() => []);

  useEffect(() => {
    Promise.all([reloadStates(), reload()]).then(([rows, data]) => {
      if (data?.length) {
        setMuniId((current) => current ?? data[0].id);
        setDistrictId((current) => current ?? data[0].zoning_districts[0]?.id ?? null);
      }
      // The remembered state is trusted only if it still exists — a state that
      // has since been emptied or removed would otherwise open to nothing with
      // no explanation.
      const known = new Set([
        ...(rows ?? []).map((row) => row.code),
        ...(data ?? []).map((item) => item.state_code),
      ]);
      const resolved = (current) =>
        current && known.has(current) ? current : data?.[0]?.state_code ?? null;
      setStateCode(resolved);
      // Nothing to open into: fall back to the picker rather than an empty list.
      if (!resolved(loadLastState())) setView("states");
    });
  }, []);

  // One place to record it, so every route into a state — the picker, the
  // dashboard, creating or moving a town — is remembered without each having
  // to say so.
  useEffect(() => {
    rememberLastState(stateCode);
  }, [stateCode]);

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
    // Arriving from the dashboard can cross states, so the crumb trail is told
    // which state this town is in rather than assuming the one already picked.
    const targetMuni = munis?.find((item) => item.id === id) ?? null;
    if (targetMuni?.state_code) setStateCode(targetMuni.state_code);
    setView("districts");
  };

  const submitNewState = async () => {
    const code = newState?.code.trim().toUpperCase() ?? "";
    if (code.length !== 2) {
      setSaveState({ kind: "error", text: "A state needs its 2-letter code." });
      return;
    }
    setSaving(true);
    setSaveState(null);
    try {
      await createState({ code, name: newState.name });
      await reloadStates();
      setNewState(null);
      // Straight into the new state: it is empty, and adding the first
      // municipality is the only thing left to do in it.
      setStateCode(code);
      setMuniQuery("");
      setView("municipalities");
      setSaveState({
        kind: "ok",
        text: `${stateNameFor(code)} added. Add its first municipality next.`,
      });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  /** Drill from the state list into the towns in one state. */
  const openState = (code) => {
    setStateCode(code);
    setMuniQuery("");
    setNewMuni(null);
    setEditMuni(null);
    setDeleteMuni(null);
    setView("municipalities");
  };

  const openDistrict = (id) => {
    setDistrictId(id);
    setRuleTab("setbacks");
    setView("rules");
  };

  const openZoningSetup = (id) => {
    const targetMuni = munis?.find((item) => item.id === id) ?? null;
    setMuniId(id);
    if (targetMuni?.state_code) setStateCode(targetMuni.state_code);
    setDistrictId((current) =>
      targetMuni?.zoning_districts.some((item) => item.id === current)
        ? current
        : targetMuni?.zoning_districts[0]?.id ?? null
    );
    setZoningSetupDirty(false);
    setPendingSetupView(null);
    setView("zoning-setup");
  };

  const selectSetupTab = (tab) => {
    if (tab.id === "zoning-setup") return;
    const destination = districtId
      ? { view: "rules", ruleTab: tab.id }
      : { view: "districts", ruleTab: tab.id };
    if (zoningSetupDirty) {
      setPendingSetupView(destination);
      return;
    }
    setRuleTab(tab.id);
    setView(destination.view);
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
    } else if (nextView && typeof nextView === "object") {
      setRuleTab(nextView.ruleTab ?? "setbacks");
      setView(nextView.view);
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
  const stateName = stateNameFor(stateCode);

  // Every state on file, whether or not a municipality has been added to it —
  // an added state has to be visible before it has anything in it, or there is
  // nowhere to add the first town. Codes found only on municipalities are
  // folded in too, so a town can never sit in a state the list omits.
  const states = useMemo(() => {
    const groups = new Map();
    const blankGroup = (code) => ({
      code,
      // Named from the code rather than from the stored name: rows created
      // before states were added explicitly hold the code in that column, and
      // "NJ" is not what the list should say.
      name: stateNameFor(code),
      munis: [],
      counties: [],
      live: 0,
    });
    for (const row of stateRows) {
      if (row.code) groups.set(row.code, blankGroup(row.code));
    }
    for (const item of munis ?? []) {
      const code = item.state_code;
      if (!code) continue;
      const group = groups.get(code) ?? blankGroup(code);
      group.munis.push(item);
      if (item.county && !group.counties.includes(item.county)) group.counties.push(item.county);
      // Same readiness rule the town rows report, rolled up.
      if (
        municipalityStatus(item, zoningCounts ? zoningCounts.get(item.id) ?? 0 : null).key ===
        "active"
      ) {
        group.live += 1;
      }
      groups.set(code, group);
    }
    for (const group of groups.values()) group.counties.sort((a, b) => a.localeCompare(b));
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [munis, stateRows, zoningCounts]);

  const stateMunis = useMemo(
    () => (munis ?? []).filter((item) => item.state_code === stateCode),
    [munis, stateCode]
  );
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
      setRuleDraft([]);
      setDraftInfo(null);
      return;
    }
    const stored = loadLocalDraft(district.id);
    if (stored?.draft) {
      setDraft({
        ...stored.draft,
        // Drafts saved before district names became editable do not contain
        // this key. Preserve the published name instead of showing a blank.
        name: stored.draft.name ?? district.name ?? "",
      });
      setRuleDraft(
        (stored.ruleDraft ?? district.zoning_rules ?? []).map((rule) =>
          normalizeZoningRule(rule, {
            municipalityId: muni?.id,
            districtId: district.id,
          })
        )
      );
      if (stored.costDraft) setCostDraft({ ...stored.costDraft, provenance: "estimated" });
      setDraftInfo({ savedAt: stored.savedAt });
    } else {
      setDraft(draftFromDistrict(district));
      setRuleDraft(
        (district.zoning_rules ?? []).map((rule) =>
          normalizeZoningRule(rule, {
            municipalityId: muni?.id,
            districtId: district.id,
          })
        )
      );
      setDraftInfo(null);
    }
    setSaveState(null);
    setTestResult(null);
    setPdfImport(null);
    setPdfProgress("");
    setPdfImportedKeys([]);
  }, [district, muni?.id]);
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

  const synchronizedRules = useMemo(
    () => synchronizeBaselineRules(
      district ? { ...district, source_url: muni?.source_url ?? "" } : district,
      draft,
      ruleDraft
    ),
    [district, draft, ruleDraft, muni?.source_url]
  );

  const jsonPreview = useMemo(() => {
    if (!draft || !muni || !district) return "";
    return JSON.stringify(
      {
        municipality: muni.name,
        district: district.code,
        district_name: draft.name.trim() || null,
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
        zoning_rules: synchronizedRules,
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
  }, [draft, costDraft, muni, district, synchronizedRules]);

  const costModelComplete =
    costDraft &&
    TIER_ORDER.every(
      (name) => costDraft.tiers[name].min !== "" && costDraft.tiers[name].max !== ""
    );

  const saveDraftLocal = () => {
    if (!district) return;
    const savedAt = new Date().toISOString();
    localStorage.setItem(
      draftKey(district.id),
      JSON.stringify({ draft, costDraft, ruleDraft: synchronizedRules, savedAt })
    );
    setDraftInfo({ savedAt });
    setSaveState({
      kind: "ok",
      text: "Draft saved in this browser only. The live site is untouched until you publish.",
    });
  };

  /**
   * Every check the loader/DB would enforce, run client-side on the draft.
   *
   * `issues` block publishing; `notes` are reported and do not. The split
   * exists because an unfinished rule is a normal state of work — it is skipped
   * by the engine rather than answering wrongly, so it is no reason to hold the
   * rest of the district back.
   */
  const collectValidation = () => {
    const issues = [];
    const notes = [];
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
    synchronizedRules.forEach((rule, index) => {
      const where = `Rule ${index + 1} (${enumLabel(rule.category)})`;
      for (const issue of validateZoningRule(rule)) issues.push(`${where}: ${issue}`);
      for (const note of zoningRuleNotes(rule)) notes.push(`${where}: ${note}`);
    });
    if (synchronizedRules.length > 0) {
      ok.push(`${synchronizedRules.length} normalized zoning rule(s) are ready to publish.`);
    }
    for (const name of TIER_ORDER) {
      const t = costDraft.tiers[name];
      if (t.min === "" || t.max === "") {
        issues.push(`${TIER_LABELS[name]}: projected tiers need both min and max.`);
      } else if (Number(t.max) < Number(t.min)) {
        issues.push(`${TIER_LABELS[name]}: max ($${t.max}) is below min ($${t.min}).`);
      }
    }
    if (issues.length === 0) ok.unshift("All checks passed — safe to publish.");
    return { issues, notes, ok };
  };

  /** District-shaped object from the DRAFT values, exactly as publish would store them. */
  const districtFromDraft = () => applyZoningRules(
    {
      ...district,
      front_yard_min_ft: numOrNull(draft.front_yard_min_ft),
      rear_yard_min_ft: numOrNull(draft.rear_yard_min_ft),
      side_yard_one_min_ft: numOrNull(draft.side_yard_one_min_ft),
      side_yard_total_min_ft: numOrNull(draft.side_yard_total_min_ft),
      max_building_coverage_pct: numOrNull(draft.max_building_coverage_pct),
      max_stories: numOrNull(draft.max_stories),
      max_far: numOrNull(draft.max_far),
      zoning_rules: synchronizedRules,
    },
    {
      GROSS_BUILDING_AREA: Number(testLot.grossBuildingArea) || 0,
      LOT_AREA: Number(testLot.area) || 0,
      LOT_WIDTH: Number(testLot.width) || 0,
      LOT_DEPTH: Number(testLot.depth) || 0,
    },
    { appliesTo: testLot.appliesTo }
  );

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
    // The Validate button is gone, but the check it ran still guards publishing —
    // it is what stops an unsatisfiable side-yard pair or a coverage over 100%
    // from reaching the live calculator. With no panel to point at, the issues
    // are named in the status line itself.
    const check = collectValidation();
    if (check.issues.length > 0) {
      setSaveState({
        kind: "error",
        text: `Cannot publish — ${check.issues.length} issue${
          check.issues.length > 1 ? "s" : ""
        } to fix: ${check.issues.join(" ")}`,
      });
      return;
    }
    setSaving(true);
    setSaveState(null);
    try {
      const maxStories = numOrNull(draft.max_stories);
      const { max_stories_exact: _oldMaxStoriesExact, ...existingExtraRules } =
        district.extra_rules ?? {};
      await saveDistrict(district.id, {
        name: draft.name.trim() || null,
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

      await replaceZoningRules(muni.id, district.id, synchronizedRules);

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

      // Publishing is a claim that these are the rules that were checked, so
      // the town's "Updated" date moves with it. "Zoning last verified" writes
      // the same column, so a back-dated verification has to be entered after
      // publishing rather than before.
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
    if (!newMuni?.name.trim() || newMuni.state.trim().length !== 2) {
      setSaveState({ kind: "error", text: "A new municipality needs a name and a 2-letter state." });
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
      });
      await reload();
      setMuniId(id);
      setDistrictId(null);
      // A town can be created into a state other than the one being browsed;
      // follow it there so the crumbs and the list behind it agree.
      setStateCode(newMuni.state.trim().toUpperCase());
      setNewMuni(null);
      // No starter district is created any more, so there are no rules to land
      // on — the districts panel, where its first district is named, is next.
      setView("districts");
      setSaveState({
        kind: "ok",
        text: "Municipality created. Add its zoning districts next, then enter each district’s rules.",
      });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  /** Reopen the create form's fields against a town that already exists. */
  const startEditMuni = (targetMuni) => {
    if (!targetMuni) return;
    setMuniId(targetMuni.id);
    setDistrictId(null);
    setNewMuni(null);
    setDeleteMuni(null);
    setEditMuni({
      id: targetMuni.id,
      name: targetMuni.name ?? "",
      state: targetMuni.state_code ?? "",
      county: targetMuni.county ?? "",
      slug: targetMuni.slug ?? "",
    });
    setSaveState(null);
  };

  const submitEditMuni = async () => {
    if (!editMuni?.name.trim() || editMuni.state.trim().length !== 2) {
      setSaveState({ kind: "error", text: "A municipality needs a name and a 2-letter state." });
      return;
    }
    setSaving(true);
    setSaveState(null);
    try {
      await updateMunicipality(editMuni.id, {
        name: editMuni.name.trim(),
        stateCode: editMuni.state.trim(),
        county: editMuni.county.trim(),
      });
      const renamed = editMuni.name.trim();
      await reload();
      // Correcting the state moves the town out of the list it was edited from,
      // so follow it rather than leaving it looking deleted.
      setStateCode(editMuni.state.trim().toUpperCase());
      setEditMuni(null);
      setSaveState({
        kind: "ok",
        text: `Saved. This town now reads ${renamed} everywhere, including the public app.`,
      });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  /** Open the municipality delete confirm and load what it would take with it. */
  const startDeleteMuni = async (targetMuni) => {
    if (!targetMuni) return;
    setMuniId(targetMuni.id);
    setDistrictId(null);
    setNewMuni(null);
    setEditMuni(null);
    setDeleteMuni({ id: targetMuni.id, name: targetMuni.name, typed: "", impact: null });
    setSaveState(null);
    try {
      const impact = await municipalityImpact(targetMuni.id);
      setDeleteMuni((current) =>
        current?.id === targetMuni.id ? { ...current, impact } : current
      );
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
      setDeleteMuni(null);
    }
  };

  const submitDeleteMuni = async () => {
    if (!deleteMuni || deleteMuni.typed.trim() !== deleteMuni.name) return;
    setSaving(true);
    setSaveState(null);
    try {
      const removed = deleteMuni.name;
      await deleteMunicipality(deleteMuni.id);
      const removedMuni = munis.find((item) => item.id === deleteMuni.id);
      for (const removedDistrict of removedMuni?.zoning_districts ?? []) {
        localStorage.removeItem(draftKey(removedDistrict.id));
      }
      const data = await reload();
      // Stay in the state being browsed if it still has towns; deleting its last
      // one empties the state itself, so fall back to the state list.
      const sameState = (data ?? []).filter((item) => item.state_code === stateCode);
      const next = sameState[0] ?? data?.[0] ?? null;
      if (!sameState.length) {
        setStateCode(next?.state_code ?? null);
        setView("states");
      }
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
      // Straight into its rules: it is created empty, so the next action is
      // always to fill it in — and until they are filled in and published,
      // neither the public app nor a test drive will calculate.
      openDistrict(id);
      setNewDistrict(null);
      setSaveState({
        kind: "ok",
        text:
          "District added with blank rules. Fill in its setbacks, coverage and stories, then " +
          "Publish — “Review & test” can then run it on the public app.",
      });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  /** Open the district code/name form against a district that already exists. */
  const startEditDist = (targetDistrict) => {
    if (!targetDistrict) return;
    setNewDistrict(null);
    setDeleteDist(null);
    setEditDist({
      id: targetDistrict.id,
      code: targetDistrict.code ?? "",
      name: targetDistrict.name ?? "",
    });
    setSaveState(null);
  };

  const submitEditDist = async () => {
    if (!editDist?.code.trim()) {
      setSaveState({ kind: "error", text: "A district needs a code." });
      return;
    }
    setSaving(true);
    setSaveState(null);
    try {
      const code = editDist.code.trim().toUpperCase();
      // Only the identifying columns — the rules on this district are edited
      // through the draft-and-publish cycle and must not be touched here.
      await saveDistrict(editDist.id, { code, name: editDist.name.trim() || null });
      await reload();
      setEditDist(null);
      setSaveState({ kind: "ok", text: `District saved as ${code}.` });
    } catch (err) {
      setSaveState({ kind: "error", text: err.message ?? String(err) });
    } finally {
      setSaving(false);
    }
  };

  /** Open the district delete confirm. */
  const startDeleteDist = (targetDistrict) => {
    if (!targetDistrict) return;
    setNewDistrict(null);
    setEditDist(null);
    setDeleteDist({ id: targetDistrict.id, code: targetDistrict.code, typed: "" });
    setSaveState(null);
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

  // Save stays disabled until an edit actually differs from the stored row, so
  // the button never invites a write that would change nothing.
  const editMuniRow = editMuni ? munis.find((item) => item.id === editMuni.id) ?? null : null;
  const muniEdited =
    !!editMuni &&
    (editMuni.name.trim() !== (editMuniRow?.name ?? "") ||
      editMuni.state.trim().toUpperCase() !== (editMuniRow?.state_code ?? "") ||
      editMuni.county.trim() !== (editMuniRow?.county ?? ""));

  // Held as an element for the same reason the municipality forms are: a
  // component redeclared each render would remount and drop input focus.
  const stateForm = newState ? (
    <div className="inline-create" role="group" aria-label="New state">
      <div className="inline-create-row">
        <label>
          State code
          <input
            type="text"
            maxLength={2}
            autoFocus
            value={newState.code}
            placeholder="e.g. FL"
            onChange={(e) => {
              const code = e.target.value.toUpperCase();
              // The name follows the code while it is still the one the code
              // implies. Once it has been typed over, it is left alone.
              setNewState((current) => ({
                code,
                name:
                  current.name && current.name !== STATE_NAMES[current.code]
                    ? current.name
                    : STATE_NAMES[code] ?? "",
              }));
            }}
          />
        </label>
        <label>
          State name
          <input
            type="text"
            value={newState.name}
            placeholder="e.g. Florida"
            onChange={(e) => setNewState({ ...newState, name: e.target.value })}
          />
        </label>
      </div>
      <div className="inline-create-actions">
        <button type="button" className="secondary compact" onClick={() => setNewState(null)}>
          Cancel
        </button>
        <button
          type="button"
          className="primary compact"
          disabled={saving || newState.code.trim().length !== 2}
          onClick={submitNewState}
        >
          {saving ? "Adding…" : "Add state"}
        </button>
      </div>
    </div>
  ) : null;

  // The create, edit and delete flows are the same wherever a municipality is
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
          {/* No "first district code" field: districts are added on the
              districts panel, so the town is not created with one. */}
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
      ) : editMuni ? (
        <div className="inline-create" role="group" aria-label="Edit municipality">
          <label>
            Town name
            <input
              type="text"
              value={editMuni.name}
              placeholder="e.g. Hoboken"
              onChange={(e) => setEditMuni({ ...editMuni, name: e.target.value })}
            />
          </label>
          <div className="inline-create-row">
            <label>
              State
              <input
                type="text"
                maxLength={2}
                value={editMuni.state}
                onChange={(e) => setEditMuni({ ...editMuni, state: e.target.value.toUpperCase() })}
              />
            </label>
            <label>
              County
              <input
                type="text"
                value={editMuni.county}
                placeholder="optional"
                onChange={(e) => setEditMuni({ ...editMuni, county: e.target.value })}
              />
            </label>
          </div>
          {/* The create form derives the config id from the name; here it is
              stated rather than derived, because renaming a town does not
              re-key its zoning layer, parcels or config file. */}
          <p className="admin-side-note">
            Config id: <code>{editMuni.slug}</code> — unchanged by a rename.
          </p>
          <div className="inline-create-actions">
            <button type="button" className="secondary compact" onClick={() => setEditMuni(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary compact"
              disabled={saving || !muniEdited}
              onClick={submitEditMuni}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      ) : deleteMuni ? (
        <div className="danger-confirm" role="group" aria-label="Delete municipality">
          <strong>Delete {deleteMuni.name}?</strong>
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
              Type <code>{deleteMuni.name}</code> to confirm
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
              disabled={saving || deleteMuni.typed.trim() !== deleteMuni.name}
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
      {/* The rail returns to the towns of the state last worked in. The picker
          is only the destination when there is no such state to return to;
          otherwise it is reached from the state's own crumb. */}
      <AdminSidebar
        view={activeNav}
        onView={(next) => requestView(next === "municipalities" && !stateCode ? "states" : next)}
        adminEmail={adminEmail}
      />

      {view === "states" ? (
        <StatesPanel
          states={states}
          stateCode={stateCode}
          ready={ready}
          newState={newState}
          onSelect={openState}
          onNewState={() => {
            setSaveState(null);
            setNewState({ code: "", name: "" });
          }}
        >
          {stateForm}
        </StatesPanel>
      ) : view === "municipalities" ? (
        <MunicipalitiesPanel
          munis={stateMunis}
          muniId={muniId}
          stateName={stateName}
          zoningCounts={zoningCounts}
          ready={ready}
          query={muniQuery}
          onQuery={setMuniQuery}
          onBackToStates={() => setView("states")}
          onSelect={openMunicipality}
          onSetup={openZoningSetup}
          onEdit={startEditMuni}
          onDelete={startDeleteMuni}
          onNew={() => {
            setEditMuni(null);
            setDeleteMuni(null);
            setNewMuni({
              name: "",
              state: stateCode ?? "NJ",
              county: "",
              sourceUrl: "",
              lastUpdated: "",
            });
          }}
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
          district={district}
          zoningAreaCount={zoningCounts?.get(muni?.id) ?? 0}
          onBack={() => requestView("municipalities")}
          onBackToStates={() => requestView("states")}
          onSelectRuleTab={selectSetupTab}
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
                  { label: stateName, onClick: () => setView("states") },
                  { label: "Municipalities", onClick: () => setView("municipalities") },
                  { label: muni?.name ?? "Municipality" },
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
                aria-haspopup="menu"
                onClick={() => openDistrict(item.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openDistrictMenu(event, item);
                }}
                onKeyDown={contextMenuKeyHandler(openDistrictMenu, item)}
              >
                <span className="district-code">{item.code}</span>
                <span className="district-name">{item.name ?? "—"}</span>
                <span className="district-check" aria-hidden="true">›</span>
              </button>
            </li>
          ))}
          {districts.length === 0 && <li className="admin-side-note">No districts match.</li>}
        </ul>
        <ContextMenu
          menu={districtMenu}
          label={districtMenu ? `District ${districtMenu.item.code} actions` : undefined}
          firstItemRef={districtMenuFirstItemRef}
          onClose={closeDistrictMenu}
          items={[
            { label: "Edit zoning district", onSelect: startEditDist },
            { label: "Delete zoning district", onSelect: startDeleteDist, danger: true },
          ]}
        />
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
        ) : editDist ? (
          <div className="inline-create" role="group" aria-label="Edit district">
            <div className="inline-create-row">
              <label>
                Code
                <input
                  type="text"
                  value={editDist.code}
                  placeholder="e.g. R-2"
                  onChange={(e) => setEditDist({ ...editDist, code: e.target.value })}
                />
              </label>
              <label>
                Name
                <input
                  type="text"
                  value={editDist.name}
                  placeholder="optional"
                  onChange={(e) => setEditDist({ ...editDist, name: e.target.value })}
                />
              </label>
            </div>
            {/* Zoning polygons point at the district by id, not by code, so a
                code correction does not strand the map. */}
            <p className="admin-side-note">
              Renaming changes how this district is labelled everywhere. Its rules, pricing and
              mapped zoning polygons stay attached.
            </p>
            <div className="inline-create-actions">
              <button type="button" className="secondary compact" onClick={() => setEditDist(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary compact"
                disabled={saving || !editDist.code.trim()}
                onClick={submitEditDist}
              >
                {saving ? "Saving…" : "Save changes"}
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
            {/* Deleting the town is on its right-click menu in the list it
                belongs to; a standing delete button on the way into its
                districts was one misclick from the wrong thing. */}
            <button
              type="button"
              className="secondary compact"
              disabled={!ready}
              onClick={() => setNewDistrict({ code: "", name: "" })}
            >
              ＋ Add district
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
                { label: stateName, onClick: () => setView("states") },
                { label: "Municipalities", onClick: () => setView("municipalities") },
                {
                  label: muni?.name ?? "Municipality",
                  onClick: () => setView("districts"),
                },
                { label: district?.code ?? "District" },
              ]}
            />
            <h2>District Rules</h2>
            <p>
              {district?.code} — {draft.name.trim() || "Unnamed district"}
            </p>
          </div>
          {draftInfo && (
            <span className="draft-badge" title={`Draft saved ${draftInfo.savedAt}`}>
              ● Unpublished draft
            </span>
          )}
        </div>

        <RuleTabBar
          activeTab={ruleTab}
          onSelect={(tab) => {
            if (tab.opensView) {
              setView("zoning-setup");
              return;
            }
            setRuleTab(tab.id);
          }}
        />

        <div className="district-identity-editor">
          <label>
            District name
            <input
              type="text"
              value={draft.name}
              placeholder="e.g. One Family Residential"
              disabled={!ready || saving}
              onChange={(event) => setField("name")(event.target.value)}
            />
          </label>
          <span>
            District code <strong>{district.code}</strong>
          </span>
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
              hint="Enter a whole number. The total building height is controlled by Max Total Building Height."
              imported={pdfImportedKeys.includes("max_stories")}
            />
            <Num
              label="Max FAR (0.00)"
              value={draft.max_far}
              onChange={setField("max_far")}
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
                  />
                  <Num
                    label="Max ($/sq ft)"
                    value={costDraft.tiers[name].max}
                    onChange={(value) => setTierField(name, "max")(value)}
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
            <Num label="Test gross building area (sq ft)" value={testLot.grossBuildingArea} onChange={(v) => setTestLot({ ...testLot, grossBuildingArea: v })} />
            <label>
              Applies to
              <select value={testLot.appliesTo} onChange={(event) => setTestLot({ ...testLot, appliesTo: event.target.value })}>
                {RULE_APPLIES_TO.map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}
              </select>
            </label>
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
              setRuleDraft(
                (district.zoning_rules ?? []).map((rule) =>
                  normalizeZoningRule(rule, {
                    municipalityId: muni.id,
                    districtId: district.id,
                  })
                )
              );
              setCostDraft(draftFromCostModel(costModel));
              setSaveState(null);
                        setTestResult(null);
              setPdfImportedKeys([]);
            }}
          >
            ⟲ Discard draft
          </button>
          <button type="button" className="secondary" disabled={saving || !ready} onClick={saveDraftLocal}>
            Save draft
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
  district,
  zoningAreaCount,
  onBack,
  onBackToStates,
  onSelectRuleTab,
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
      {/* `admin-editor-head`, not `admin-panel-head`: this is a tab of the
          District Rules screen, and the panel head sizes its h2 differently,
          so the heading changed size and position when the tab changed. */}
      <div className="admin-editor-head">
        <div>
          <AdminCrumbs
            items={[
              { label: stateNameFor(muni.state_code), onClick: onBackToStates },
              { label: "Municipalities", onClick: onBack },
              { label: muni.name },
              ...(district ? [{ label: district.code }] : []),
            ]}
          />
          <h2>District Rules</h2>
          <p>{district ? `${district.code} — ${district.name ?? "District"}` : "Choose a district to edit its rules."}</p>
        </div>
      </div>

      <RuleTabBar activeTab="zoning-setup" onSelect={onSelectRuleTab} />

      <div className="zoning-setup-title">
        <h3>Zoning Layer Setup</h3>
        <p className="admin-side-note">
          {incompleteDistrictCount > 0
            ? `${incompleteDistrictCount} district rule set${incompleteDistrictCount === 1 ? "" : "s"} incomplete`
            : "Rules complete"}
          {" · "}
          {zoningAreaCount > 0 ? `${zoningAreaCount} map boundaries published` : "Map boundary missing"}
        </p>
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
        <button type="button" className="secondary compact" onClick={() => onView("states")}>
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

/**
 * A numeric field that reads the way the number is spoken — 10,000, not 10000.
 *
 * `type="text"` rather than `type="number"`: a number input rejects the
 * separators outright, so grouping is impossible while it stays one. What that
 * gives up is recovered deliberately — `inputMode` keeps the numeric keypad on
 * touch, and the input pattern below refuses a leading minus the way `min="0"`
 * used to.
 *
 * The grouped form shows only while the field is idle. Regrouping under the
 * caret would move it on every keystroke past the thousands mark, and the raw
 * keystrokes are held here rather than round-tripped through a number so a
 * half-typed "10." survives long enough to become "10.5".
 */
function Num({ label, value, onChange, imported = false, hint = null }) {
  const [typed, setTyped] = useState(null); // non-null only while focused

  const blank = value === "" || value == null;
  const display =
    typed !== null
      ? typed
      : blank
        ? ""
        // Every decimal the value carries is kept: rounding to the default
        // three would quietly rewrite a FAR of 0.1875 as 0.188.
        : Number(value).toLocaleString("en-US", { maximumFractionDigits: 20 });

  return (
    <label className={imported ? "pdf-imported" : undefined}>
      {label}
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onFocus={() => setTyped(blank ? "" : String(value))}
        onBlur={() => setTyped(null)}
        onChange={(e) => {
          const raw = e.target.value.replace(/,/g, "");
          // Anything that is not a non-negative decimal is dropped rather than
          // committed, which is what the number input did on its own.
          if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
          setTyped(raw);
          onChange(raw === "" ? "" : Number(raw));
        }}
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
