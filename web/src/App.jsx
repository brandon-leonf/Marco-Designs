import { useEffect, useMemo, useState } from "react";
import {
  supabase,
  fetchMunicipalities,
  fetchParcelEnvelope,
  resolveParcelZoning,
} from "./lib/supabase.js";
import {
  computeBuildable,
  computeBuildableFromAreas,
  conservativeInsetFt,
} from "./lib/envelope.js";
import ParcelSearch from "./components/ParcelSearch.jsx";
import ParcelPlan from "./components/ParcelPlan.jsx";

const TIER_LABELS = {
  builder_grade: "Builder grade",
  mid_level: "Mid level",
  high_end: "High end",
};
const TIER_ORDER = ["builder_grade", "mid_level", "high_end"];
const PROJECT_TYPES = [
  { id: "new_house", label: "New house", description: "Vacant lot or full replacement" },
  { id: "addition", label: "Addition", description: "Expand an existing house" },
  { id: "adu", label: "ADU", description: "Add a smaller separate living space" },
];
const STEPS = ["Property Input", "Results", "Review & Export"];

const fmt = (n, digits = 0) =>
  n == null || !isFinite(n)
    ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });

export default function App() {
  const [munis, setMunis] = useState(null);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [projectType, setProjectType] = useState("");
  const [entryMode, setEntryMode] = useState("search");
  const [muniId, setMuniId] = useState(null);
  const [districtId, setDistrictId] = useState(null);
  const [lot, setLot] = useState({ width_ft: 25, depth_ft: 100, area_sqft: 2500 });
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
        const check = await resolveParcelZoning(parcelPick.parcel_id);
        if (stale) return;
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
  const propertyReady =
    entryMode === "search"
      ? Boolean(parcel && zoningCheck?.status === "matched")
      : Boolean(result);
  const structureReady =
    projectType === "new_house" ||
    Number(existingStructure.footprint_sqft) > 0;
  const canContinue = Boolean(projectType && district && propertyReady && structureReady);

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
      <main className="shell">
        <Brand />
        <div className="card setup-card">
          <p>
            Supabase is not configured. Copy <code>web/.env.example</code> to{" "}
            <code>web/.env</code>, fill in <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>, then restart <code>npm run dev</code>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <Brand />
      <Stepper step={step} maxStepReached={maxStepReached} onStep={goToStep} />

      {error && <div className="card error">Failed to load data: {error}</div>}
      {!error && !munis && <div className="card loading-card">Loading Union City property data…</div>}

      {munis && step === 1 && (
        <PropertyInput
          munis={munis}
          muni={muni}
          district={district}
          muniId={muniId}
          districtId={districtId}
          projectType={projectType}
          entryMode={entryMode}
          lot={lot}
          existingStructure={existingStructure}
          parcelPick={parcelPick}
          parcel={parcel}
          parcelError={parcelError}
          zoningCheck={zoningCheck}
          canContinue={canContinue}
          onProjectType={setProjectType}
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
          onExistingStructure={setExistingStructure}
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
          existingStructure={existingStructure}
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
          existingStructure={existingStructure}
          parcel={entryMode === "search" ? parcel : null}
          result={result}
          costModel={costModel}
          onBack={() => goToStep(2)}
        />
      )}
    </main>
  );
}

function Brand() {
  return (
    <header className="brand">
      <div className="brand-mark">D</div>
      <div>
        <h1>Demarco</h1>
        <p>Buildable potential &amp; preliminary cost planning</p>
      </div>
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

function PropertyInput({
  munis,
  muni,
  district,
  muniId,
  districtId,
  projectType,
  entryMode,
  lot,
  existingStructure,
  parcelPick,
  parcel,
  parcelError,
  zoningCheck,
  canContinue,
  onProjectType,
  onMuni,
  onDistrict,
  onLot,
  onExistingStructure,
  onParcel,
  onManual,
  onSearch,
  onContinue,
}) {
  return (
    <section className="workspace-grid">
      <div className="card form-card">
        <div className="section-heading">
          <span className="section-icon">⌂</span>
          <div>
            <p className="eyebrow">Step 1</p>
            <h2>Tell us about your project</h2>
            <p>Choose what you want to build, then identify the property.</p>
          </div>
        </div>

        <fieldset className="field-group">
          <legend>What are you planning?</legend>
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

        {projectType === "new_house" && (
          <div className="project-assumption">
            <span aria-hidden="true">⌂</span>
            <div>
              <strong>New house calculation</strong>
              <p>
                This assumes the property is vacant or the existing structure will be completely replaced. The result
                will show the maximum house footprint and total allowable building area.
              </p>
            </div>
          </div>
        )}

        {(projectType === "addition" || projectType === "adu") && (
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
              />
              <NumberField
                label="Number of stories"
                value={existingStructure.stories}
                onChange={(value) =>
                  onExistingStructure({ ...existingStructure, stories: value })
                }
                help="Optional. Used to approximate total floor area when it is unknown."
                step="0.5"
              />
              <NumberField
                label="Existing total square feet"
                value={existingStructure.total_area_sqft}
                onChange={(value) =>
                  onExistingStructure({ ...existingStructure, total_area_sqft: value })
                }
                help="Optional. Combined finished area across all stories."
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
                confirmed with Union City.
              </p>
            )}
          </div>
        )}

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
              <select value={districtId ?? ""} onChange={(e) => onDistrict(Number(e.target.value))}>
                {muni?.zoning_districts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} {item.name ? `— ${item.name}` : ""}
                  </option>
                ))}
              </select>
              <small>Confirm this district with Union City before relying on the result.</small>
            </label>
          ) : (
            <div className="auto-zoning-field">
              <span>Municipal zoning district</span>
              <strong>{zoningStatusLabel(zoningCheck)}</strong>
              <small>Automatically identified by intersecting the parcel polygon with the municipal zoning layer.</small>
            </div>
          )}
        </div>

        {entryMode === "search" ? (
          <div className="property-method">
            <div className="method-title">
              <div>
                <h3>Find the property</h3>
                <p>Search Union City public parcel records by street address.</p>
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
              <button type="button" className="text-button compact" onClick={onSearch}>
                Search by address
              </button>
            </div>
            <div className="form-grid three">
              <NumberField
                label="Lot width (ft)"
                value={lot.width_ft}
                onChange={(value) => onLot({ ...lot, width_ft: value })}
              />
              <NumberField
                label="Lot depth (ft)"
                value={lot.depth_ft}
                onChange={(value) => onLot({ ...lot, depth_ft: value })}
              />
              <NumberField
                label="Lot area (sq ft)"
                value={lot.area_sqft}
                onChange={(value) => onLot({ ...lot, area_sqft: value })}
              />
            </div>
          </div>
        )}

        <SurveyNotice />

        <button type="button" className="primary full" disabled={!canContinue} onClick={onContinue}>
          Calculate buildable potential <span aria-hidden="true">→</span>
        </button>
        {!projectType && <p className="form-hint">Choose a project type to continue.</p>}
        {projectType && !structureReadyFromInputs(projectType, existingStructure) && (
          <p className="form-hint">Enter the existing building footprint to continue.</p>
        )}
      </div>

      <aside className="card preview-card">
        <p className="eyebrow">Property preview</p>
        <h2>{parcel?.address ?? parcelPick?.address ?? "Union City lot"}</h2>
        <p className="preview-note">Diagram is for reference only and is not a survey.</p>
        {parcel ? (
          <ParcelPlan parcelGeojson={parcel.parcel_geojson} envelopeGeojson={parcel.envelope_geojson} />
        ) : (
          <LotPreview lot={lot} district={district} active={entryMode === "manual"} />
        )}
        <div className="legend">
          <span><i className="legend-lot" /> Property boundary</span>
          <span><i className="legend-envelope" /> Approx. buildable envelope</span>
        </div>
        <div className="preview-facts">
          <div><span>Project</span><strong>{PROJECT_TYPES.find((item) => item.id === projectType)?.label ?? "Not selected"}</strong></div>
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
    </section>
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

function NumberField({ label, value, onChange, help, step = "1" }) {
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
      {help && <small>{help}</small>}
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

function Results({ project, muni, district, lot, parcel, result, costModel, onBack, onContinue }) {
  return (
    <>
      <section className="results-heading">
        <div>
          <p className="eyebrow">Step 2</p>
          <h2>Preliminary property results</h2>
          <p>{project?.label} · {parcel?.address ?? `${muni.name}, ${muni.state_code}`} · Zoning {district.code}</p>
        </div>
        <span className="preliminary-badge">Preliminary</span>
      </section>

      <section className="results-grid">
        <div className="card result-card">
          <h3>{projectResultTitle(project?.id)}</h3>
          {parcel ? (
            <ParcelPlan parcelGeojson={parcel.parcel_geojson} envelopeGeojson={parcel.envelope_geojson} />
          ) : (
            <LotDiagram lot={lot} result={result} />
          )}
          <PropertyTable parcel={parcel} result={result} district={district} projectType={project?.id} />
          {(project?.id === "addition" || project?.id === "adu") &&
            result.availableFootprint === 0 && (
              <div className="capacity-warning">
                The entered existing footprint uses or exceeds the footprint calculated from the zoning rules. Review
                the dimensions and consult Union City before planning additional construction.
              </div>
            )}
          {project?.id === "adu" && (
            <div className="adu-result-note">
              This is the property’s remaining zoning capacity—not confirmation that an ADU of this size is permitted.
            </div>
          )}
          {district.front_yard_prevailing_rule && (
            <p className="fine">Front setback may depend on the prevailing block average; the minimum shown is a planning floor.</p>
          )}
        </div>
        <CostCard result={result} costModel={costModel} projectType={project?.id} />
      </section>

      <SurveyNotice />
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>← Edit property</button>
        <button type="button" className="primary" onClick={onContinue}>Review &amp; export →</button>
      </div>
    </>
  );
}

function projectResultTitle(projectType) {
  if (projectType === "addition") return "Remaining addition capacity";
  if (projectType === "adu") return "Potential ADU capacity";
  return "Maximum new house capacity";
}

function PropertyTable({ parcel, result, district, projectType }) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  return (
    <table className="result-table">
      <tbody>
        {parcel && (
          <>
            <tr><td>Block / Lot</td><td>{parcel.block ?? "—"} / {parcel.lot ?? "—"}</td></tr>
            {parcel.land_desc && <tr><td>Recorded lot</td><td>{parcel.land_desc}</td></tr>}
          </>
        )}
        <tr><td>Lot area</td><td>{fmt(result.lotArea)} sq ft</td></tr>
        <tr>
          <td>Approx. envelope</td>
          <td>{fmt(parcel ? result.envelopeArea : result.envelope.areaSqft)} sq ft</td>
        </tr>
        <tr><td>{hasExistingHouse ? "Zoning maximum footprint" : "Maximum house footprint"}</td><td>{fmt(result.footprint)} sq ft</td></tr>
        {hasExistingHouse && (
          <>
            <tr><td>Existing building footprint</td><td>− {fmt(result.existingFootprint)} sq ft</td></tr>
            <tr className="total"><td>Approximate additional footprint</td><td>{fmt(result.availableFootprint)} sq ft</td></tr>
            <tr><td>Current structure location</td><td>{structureLocationLabel(result.existingLocation)}</td></tr>
            {result.existingArea != null && (
              <>
                <tr><td>Zoning maximum building area</td><td>{fmt(result.buildable)} sq ft</td></tr>
                <tr>
                  <td>
                    Existing total floor area
                    {result.existingAreaSource === "footprint_times_stories" && (
                      <span className="table-note"> (estimated from footprint × stories)</span>
                    )}
                  </td>
                  <td>− {fmt(result.existingArea)} sq ft</td>
                </tr>
              </>
            )}
          </>
        )}
        {(!hasExistingHouse || result.availableBuildingArea != null) && (
          <tr className="total">
            <td>{hasExistingHouse ? "Additional total floor area potentially available" : "Total allowable building area"}</td>
            <td>{fmt(hasExistingHouse ? result.availableBuildingArea : result.buildable)} sq ft</td>
          </tr>
        )}
        {hasExistingHouse && result.availableBuildingArea == null && (
          <tr className="optional-result">
            <td>Total floor-area capacity</td>
            <td>Enter stories or total square feet</td>
          </tr>
        )}
        <tr><td>Planning stories</td><td>{result.stories}</td></tr>
        <tr><td>Coverage limit</td><td>{district.max_building_coverage_pct ?? "—"}%</td></tr>
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
      <p className="card-intro">Planning ranges based on the {estimateLabel}, not a contractor quote.</p>
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
                <div><strong>{TIER_LABELS[tierName]}</strong><span>${fmt(tier.rate_per_sqft, 2)} / sq ft</span></div>
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
  const midTier = costModel?.build_cost_tiers.find((item) => item.tier === "mid_level");
  const hasExistingHouse = project?.id === "addition" || project?.id === "adu";
  return (
    <>
      <section className="results-heading">
        <div>
          <p className="eyebrow">Step 3</p>
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
          <div><span>Project type</span><strong>{project?.label}</strong></div>
          <div><span>Property</span><strong>{parcel?.address ?? "Manual lot entry"}</strong></div>
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
          <div>
            <span>Mid-level cost estimate</span>
            <strong>{midTier && result.estimateArea != null ? `$${fmt(result.estimateArea * midTier.rate_per_sqft)}` : "Needs floor-area input"}</strong>
          </div>
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

function LotPreview({ lot, district, active }) {
  if (!district) return <div className="preview-placeholder">Loading zoning data…</div>;
  const safeLot = {
    width_ft: lot.width_ft > 0 ? lot.width_ft : 25,
    depth_ft: lot.depth_ft > 0 ? lot.depth_ft : 100,
    area_sqft: lot.area_sqft > 0 ? lot.area_sqft : 2500,
  };
  const previewResult = computeBuildable(safeLot, district);
  return (
    <div className={!active ? "lot-preview muted-preview" : "lot-preview"}>
      <LotDiagram lot={safeLot} result={previewResult} />
      {!active && <p>Search for an address to load the actual parcel polygon.</p>}
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
