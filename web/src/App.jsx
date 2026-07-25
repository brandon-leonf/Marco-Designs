import { useEffect, useMemo, useState } from "react";
import {
  supabase,
  fetchMunicipalities,
  fetchParcelEnvelope,
  hasParcels,
  resolveParcelZoning,
} from "./lib/supabase.js";
import {
  computeBuildable,
  computeBuildableFromAreas,
  conservativeInsetFt,
} from "./lib/envelope.js";
import ParcelSearch from "./components/ParcelSearch.jsx";
import ParcelPlan from "./components/ParcelPlan.jsx";
import Logo from "./components/Logo.jsx";

// Marketing names for the build-quality levels. The `id` stays on the database
// tier keys so the loaded rate card keeps resolving without a migration.
const PACKAGES = [
  {
    id: "builder_grade",
    label: "Essential",
    description: "Efficient, code-compliant construction with standard finishes.",
  },
  {
    id: "mid_level",
    label: "Signature",
    description: "Upgraded finishes, detailing, and systems for most custom homes.",
  },
  {
    id: "high_end",
    label: "Premium",
    description: "High-end materials, custom millwork, and premium mechanicals.",
  },
];
const TIER_LABELS = Object.fromEntries(PACKAGES.map((item) => [item.id, item.label]));
const TIER_DESCRIPTIONS = Object.fromEntries(PACKAGES.map((item) => [item.id, item.description]));
const TIER_ORDER = PACKAGES.map((item) => item.id);
const PROJECT_TYPES = [
  { id: "new_house", label: "New house", description: "Vacant lot or full replacement" },
  { id: "addition", label: "Addition", description: "Expand an existing house" },
  { id: "adu", label: "ADU", description: "Add a smaller separate living space" },
];
const STEPS = ["Project & Property", "Results", "Review & Export"];

const fmt = (n, digits = 0) =>
  n == null || !isFinite(n)
    ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });

const tierRate = (costModel, tierId) =>
  costModel?.build_cost_tiers?.find((item) => item.tier === tierId)?.rate_per_sqft ?? null;

// The parcel path (PostGIS) reports `envelopeArea`; the rectangular manual path
// reports a full `envelope` object. Callers should not have to know which.
const envelopeAreaOf = (result) => result.envelopeArea ?? result.envelope?.areaSqft ?? 0;

// Declarative bounds for the simple numeric inputs. Validation messages and the
// browser min/max hints both read from here, so adding a new schema field is a
// single entry — not per-field logic scattered through the form.
const FIELD_RULES = {
  width_ft: { label: "Lot width", min: 1, max: 5000 },
  depth_ft: { label: "Lot depth", min: 1, max: 5000 },
  area_sqft: { label: "Lot area", min: 1, max: 10000000 },
  footprint_sqft: { label: "Existing footprint", min: 1, max: 1000000 },
  stories: { label: "Number of stories", min: 0, max: 100 },
  total_area_sqft: { label: "Existing total floor area", min: 0, max: 5000000 },
};

/** Returns an error string for a field value, or null when it is acceptable. */
function validateField(key, value, { required = false } = {}) {
  const rule = FIELD_RULES[key];
  const name = rule?.label ?? "This value";
  if (value === "" || value == null) {
    return required ? `${name} is required.` : null;
  }
  const n = Number(value);
  if (!isFinite(n)) return `${name} must be a number.`;
  if (rule?.min != null && n < rule.min) {
    return rule.min === 1 ? `${name} must be greater than zero.` : `${name} must be at least ${rule.min}.`;
  }
  if (rule?.max != null && n > rule.max) return `${name} looks too large — double-check the units.`;
  return null;
}

// Manual lot area tracks width × depth until the user types an area directly.
function deriveArea(width, depth, fallback) {
  const w = Number(width);
  const d = Number(depth);
  return w > 0 && d > 0 ? Math.round(w * d) : fallback;
}
function withLotWidth(lot, value) {
  return {
    ...lot,
    width_ft: value,
    area_sqft: lot.area_manual ? lot.area_sqft : deriveArea(value, lot.depth_ft, lot.area_sqft),
  };
}
function withLotDepth(lot, value) {
  return {
    ...lot,
    depth_ft: value,
    area_sqft: lot.area_manual ? lot.area_sqft : deriveArea(lot.width_ft, value, lot.area_sqft),
  };
}
function withLotAreaManual(lot, value) {
  return { ...lot, area_sqft: value, area_manual: true };
}
function withLotAreaRecalculated(lot) {
  return { ...lot, area_sqft: deriveArea(lot.width_ft, lot.depth_ft, lot.area_sqft), area_manual: false };
}

export default function App() {
  const [munis, setMunis] = useState(null);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [projectType, setProjectType] = useState("");
  const [entryMode, setEntryMode] = useState("search");
  const [muniId, setMuniId] = useState(null);
  const [districtId, setDistrictId] = useState(null);
  const [lot, setLot] = useState({ width_ft: 25, depth_ft: 100, area_sqft: 2500, area_manual: false });
  const [existingStructure, setExistingStructure] = useState({
    footprint_sqft: "",
    stories: "",
    total_area_sqft: "",
    location: "unsure",
  });
  const [parcelPick, setParcelPick] = useState(null);
  const [parcel, setParcel] = useState(null);
  const [parcelError, setParcelError] = useState(null);
  const [zoningCheck, setZoningCheck] = useState(null);
  // "unknown" until the parcels table has been checked for this municipality.
  const [parcelData, setParcelData] = useState("unknown");

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

  // Address search is only worth offering when parcels exist for this town.
  // Where the NJGIN import has not been run, fall back to manual entry rather
  // than leaving the user on a search that can never return a result.
  useEffect(() => {
    if (!muniId) return;
    let stale = false;
    setParcelData("unknown");
    hasParcels(muniId)
      .then((available) => {
        if (stale) return;
        setParcelData(available ? "available" : "missing");
        if (!available) {
          setEntryMode("manual");
          setParcelPick(null);
          setParcel(null);
          setZoningCheck(null);
        }
      })
      .catch(() => {
        // A failed probe must not strand the user: leave search available and
        // let the search itself surface the error.
        if (!stale) setParcelData("unknown");
      });
    return () => {
      stale = true;
    };
  }, [muniId]);

  const muni = munis?.find((m) => m.id === muniId) ?? null;
  const district = muni?.zoning_districts.find((d) => d.id === districtId) ?? null;
  const rawCostModel = muni?.build_cost_models;
  const costModel = (Array.isArray(rawCostModel) ? rawCostModel[0] : rawCostModel) ?? null;

  useEffect(() => {
    if (!parcelPick || entryMode !== "search") {
      setParcel(null);
      setZoningCheck(null);
      return;
    }

    let stale = false;
    setParcel(null);
    setParcelError(null);
    setZoningCheck({ status: "checking" });

    async function verifyAndLoadParcel() {
      try {
        // The public parcel boundary is useful even when the municipal zoning
        // layer is missing or inconclusive. Load it independently with a
        // zero-foot inset, then replace it with the verified envelope only
        // after a district match supplies authoritative setbacks.
        const [check, boundary] = await Promise.all([
          resolveParcelZoning(parcelPick.parcel_id),
          fetchParcelEnvelope(parcelPick.parcel_id, 0),
        ]);
        if (stale) return;

        setParcel({
          ...boundary,
          envelope_geojson: null,
          envelope_area_sqft: null,
        });

        if (!check) {
          setZoningCheck({ status: "unmapped" });
          return;
        }
        setZoningCheck(check);
        if (check.status !== "matched") return;

        const matchedDistrict = muni?.zoning_districts.find(
          (item) => item.id === Number(check.district_id)
        );
        if (!matchedDistrict) {
          setZoningCheck({ ...check, status: "rules_missing" });
          return;
        }

        setDistrictId(matchedDistrict.id);
        const loadedParcel = await fetchParcelEnvelope(
          parcelPick.parcel_id,
          conservativeInsetFt(matchedDistrict)
        );
        if (!stale) setParcel(loadedParcel);
      } catch (e) {
        if (stale) return;
        setParcelError(e.message ?? String(e));
        setZoningCheck({ status: "error" });
      }
    }

    verifyAndLoadParcel();
    return () => {
      stale = true;
    };
  }, [entryMode, muni, parcelPick]);

  const result = useMemo(() => {
    if (!district) return null;
    let zoningResult = null;
    if (entryMode === "search" && parcel) {
      zoningResult = computeBuildableFromAreas(
        Number(parcel.lot_area_sqft),
        Number(parcel.envelope_area_sqft ?? 0),
        district
      );
    } else if (entryMode === "manual" && lot.width_ft > 0 && lot.depth_ft > 0 && lot.area_sqft > 0) {
      zoningResult = computeBuildable(lot, district);
    }
    if (!zoningResult) return null;

    const hasExistingHouse = projectType === "addition" || projectType === "adu";
    const existingFootprint = hasExistingHouse ? Number(existingStructure.footprint_sqft) || 0 : 0;
    const enteredArea = hasExistingHouse ? Number(existingStructure.total_area_sqft) || 0 : 0;
    const enteredStories = hasExistingHouse ? Number(existingStructure.stories) || 0 : 0;
    const existingArea = !hasExistingHouse
      ? 0
      : enteredArea > 0
        ? enteredArea
        : enteredStories > 0
          ? existingFootprint * enteredStories
          : null;
    const existingAreaSource =
      !hasExistingHouse || enteredArea > 0
        ? "entered"
        : enteredStories > 0
          ? "footprint_times_stories"
          : null;
    const availableFootprint = Math.max(0, zoningResult.footprint - existingFootprint);
    const availableBuildingArea = existingArea == null ? null : Math.max(0, zoningResult.buildable - existingArea);

    return {
      ...zoningResult,
      existingFootprint,
      existingStories: enteredStories || null,
      existingArea,
      existingAreaSource,
      existingLocation: existingStructure.location,
      availableFootprint,
      availableBuildingArea,
      estimateArea: hasExistingHouse ? availableBuildingArea : zoningResult.buildable,
    };
  }, [district, entryMode, existingStructure, lot, parcel, projectType]);

  const project = PROJECT_TYPES.find((item) => item.id === projectType);
  const manualInputsValid =
    entryMode !== "manual" ||
    (!validateField("width_ft", lot.width_ft, { required: true }) &&
      !validateField("depth_ft", lot.depth_ft, { required: true }) &&
      !validateField("area_sqft", lot.area_sqft, { required: true }));
  const locationReady =
    entryMode === "search"
      ? Boolean(parcel && zoningCheck?.status === "matched")
      : Boolean(
          district &&
            manualInputsValid &&
            Number(lot.width_ft) > 0 &&
            Number(lot.depth_ft) > 0 &&
            Number(lot.area_sqft) > 0
        );
  const structureReady =
    projectType === "new_house" ||
    Number(existingStructure.footprint_sqft) > 0;
  const existingInputsValid =
    projectType === "new_house" ||
    !validateField("footprint_sqft", existingStructure.footprint_sqft, { required: true });

  // The single input step reveals itself in order: project type, then the
  // property, then the questions that depend on a resolved property. Each gate
  // below is also what unlocks the next section, so a user is never blocked by
  // a question they have not been shown yet.
  const propertyReady = Boolean(projectType && district && locationReady);
  const canCalculate = Boolean(
    propertyReady && structureReady && existingInputsValid && result
  );

  const goToStep = (next) => {
    if (next > maxStepReached) return;
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const advance = (next) => {
    setStep(next);
    setMaxStepReached((current) => Math.max(current, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const chooseManual = () => {
    setEntryMode("manual");
    setParcelPick(null);
    setParcel(null);
    setParcelError(null);
    setZoningCheck(null);
  };

  const chooseSearch = () => {
    setEntryMode("search");
    setParcelPick(null);
    setParcel(null);
    setParcelError(null);
    setZoningCheck(null);
  };

  if (!supabase) {
    return (
      <>
        <TopNav />
        <main className="shell">
          <div className="card setup-card">
          <p>
            Supabase is not configured. Copy <code>web/.env.example</code> to{" "}
            <code>web/.env</code>, fill in <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>, then restart <code>npm run dev</code>.
            </p>
          </div>
        </main>
      </>
    );
  }

  // The preview panel has nothing real to draw until a parcel is picked (search)
  // or dimensions exist (manual), so it stays hidden rather than showing a
  // placeholder lot the user might mistake for their property. It also waits on
  // the project type, so the opening question is never crowded by a diagram of
  // the default lot.
  const previewProps = {
    visible:
      !projectType
        ? false
        : entryMode === "search"
          ? Boolean(parcelPick)
          : Number(lot.width_ft) > 0 && Number(lot.depth_ft) > 0 && Number(lot.area_sqft) > 0,
    muni,
    district,
    lot,
    entryMode,
    parcel,
    parcelPick,
    zoningCheck,
    project,
  };

  return (
    <>
      <TopNav />
      <main className="shell">
      <Stepper step={step} maxStepReached={maxStepReached} onStep={goToStep} />

      {error && <div className="card error">Failed to load data: {error}</div>}
      {!error && !munis && <div className="card loading-card">Loading Union City property data…</div>}

      {munis && step === 1 && (
        <ProjectSetup
          munis={munis}
          muni={muni}
          muniId={muniId}
          districtId={districtId}
          entryMode={entryMode}
          parcelData={parcelData}
          lot={lot}
          parcelPick={parcelPick}
          parcel={parcel}
          parcelError={parcelError}
          zoningCheck={zoningCheck}
          projectType={projectType}
          existingStructure={existingStructure}
          locationReady={locationReady}
          propertyReady={propertyReady}
          canContinue={canCalculate}
          previewProps={previewProps}
          onProjectType={setProjectType}
          onExistingStructure={setExistingStructure}
          onMuni={(id) => {
            setMuniId(id);
            const nextMuni = munis.find((item) => item.id === id);
            setDistrictId(nextMuni?.zoning_districts[0]?.id ?? null);
            setParcelPick(null);
            setParcel(null);
            setZoningCheck(null);
          }}
          onDistrict={setDistrictId}
          onLot={setLot}
          onParcel={(picked) => {
            setParcelPick(picked);
            setParcel(null);
            setZoningCheck(null);
          }}
          onManual={chooseManual}
          onSearch={chooseSearch}
          onContinue={() => advance(2)}
        />
      )}

      {munis && step === 2 && result && (
        <Results
          project={project}
          muni={muni}
          district={district}
          lot={lot}
          entryMode={entryMode}
          parcel={entryMode === "search" ? parcel : null}
          result={result}
          costModel={costModel}
          onBack={() => goToStep(1)}
          onContinue={() => advance(3)}
        />
      )}

      {munis && step === 3 && result && (
        <Review
          project={project}
          muni={muni}
          district={district}
          lot={lot}
          parcel={entryMode === "search" ? parcel : null}
          result={result}
          costModel={costModel}
          onBack={() => goToStep(2)}
        />
      )}
      </main>
    </>
  );
}

function TopNav() {
  return (
    <nav className="top-nav">
      <div className="top-nav-inner">
        <Logo className="nav-logo" />
        <span className="nav-tagline">Buildable potential &amp; preliminary cost planning</span>
        <a className="nav-login" href="#/admin" title="Owner login" aria-label="Owner login">
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
          </svg>
        </a>
      </div>
    </nav>
  );
}

function Brand() {
  return (
    <header className="brand">
      <Logo className="brand-logo" />
      <p>Buildable potential &amp; preliminary cost planning</p>
    </header>
  );
}

function Stepper({ step, maxStepReached, onStep }) {
  return (
    <nav className="stepper" aria-label="Project steps">
      {STEPS.map((label, index) => {
        const number = index + 1;
        const available = number <= maxStepReached;
        return (
          <div className="step-wrap" key={label}>
            {index > 0 && <span className="step-line" aria-hidden="true" />}
            <button
              type="button"
              className={`step ${number === step ? "active" : ""} ${number < step ? "done" : ""}`}
              onClick={() => onStep(number)}
              disabled={!available}
              aria-current={number === step ? "step" : undefined}
            >
              <span>{number < step ? "✓" : number}</span>
              {label}
            </button>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The single input step, revealed in the order the calculation needs it:
 * project type first, then the property, then the questions that only make
 * sense once a real lot has been resolved. Nothing is asked before the answer
 * can be used, and no section appears until the one above it is settled.
 */
function ProjectSetup({
  munis,
  muni,
  muniId,
  districtId,
  entryMode,
  parcelData,
  lot,
  parcelPick,
  parcel,
  parcelError,
  zoningCheck,
  projectType,
  existingStructure,
  locationReady,
  propertyReady,
  canContinue,
  previewProps,
  onProjectType,
  onExistingStructure,
  onMuni,
  onDistrict,
  onLot,
  onParcel,
  onManual,
  onSearch,
  onContinue,
}) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  const searchUnavailable = parcelData === "missing";

  return (
    <section className={previewProps.visible ? "workspace-grid" : "workspace-grid solo"}>
      <div className="card form-card">
        <div className="section-heading">
          <span className="section-icon">⌂</span>
          <div>
            <p className="eyebrow">Step 1</p>
            <h2>What are you building, and where?</h2>
            <p>Start with the type of project. The rest of the form opens up as you go.</p>
          </div>
        </div>

        <fieldset className="field-group">
          <legend>What type of project is this?</legend>
          <div className="project-types">
            {PROJECT_TYPES.map((item) => (
              <button
                type="button"
                className={projectType === item.id ? "project-option selected" : "project-option"}
                onClick={() => onProjectType(item.id)}
                aria-pressed={projectType === item.id}
                key={item.id}
              >
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {!projectType && (
          <p className="reveal-hint">Choose a project type to continue.</p>
        )}

        {projectType && (
          <div className="reveal">
            <div className="form-grid">
              <label>
                Municipality
                <select value={muniId ?? ""} onChange={(e) => onMuni(Number(e.target.value))}>
                  {munis.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}, {item.state_code}
                    </option>
                  ))}
                </select>
              </label>
              {entryMode === "manual" ? (
                <label>
                  Zoning district <span className="manual-badge">Manual—unverified</span>
                  <select
                    value={districtId ?? ""}
                    onChange={(e) => onDistrict(Number(e.target.value))}
                    disabled={!muni?.zoning_districts?.length}
                  >
                    {muni?.zoning_districts?.length ? (
                      muni.zoning_districts.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code} {item.name ? `— ${item.name}` : ""}
                        </option>
                      ))
                    ) : (
                      <option value="">No districts loaded for this municipality</option>
                    )}
                  </select>
                  <small>Confirm this district with {muni?.name} before relying on the result.</small>
                </label>
              ) : (
                <div className="auto-zoning-field">
                  <span>Municipal zoning district</span>
                  <strong>{zoningStatusLabel(zoningCheck)}</strong>
                  <small>Automatically identified by intersecting the parcel polygon with the municipal zoning layer.</small>
                </div>
              )}
            </div>

            {searchUnavailable && (
              <div className="data-missing-notice" role="status">
                <strong>Address search is unavailable for {muni?.name}.</strong>
                <span>
                  The public NJGIN parcel data has not been imported into this environment, so there are no
                  addresses to search. Enter the lot dimensions from a deed, tax record, or survey to continue —
                  the result will be labelled manual and unverified.
                </span>
              </div>
            )}

            {entryMode === "search" ? (
              <div className="property-method">
                <div className="method-title">
                  <div>
                    <h3>Find the property</h3>
                    <p>Search {muni?.name} public parcel records by street address.</p>
                  </div>
                  <span className="data-tag">NJGIN public data</span>
                </div>
                <ParcelSearch
                  muniSlug={muni.slug}
                  selected={parcelPick}
                  onSelect={onParcel}
                  onClear={() => onParcel(null)}
                />
                {zoningCheck?.status === "checking" && (
                  <p className="status-line">Checking the parcel against the municipal zoning layer…</p>
                )}
                {parcelError && <p className="status-line error-text">Parcel lookup failed: {parcelError}</p>}
                {parcelPick && (
                  <div className="selected-property">
                    <span className={zoningCheck?.status === "matched" ? "check" : "check pending"}>
                      {zoningCheck?.status === "matched" ? "✓" : "!"}
                    </span>
                    <div>
                      <strong>{parcel?.address ?? parcelPick.address ?? parcelPick.pams_pin}</strong>
                      <span>
                        Block {parcel?.block ?? parcelPick.block ?? "—"} / Lot {parcel?.lot ?? parcelPick.lot ?? "—"} ·{" "}
                        {fmt(parcel?.lot_area_sqft ?? parcelPick.lot_area_sqft)} sq ft
                      </span>
                    </div>
                  </div>
                )}
                <ZoningCheckNotice check={zoningCheck} />
                <button type="button" className="text-button" onClick={onManual}>
                  Can’t find the address? Enter lot details manually →
                </button>
              </div>
            ) : (
              <div className="property-method manual-entry">
                <div className="method-title">
                  <div>
                    <h3>Enter lot details manually</h3>
                    <p>Use dimensions from a deed, tax record, or recent survey.</p>
                  </div>
                  {!searchUnavailable && (
                    <button type="button" className="text-button compact" onClick={onSearch}>
                      Search by address
                    </button>
                  )}
                </div>
                <div className="form-grid three">
                  <NumberField
                    label="Lot width (ft)"
                    value={lot.width_ft}
                    onChange={(value) => onLot(withLotWidth(lot, value))}
                    fieldKey="width_ft"
                    required
                  />
                  <NumberField
                    label="Lot depth (ft)"
                    value={lot.depth_ft}
                    onChange={(value) => onLot(withLotDepth(lot, value))}
                    fieldKey="depth_ft"
                    required
                  />
                  <NumberField
                    label="Lot area (sq ft)"
                    value={lot.area_sqft}
                    onChange={(value) => onLot(withLotAreaManual(lot, value))}
                    help={lot.area_manual ? undefined : "Auto-calculated from width × depth."}
                    fieldKey="area_sqft"
                    required
                  />
                </div>
                {lot.area_manual && (
                  <button
                    type="button"
                    className="text-button compact"
                    onClick={() => onLot(withLotAreaRecalculated(lot))}
                  >
                    Reset area to width × depth
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {projectType && !locationReady && (
          <p className="reveal-hint">
            {entryMode === "search"
              ? "Select a property whose zoning is verified to see the remaining questions."
              : "Enter the lot dimensions to see the remaining questions."}
          </p>
        )}

        {propertyReady && (
          <div className="reveal">
            {projectType === "new_house" && (
              <div className="project-assumption">
                <span aria-hidden="true">⌂</span>
                <div>
                  <strong>New house calculation</strong>
                  <p>
                    This assumes the property is vacant or the existing structure will be completely replaced. The
                    result will show the maximum house footprint and total allowable building area.
                  </p>
                </div>
              </div>
            )}

            {hasExistingHouse && (
              <div className="existing-structure">
                <div className="method-title">
                  <div>
                    <h3>Existing house</h3>
                    <p>
                      {projectType === "addition"
                        ? "The footprint is the key MVP input. We’ll subtract it from the footprint zoning permits."
                        : "The footprint is the key MVP input for estimating the space that may remain for an ADU."}
                    </p>
                  </div>
                  <span className="data-tag">Footprint required</span>
                </div>
                <div className="form-grid existing-fields">
                  <NumberField
                    label="Existing building footprint (sq ft) *"
                    value={existingStructure.footprint_sqft}
                    onChange={(value) =>
                      onExistingStructure({ ...existingStructure, footprint_sqft: value })
                    }
                    help="Required. Ground area occupied by the current structure."
                    fieldKey="footprint_sqft"
                    required
                  />
                  <NumberField
                    label="Number of stories"
                    value={existingStructure.stories}
                    onChange={(value) =>
                      onExistingStructure({ ...existingStructure, stories: value })
                    }
                    help="Optional. Used to approximate total floor area when it is unknown."
                    step="0.5"
                    fieldKey="stories"
                  />
                  <NumberField
                    label="Existing total square feet"
                    value={existingStructure.total_area_sqft}
                    onChange={(value) =>
                      onExistingStructure({ ...existingStructure, total_area_sqft: value })
                    }
                    help="Optional. Combined finished area across all stories."
                    fieldKey="total_area_sqft"
                  />
                  <label>
                    Current structure location
                    <select
                      value={existingStructure.location}
                      onChange={(e) =>
                        onExistingStructure({ ...existingStructure, location: e.target.value })
                      }
                    >
                      <option value="unsure">Not sure</option>
                      <option value="front">Toward the front of the lot</option>
                      <option value="center">Near the center of the lot</option>
                      <option value="rear">Toward the rear of the lot</option>
                    </select>
                    <small>Optional. Helps future site-layout analysis; it does not change the MVP calculation.</small>
                  </label>
                </div>
                {projectType === "adu" && (
                  <p className="adu-note">
                    ADU eligibility, size, setbacks, parking, utilities, and whether it may be detached must still be
                    confirmed with {muni?.name}.
                  </p>
                )}
              </div>
            )}

          </div>
        )}

        <SurveyNotice />

        <button type="button" className="primary full" disabled={!canContinue} onClick={onContinue}>
          Calculate buildable potential <span aria-hidden="true">→</span>
        </button>
        {propertyReady && !structureReadyFromInputs(projectType, existingStructure) && (
          <p className="form-hint">Enter the existing building footprint to continue.</p>
        )}
      </div>

      {previewProps.visible && <PropertyPreview {...previewProps} />}
    </section>
  );
}

/**
 * Right-hand panel for the input step. Only rendered once a property exists to
 * draw — see `previewProps.visible`.
 */
function PropertyPreview({ muni, district, lot, entryMode, parcel, parcelPick, zoningCheck, project }) {
  return (
    <aside className="card preview-card">
      <p className="eyebrow">Property preview</p>
      <h2>{parcel?.address ?? parcelPick?.address ?? "Union City lot"}</h2>
      <p className="preview-note">Diagram is for reference only and is not a survey.</p>
      {parcel ? (
        <>
          <ParcelPlan parcelGeojson={parcel.parcel_geojson} envelopeGeojson={parcel.envelope_geojson} />
          {!parcel.envelope_geojson && (
            <p className="parcel-preview-status">
              Showing the actual NJGIN parcel boundary. The buildable envelope will appear after municipal zoning
              geometry and setbacks are verified.
            </p>
          )}
        </>
      ) : parcelPick ? (
        <div className="preview-placeholder parcel-loading">Loading the public parcel boundary…</div>
      ) : (
        <LotPreview lot={lot} district={district} />
      )}
      <div className="legend">
        <span><i className="legend-lot" /> Property boundary</span>
        {(entryMode === "manual" || parcel?.envelope_geojson) && (
          <span><i className="legend-envelope" /> Approx. buildable envelope</span>
        )}
      </div>
      <div className="preview-facts">
        <div><span>Project type</span><strong>{project?.label ?? "Not selected"}</strong></div>
        <div><span>Municipality</span><strong>{muni?.name}, {muni?.state_code}</strong></div>
        <div>
          <span>Zoning</span>
          <strong>
            {entryMode === "manual"
              ? `${district?.code ?? "—"} (manual)`
              : zoningCheck?.status === "matched"
                ? `${zoningCheck.district_code} (automatic)`
                : zoningStatusLabel(zoningCheck)}
          </strong>
        </div>
        <div><span>Data source</span><strong>{parcelPick ? "NJGIN parcel" : entryMode === "manual" ? "Manual entry" : "Awaiting address"}</strong></div>
      </div>
    </aside>
  );
}

function zoningStatusLabel(check) {
  if (!check) return "Identified after parcel selection";
  if (check.status === "checking") return "Checking zoning geometry…";
  if (check.status === "matched") {
    return `${check.district_code}${check.district_name ? ` — ${check.district_name}` : ""}`;
  }
  if (check.status === "rules_missing") return `${check.district_code ?? "District found"} — rules not loaded`;
  if (check.status === "boundary_conflict") return "Multiple districts intersect parcel";
  if (check.status === "unmapped") return "Parcel is outside mapped zoning polygons";
  if (check.status === "no_layer") return "Municipal zoning layer not loaded";
  return "Automatic zoning check unavailable";
}

function ZoningCheckNotice({ check }) {
  if (!check || check.status === "checking" || check.status === "matched") {
    if (check?.status !== "matched") return null;
    return (
      <div className="zoning-check matched" role="status">
        <strong>Zoning verified from geometry: {check.district_code}</strong>
        <span>
          The zoning polygon covers {fmt(check.overlap_pct, 1)}% of this parcel. The identified district—not the
          manual dropdown—governs this calculation.
        </span>
      </div>
    );
  }

  const messages = {
    no_layer: "Union City’s machine-readable zoning polygons have not been loaded. Calculation is disabled rather than assuming a district.",
    unmapped: "This parcel does not intersect the loaded municipal zoning layer. Calculation is disabled pending review.",
    boundary_conflict: `This parcel intersects multiple districts${check.competing_codes?.length ? ` (${check.competing_codes.join(", ")})` : ""}. Municipal review is required.`,
    rules_missing: `The parcel is in district ${check.district_code ?? "unknown"}, but that district’s rules are not loaded yet.`,
    error: "The automatic zoning check could not be completed. Calculation is disabled; a manual district will not be substituted.",
  };
  return (
    <div className="zoning-check blocked" role="alert">
      <strong>Automatic zoning verification required</strong>
      <span>{messages[check.status] ?? messages.error}</span>
    </div>
  );
}

function NumberField({ label, value, onChange, help, step = "1", fieldKey, required = false }) {
  // Only surface an error once the field has been touched, so a blank optional
  // (or not-yet-filled required) input doesn't shout on first render.
  const [touched, setTouched] = useState(false);
  const rule = fieldKey ? FIELD_RULES[fieldKey] : null;
  const error = fieldKey ? validateField(fieldKey, value, { required }) : null;
  const showError = touched && Boolean(error);
  return (
    <label className={showError ? "field invalid" : "field"}>
      {label}
      <input
        type="number"
        min={rule?.min ?? 0}
        max={rule?.max}
        step={step}
        value={value}
        aria-invalid={showError || undefined}
        onBlur={() => setTouched(true)}
        onChange={(e) => {
          setTouched(true);
          onChange(e.target.value === "" ? "" : Number(e.target.value));
        }}
      />
      {showError ? <small className="field-error">{error}</small> : help && <small>{help}</small>}
    </label>
  );
}

function structureReadyFromInputs(projectType, existingStructure) {
  return (
    projectType === "new_house" ||
    Number(existingStructure.footprint_sqft) > 0
  );
}

function SurveyNotice() {
  return (
    <div className="survey-notice" role="note">
      <span aria-hidden="true">!</span>
      <div>
        <strong>A property survey is required to confirm boundaries.</strong>
        <p>
          Public parcel records and manual dimensions are preliminary. A licensed surveyor must verify lot lines,
          dimensions, easements, and existing improvements before design or construction.
        </p>
      </div>
    </div>
  );
}

function Results({ project, muni, district, lot, entryMode, parcel, result, costModel, onBack, onContinue }) {
  return (
    <>
      <section className="results-heading">
        <div>
          <p className="eyebrow">Step 3</p>
          <h2>Preliminary property results</h2>
          <p>
            {project?.label} · {parcel?.address ?? `${muni.name}, ${muni.state_code}`} · Zoning{" "}
            {district.code}
          </p>
        </div>
        <span className="preliminary-badge">Preliminary</span>
      </section>

      {/* Order matches the flow diagram: the engine's four steps, then cost
          across the three tiers, then the zoning check, then the answer. */}
      <div className="results-flow">
        <div className="card result-card">
          <h3>{projectResultTitle(project?.id)}</h3>
          {parcel ? (
            <ParcelPlan parcelGeojson={parcel.parcel_geojson} envelopeGeojson={parcel.envelope_geojson} />
          ) : (
            <LotDiagram lot={lot} result={result} />
          )}
          <EngineSteps result={result} district={district} projectType={project?.id} />
          <PropertyTable parcel={parcel} result={result} district={district} projectType={project?.id} />
        </div>

        <CostCard result={result} costModel={costModel} projectType={project?.id} />

        <ZoningCheck
          result={result}
          district={district}
          lot={lot}
          entryMode={entryMode}
          projectType={project?.id}
          muni={muni}
        />

        <AnswerSummary
          project={project}
          muni={muni}
          parcel={parcel}
          entryMode={entryMode}
          result={result}
          costModel={costModel}
        />
      </div>

      <SurveyNotice />
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>← Edit project details</button>
        <button type="button" className="primary" onClick={onContinue}>Review &amp; export →</button>
      </div>
    </>
  );
}

/**
 * The flow diagram's last box: buildable SF, cost, and caveats in one place.
 * A synthesis of what the three stages above produced — deliberately not a
 * repeat of the tier table or the findings list.
 */
function AnswerSummary({ project, muni, parcel, entryMode, result, costModel }) {
  const rates = TIER_ORDER.map((tier) => tierRate(costModel, tier)).filter((value) => value != null);
  const area = result.estimateArea;
  const low = rates.length ? Math.min(...rates) : null;
  const high = rates.length ? Math.max(...rates) : null;

  return (
    <section className="card answer-card">
      <p className="eyebrow">The answer</p>
      <h3>
        {project?.label ?? "This project"} · {parcel?.address ?? `${muni.name}, ${muni.state_code}`}
      </h3>

      <div className="answer-figures">
        <div>
          <span>{projectResultTitle(project?.id)}</span>
          {area == null ? (
            <strong className="answer-pending">Needs one more input</strong>
          ) : (
            <strong>
              {fmt(area)} <em>sq ft</em>
            </strong>
          )}
        </div>
        <div>
          <span>Preliminary cost, Essential to Premium</span>
          {area == null || low == null ? (
            <strong className="answer-pending">—</strong>
          ) : (
            <strong>
              ${fmt(area * low)} – ${fmt(area * high)}
            </strong>
          )}
        </div>
      </div>

      <ul className="answer-caveats">
        <li>
          {entryMode === "manual"
            ? "Lot dimensions were entered by hand and have not been verified against parcel records."
            : "Based on public NJGIN parcel data, which the State states is not survey data and does not represent legal boundaries."}{" "}
          A survey is required to confirm.
        </li>
        <li>
          Cost figures are planning averages
          {costModel?.provenance ? ` (${costModel.provenance})` : ""}, not a quote. An accurate price is not possible
          without a full plan set.
        </li>
        <li>
          This is a preliminary zoning estimate, not a zoning determination. Confirm with {muni.name} before design or
          construction.
        </li>
      </ul>
    </section>
  );
}

/**
 * The four-step derivation from the kickoff algorithm, shown as a chain rather
 * than as isolated totals: inset by setbacks → apply the coverage cap →
 * multiply by stories → subtract what already exists. `binding` and
 * `farLimited` come straight from the engine, so the UI never re-derives which
 * rule actually governed the answer.
 */
function EngineSteps({ result, district, projectType }) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  const envelopeArea = envelopeAreaOf(result);
  const coveragePct = district.max_building_coverage_pct;
  const coverageCap = coveragePct != null ? result.lotArea * (coveragePct / 100) : null;

  const steps = [
    {
      label: "Inset by setbacks",
      value: `${fmt(envelopeArea)} sq ft`,
      note: `The ${fmt(result.lotArea)} sq ft lot, less the front, side, and rear yards ${district.code} requires. What remains is the buildable envelope.`,
    },
    {
      label: "Apply coverage cap",
      value: `${fmt(result.footprint)} sq ft`,
      note:
        coverageCap == null
          ? `${district.code} sets no building-coverage limit, so the setback envelope alone governs the footprint.`
          : `The smaller of the ${fmt(envelopeArea)} sq ft envelope and ${fmt(coverageCap)} sq ft — ${coveragePct}% of the lot.`,
      flag:
        coverageCap == null
          ? null
          : result.binding === "coverage"
            ? "Coverage limit binds first"
            : "Setbacks bind first",
    },
    {
      label: "Multiply by stories",
      value: `${fmt(result.buildable)} sq ft`,
      note: `${fmt(result.footprint)} sq ft footprint × ${result.stories} ${
        Number(result.stories) === 1 ? "story" : "stories"
      } permitted in ${district.code}${
        district.max_far != null ? `, then capped by the ${district.max_far} floor-area ratio` : ""
      }.`,
      flag: result.farLimited ? `Floor-area ratio binds` : null,
      // The diagram caps this step by height as well as FAR. The engine does
      // not yet: converting a height limit into a story count needs a
      // floor-to-floor assumption we have not been given, and inventing one
      // would be exactly the false precision the brief warns against.
      caution:
        district.max_height_ft != null
          ? `${district.code} also limits height to ${fmt(
              district.max_height_ft
            )} ft. That limit is not applied here — the story count alone governs this figure. A tall-ceiling design could hit the height limit before the third story.`
          : null,
    },
  ];

  if (hasExistingHouse) {
    const pending = result.availableBuildingArea == null;
    steps.push({
      label: "Subtract existing",
      value: pending ? "—" : `${fmt(result.availableBuildingArea)} sq ft`,
      pending,
      note: pending
        ? "Enter the existing number of stories or total floor area on the previous step to complete this calculation."
        : `${fmt(result.buildable)} sq ft permitted, less ${fmt(result.existingArea)} sq ft of existing floor area${
            result.existingAreaSource === "footprint_times_stories" ? " (estimated from footprint × stories)" : ""
          }.`,
      footprintNote: `Ground floor: ${fmt(result.footprint)} sq ft permitted − ${fmt(
        result.existingFootprint
      )} sq ft existing = ${fmt(result.availableFootprint)} sq ft of additional footprint.`,
    });
  }

  return (
    <>
      <h4 className="engine-heading">How this number is calculated</h4>
      <ol className="engine-steps">
        {steps.map((item, index) => (
          <li className={item.pending ? "engine-step pending" : "engine-step"} key={item.label}>
            <span className="engine-step-num" aria-hidden="true">{index + 1}</span>
            <div className="engine-step-body">
              <div className="engine-step-head">
                <strong>{item.label}</strong>
                <b>{item.value}</b>
              </div>
              <span>{item.note}</span>
              {item.footprintNote && <span>{item.footprintNote}</span>}
              {item.caution && <span className="engine-caution">{item.caution}</span>}
              {item.flag && <em className="engine-flag">{item.flag}</em>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * Plain-language review of the lot against the district's loaded rules. Only
 * checks backed by fields that actually exist in the district record are
 * reported — an absent limit is silence, never a pass.
 */
function zoningFindings({ result, district, lot, entryMode, projectType, muni }) {
  const findings = [];
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  const town = muni?.name ?? "the municipality";

  if (envelopeAreaOf(result) <= 0) {
    findings.push({
      level: "blocking",
      title: "The required setbacks leave no buildable area",
      detail: `The front, side, and rear yards ${district.code} requires consume this entire lot, so no conforming building area remains. Any construction would need relief from ${town}'s zoning board.`,
    });
  }

  if (district.min_lot_area_sqft != null && result.lotArea < Number(district.min_lot_area_sqft)) {
    findings.push({
      level: "warning",
      title: "The lot is smaller than the district minimum",
      detail: `This lot is ${fmt(result.lotArea)} sq ft, below the ${fmt(
        district.min_lot_area_sqft
      )} sq ft ${district.code} requires. It is most likely a pre-existing non-conforming lot, which can limit what may be built without a variance.`,
    });
  }

  // Width and depth are only known when the dimensions were typed in. The
  // parcel path works from a polygon, which has no single meaningful frontage.
  if (entryMode === "manual") {
    if (district.min_lot_width_ft != null && Number(lot.width_ft) < Number(district.min_lot_width_ft)) {
      findings.push({
        level: "warning",
        title: "The lot is narrower than the district minimum",
        detail: `The entered width of ${fmt(lot.width_ft)} ft is below the ${fmt(
          district.min_lot_width_ft
        )} ft minimum for ${district.code}. Narrow lots frequently need side-yard relief.`,
      });
    }
    if (district.min_lot_depth_ft != null && Number(lot.depth_ft) < Number(district.min_lot_depth_ft)) {
      findings.push({
        level: "warning",
        title: "The lot is shallower than the district minimum",
        detail: `The entered depth of ${fmt(lot.depth_ft)} ft is below the ${fmt(
          district.min_lot_depth_ft
        )} ft minimum for ${district.code}.`,
      });
    }
  }

  if (hasExistingHouse && result.existingFootprint > 0 && result.availableFootprint === 0) {
    findings.push({
      level: "blocking",
      title: "The existing building already uses the permitted footprint",
      detail: `The existing structure covers ${fmt(result.existingFootprint)} sq ft, at or above the ${fmt(
        result.footprint
      )} sq ft these rules permit. No additional ground-floor footprint is available — confirm the structure's status with ${town} before planning work.`,
    });
  }

  if (hasExistingHouse && result.availableBuildingArea === 0 && result.existingArea > 0) {
    findings.push({
      level: "blocking",
      title: "The existing floor area already uses the permitted building area",
      detail: `The existing ${fmt(result.existingArea)} sq ft meets or exceeds the ${fmt(
        result.buildable
      )} sq ft ${district.code} allows on this lot, so no additional floor area is available under the current rules.`,
    });
  }

  return findings;
}

/** Caveats that qualify the answer without being conflicts in their own right. */
function zoningCaveats({ result, district, projectType }) {
  const caveats = [];
  if (district.front_yard_prevailing_rule) {
    caveats.push(
      `${district.code} sets the front setback by the prevailing average of the block, not a fixed number. The figure used here is the minimum floor, so the real buildable depth may be smaller.`
    );
  }
  if (result.farLimited) {
    caveats.push(
      `The floor-area ratio, not the footprint or story count, is what limits this result. Adding stories would not increase the buildable area.`
    );
  }
  if (projectType === "adu") {
    caveats.push(
      `This is the property's remaining zoning capacity — not confirmation that an ADU is permitted. Eligibility, size, setbacks, parking, and utility requirements must still be confirmed.`
    );
  }
  return caveats;
}

function ZoningCheck({ result, district, lot, entryMode, projectType, muni }) {
  const findings = zoningFindings({ result, district, lot, entryMode, projectType, muni });
  const caveats = zoningCaveats({ result, district, projectType });
  return (
    <section className="card zoning-check-card">
      <h3>Zoning check</h3>
      <p className="card-intro">
        This lot reviewed against the {district.code} rules loaded for {muni.name}, in plain language.
      </p>
      {findings.length === 0 ? (
        <div className="finding clear">
          <strong>No conflicts found in the rules we check.</strong>
          <span>
            Lot minimums, setbacks, coverage, story count, and floor-area ratio are all satisfied by the figures
            above. This covers the loaded zoning rules only — not permitted uses, overlay or historic districts,
            flood zones, easements, or deed restrictions.
          </span>
        </div>
      ) : (
        <ul className="finding-list">
          {findings.map((item) => (
            <li className={`finding ${item.level}`} key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {caveats.length > 0 && (
        <ul className="caveat-list">
          {caveats.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function projectResultTitle(projectType) {
  if (projectType === "addition") return "Remaining addition capacity";
  if (projectType === "adu") return "Potential ADU capacity";
  return "Maximum new house capacity";
}

/**
 * Reference context for the calculation above: what this property is, and the
 * district limits the four steps were driven by. Deliberately does not repeat
 * the derived figures — those belong to the step chain.
 */
function PropertyTable({ parcel, result, district, projectType }) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  return (
    <table className="result-table">
      <thead>
        <tr>
          <th>Property &amp; district limits</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {parcel && (
          <>
            <tr><td>Block / Lot</td><td>{parcel.block ?? "—"} / {parcel.lot ?? "—"}</td></tr>
            {parcel.land_desc && <tr><td>Recorded lot</td><td>{parcel.land_desc}</td></tr>}
          </>
        )}
        <tr><td>Lot area</td><td>{fmt(result.lotArea)} sq ft</td></tr>
        <tr><td>Zoning district</td><td>{district.code}{district.name ? ` — ${district.name}` : ""}</td></tr>
        {district.min_lot_area_sqft != null && (
          <tr><td>Minimum lot area</td><td>{fmt(district.min_lot_area_sqft)} sq ft</td></tr>
        )}
        <tr>
          <td>Maximum building coverage</td>
          <td>{district.max_building_coverage_pct != null ? `${district.max_building_coverage_pct}%` : "Not limited"}</td>
        </tr>
        <tr>
          <td>Maximum stories</td>
          <td>{district.max_stories ?? "Not specified"}</td>
        </tr>
        {district.max_height_ft != null && (
          <tr><td>Maximum height</td><td>{fmt(district.max_height_ft)} ft</td></tr>
        )}
        <tr>
          <td>Floor-area ratio</td>
          <td>{district.max_far != null ? district.max_far : "Not used here"}</td>
        </tr>
        {hasExistingHouse && (
          <tr><td>Current structure location</td><td>{structureLocationLabel(result.existingLocation)}</td></tr>
        )}
      </tbody>
    </table>
  );
}

function structureLocationLabel(location) {
  return {
    front: "Toward front of lot",
    center: "Near center of lot",
    rear: "Toward rear of lot",
    unsure: "Not sure",
  }[location] ?? "Not sure";
}

function CostCard({ result, costModel, projectType }) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  const estimateLabel = projectType === "adu" ? "potential ADU capacity" : hasExistingHouse ? "remaining addition capacity" : "total allowable area";
  return (
    <div className="card result-card">
      <h3>
        Preliminary build cost
        {costModel && <span className={`badge ${costModel.provenance}`}>{costModel.provenance}</span>}
      </h3>
      <p className="card-intro">
        Planning ranges based on the {estimateLabel}, not a contractor quote. All three levels are shown so the
        spread is visible — the finishes, not the buildable area, are what move the number.
      </p>
      {!costModel && <p className="fine">No rate card is loaded for this municipality yet.</p>}
      {costModel && hasExistingHouse && result.estimateArea == null && (
        <div className="cost-unavailable">
          Enter the existing number of stories or total square feet to estimate remaining floor area and construction cost.
        </div>
      )}
      {costModel && result.estimateArea != null && (
        <div className="cost-tiers">
          {TIER_ORDER.map((tierName) => {
            const tier = costModel.build_cost_tiers.find((item) => item.tier === tierName);
            if (!tier) return null;
            return (
              <div className="cost-tier" key={tierName}>
                <div>
                  <strong>{TIER_LABELS[tierName]}</strong>
                  <span className="tier-desc">{TIER_DESCRIPTIONS[tierName]}</span>
                  <span className="tier-rate">${fmt(tier.rate_per_sqft, 2)} / sq ft</span>
                </div>
                <b>${fmt(result.estimateArea * tier.rate_per_sqft)}</b>
              </div>
            );
          })}
        </div>
      )}
      {costModel?.provenance === "estimated" && result.estimateArea != null && (
        <p className="fine">
          Based on a ${fmt(costModel.regional_baseline_per_sqft, 2)}/sq ft regional baseline × {costModel.local_cost_factor} local factor.
        </p>
      )}
    </div>
  );
}

function Review({ project, muni, district, lot, parcel, result, costModel, onBack }) {
  const hasExistingHouse = project?.id === "addition" || project?.id === "adu";
  return (
    <>
      <section className="results-heading">
        <div>
          <p className="eyebrow">Step 4</p>
          <h2>Review your preliminary report</h2>
          <p>Confirm the inputs below, then print or save the report as a PDF.</p>
        </div>
      </section>
      <section className="card review-card">
        <div className="review-header">
          <Brand />
          <span>Preliminary feasibility summary</span>
        </div>
        <div className="review-summary">
          <div><span>Property</span><strong>{parcel?.address ?? "Manual lot entry"}</strong></div>
          <div><span>Project type</span><strong>{project?.label ?? "Not selected"}</strong></div>
          <div><span>Municipality</span><strong>{muni.name}, {muni.state_code}</strong></div>
          <div><span>Zoning district</span><strong>{district.code} — {district.name}</strong></div>
          <div><span>Lot area</span><strong>{fmt(result.lotArea)} sq ft</strong></div>
          {hasExistingHouse ? (
            <>
              <div><span>Existing footprint</span><strong>{fmt(result.existingFootprint)} sq ft</strong></div>
              {result.existingStories && <div><span>Existing stories</span><strong>{fmt(result.existingStories, 1)}</strong></div>}
              {result.existingArea != null && (
                <div>
                  <span>Existing total floor area</span>
                  <strong>
                    {fmt(result.existingArea)} sq ft
                    {result.existingAreaSource === "footprint_times_stories" ? " (estimated)" : ""}
                  </strong>
                </div>
              )}
              <div><span>Structure location</span><strong>{structureLocationLabel(result.existingLocation)}</strong></div>
              <div><span>Approx. additional footprint</span><strong>{fmt(result.availableFootprint)} sq ft</strong></div>
              {result.availableBuildingArea != null && (
                <div><span>Additional floor area available</span><strong>{fmt(result.availableBuildingArea)} sq ft</strong></div>
              )}
            </>
          ) : (
            <>
              <div><span>Maximum house footprint</span><strong>{fmt(result.footprint)} sq ft</strong></div>
              <div><span>Total allowable building area</span><strong>{fmt(result.buildable)} sq ft</strong></div>
            </>
          )}
          {TIER_ORDER.map((tierName) => {
            const rate = tierRate(costModel, tierName);
            return (
              <div key={tierName}>
                <span>{TIER_LABELS[tierName]} estimate</span>
                <strong>
                  {rate != null && result.estimateArea != null
                    ? `$${fmt(result.estimateArea * rate)}`
                    : "Needs floor-area input"}
                </strong>
              </div>
            );
          })}
          {parcel ? (
            <div><span>Block / Lot</span><strong>{parcel.block ?? "—"} / {parcel.lot ?? "—"}</strong></div>
          ) : (
            <div><span>Manual dimensions</span><strong>{fmt(lot.width_ft)}′ × {fmt(lot.depth_ft)}′</strong></div>
          )}
        </div>
        <SurveyNotice />
        {project?.id === "adu" && (
          <p className="adu-review-note">
            ADU capacity is preliminary. Union City must confirm that an ADU is permitted and determine applicable size,
            location, setback, parking, utility, and occupancy requirements.
          </p>
        )}
        <p className="report-disclaimer">
          This report is for early planning only. It is not a zoning determination, site plan, survey, architectural drawing,
          construction estimate, or approval to build. Confirm requirements with Union City and licensed professionals.
        </p>
      </section>
      <div className="actions no-print">
        <button type="button" className="secondary" onClick={onBack}>← Back to results</button>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
      </div>
    </>
  );
}

function LotPreview({ lot, district }) {
  if (!district) return <div className="preview-placeholder">Loading zoning data…</div>;
  const safeLot = {
    width_ft: lot.width_ft > 0 ? lot.width_ft : 25,
    depth_ft: lot.depth_ft > 0 ? lot.depth_ft : 100,
    area_sqft: lot.area_sqft > 0 ? lot.area_sqft : 2500,
  };
  return (
    <div className="lot-preview">
      <LotDiagram lot={safeLot} result={computeBuildable(safeLot, district)} />
    </div>
  );
}

/** SVG plan view: rectangular lot outline with the envelope inset inside. */
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
      aria-label="Lot with approximate buildable envelope"
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
      <text x={pad + w / 2} y={pad - 3} textAnchor="middle" className="dim">{lot.width_ft}′</text>
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
