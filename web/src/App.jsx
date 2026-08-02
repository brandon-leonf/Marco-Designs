import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  supabase,
  fetchMunicipalities,
  fetchParcelEnvelope,
  findImportedParcelByPin,
  resolveParcelZoning,
} from "./lib/supabase.js";
import {
  computeBuildable,
  computeBuildableFromAreas,
  conservativeInsetFt,
  recordedRectDims,
  missingDistrictRules,
  lotViolations,
  aduRules,
  FLOOR_TO_FLOOR_FT,
} from "./lib/envelope.js";
import {
  fetchNjginParcel,
  findNjginParcelAtPoint,
  njginParcelFromFeature,
  NJGIN_SOURCE_URL,
} from "./lib/njgin.js";
import { detectExistingBuilding } from "./lib/buildings.js";
import { resolveMunicipalGisZoning } from "./lib/municipalGis.js";
import { northAngleFromParcel } from "./lib/orientation.js";
import {
  envelopeRect,
  existingRect,
  floorRects as computeFloorRects,
  rectFitsEnvelope,
  rectOnTopOf,
} from "./lib/placement.js";
import { matchParcelToRoad } from "./lib/roads.js";
import ParcelSearch from "./components/ParcelSearch.jsx";
import BuildingPreview3D from "./components/BuildingPreview3D.jsx";
import SitePlan2D, { floorColor } from "./components/SitePlan2D.jsx";
// Leaflet is a large dependency for one panel, so the map is split out of
// the main bundle and fetched when a municipality is actually shown.
const ZoningMap = lazy(() => import("./components/ZoningMap.jsx"));
import Logo from "./components/Logo.jsx";

// Marketing names and copy for the build-quality levels. The ids are the
// database tier keys as renamed by migration 0010 (builder_grade -> essential,
// mid_level -> signature, high_end -> premium), so the loaded rate card keeps
// resolving.
const PACKAGES = [
  {
    id: "essential",
    label: "Essential",
    description: "Efficient, code-compliant construction with standard finishes.",
  },
  {
    id: "signature",
    label: "Signature",
    description: "Upgraded finishes, detailing, and systems for most custom homes.",
  },
  {
    id: "premium",
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
// Step 2 can be used as a parcel-only drawing workspace when no zoning layer
// resolves. These values are deliberately non-regulatory: zero setbacks draw
// the parcel boundary only, while every zoning maximum remains null.
const UNVERIFIED_DISTRICT = {
  code: "Not verified",
  name: "Zoning unavailable",
  front_yard_min_ft: 0,
  rear_yard_min_ft: 0,
  side_yard_one_min_ft: 0,
  side_yard_total_min_ft: null,
  max_height_ft: null,
  max_stories: null,
};
const STEPS = ["Project & Property", "What You Can Build", "Results", "Review & Export"];

const fmt = (n, digits = 0) =>
  n == null || !isFinite(n)
    ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });

const tierRate = (costModel, tierId) =>
  costModel?.build_cost_tiers?.find((item) => item.tier === tierId)?.rate_per_sqft ?? null;

// The parcel path (PostGIS) reports `envelopeArea`; the rectangular manual path
// reports a full `envelope` object. Callers should not have to know which.
const envelopeAreaOf = (result) => result.envelopeArea ?? result.envelope?.areaSqft ?? 0;

/**
 * Put the matched street edge on the rectangle's width axis. MOD-IV frontage
 * is normally already the street-facing dimension, but corner-lot records can
 * use the other frontage. In that case the road match tells us to swap the
 * axes before applying front/rear versus side setbacks.
 */
function streetOrientedLotDims(parcel, fallbackLot, streetEdge) {
  const recorded = parcel ? recordedRectDims(parcel) : null;
  // Once a real parcel exists, only its own recorded dimensions are valid.
  // The starter lot is intentionally ignored so it can never leak into a
  // selected property's plan, 3D preview, findings, or exported drawing.
  if (parcel && !recorded) {
    return { width_ft: null, depth_ft: null, source: null };
  }
  let widthFt = Number(recorded?.width_ft ?? fallbackLot?.width_ft);
  let depthFt = Number(recorded?.depth_ft ?? fallbackLot?.depth_ft);
  if (!(widthFt > 0) || !(depthFt > 0)) {
    return { width_ft: null, depth_ft: null, source: null };
  }
  const edgeLength = Number(streetEdge?.lengthFt);
  if (
    edgeLength > 0 &&
    Math.abs(edgeLength - depthFt) + 1 < Math.abs(edgeLength - widthFt)
  ) {
    [widthFt, depthFt] = [depthFt, widthFt];
  }
  return { width_ft: widthFt, depth_ft: depthFt, source: recorded?.source ?? "manual" };
}

/**
 * The loaded municipality a searched address belongs to, or null when it is
 * somewhere we hold no zoning for. NJGIN spells municipalities with their type
 * suffix ("UNION CITY CITY", "NORTH BERGEN TWP") and geocoders spell them
 * plainly, so match on a name prefix, confirmed by county where both know it.
 */
function matchLoadedMuni(munis, row) {
  const name = String(row?.muni_name ?? "").trim().toUpperCase();
  if (!name || !munis?.length) return null;
  const county = String(row?.county ?? "").trim().toUpperCase();
  return (
    munis.find((item) => {
      const loaded = String(item.name ?? "").trim().toUpperCase();
      if (!loaded || (name !== loaded && !name.startsWith(`${loaded} `))) return false;
      const loadedCounty = String(item.county ?? "").trim().toUpperCase();
      return !county || !loadedCounty || county === loadedCounty;
    }) ?? null
  );
}

/**
 * How a selected property has to be loaded, which follows from what its search
 * result actually carries rather than from which source was searched:
 * an imported row has a database id, a live NJGIN row has only its PAMS_PIN,
 * and a geocoded row has no parcel at all — just a point.
 */
function pickKindOf(pick) {
  if (!pick) return null;
  if (pick.kind === "place") return "place";
  return pick.parcel_id != null ? "db" : "njgin";
}

/** Recorded-address fallback while the live centerline match is unavailable. */
function streetNameFor(parcel, streetEdge) {
  if (streetEdge?.streetName) return streetEdge.streetName;
  const address = String(parcel?.address ?? "").trim();
  if (!address) return null;
  const street = address
    .replace(/^\d+[A-Z]?(?:\s*-\s*\d+[A-Z]?)?\s+/i, "")
    .replace(/\s+(?:APT|UNIT|#)\s*.*$/i, "")
    .trim();
  return street || null;
}

/**
 * Reduce the per-floor plan to the three figures the zoning maximums are
 * checked against: total floor area (sum), footprint (the largest floor), and
 * floor count. Returns nulls when no floor size has been entered.
 */
function derivePlan(plannedFloors) {
  const dimensions = plannedFloors.map((floor) => {
    const widthFt = Number(floor?.width_ft);
    const depthFt = Number(floor?.depth_ft);
    const heightFt = Number(floor?.height_ft);
    return {
      widthFt: widthFt > 0 ? widthFt : null,
      depthFt: depthFt > 0 ? depthFt : null,
      heightFt: heightFt > 0 ? heightFt : null,
      areaSqft: widthFt > 0 && depthFt > 0 ? widthFt * depthFt : null,
    };
  });
  const sizes = dimensions.map((floor) => floor.areaSqft).filter((area) => area != null);
  // What has been drawn so far, floor by floor. `plannedArea` below stays
  // strict — a total is not a total until every floor has a size — but the
  // remaining-capacity figures have to fall as each floor is entered, which
  // means counting the floors that do have one.
  const plannedAreaSoFar = sizes.reduce((sum, area) => sum + area, 0);
  const plannedFootprintSoFar = sizes.length ? Math.max(...sizes) : 0;
  const heights = dimensions.map((floor) => floor.heightFt).filter((height) => height != null);
  const plannedHeight =
    heights.length === plannedFloors.length
      ? heights.reduce((sum, height) => sum + height, 0)
      : null;
  if (sizes.length === 0 || sizes.length !== plannedFloors.length) {
    return {
      plannedArea: null,
      plannedFootprint: null,
      plannedAreaSoFar,
      plannedFootprintSoFar,
      plannedFloorCount: plannedFloors.length,
      plannedHeight,
      plannedDimensions: dimensions,
    };
  }
  return {
    plannedArea: plannedAreaSoFar,
    plannedFootprint: plannedFootprintSoFar,
    plannedAreaSoFar,
    plannedFootprintSoFar,
    plannedFloorCount: plannedFloors.length,
    plannedHeight,
    plannedDimensions: dimensions,
  };
}

// Declarative bounds for the simple numeric inputs. Validation messages and the
// browser min/max hints both read from here, so adding a new schema field is a
// single entry — not per-field logic scattered through the form.
const FIELD_RULES = {
  footprint_sqft: { label: "Existing footprint", min: 1, max: 1000000 },
  stories: { label: "Number of stories", min: 0, max: 100 },
  total_area_sqft: { label: "Existing total floor area", min: 0, max: 5000000 },
  planned_floor_dimension: { label: "Floor dimension", min: 1, max: 5000 },
  planned_floor_height: { label: "Floor height", min: 1, max: 50 },
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

export default function App() {
  const [munis, setMunis] = useState(null);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [projectType, setProjectType] = useState("");
  const [muniId, setMuniId] = useState(null);
  const [districtId, setDistrictId] = useState(null);
  const [lot] = useState({ width_ft: null, depth_ft: null, area_sqft: null });
  const [existingStructure, setExistingStructure] = useState({
    footprint_sqft: "",
    stories: "",
    total_area_sqft: "",
    location: "unsure",
    position: null,
    addition_location: "above",
  });
  // Optional: the building the client intends to build, floor by floor. Each
  // entry is one floor's size (sq ft). An empty array means "no plan — estimate
  // the maximum." When present it drives cost and a fits/exceeds check against
  // the zoning maximums (kickoff section 6 — compare the program to the envelope).
  const [plannedFloors, setPlannedFloors] = useState([]);
  // Where the client has dragged each floor on the site plan, as front-left
  // corners in lot feet, indexed by floor. A null entry keeps that floor's
  // default placement — centred in the envelope, against the existing wall, or
  // centred on the floor below — so nothing moves until they move it.
  const [floorPositions, setFloorPositions] = useState([]);
  const [parcelPick, setParcelPick] = useState(null);
  // Click-to-identify on the zoning map. One lookup at a time: a second click
  // aborts the first rather than racing it to set the selection.
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState(null);
  const pickAbortRef = useRef(null);
  // The published building footprint standing on the parcel, when a source has
  // one. `footprintChoice` records what the client did with it, so the offer is
  // not re-made after they have chosen manual entry.
  const [detectedBuilding, setDetectedBuilding] = useState(null);
  const [detectingBuilding, setDetectingBuilding] = useState(false);
  const [footprintChoice, setFootprintChoice] = useState(null); // null | "detected" | "adjust" | "manual"
  const [parcel, setParcel] = useState(null);
  const [streetEdge, setStreetEdge] = useState(null);
  const [parcelError, setParcelError] = useState(null);
  const [zoningCheck, setZoningCheck] = useState(null);
  const [municipalGisCheck, setMunicipalGisCheck] = useState(null);
  // The live NJGIN feature, kept so changing the district re-insets the
  // envelope without another round trip to the service.
  const [njginFeature, setNjginFeature] = useState(null);
  // Marco's guide calls Signature "our most popular level", so it starts
  // selected. The client's choice drives the report and the contingency.
  const [selectedTier, setSelectedTier] = useState("signature");

  useEffect(() => {
    if (!supabase) return;
    fetchMunicipalities()
      .then((data) => setMunis(data))
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  const muni = munis?.find((m) => m.id === muniId) ?? null;
  // How the selection has to be loaded, and whether it is anywhere we hold
  // zoning for. A property outside that coverage is located and flagged, never
  // measured: the loaded town's districts say nothing about a lot in another
  // municipality, so no district is applied to it at all.
  const pickKind = pickKindOf(parcelPick);
  const parcelSource = pickKind === "db" ? "db" : "njgin";
  const outsideCoverage = Boolean(parcelPick) && parcelPick.municipality_id == null;
  // Memoised: the map keys its "fly to this point" effect on identity, and a
  // fresh object each render would re-centre the map under the user's hands.
  const placePoint = useMemo(
    () =>
      parcelPick?.kind === "place"
        ? {
            lat: parcelPick.lat,
            lon: parcelPick.lon,
            label: parcelPick.full_label ?? parcelPick.address,
          }
        : null,
    [parcelPick]
  );
  const district = outsideCoverage
    ? null
    : muni?.zoning_districts.find((d) => d.id === districtId) ?? null;
  const rawCostModel = muni?.build_cost_models;
  const costModel = (Array.isArray(rawCostModel) ? rawCostModel[0] : rawCostModel) ?? null;

  useEffect(() => {
    if (!parcelPick) {
      setParcel(null);
      setNjginFeature(null);
      setZoningCheck(null);
      return;
    }
    if (pickKind !== "db") return;

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
  }, [muni, parcelPick, pickKind]);

  // Live NJGIN path: pull the parcel geometry once. There is no zoning layer to
  // intersect it against here, so the district stays a manual, clearly labelled
  // choice — the app never claims a verification it did not perform. An
  // out-of-coverage address takes this path too, keyed on PAMS_PIN alone: the
  // State's boundary is drawable wherever the lot is, and only the zoning
  // question goes unanswered.
  useEffect(() => {
    if (!parcelPick || pickKind !== "njgin") return;

    let stale = false;
    setParcel(null);
    setNjginFeature(null);
    setParcelError(null);
    setZoningCheck({ status: outsideCoverage ? "outside_coverage" : "live_parcel" });

    fetchNjginParcel(outsideCoverage ? null : muni, parcelPick.pams_pin)
      .then((loaded) => {
        if (!stale) setNjginFeature(loaded.raw);
      })
      .catch((e) => {
        if (stale) return;
        setParcelError(e.message ?? String(e));
        setZoningCheck({ status: "error" });
      });

    return () => {
      stale = true;
    };
  }, [muni, parcelPick, pickKind, outsideCoverage]);

  // Geocoded address: there is no parcel to load at all. The point itself is
  // the whole result, and it is passed to the map as such.
  useEffect(() => {
    if (pickKind !== "place") return;
    setParcel(null);
    setNjginFeature(null);
    setParcelError(null);
    setZoningCheck({ status: "outside_coverage" });
  }, [pickKind, parcelPick]);

  // Re-inset the live parcel whenever the chosen district changes. Cheap enough
  // to run on every district switch: the geometry is already in memory.
  useEffect(() => {
    if (pickKind !== "njgin" || !njginFeature) return;
    setParcel(njginParcelFromFeature(njginFeature, district ? conservativeInsetFt(district) : 0));
  }, [district, njginFeature, pickKind]);

  // Resolve the real front of the parcel from NJ road centerlines. The
  // centerline service is an enhancement rather than a loading gate: on a
  // network failure or an isolated lot, previews retain the parcel-axis
  // orientation used before this feature.
  useEffect(() => {
    const geometry = parcel?.parcel_geojson_wgs84;
    if (!geometry) {
      setStreetEdge(null);
      return undefined;
    }
    const controller = new AbortController();
    setStreetEdge(null);
    matchParcelToRoad(geometry, controller.signal).then((match) => {
      if (!controller.signal.aborted) setStreetEdge(match);
    });
    return () => controller.abort();
  }, [parcel?.parcel_geojson_wgs84]);

  /**
   * Look for a published building footprint on the parcel — but only for the
   * projects that need one. A new house does not care what is standing there
   * now, so the query is not made.
   *
   * Only the footprint is offered. Storeys and total finished area are left
   * alone deliberately: a footprint layer is an outline seen from above and
   * knows nothing about what is under the roof, so filling those from it would
   * be inventing figures the source does not hold.
   */
  useEffect(() => {
    const geometry = parcel?.parcel_geojson_wgs84;
    const wantsExisting = projectType === "addition" || projectType === "adu";
    if (!geometry || !wantsExisting) {
      setDetectedBuilding(null);
      setDetectingBuilding(false);
      return undefined;
    }
    const controller = new AbortController();
    setDetectingBuilding(true);
    setDetectedBuilding(null);
    detectExistingBuilding(geometry, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        setDetectedBuilding(found);
        // Fill the footprint as soon as it is known, unless the client has
        // already taken the field over by hand.
        setFootprintChoice((choice) => {
          if (choice === "manual" || choice === "adjust") return choice;
          if (found) {
            setExistingStructure((current) => ({
              ...current,
              footprint_sqft: found.areaSqft,
            }));
            return "detected";
          }
          return choice;
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetectedBuilding(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetectingBuilding(false);
      });
    return () => controller.abort();
  }, [parcel?.parcel_geojson_wgs84, projectType]);

  // Level B only starts after Level A has either been ruled out or completed
  // without a verified Marco district. The municipality's own GIS can identify
  // a district, but it never supplies calculation rules.
  useEffect(() => {
    const geometry = parcel?.parcel_geojson_wgs84;
    const levelAStillChecking =
      pickKind === "db" && (!zoningCheck || zoningCheck.status === "checking");
    if (!parcelPick || !geometry || levelAStillChecking || zoningCheck?.status === "matched") {
      setMunicipalGisCheck(null);
      return undefined;
    }

    const controller = new AbortController();
    setMunicipalGisCheck({ status: "checking" });
    resolveMunicipalGisZoning({
      municipality: parcelPick.muni_name ?? muni?.name,
      stateCode: parcelPick.state_code ?? muni?.state_code,
      parcelGeojson: geometry,
      lat: parcelPick.lat,
      lon: parcelPick.lon,
      signal: controller.signal,
    })
      .then((check) => {
        if (!controller.signal.aborted) setMunicipalGisCheck(check);
      })
      .catch((lookupError) => {
        if (!controller.signal.aborted) {
          setMunicipalGisCheck({
            status: "error",
            message: lookupError.message ?? String(lookupError),
          });
        }
      });
    return () => controller.abort();
  }, [
    muni?.name,
    muni?.state_code,
    parcel?.parcel_geojson_wgs84,
    parcelPick,
    pickKind,
    zoningCheck?.status,
  ]);

  // A district with unfilled rules cannot produce a trustworthy answer, so the
  // calculation is refused rather than run against nulls (which would read as
  // "no setbacks, no coverage limit" and report the whole lot as buildable).
  // Outside our coverage there is no district on purpose, and the reason has
  // already been given by the unverified flag. Reporting Union City's rules as
  // "missing" on top of that would blame the wrong thing.
  const missingRules = useMemo(
    () => (outsideCoverage ? [] : missingDistrictRules(district)),
    [district, outsideCoverage]
  );
  const rulesReady = Boolean(district) && missingRules.length === 0;
  // A district that records ADUs as not permitted answers the client's
  // question outright; pricing one would contradict the ordinance on file.
  const adu = useMemo(() => aduRules(district), [district]);
  const aduBlocked = projectType === "adu" && adu.known && !adu.allowed;
  const zoningAvailable =
    zoningCheck?.status === "matched" && Boolean(district) && missingRules.length === 0;
  const municipalGisIdentified = municipalGisCheck?.status === "matched";
  const pricingAvailable = Boolean(costModel?.build_cost_tiers?.length);
  // Address, parcel, zoning, and pricing are independent layers. This mode is
  // a summary of which layers resolved; it never discards a valid lower layer
  // merely because a higher one is unavailable.
  const applicationMode = !parcelPick
    ? "address"
    : !parcel && pickKind !== "place"
      ? "resolving"
      : pickKind === "place"
        ? "address_only"
        : !zoningAvailable
          ? municipalGisIdentified
            ? "municipal_gis"
            : "parcel_only"
          : pricingAvailable
            ? "full"
            : "zoning_only";

  const result = useMemo(() => {
    if (!district || missingRules.length > 0) return null;
    let zoningResult = null;
    if (parcel) {
      const envelopeArea =
        parcel.envelope_area_sqft == null ? null : Number(parcel.envelope_area_sqft);
      // The uniform polygon inset (largest setback on every edge) collapses
      // narrow lots to nothing. When that happens and MOD-IV recorded the
      // rectangular dimensions, fall back to per-edge arithmetic on that
      // rectangle — the approximation the project doc calls for — instead of
      // reporting 0 sq ft.
      const recordedDims = recordedRectDims(parcel);
      const rectDims =
        envelopeArea > 0 || !recordedDims
          ? null
          : streetOrientedLotDims(parcel, lot, streetEdge);
      if (rectDims) {
        const rect = computeBuildable(
          { ...rectDims, area_sqft: Number(parcel.lot_area_sqft) },
          district
        );
        zoningResult = {
          ...rect,
          envelopeArea: rect.envelope.areaSqft,
          approximation: { widthFt: rectDims.width_ft, depthFt: rectDims.depth_ft },
        };
      } else {
        zoningResult = computeBuildableFromAreas(
          Number(parcel.lot_area_sqft),
          envelopeArea ?? 0,
          district
        );
      }
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
    const additionLocation = existingStructure.addition_location || "above";
    const existingHeightEstimate =
      enteredStories > 0
        ? enteredStories * FLOOR_TO_FLOOR_FT
        : existingArea != null && existingFootprint > 0
          ? (existingArea / existingFootprint) * FLOOR_TO_FLOOR_FT
          : FLOOR_TO_FLOOR_FT;
    const heightAvailable =
      Number(district.max_height_ft) > 0
        ? Math.max(0, Number(district.max_height_ft) - existingHeightEstimate)
        : null;

    // An ADU is capped by the district's own size limit, not just by what is
    // left over on the lot. Without this the tool quotes the full remaining
    // capacity for a unit the ordinance would not allow at that size.
    const adu = aduRules(district);

    // The zoning ceilings this project is measured against. maxArea is null for
    // an addition/ADU whose existing floor area is not yet known.
    let maxArea = hasExistingHouse ? availableBuildingArea : zoningResult.buildable;
    let aduSizeCapped = false;
    if (projectType === "adu" && adu.maxSizeSqft != null && maxArea != null && maxArea > adu.maxSizeSqft) {
      maxArea = adu.maxSizeSqft;
      aduSizeCapped = true;
    }
    const maxFootprint =
      projectType === "addition" && additionLocation === "above"
        ? existingFootprint
        : hasExistingHouse
          ? availableFootprint
          : zoningResult.footprint;
    // The effective story count, already capped by the height limit in
    // resolveStories — not district.max_stories, which ignores height.
    const maxFloors = zoningResult.stories ?? null;

    // The client's planned building, floor by floor, reduced to comparable
    // figures. When present, the total drives cost; otherwise the ceiling does.
    const {
      plannedArea: planned,
      plannedFootprint,
      plannedAreaSoFar,
      plannedFootprintSoFar,
      plannedFloorCount,
      plannedHeight,
      plannedDimensions,
    } = derivePlan(plannedFloors);
    const fitsArea = planned == null || maxArea == null ? null : planned <= maxArea;
    const fitsFootprint =
      plannedFootprint == null || maxFootprint == null ? null : plannedFootprint <= maxFootprint;
    const existingFloorsForZoning =
      enteredStories > 0
        ? Math.ceil(enteredStories)
        : existingArea != null && existingFootprint > 0
          ? Math.ceil(existingArea / existingFootprint)
          : hasExistingHouse
            ? 1
            : 0;
    const floorsForZoning =
      projectType === "addition" && additionLocation === "above"
        ? existingFloorsForZoning + plannedFloorCount
        : plannedFloorCount;
    const fitsFloors = planned == null || maxFloors == null ? null : floorsForZoning <= maxFloors;
    const maxHeight =
      projectType === "addition" && additionLocation === "above"
        ? heightAvailable
        : Number(district.max_height_ft) || null;
    const fitsHeight =
      plannedHeight == null || maxHeight == null ? null : plannedHeight <= maxHeight;
    let placementMaxWidthFt = null;
    let placementMaxDepthFt = null;
    let placementCapacitySqft = null;
    const placementLot = streetOrientedLotDims(parcel, lot, streetEdge);
    if (
      projectType === "addition" &&
      ["side_left", "side_right", "front", "back"].includes(additionLocation) &&
      Number(placementLot.width_ft) > 0 &&
      Number(placementLot.depth_ft) > 0
    ) {
      const lotWidth = Number(placementLot.width_ft);
      const lotDepth = Number(placementLot.depth_ft);
      const placedExisting = existingRect(
        lotWidth,
        lotDepth,
        existingFootprint,
        existingStructure.location,
        existingStructure.position
      );
      const existingWidth = placedExisting.x1 - placedExisting.x0;
      const existingDepth = placedExisting.y1 - placedExisting.y0;
      const existingX0 = placedExisting.x0;
      const existingY0 = placedExisting.y0;
      const side = district.side_yard_total_min_ft != null
        ? Number(district.side_yard_total_min_ft) / 2
        : Number(district.side_yard_one_min_ft) || 0;
      const envelopeX0 = side;
      const envelopeX1 = lotWidth - side;
      const envelopeY0 = Number(district.front_yard_min_ft) || 0;
      const envelopeY1 = lotDepth - (Number(district.rear_yard_min_ft) || 0);

      if (additionLocation === "side_left" || additionLocation === "side_right") {
        placementMaxWidthFt =
          additionLocation === "side_left"
            ? Math.max(0, existingX0 - envelopeX0)
            : Math.max(0, envelopeX1 - (existingX0 + existingWidth));
        placementMaxDepthFt = Math.max(
          0,
          Math.min(existingDepth, envelopeY1 - envelopeY0)
        );
      } else {
        placementMaxWidthFt = Math.max(
          0,
          Math.min(existingWidth, envelopeX1 - envelopeX0)
        );
        placementMaxDepthFt =
          additionLocation === "front"
            ? Math.max(0, existingY0 - envelopeY0)
            : Math.max(0, envelopeY1 - (existingY0 + existingDepth));
      }
      placementCapacitySqft = Math.min(
        availableFootprint,
        placementMaxWidthFt * placementMaxDepthFt
      );
    }
    // The setback check is run against the rectangle actually on the site
    // plan — the client's own placement once they have dragged it, the default
    // placement until then. It applies to a new house as much as to an
    // addition: now that the building can be moved, either can be put across a
    // setback line, and the calculation has to score what is drawn.
    const orientedForPlan = streetOrientedLotDims(parcel, lot, streetEdge);
    const planLotWidth = Number(orientedForPlan.width_ft);
    const planLotDepth = Number(orientedForPlan.depth_ft);
    const planDimensionsAvailable = planLotWidth > 0 && planLotDepth > 0;
    const planEnvelope = planDimensionsAvailable
      ? envelopeRect(planLotWidth, planLotDepth, {
          front: district.front_yard_min_ft,
          rear: district.rear_yard_min_ft,
          side:
            district.side_yard_total_min_ft != null
              ? Number(district.side_yard_total_min_ft) / 2
              : district.side_yard_one_min_ft,
        })
      : null;
    const planExisting =
      planDimensionsAvailable && hasExistingHouse
        ? existingRect(
            planLotWidth,
            planLotDepth,
            existingFootprint,
            existingStructure.location,
            existingStructure.position
          )
        : null;
    const planFloorRects = planDimensionsAvailable
      ? computeFloorRects({
          lotWidthFt: planLotWidth,
          lotDepthFt: planLotDepth,
          envelope: planEnvelope,
          existing: planExisting,
          additionLocation,
          placementMode:
            projectType === "adu"
              ? "adu"
              : projectType === "addition" && additionLocation !== "above"
                ? "addition"
                : "free",
          floors: plannedDimensions,
          positions: floorPositions,
        })
      : [];
    const placedRects = planFloorRects.filter(Boolean);
    // Every floor has to clear the setbacks, not just the one on the ground:
    // an upper floor can be dragged over a side yard just as easily.
    const fitsEnvelope = placedRects.length
      ? placedRects.every((rect) => rectFitsEnvelope(rect, planEnvelope))
      : null;
    // And every floor has to land on the one below it. The size caps already
    // stop an upper floor being larger; free placement means it can also be
    // pushed off the edge of its own support.
    const fitsStack =
      placedRects.length < 2
        ? null
        : planFloorRects.every(
            (rect, index) => index === 0 || !rect || rectOnTopOf(rect, planFloorRects[index - 1])
          );
    const groundRect = planFloorRects[0] ?? null;
    const fitsAttachment =
      projectType === "addition" && additionLocation !== "above" && planned != null
        ? Boolean(groundRect)
        : null;
    const fitsSeparation =
      projectType === "adu" && planned != null ? Boolean(groundRect) : null;
    // Overall fit is a pass unless any applicable check explicitly fails.
    const fitsPlan =
      planned == null
        ? null
        : ![
            fitsArea,
            fitsFootprint,
            fitsFloors,
            fitsHeight,
            fitsEnvelope,
            fitsStack,
            fitsAttachment,
            fitsSeparation,
          ].includes(
            false
          );
    const planDelta = planned == null || maxArea == null ? null : maxArea - planned;

    return {
      ...zoningResult,
      existingFootprint,
      existingStories: enteredStories || null,
      existingArea,
      existingAreaSource,
      existingLocation: existingStructure.location,
      existingPosition: existingStructure.position,
      additionLocation,
      existingHeightEstimate,
      heightAvailable,
      availableFootprint,
      availableBuildingArea,
      maxArea,
      maxFootprint,
      maxFloors,
      plannedArea: planned,
      plannedFootprint,
      plannedAreaSoFar,
      plannedFootprintSoFar,
      plannedFloorCount,
      plannedHeight,
      plannedDimensions,
      maxHeight,
      placementMaxWidthFt,
      placementMaxDepthFt,
      placementCapacitySqft,
      lotDimensionsAvailable: planDimensionsAvailable,
      lotDimensionSource: orientedForPlan.source,
      lotWidthFt: planDimensionsAvailable ? planLotWidth : null,
      lotDepthFt: planDimensionsAvailable ? planLotDepth : null,
      planEnvelope,
      groundRect,
      floorRects: planFloorRects,
      positionMoved: floorPositions.some((position) => position != null),
      fitsArea,
      fitsFootprint,
      fitsFloors,
      fitsHeight,
      fitsEnvelope,
      fitsStack,
      fitsAttachment,
      fitsSeparation,
      fitsPlan,
      planDelta,
      estimateArea: planned ?? maxArea,
      aduSizeCapped,
      aduMaxSizeSqft: adu.maxSizeSqft,
    };
  }, [floorPositions, district, missingRules, existingStructure, lot, parcel, plannedFloors, projectType, streetEdge]);

  // A parcel without verified Marco rules may still be sketched in Step 2.
  // This result contains geometry and the user's own dimensions only. It does
  // not manufacture a district, setbacks, coverage, FAR, stories, or height.
  const parcelPlanningResult = useMemo(() => {
    if (!parcel || !projectType || zoningAvailable) return null;

    const oriented = streetOrientedLotDims(parcel, lot, streetEdge);
    const lotWidth = Number(oriented.width_ft);
    const lotDepth = Number(oriented.depth_ft);
    const lotDimensionsAvailable = lotWidth > 0 && lotDepth > 0;

    const hasExistingHouse = projectType === "addition" || projectType === "adu";
    const existingFootprint = hasExistingHouse
      ? Number(existingStructure.footprint_sqft) || 0
      : 0;
    const enteredArea = hasExistingHouse
      ? Number(existingStructure.total_area_sqft) || 0
      : 0;
    const enteredStories = hasExistingHouse
      ? Number(existingStructure.stories) || 0
      : 0;
    const existingArea = !hasExistingHouse
      ? 0
      : enteredArea > 0
        ? enteredArea
        : enteredStories > 0
          ? existingFootprint * enteredStories
          : null;
    const additionLocation = existingStructure.addition_location || "above";
    const plan = derivePlan(plannedFloors);
    const planEnvelope = lotDimensionsAvailable
      ? envelopeRect(lotWidth, lotDepth, { front: 0, rear: 0, side: 0 })
      : null;
    const planExisting =
      lotDimensionsAvailable && hasExistingHouse
        ? existingRect(
            lotWidth,
            lotDepth,
            existingFootprint,
            existingStructure.location,
            existingStructure.position
          )
        : null;
    const planFloorRects = lotDimensionsAvailable
      ? computeFloorRects({
          lotWidthFt: lotWidth,
          lotDepthFt: lotDepth,
          envelope: planEnvelope,
          existing: planExisting,
          additionLocation,
          placementMode:
            projectType === "adu"
              ? "adu"
              : projectType === "addition" && additionLocation !== "above"
                ? "addition"
                : "free",
          floors: plan.plannedDimensions,
          positions: floorPositions,
        })
      : [];
    const placedRects = planFloorRects.filter(Boolean);
    const fitsParcel = placedRects.length
      ? placedRects.every((rect) => rectFitsEnvelope(rect, planEnvelope))
      : null;
    const fitsStack =
      placedRects.length < 2
        ? null
        : planFloorRects.every(
            (rect, index) =>
              index === 0 ||
              !rect ||
              !planFloorRects[index - 1] ||
              rectOnTopOf(rect, planFloorRects[index - 1])
          );
    const fitsAttachment =
      projectType === "addition" &&
      additionLocation !== "above" &&
      plan.plannedArea != null
        ? Boolean(planFloorRects[0])
        : null;
    const fitsSeparation =
      projectType === "adu" && plan.plannedArea != null
        ? Boolean(planFloorRects[0])
        : null;

    return {
      zoningVerified: false,
      lotArea:
        Number(parcel.lot_area_sqft) ||
        (lotDimensionsAvailable ? lotWidth * lotDepth : null),
      envelope: lotDimensionsAvailable
        ? {
            widthFt: lotWidth,
            depthFt: lotDepth,
            areaSqft: lotWidth * lotDepth,
            insets: { front: 0, rear: 0, side: 0 },
          }
        : null,
      footprint: null,
      buildable: null,
      stories: null,
      heightLimited: false,
      existingFootprint,
      existingStories: enteredStories || null,
      existingArea,
      existingAreaSource:
        !hasExistingHouse || enteredArea > 0
          ? "entered"
          : enteredStories > 0
            ? "footprint_times_stories"
            : null,
      existingLocation: existingStructure.location,
      existingPosition: existingStructure.position,
      additionLocation,
      existingHeightEstimate:
        enteredStories > 0 ? enteredStories * FLOOR_TO_FLOOR_FT : null,
      heightAvailable: null,
      availableFootprint: null,
      availableBuildingArea: null,
      maxArea: null,
      maxFootprint: null,
      maxFloors: null,
      ...plan,
      maxHeight: null,
      placementMaxWidthFt: null,
      placementMaxDepthFt: null,
      placementCapacitySqft: null,
      lotDimensionsAvailable,
      lotDimensionSource: oriented.source,
      lotWidthFt: lotDimensionsAvailable ? lotWidth : null,
      lotDepthFt: lotDimensionsAvailable ? lotDepth : null,
      planEnvelope,
      groundRect: planFloorRects[0] ?? null,
      floorRects: planFloorRects,
      positionMoved: floorPositions.some((position) => position != null),
      fitsArea: null,
      fitsFootprint: null,
      fitsFloors: null,
      fitsHeight: null,
      fitsEnvelope: fitsParcel,
      fitsStack,
      fitsAttachment,
      fitsSeparation,
      fitsPlan: null,
      planDelta: null,
      estimateArea: plan.plannedArea,
      aduSizeCapped: false,
      aduMaxSizeSqft: null,
    };
  }, [
    existingStructure,
    floorPositions,
    lot,
    parcel,
    plannedFloors,
    projectType,
    streetEdge,
    zoningAvailable,
  ]);

  const project = PROJECT_TYPES.find((item) => item.id === projectType);
  const step2Result = result ?? parcelPlanningResult;
  const step2District = district ?? UNVERIFIED_DISTRICT;
  // A verified zoning result is required for calculations and pricing. A
  // resolved parcel is enough for the explicitly unverified Step 2 workspace.
  const locationReady = Boolean(parcel && zoningAvailable);
  const parcelReady = Boolean(parcel);
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
  // `rulesReady` refuses a district whose rules are only partly filled in, and
  // `aduBlocked` refuses an ADU the district records as not permitted.
  const propertyReady = Boolean(projectType && parcelReady);
  const canCalculate = Boolean(
    projectType &&
      district &&
      rulesReady &&
      locationReady &&
      structureReady &&
      existingInputsValid &&
      !aduBlocked &&
      result
  );
  const canEnterStep2 = Boolean(
    propertyReady &&
      structureReady &&
      existingInputsValid &&
      !aduBlocked &&
      step2Result
  );

  /**
   * Accept a search result from either picker. A result may be in the loaded
   * municipality, in another municipality we happen to hold zoning for (move
   * there and keep the selection), or anywhere else — in which case it is
   * tagged with no municipality and travels through the UI as unverified.
   */
  const selectParcel = async (picked) => {
    setParcel(null);
    setNjginFeature(null);
    setZoningCheck(null);
    setMunicipalGisCheck(null);
    setParcelError(null);
    setDistrictId(null);
    // Floor dimensions and dragged origins belong to the previous parcel.
    // Clearing them prevents starter or prior-lot dimensions from surviving a
    // real parcel selection while its own records are being resolved.
    setPlannedFloors([]);
    setFloorPositions([]);
    setExistingStructure((current) => ({ ...current, position: null }));
    // A detected footprint belongs to the parcel it was found on, and so does
    // the choice the client made about it.
    setDetectedBuilding(null);
    setFootprintChoice(null);

    if (!picked) {
      setParcelPick(null);
      setMuniId(null);
      return;
    }

    const home = matchLoadedMuni(munis, picked);
    let resolvedPick = {
      ...picked,
      municipality_id: home?.id ?? null,
    };

    // NJGIN owns statewide discovery. When that PIN is also present in our
    // local import, attach its database id so PostGIS can intersect the parcel
    // with the supported municipality's zoning polygons.
    if (home && picked.kind === "parcel" && picked.pams_pin) {
      try {
        const imported = await findImportedParcelByPin(home.id, picked.pams_pin);
        if (imported) {
          resolvedPick = {
            ...resolvedPick,
            ...imported,
            address: picked.matched_address ?? imported.address ?? picked.address,
            kind: "parcel",
            scope: "muni",
          };
        }
      } catch {
        // A local-link failure does not invalidate the statewide parcel. The
        // app continues honestly in parcel-only mode.
      }
    }

    setMuniId(home?.id ?? null);
    setParcelPick(resolvedPick);
  };

  /**
   * Identify the property under a click on the zoning map.
   *
   * The same NJGIN point-in-polygon query the address path already uses, only
   * the coordinates come from the cursor instead of the geocoder — so the
   * address it reports is the parcel record's own PROP_LOC, not a guess about
   * what the client meant to click. Overlapping records (condominiums, tax
   * seams) come back smallest-first, and the smallest containing parcel is the
   * one taken.
   */
  const pickParcelAtPoint = async (lat, lon) => {
    pickAbortRef.current?.abort();
    const controller = new AbortController();
    pickAbortRef.current = controller;
    setPicking(true);
    setPickError(null);
    try {
      const found = await findNjginParcelAtPoint(lat, lon, 5, controller.signal);
      if (controller.signal.aborted) return;
      if (found.length === 0) {
        setPickError(
          "No parcel record covers that point. Streets, water and public rights-of-way are not parcels — try clicking inside a lot."
        );
        return;
      }
      await selectParcel(found[0]);
    } catch (e) {
      if (controller.signal.aborted || e?.name === "AbortError") return;
      setPickError(`Could not identify that property: ${e.message ?? String(e)}`);
    } finally {
      if (!controller.signal.aborted) setPicking(false);
    }
  };

  /** Take the detected figure — the initial state, and the way back to it. */
  const useDetectedBuilding = () => {
    if (!detectedBuilding) return;
    setExistingStructure((current) => ({
      ...current,
      footprint_sqft: detectedBuilding.areaSqft,
    }));
    setFootprintChoice("detected");
  };

  /**
   * Keep the detected outline on the map but hand the number to the client.
   * The drawing is what they are adjusting against, so it stays.
   */
  const adjustOutline = () => setFootprintChoice("adjust");

  /** Start from nothing: clear the figure and take the outline off the map. */
  const enterFootprintManually = () => {
    setExistingStructure((current) => ({ ...current, footprint_sqft: "" }));
    setFootprintChoice("manual");
  };

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

  const previewProps = {
    // The address/parcel layer is useful even when no local zoning catalog
    // exists, so the preview opens as soon as a property result is selected.
    visible: Boolean(parcelPick),
    muni,
    district,
    lot,
    parcelSource,
    parcel,
    parcelPick,
    zoningCheck,
    municipalGisCheck,
    project,
    outsideCoverage,
    placePoint,
    picking,
    pickError,
    // Withdrawn once the client chooses to type their own figure: the drawing
    // would otherwise keep asserting a measurement they have set aside.
    buildingGeojson: footprintChoice === "manual" ? null : detectedBuilding?.geometry ?? null,
    onPickPoint: pickParcelAtPoint,
    onParcel: selectParcel,
  };

  return (
    <>
      <TopNav />
      <main className="shell">
      <Stepper step={step} maxStepReached={maxStepReached} onStep={goToStep} />

      {error && <div className="card error">Failed to load data: {error}</div>}
      {!error && !munis && <div className="card loading-card">Loading property data…</div>}

      {munis && step === 1 && (
        <ProjectSetup
          muni={muni}
          district={district}
          parcelSource={parcelSource}
          parcelPick={parcelPick}
          parcel={parcel}
          parcelError={parcelError}
          zoningCheck={zoningCheck}
          municipalGisCheck={municipalGisCheck}
          outsideCoverage={outsideCoverage}
          applicationMode={applicationMode}
          zoningAvailable={zoningAvailable}
          municipalGisIdentified={municipalGisIdentified}
          pricingAvailable={pricingAvailable}
          projectType={projectType}
          existingStructure={existingStructure}
          propertyReady={propertyReady}
          missingRules={missingRules}
          adu={adu}
          aduBlocked={aduBlocked}
          canContinue={canEnterStep2}
          previewProps={previewProps}
          onProjectType={setProjectType}
          onExistingStructure={setExistingStructure}
          detectedBuilding={detectedBuilding}
          detectingBuilding={detectingBuilding}
          footprintChoice={footprintChoice}
          onUseDetectedBuilding={useDetectedBuilding}
          onAdjustOutline={adjustOutline}
          onEnterFootprintManually={enterFootprintManually}
          onParcel={selectParcel}
          onContinue={() => advance(2)}
        />
      )}

      {munis && step === 2 && step2Result && (
        <CapacityStep
          project={project}
          district={step2District}
          lot={lot}
          parcel={parcel}
          streetEdge={streetEdge}
          result={step2Result}
          zoningVerified={zoningAvailable}
          existingStructure={existingStructure}
          plannedFloors={plannedFloors}
          floorPositions={floorPositions}
          onExistingStructure={setExistingStructure}
          onPlannedFloors={setPlannedFloors}
          onFloorPositions={setFloorPositions}
          onBack={() => goToStep(1)}
          onContinue={canCalculate ? () => advance(3) : null}
        />
      )}

      {munis && step === 3 && result && (
        <Results
          project={project}
          muni={muni}
          district={district}
          lot={lot}
          parcelSource={parcelSource}
          parcel={parcel}
          streetEdge={streetEdge}
          result={result}
          costModel={costModel}
          selectedTier={selectedTier}
          onSelectTier={setSelectedTier}
          adu={adu}
          onBack={() => goToStep(2)}
          onContinue={() => advance(4)}
        />
      )}

      {munis && step === 4 && result && (
        <Review
          project={project}
          muni={muni}
          district={district}
          lot={lot}
          parcel={parcel}
          streetEdge={streetEdge}
          result={result}
          costModel={costModel}
          selectedTier={selectedTier}
          onBack={() => goToStep(3)}
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
  muni,
  district,
  parcelSource,
  parcelPick,
  parcel,
  parcelError,
  zoningCheck,
  municipalGisCheck,
  outsideCoverage,
  applicationMode,
  zoningAvailable,
  municipalGisIdentified,
  pricingAvailable,
  projectType,
  existingStructure,
  propertyReady,
  missingRules,
  aduBlocked,
  canContinue,
  previewProps,
  onProjectType,
  onExistingStructure,
  detectedBuilding,
  detectingBuilding,
  footprintChoice,
  onUseDetectedBuilding,
  onAdjustOutline,
  onEnterFootprintManually,
  onParcel,
  onContinue,
}) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  const propertyResolved = Boolean(parcelPick && applicationMode !== "resolving");

  return (
    <section className={previewProps.visible ? "workspace-grid" : "workspace-grid solo"}>
      <div className="card form-card">
        <div className="section-heading">
          <span className="section-icon">⌖</span>
          <div>
            <p className="eyebrow">Step 1</p>
            <h2>Enter the property address</h2>
            <p>Start with an address. We’ll handle the property records, zoning, and pricing.</p>
          </div>
        </div>

        <div className="property-method address-first">
          <div className="method-title">
            <div>
              <h3>Find the property</h3>
              <p>Start with any address. New Jersey parcels are searched statewide.</p>
            </div>
            <span className="data-tag live">Census + NJGIN</span>
          </div>
          <div className={parcelPick ? "property-picker chosen" : "property-picker"}>
            {parcelPick && (
              <div
                className={
                  zoningAvailable
                    ? "selected-property"
                    : municipalGisIdentified
                      ? "selected-property gis-identified"
                      : "selected-property unverified"
                }
              >
                <span
                  className={
                    applicationMode === "resolving"
                      ? "check pending"
                      : zoningAvailable
                        ? "check"
                        : municipalGisIdentified
                          ? "check identified"
                          : "check unverified"
                  }
                >
                  {applicationMode === "resolving"
                    ? "…"
                    : zoningAvailable
                      ? "✓"
                      : municipalGisIdentified
                        ? "B"
                        : "⚑"}
                </span>
                <div>
                  <strong>
                    {parcelPick.matched_address ??
                      parcel?.address ??
                      parcelPick.full_label ??
                      parcelPick.address}
                  </strong>
                  <span>
                    {parcelPick.kind === "place"
                      ? `${parcelPick.muni_name ?? "Municipality not identified"} · address location only`
                      : `${parcelPick.muni_name ?? muni?.name ?? "Municipality not identified"} · Block ${parcel?.block ?? parcelPick.block ?? "—"} / Lot ${parcel?.lot ?? parcelPick.lot ?? "—"} · ${fmt(parcel?.lot_area_sqft ?? parcelPick.lot_area_sqft)} sq ft`}
                  </span>
                </div>
              </div>
            )}
            <ParcelSearch
              selected={parcelPick}
              onSelect={onParcel}
              onClear={() => onParcel(null)}
            />
          </div>

          {parcelPick && (
            <LookupLayerStatus
              mode={applicationMode}
              muni={muni}
              parcelPick={parcelPick}
              parcel={parcel}
              district={district}
              zoningCheck={zoningCheck}
              municipalGisCheck={municipalGisCheck}
              zoningAvailable={zoningAvailable}
              pricingAvailable={pricingAvailable}
            />
          )}
          {zoningCheck?.status === "checking" && (
            <p className="status-line">Checking Marco-configured zoning first…</p>
          )}
          {municipalGisCheck?.status === "checking" && (
            <p className="status-line">Checking the municipality’s official GIS…</p>
          )}
          {parcelSource === "njgin" && parcelPick?.kind === "parcel" && !parcel && !parcelError && (
            <p className="status-line">Loading the statewide NJGIN parcel boundary…</p>
          )}
          {parcelError && (
            <p className="status-line error-text">Parcel lookup failed: {parcelError}</p>
          )}
        </div>

        {parcel && propertyResolved && (
          <fieldset className="field-group reveal">
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
        )}

        {propertyReady && (
          <div className="reveal">
            {projectType === "new_house" && (
              <div className="project-assumption">
                <span aria-hidden="true">⌂</span>
                <div>
                  <strong>New house calculation</strong>
                  <p>
                    {zoningAvailable
                      ? "This assumes the property is vacant or the existing structure will be completely replaced. The result will show the maximum house footprint and total allowable building area."
                      : "This assumes the property is vacant or the existing structure will be completely replaced. You can sketch a preliminary building inside the parcel, but no zoning maximum will be calculated."}
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
                      {zoningAvailable
                        ? projectType === "addition"
                          ? "The footprint is the key input. We’ll subtract it from the footprint zoning permits."
                          : "The footprint is the key input for estimating the space that may remain for an ADU."
                        : "The footprint places the existing house in the parcel-only drawing. Zoning capacity is not calculated."}
                    </p>
                  </div>
                  <span className="data-tag">Footprint required</span>
                </div>

                <DetectedBuildingNotice
                  detecting={detectingBuilding}
                  detected={detectedBuilding}
                  choice={footprintChoice}
                  onUseDetected={onUseDetectedBuilding}
                  onAdjustOutline={onAdjustOutline}
                  onEnterManually={onEnterFootprintManually}
                />

                <div className="form-grid existing-fields">
                  <NumberField
                    label="Existing building footprint (sq ft) *"
                    value={existingStructure.footprint_sqft}
                    onChange={(value) => {
                      // Typing over a detected figure makes it the client's
                      // number, not the source's — the note must stop crediting
                      // NJDEP or OSM for a value they did not produce.
                      if (footprintChoice === "detected") onAdjustOutline();
                      onExistingStructure({ ...existingStructure, footprint_sqft: value });
                    }}
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
                      onChange={(event) =>
                        onExistingStructure({
                          ...existingStructure,
                          location: event.target.value,
                          position: null,
                        })
                      }
                    >
                      <option value="unsure">Not sure</option>
                      <option value="front">Toward the front of the lot</option>
                      <option value="center">Near the center of the lot</option>
                      <option value="rear">Toward the rear of the lot</option>
                    </select>
                    <small>
                      Optional. Helps site-layout analysis; it does not change the zoning calculation.
                    </small>
                  </label>
                </div>
                {projectType === "adu" && (
                  <p className="adu-note">
                    ADU eligibility, size, setbacks, parking, utilities, and whether it may be
                    detached must still be confirmed with{" "}
                    {muni?.name ?? parcelPick?.muni_name ?? "the municipality"}.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {district && (
          <RulesMissingNotice
            missing={missingRules}
            muniName={muni?.name}
            districtCode={district.code}
          />
        )}
        <AduNotPermittedNotice
          show={aduBlocked}
          muniName={muni?.name}
          districtCode={district?.code}
        />

        {!parcelPick && <SurveyNotice />}

        <button type="button" className="primary full" disabled={!canContinue} onClick={onContinue}>
          {zoningAvailable ? "See what you can build" : "Continue to preliminary plan"}{" "}
          <span aria-hidden="true">→</span>
        </button>
        {propertyReady && !structureReadyFromInputs(projectType, existingStructure) && (
          <p className="form-hint">Enter the existing building footprint to continue.</p>
        )}
      </div>

      {previewProps.visible && <PropertyPreview {...previewProps} />}
    </section>
  );
}

function LookupLayerStatus({
  mode,
  muni,
  parcelPick,
  parcel,
  district,
  zoningCheck,
  municipalGisCheck,
  zoningAvailable,
  pricingAvailable,
}) {
  const modeCopy = {
    address: ["Enter an address", "waiting"],
    resolving: ["Resolving property layers", "resolving"],
    full: ["Full zoning + pricing mode", "full"],
    zoning_only: ["Zoning mode · pricing unavailable", "partial"],
    municipal_gis: ["Municipal GIS district mode · rules pending", "identified"],
    parcel_only: ["Parcel preview mode · zoning unavailable", "partial"],
    address_only: ["Address location mode · parcel unavailable", "partial"],
  }[mode] ?? ["Property lookup", "waiting"];
  const rows = [
    {
      label: "Municipality & State",
      ready: Boolean(parcelPick),
      value: muni
        ? `${muni.name}, ${muni.state_code}`
        : parcelPick.muni_name
          ? `${parcelPick.muni_name}${parcelPick.state_code ? `, ${parcelPick.state_code}` : ""}`
          : "Location identified",
    },
    {
      label: "Parcel polygon",
      ready: Boolean(parcel),
      value: parcel
        ? `NJGIN · Block ${parcel.block ?? parcelPick.block ?? "—"} / Lot ${parcel.lot ?? parcelPick.lot ?? "—"}`
        : parcelPick.kind === "parcel"
          ? "Loading NJGIN boundary…"
          : "Not available",
    },
    {
      label: "Zoning district",
      state: zoningAvailable
        ? "verified"
        : municipalGisCheck?.status === "matched"
          ? "identified"
          : "unavailable",
      value: zoningAvailable
        ? "Zoning verified"
        : municipalGisCheck?.status === "matched"
          ? municipalGisDistrictLabel(municipalGisCheck)
          : municipalGisStatusLabel(municipalGisCheck, zoningCheck),
    },
    {
      label: "Construction pricing",
      ready: pricingAvailable,
      value: pricingAvailable
        ? `${muni?.name ?? "Local"} pricing available`
        : "Not available for this municipality",
    },
  ];
  return (
    <div className="lookup-layer-status" role="status">
      <div className="lookup-mode-head">
        <strong>Application mode</strong>
        <span className={`lookup-mode ${modeCopy[1]}`}>{modeCopy[0]}</span>
      </div>
      <ol>
        {rows.map((row) => (
          <li
            className={row.state ?? (row.ready ? "ready" : "unavailable")}
            key={row.label}
          >
            <span aria-hidden="true">
              {row.state === "identified" ? "B" : row.state === "unavailable" || !row.ready && !row.state ? "—" : "✓"}
            </span>
            <div>
              <strong>{row.label}</strong>
              <small>{row.value}</small>
            </div>
          </li>
        ))}
      </ol>
      {municipalGisCheck?.status === "matched" && (
        <p className="municipal-gis-notice">
          <strong>District identified from municipal GIS. Dimensional rules are pending review.</strong>
          <span>
            Level B · {municipalGisCheck.provider}
            {municipalGisCheck.source_url && (
              <>
                {" · "}
                <a href={municipalGisCheck.source_url} target="_blank" rel="noreferrer">
                  Open official map
                </a>
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Right-hand panel for the input step. Only rendered once a property exists to
 * draw — see `previewProps.visible`.
 */
function PropertyPreview({
  muni,
  district,
  parcel,
  parcelPick,
  zoningCheck,
  outsideCoverage,
  placePoint,
  picking,
  pickError,
  buildingGeojson,
  onPickPoint,
  onParcel,
}) {
  const [mapOpen, setMapOpen] = useState(false);
  const propertyLabel =
    parcelPick?.matched_address ??
    parcel?.address ??
    parcelPick?.full_label ??
    parcelPick?.address ??
    `${muni?.name ?? "Selected"} lot`;
  const municipalityName = muni?.name ?? parcelPick?.muni_name ?? "Property";
  const unverified = outsideCoverage || zoningCheck?.status !== "matched" || !district;

  return (
    <aside className="card preview-card">
      <Suspense fallback={<div className="preview-placeholder">Loading the property map…</div>}>
        <ZoningMap
          muniSlug={muni?.slug ?? null}
          muniName={municipalityName}
          districts={muni?.zoning_districts ?? []}
          parcelGeojson={parcel?.parcel_geojson_wgs84 ?? null}
          parcelLabel={propertyLabel}
          focusPoint={placePoint}
          unverified={unverified}
          buildingGeojson={buildingGeojson}
          onPickPoint={onPickPoint}
          picking={picking}
          pickError={pickError}
          headingLabel="Property preview"
          note="Parcel boundaries and zoning are separate data layers. Diagram is not a survey."
          onExpand={() => setMapOpen(true)}
        />
      </Suspense>
      {mapOpen && (
        <ExpandedMapDialog
          muni={muni}
          district={district}
          zoningCheck={zoningCheck}
          parcel={parcel}
          parcelPick={parcelPick}
          propertyLabel={propertyLabel}
          outsideCoverage={outsideCoverage}
          placePoint={placePoint}
          picking={picking}
          pickError={pickError}
          buildingGeojson={buildingGeojson}
          onPickPoint={onPickPoint}
          onParcel={onParcel}
          onClose={() => setMapOpen(false)}
        />
      )}
    </aside>
  );
}

function ExpandedMapDialog({
  muni,
  district,
  zoningCheck,
  parcel,
  parcelPick,
  propertyLabel,
  outsideCoverage,
  placePoint,
  picking,
  pickError,
  buildingGeojson,
  onPickPoint,
  onParcel,
  onClose,
}) {
  const closeRef = useRef(null);
  const municipalityName = muni?.name ?? parcelPick?.muni_name ?? "this location";
  const unverified = outsideCoverage || zoningCheck?.status !== "matched" || !district;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="map-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="map-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-dialog-title"
      >
        <header className="map-dialog-header">
          <div>
            <p className="eyebrow">Statewide property map</p>
            <h2 id="map-dialog-title">Find and preview a property</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="map-dialog-close"
            onClick={onClose}
            aria-label="Close expanded property map"
          >
            ×
          </button>
        </header>

        <div className="map-dialog-body">
          <div className="map-dialog-search">
            <h3>Select a property address</h3>
            <ParcelSearch
              selected={parcelPick}
              onSelect={onParcel}
              onClear={() => onParcel(null)}
              alwaysShowForm
              showScopeHint={false}
            />
            <span className="data-tag live">Census + statewide NJGIN</span>
            {parcelPick && (
              <div className={unverified ? "selected-property unverified" : "selected-property"}>
                <span className={unverified ? "check unverified" : parcel ? "check" : "check pending"}>
                  {unverified ? "⚑" : parcel ? "✓" : "!"}
                </span>
                <div>
                  <strong>{propertyLabel}</strong>
                  <span>
                    {parcelPick.kind === "place"
                      ? `${municipalityName} · located address · no parcel polygon`
                      : `${municipalityName} · Block ${parcel?.block ?? parcelPick.block ?? "—"} / Lot ${parcel?.lot ?? parcelPick.lot ?? "—"} · ${fmt(parcel?.lot_area_sqft ?? parcelPick.lot_area_sqft)} sq ft`}
                  </span>
                </div>
              </div>
            )}
            <button
              type="button"
              className="primary full map-dialog-apply"
              disabled={!parcel && !placePoint}
              onClick={onClose}
            >
              {parcelPick && !parcel && !placePoint ? "Loading property…" : "Apply property"}
            </button>
          </div>

          <Suspense fallback={<div className="preview-placeholder">Loading the expanded map…</div>}>
            <ZoningMap
              muniSlug={muni?.slug ?? null}
              muniName={municipalityName}
              districts={muni?.zoning_districts ?? []}
              parcelGeojson={parcel?.parcel_geojson_wgs84 ?? null}
              parcelLabel={propertyLabel}
              focusPoint={placePoint}
              unverified={unverified}
              buildingGeojson={buildingGeojson}
              onPickPoint={onPickPoint}
              picking={picking}
              pickError={pickError}
              headingLabel="Property preview"
              note="Public parcel boundaries are preliminary and are not a survey."
              expanded
            />
          </Suspense>
        </div>
      </section>
    </div>
  );
}

/**
 * What was found standing on the parcel, where it came from, and what the
 * client can do about it.
 *
 * The source is always named. A footprint layer is published data of varying
 * age and completeness, not a survey, and the difference between "the State
 * measured this" and "a mapper drew this" is exactly the sort of thing a
 * client should be told rather than left to assume.
 */
function DetectedBuildingNotice({
  detecting,
  detected,
  choice,
  onUseDetected,
  onAdjustOutline,
  onEnterManually,
}) {
  if (choice === "manual") {
    return (
      <p className="footprint-note manual" role="status">
        <span aria-hidden="true">✎</span>
        <span>
          Footprint entered by hand.
          {detected && (
            <>
              {" "}
              <button type="button" className="text-button compact" onClick={onUseDetected}>
                Use the detected building ({fmt(detected.areaSqft)} sq ft) instead
              </button>
            </>
          )}
        </span>
      </p>
    );
  }

  if (detecting) {
    return (
      <p className="footprint-note busy" role="status">
        <span className="footprint-spinner" aria-hidden="true" />
        Looking for a published building footprint on this parcel…
      </p>
    );
  }

  if (!detected) {
    return (
      <p className="footprint-note" role="status">
        <span aria-hidden="true">○</span>
        <span>
          No published building footprint covers this parcel, so there is nothing to measure
          automatically. Enter the footprint below.
        </span>
      </p>
    );
  }

  const adjusting = choice === "adjust";
  return (
    <div className={adjusting ? "footprint-detected adjusting" : "footprint-detected"} role="status">
      <div className="footprint-detected-head">
        <strong>
          {adjusting ? "Adjusting the detected outline" : "Existing building detected"}
        </strong>
        <span className="footprint-area">{fmt(detected.areaSqft)} sq ft</span>
      </div>
      <p className="footprint-source">
        Measured from <strong>{detected.source.name}</strong> — {detected.source.detail}.{" "}
        <a href={detected.source.url} target="_blank" rel="noreferrer">
          Source →
        </a>
      </p>
      {detected.clipped && (
        <p className="fine">
          The outline crosses this lot's boundary. The {fmt(detected.areaSqft)} sq ft above is the
          part standing on this parcel, out of {fmt(detected.fullAreaSqft)} sq ft in total — an
          attached row house is normally drawn as one shape across several lots.
        </p>
      )}
      <p className="fine">
        Outlines are published data of varying age and accuracy, not a survey. Storeys and total
        finished area are not filled in: a footprint is an outline seen from above and says nothing
        about what is under the roof.
      </p>
      <div className="footprint-actions">
        {adjusting ? (
          <button type="button" className="secondary compact" onClick={onUseDetected}>
            Restore detected size
          </button>
        ) : (
          <button type="button" className="secondary compact" onClick={onAdjustOutline}>
            Adjust outline
          </button>
        )}
        <button type="button" className="text-button compact" onClick={onEnterManually}>
          Enter manually
        </button>
      </div>
    </div>
  );
}

/**
 * Whether the selected parcel is settled enough to build on. The two sources
 * clear different bars: an imported parcel needs a geometry-verified district,
 * a live NJGIN parcel only needs its boundary, because its district was chosen
 * by hand and is labelled as such throughout.
 */
function parcelResolved(check, parcel, live) {
  return live ? Boolean(parcel) : check?.status === "matched";
}

function zoningStatusLabel(check) {
  if (!check) return "Identified after parcel selection";
  if (check.status === "checking") return "Checking zoning geometry…";
  if (check.status === "outside_coverage") return "Not verified — outside our zoning data";
  if (check.status === "live_parcel") return "Chosen manually — no zoning layer loaded";
  if (check.status === "matched") {
    return `${check.district_code}${check.district_name ? ` — ${check.district_name}` : ""}`;
  }
  if (check.status === "rules_missing") return `${check.district_code ?? "District found"} — rules not loaded`;
  if (check.status === "boundary_conflict") return "Multiple districts intersect parcel";
  if (check.status === "unmapped") return "Parcel is outside mapped zoning polygons";
  if (check.status === "no_layer") return "Municipal zoning layer not loaded";
  return "Automatic zoning check unavailable";
}

function municipalGisStatusLabel(gisCheck, marcoCheck) {
  if (gisCheck?.status === "checking") return "Checking official municipal GIS…";
  if (gisCheck?.status === "unmapped") return "Official GIS has no district at this parcel";
  if (gisCheck?.status === "boundary_conflict") {
    return `Official GIS returns multiple districts${
      gisCheck.competing_codes?.length ? ` (${gisCheck.competing_codes.join(", ")})` : ""
    }`;
  }
  if (gisCheck?.status === "error") return "Official municipal GIS could not be reached";
  if (gisCheck?.status === "unavailable") return "Official municipal GIS zoning is not connected";
  return zoningStatusLabel(marcoCheck);
}

function municipalGisDistrictLabel(check) {
  const code = String(check?.district_code ?? "").trim();
  const name = String(check?.district_name ?? "").trim();
  const district =
    code && name && code.toUpperCase() !== name.toUpperCase()
      ? `${code} — ${name}`
      : code || name || "District identified";
  return check?.district_type ? `${district} · ${check.district_type}` : district;
}

function ZoningCheckNotice({ check, live, muni, ready, outsideCoverage }) {
  // Outside the imported zoning there is nothing to check against. The red flag
  // on the map and the "Not verified" district field already say so, so the
  // only thing left worth reporting here is an outright failure to load.
  if (outsideCoverage) {
    if (check?.status === "error") {
      return (
        <div className="zoning-check unverified" role="alert">
          <strong>⚑ The parcel boundary could not be loaded</strong>
          <span>
            This address is outside our zoning coverage, and the State parcel service did not return
            its boundary either. Try another address.
          </span>
        </div>
      );
    }
    return null;
  }

  // On the live path there is no automatic check to report. Say what was and
  // was not established rather than raising an alert about a check that was
  // never available for this municipality.
  if (live) {
    if (!ready && check?.status !== "error") return null;
    if (check?.status === "error") {
      return (
        <div className="zoning-check blocked" role="alert">
          <strong>The NJGIN parcel could not be loaded</strong>
          <span>
            The State parcel service did not return this boundary. Try another address, or enter the lot
            dimensions manually.
          </span>
        </div>
      );
    }
    return (
      <div className="zoning-check live" role="status">
        <strong>Boundary from NJGIN · district selected by hand</strong>
        <span>
          The lot boundary and area come from the State's parcel record. No machine-readable zoning layer is
          loaded for {muni?.name ?? "this municipality"}, so the district above was not verified against the
          parcel — confirm it before relying on the result.
        </span>
      </div>
    );
  }

  if (!check || check.status === "checking" || check.status === "matched") return null;

  const messages = {
    no_layer: `${muni?.name ?? "This municipality"}’s machine-readable zoning polygons have not been loaded. Calculation is disabled rather than assuming a district.`,
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

function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
         strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function NumberField({
  label,
  value,
  onChange,
  help,
  step = "1",
  fieldKey,
  required = false,
  max,
}) {
  // Only surface an error once the field has been touched, so a blank optional
  // (or not-yet-filled required) input doesn't shout on first render.
  const [touched, setTouched] = useState(false);
  const rule = fieldKey ? FIELD_RULES[fieldKey] : null;
  const ruleError = fieldKey ? validateField(fieldKey, value, { required }) : null;
  const maxError =
    value !== "" && value != null && max != null && Number(value) > Number(max)
      ? `${label} cannot exceed ${fmt(Number(max), 1)}.`
      : null;
  const error = ruleError || maxError;
  const showError = touched && Boolean(error);
  return (
    <label className={showError ? "field invalid" : "field"}>
      {label}
      <input
        type="number"
        min={rule?.min ?? 0}
        max={max ?? rule?.max}
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

/**
 * Refuses the calculation when a municipality's district is only partly
 * filled in. Without this, null rules read as zeros and the tool reports the
 * entire lot as buildable — a confident wrong answer is worse than none.
 */
function RulesMissingNotice({ missing, muniName, districtCode }) {
  if (!missing || missing.length === 0) return null;
  return (
    <div className="zoning-check blocked" role="alert">
      <strong>Zoning rules are not loaded for this municipality</strong>
      <span>
        {muniName ?? "This municipality"}
        {districtCode ? ` district ${districtCode}` : ""} is missing its {listPhrase(missing)}.
        Calculation is disabled until those rules are entered — an incomplete
        configuration would report the whole lot as buildable.
      </span>
    </div>
  );
}

/**
 * The district records ADUs as not permitted. That is the answer to the
 * client's question — quoting a price for one would contradict the ordinance
 * on file. A variance is possible, but that is the municipality's call.
 */
function AduNotPermittedNotice({ show, muniName, districtCode }) {
  if (!show) return null;
  return (
    <div className="zoning-check blocked" role="alert">
      <strong>ADUs are not a permitted use in this district</strong>
      <span>
        {muniName ?? "This municipality"}
        {districtCode ? ` district ${districtCode}` : ""} records accessory dwelling units as not
        permitted, so no ADU capacity or cost is calculated. If you believe a variance or a recent
        ordinance change applies, confirm with {muniName ?? "the municipality"} — or choose Addition
        to see what you can add to the existing house.
      </span>
    </div>
  );
}

function listPhrase(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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

/**
 * Between the property form and the full results: show what the lot can hold —
 * footprint, floors, total buildable — and only then ask what the client wants
 * to build, checking it against those maximums as they type.
 */
function CapacityStep({
  project,
  district,
  lot,
  parcel,
  streetEdge,
  result,
  zoningVerified,
  existingStructure,
  plannedFloors,
  floorPositions,
  onExistingStructure,
  onPlannedFloors,
  onFloorPositions,
  onBack,
  onContinue,
}) {
  // Which floor the site plan is editing. Reset whenever the stack shrinks
  // past it, so the selection can never point at a floor that is gone.
  const [selectedFloor, setSelectedFloor] = useState(0);
  useEffect(() => {
    setSelectedFloor((current) => Math.min(current, Math.max(0, plannedFloors.length - 1)));
  }, [plannedFloors.length]);
  // The plan is the working view — it is the one the footprint is set in — so
  // it opens first, with the massing a click away.
  const [plan2d, setPlan2d] = useState(true);
  const hasExistingHouse = project?.id === "addition" || project?.id === "adu";
  const verticalAddition = project?.id === "addition" && result.additionLocation === "above";
  const footprintValue =
    project?.id === "addition" && !verticalAddition && !result.positionMoved
      ? result.placementCapacitySqft ?? result.availableFootprint
      : hasExistingHouse
        ? result.availableFootprint
        : result.footprint;
  const footprintLabel = hasExistingHouse ? "Additional footprint available" : "Maximum building footprint";
  const orientedLot = streetOrientedLotDims(parcel, lot, streetEdge);
  const lotWidthFt = Number(orientedLot.width_ft) > 0 ? Number(orientedLot.width_ft) : null;
  const lotDepthFt = Number(orientedLot.depth_ft) > 0 ? Number(orientedLot.depth_ft) : null;
  const lotDimensionsAvailable = lotWidthFt != null && lotDepthFt != null;
  const rectangularEnvelope = result.envelope;
  let maxHouseWidthFt = lotDimensionsAvailable
    ? Number(rectangularEnvelope?.widthFt) > 0
      ? Math.min(lotWidthFt, Number(rectangularEnvelope.widthFt))
      : lotWidthFt
    : null;
  let maxHouseDepthFt = lotDimensionsAvailable
    ? Number(rectangularEnvelope?.depthFt) > 0
      ? Math.min(lotDepthFt, Number(rectangularEnvelope.depthFt))
      : lotDepthFt
    : null;
  if (lotDimensionsAvailable && verticalAddition && Number(result.existingFootprint) > 0) {
    const roofScale = Math.min(
      1,
      Math.sqrt(Number(result.existingFootprint) / (lotWidthFt * lotDepthFt))
    );
    maxHouseWidthFt = lotWidthFt * roofScale;
    maxHouseDepthFt = lotDepthFt * roofScale;
  }
  // The side-specific caps describe an addition glued to one wall of the
  // house. Once the client drags the building somewhere of their own choosing
  // that is no longer the shape of the constraint — the envelope's own
  // dimensions are, together with the footprint area still available.
  if (!verticalAddition && project?.id === "addition" && !result.positionMoved) {
    if (result.placementMaxWidthFt != null && Number(result.placementMaxWidthFt) >= 0) {
      maxHouseWidthFt = Number(result.placementMaxWidthFt);
    }
    if (result.placementMaxDepthFt != null && Number(result.placementMaxDepthFt) >= 0) {
      maxHouseDepthFt = Number(result.placementMaxDepthFt);
    }
  } else if (lotDimensionsAvailable && !verticalAddition && result.planEnvelope) {
    maxHouseWidthFt = Math.min(
      maxHouseWidthFt,
      result.planEnvelope.x1 - result.planEnvelope.x0
    );
    maxHouseDepthFt = Math.min(
      maxHouseDepthFt,
      result.planEnvelope.y1 - result.planEnvelope.y0
    );
  }
  const footprintCap = Number(result.maxFootprint);
  if (
    lotDimensionsAvailable &&
    footprintCap > 0 &&
    maxHouseWidthFt * maxHouseDepthFt > footprintCap
  ) {
    const scale = Math.sqrt(footprintCap / (maxHouseWidthFt * maxHouseDepthFt));
    maxHouseWidthFt *= scale;
    maxHouseDepthFt *= scale;
  }
  // Round down to the nearest half foot. Rounding either side up could make
  // the default rectangle fractionally larger than the calculated footprint.
  if (lotDimensionsAvailable) {
    maxHouseWidthFt = Math.max(0, Math.floor(maxHouseWidthFt * 2) / 2);
    maxHouseDepthFt = Math.max(0, Math.floor(maxHouseDepthFt * 2) / 2);
  }
  const maxFloors = result.maxFloors ?? null;
  const existingStoryCount =
    verticalAddition
      ? Math.ceil(
          Number(result.existingStories) ||
            (Number(result.existingArea) > 0 && Number(result.existingFootprint) > 0
              ? Number(result.existingArea) / Number(result.existingFootprint)
              : 1)
        )
      : 0;
  const maxPlannedFloors =
    maxFloors == null
      ? 20
      : verticalAddition
        ? Math.max(0, maxFloors - existingStoryCount)
        : maxFloors;

  // Resize the per-floor array while preserving values already typed. New
  // floors copy the floor below, producing an immediate 3D preview while
  // guaranteeing that an upper floor starts inside the lower footprint.
  const setFloorCount = (value) => {
    const count = Math.max(0, Math.min(maxPlannedFloors, Math.floor(Number(value) || 0)));
    const next = plannedFloors.slice(0, count);
    while (next.length < count) {
      const lowerFloor = next[next.length - 1];
      next.push(
        lowerFloor
          ? {
              width_ft: lowerFloor.width_ft,
              depth_ft: lowerFloor.depth_ft,
              height_ft: FLOOR_TO_FLOOR_FT,
            }
          : {
              width_ft: maxHouseWidthFt ?? "",
              depth_ft: maxHouseDepthFt ?? "",
              height_ft: FLOOR_TO_FLOOR_FT,
        }
      );
    }
    // Floor placement is indexed alongside the floor schedule. Dropping the
    // floor count must also drop positions for the removed floors; otherwise a
    // later re-added floor can jump back to a stale location. Keep the active
    // picker on a floor that still exists for the same reason.
    onFloorPositions(floorPositions.slice(0, count));
    setSelectedFloor((current) => Math.max(0, Math.min(current, count - 1)));
    onPlannedFloors(next);
  };
  const setFloorDimension = (index, field, value) => {
    const next = plannedFloors.slice();
    const numeric = value === "" ? "" : Math.max(1, Number(value));
    next[index] = { ...next[index], [field]: numeric };
    onPlannedFloors(next);
  };
  /**
   * Floor size as set by dragging the site plan. No floor may exceed the one
   * below it, so resizing a floor pulls the floors above it down to match
   * rather than leaving them invalid; floors below are left alone.
   */
  const setFootprint = (floorIndex, widthFt, depthFt) => {
    if (!plannedFloors.length) return;
    let width = widthFt;
    let depth = depthFt;
    onPlannedFloors(
      plannedFloors.map((floor, index) => {
        if (index < floorIndex) return floor;
        if (index === floorIndex) return { ...floor, width_ft: widthFt, depth_ft: depthFt };
        width = Math.min(width, Number(floor.width_ft) || width);
        depth = Math.min(depth, Number(floor.depth_ft) || depth);
        return { ...floor, width_ft: width, depth_ft: depth };
      })
    );
  };
  const fillEnvelope = () => {
    if (!lotDimensionsAvailable) return;
    if (!plannedFloors.length) {
      onPlannedFloors([
        { width_ft: maxHouseWidthFt, depth_ft: maxHouseDepthFt, height_ft: FLOOR_TO_FLOOR_FT },
      ]);
      return;
    }
    setFootprint(0, maxHouseWidthFt, maxHouseDepthFt);
  };
  /** Store one floor's placement without disturbing the others. */
  const moveFloor = (floorIndex, x0, y0) => {
    const next = plannedFloors.map((_, index) => floorPositions[index] ?? null);
    next[floorIndex] = x0 == null ? null : { x0, y0 };
    onFloorPositions(next);
  };
  // An upper floor is capped by the floor holding it up, which is the same
  // rule the width/depth number fields enforce.
  const selectedFloorMaxWidthFt =
    Number(plannedFloors[selectedFloor - 1]?.width_ft) || maxHouseWidthFt || null;
  const selectedFloorMaxDepthFt =
    Number(plannedFloors[selectedFloor - 1]?.depth_ft) || maxHouseDepthFt || null;
  const plannedTotal = result.plannedArea;
  const heightCeiling = Number(result.maxHeight) > 0 ? Number(result.maxHeight) : null;
  const heightUsed = result.plannedHeight == null ? null : Number(result.plannedHeight);
  const heightRemaining =
    heightCeiling == null || heightUsed == null ? null : Math.max(0, heightCeiling - heightUsed);
  const heightExceededBy =
    heightCeiling == null || heightUsed == null ? 0 : Math.max(0, heightUsed - heightCeiling);
  // The footprint figure counts down as the plan takes ground: the ceiling is
  // fixed, what the client wants to know is how much of it is still free. When
  // the ceiling itself is zero there is nothing to count down — saying "0 left
  // of 0 permitted" would dress a blocked lot up as arithmetic.
  const footprintUsed =
    Number(footprintValue) > 0 && Number(result.plannedFootprintSoFar) > 0
      ? Number(result.plannedFootprintSoFar)
      : 0;
  const footprintRemaining = Math.max(0, Number(footprintValue || 0) - footprintUsed);
  // The same countdown for total floor area, which is what each added floor
  // spends. Both use the running totals rather than the strict ones, so a
  // half-filled stack still shows what it has taken so far.
  const capacityCeiling = Number(result.maxArea);
  const capacityUsed =
    capacityCeiling > 0 && Number(result.plannedAreaSoFar) > 0
      ? Number(result.plannedAreaSoFar)
      : 0;
  const capacityRemaining = Math.max(0, capacityCeiling - capacityUsed);
  const groundAddition = project?.id === "addition" && !verticalAddition;
  const remainingSetbackArea =
    project?.id !== "addition"
      ? null
      : verticalAddition
        ? result.availableBuildingArea == null || plannedTotal == null
          ? result.availableBuildingArea
          : Math.max(0, result.availableBuildingArea - plannedTotal)
        : Math.max(
            0,
            Number(result.placementCapacitySqft ?? result.availableFootprint ?? 0) -
              Number(result.plannedFootprint || 0)
          );
  const moveExistingStructure = (x0, y0, dx, dy) => {
    onExistingStructure({
      ...existingStructure,
      position: { x0, y0 },
    });
    // A manually positioned ground addition moves with the house. Default
    // positions need no update because they are re-derived from the house.
    if (groundAddition && floorPositions[0] != null) {
      const next = floorPositions.slice();
      next[0] = {
        x0: Number(next[0].x0) + Number(dx || 0),
        y0: Number(next[0].y0) + Number(dy || 0),
      };
      onFloorPositions(next);
    }
  };
  const setDraggedAdditionSide = (side) => {
    if (!groundAddition || !side || side === existingStructure.addition_location) return;
    onExistingStructure({
      ...existingStructure,
      addition_location: side,
    });
  };
  const chooseAdditionLocation = (additionLocation) => {
    onExistingStructure({ ...existingStructure, addition_location: additionLocation });
    // The chosen side is what the default placement means, so a dragged
    // position from the previous side no longer describes anything.
    onFloorPositions([]);
    if (additionLocation !== "above") {
      // A side/front/back choice describes one ground-level volume. Additional
      // stories are only requested through the explicit vertical-addition path.
      onPlannedFloors([
        {
          width_ft: "",
          depth_ft: "",
          height_ft: FLOOR_TO_FLOOR_FT,
        },
      ]);
    }
  };
  // Flag an over-limit floor count as soon as it is entered — before any floor
  // sizes exist — so the user gets the error at the point of the mistake. The
  // engine's count, already capped by the height limit, is the real ceiling.
  const floorsExceeded = plannedFloors.length > maxPlannedFloors;
  useEffect(() => {
    if (plannedFloors.length > maxPlannedFloors) {
      onPlannedFloors(plannedFloors.slice(0, maxPlannedFloors));
    }
  }, [maxPlannedFloors, onPlannedFloors, plannedFloors]);

  return (
    <>
      <section className="results-heading">
        <div>
          <p className="eyebrow">Step 2</p>
          <h2>{zoningVerified ? "What you can build" : "Preliminary building plan"}</h2>
          <p>
            {zoningVerified
              ? `Here is the most this lot can hold under ${district.code}. Enter the size you have in mind to check it.`
              : "Use the matched parcel to sketch the size you have in mind. Zoning allowances and setbacks are not available for this property."}
          </p>
        </div>
        <span className="preliminary-badge">Preliminary</span>
      </section>

      <section className="workspace-grid">
        <div className="card form-card">
          <div className="capacity-figures">
            {!zoningVerified ? (
              <>
                <div>
                  <span>Parcel area</span>
                  <strong>{fmt(result.lotArea)} <em>sq ft</em></strong>
                  <small>Matched from the statewide NJGIN parcel layer.</small>
                </div>
                <div>
                  <span>Building footprint allowance</span>
                  <strong className="answer-pending">Unavailable</strong>
                  <small>A verified zoning district and dimensional rules are required.</small>
                </div>
                <div>
                  <span>Total square-foot allowance</span>
                  <strong className="answer-pending">Unavailable</strong>
                  <small>No buildable allowance is inferred from parcel area alone.</small>
                </div>
              </>
            ) : verticalAddition ? (
              <>
                <div>
                  <span>Existing building footprint</span>
                  <strong>{fmt(result.existingFootprint)} <em>sq ft</em></strong>
                  <small>Maximum roof area available for a vertical addition.</small>
                </div>
                <div>
                  <span>Floor area available</span>
                  <strong>{fmt(result.availableBuildingArea)} <em>sq ft</em></strong>
                  <small>Remaining zoning capacity across the new floor.</small>
                </div>
                <div>
                  <span>Height available</span>
                  <strong>{fmt(result.heightAvailable, 1)} <em>ft estimated</em></strong>
                  <small>District height limit minus the estimated existing height.</small>
                </div>
              </>
            ) : (
              <>
                <div className={footprintUsed > 0 ? "capacity-figure spent" : "capacity-figure"}>
                  <span>{footprintUsed > 0 ? "Building footprint left" : footprintLabel}</span>
                  <strong>{fmt(footprintRemaining)} <em>sq ft</em></strong>
                  <small>
                    {footprintUsed > 0 ? (
                      <>
                        {fmt(footprintValue)} sq ft permitted, {fmt(footprintUsed)} sq ft taken by
                        your ground floor.
                      </>
                    ) : project?.id === "addition" ? (
                      "The ground area available at the selected side after applying setbacks."
                    ) : (
                      "The additional ground area that may be occupied."
                    )}
                  </small>
                </div>
                {maxFloors != null && (
                  <div
                    className={`capacity-figure${result.plannedFloorCount > 0 ? " spent" : ""}${
                      result.fitsHeight === false ? " invalid" : ""
                    }`}
                  >
                    <span>{result.plannedFloorCount > 0 ? "Floors left" : "Maximum floors"}</span>
                    <strong>{Math.max(0, maxFloors - result.plannedFloorCount)}</strong>
                    <small>
                      {result.plannedFloorCount > 0 ? (
                        <>
                          {maxFloors}{" "}
                          {result.heightLimited ? "fit under the height limit" : `permitted in ${district.code}`},{" "}
                          {result.plannedFloorCount} planned.
                        </>
                      ) : result.heightLimited ? (
                        `What the ${fmt(district.max_height_ft)} ft height limit fits in ${district.code}.`
                      ) : (
                        `Stories permitted in ${district.code}.`
                      )}
                      {heightCeiling != null && heightUsed != null && (
                        <>
                          {" "}
                          {heightExceededBy > 0
                            ? `The planned height exceeds the ${fmt(heightCeiling, 1)} ft limit by ${fmt(heightExceededBy, 1)} ft.`
                            : `${fmt(heightUsed, 1)} of ${fmt(heightCeiling, 1)} ft used; ${fmt(heightRemaining, 1)} ft left.`}
                        </>
                      )}
                    </small>
                  </div>
                )}
                <div className={capacityUsed > 0 ? "capacity-figure spent" : "capacity-figure"}>
                  <span>Total floor-area allowance left</span>
                  {result.maxArea == null ? (
                    <strong className="answer-pending">Enter existing floor area</strong>
                  ) : (
                    <strong>{fmt(capacityRemaining)} <em>sq ft</em></strong>
                  )}
                  <small>
                    {result.maxArea == null ? (
                      "Enter the existing floor area to calculate the total allowance."
                    ) : capacityUsed > 0 ? (
                      <>
                        {fmt(capacityCeiling)} sq ft total allowance − {fmt(capacityUsed)} sq ft
                        planned = {fmt(capacityRemaining)} sq ft left.
                      </>
                    ) : (
                      <>{fmt(capacityCeiling)} sq ft total allowance available to build.</>
                    )}
                  </small>
                </div>
              </>
            )}
          </div>

          <div className="lot-dimension-status" role="status">
            <div>
              <span>Frontage:</span>
              <strong>{lotWidthFt == null ? "Not available" : `${fmt(lotWidthFt, 1)} ft`}</strong>
            </div>
            <div>
              <span>Depth:</span>
              <strong>{lotDepthFt == null ? "Not available" : `${fmt(lotDepthFt, 1)} ft`}</strong>
            </div>
            <small>
              {orientedLot.source === "land_desc"
                ? "Parsed from the parcel’s LAND_DESC record."
                : orientedLot.source === "imported_mod_iv"
                  ? "Loaded from the imported MOD-IV parcel record."
                  : "No recorded frontage or depth was found for this parcel."}
            </small>
          </div>

          <div className="planned-size">
            <div className="method-title">
              <div>
                <h3>{plannedSizeLabel(project?.id)}</h3>
              </div>
            </div>
            {project?.id === "addition" && (
              <label className="addition-location-select">
                <span>Where will the addition be located?</span>
                <select
                  value={existingStructure.addition_location}
                  onChange={(event) => chooseAdditionLocation(event.target.value)}
                >
                  <option value="side_left">Side — left</option>
                  <option value="side_right">Side — right</option>
                  <option value="front">Front addition</option>
                  <option value="back">Back addition</option>
                  <option value="above">Above the existing house — new floor</option>
                </select>
                <small>Click to choose where the new construction will be placed.</small>
              </label>
            )}
            {(!groundAddition || project?.id !== "addition") && (
              <div className="form-grid">
                <label className={floorsExceeded ? "field invalid" : "field"}>
                  {project?.id === "addition" ? "Number of new floors to add" : "Number of floors you plan"}
                  <input
                    type="number"
                    min="0"
                    max={maxPlannedFloors}
                    step="1"
                    value={plannedFloors.length || ""}
                    onChange={(e) => setFloorCount(e.target.value)}
                    aria-invalid={floorsExceeded || undefined}
                  />
                  {floorsExceeded ? (
                    <small className="field-error">
                      {verticalAddition
                        ? `${district.code} allows ${maxFloors} total stories. With ${existingStoryCount} existing, only ${maxPlannedFloors} additional ${maxPlannedFloors === 1 ? "floor is" : "floors are"} available.`
                        : `${district.code} allows a maximum of ${maxFloors} floors.`}
                    </small>
                  ) : (
                    <small>
                      Adds width, depth, and height fields for each floor.
                      {maxFloors != null
                        ? verticalAddition
                          ? ` Up to ${maxPlannedFloors} additional ${maxPlannedFloors === 1 ? "floor" : "floors"} allowed (${maxFloors} total minus ${existingStoryCount} existing).`
                          : ` Up to ${maxFloors} allowed here.`
                        : ""}
                    </small>
                  )}
                </label>
              </div>
            )}
            {plannedFloors.length > 0 && (
              <>
                <div className="floor-fields">
                  {plannedFloors.map((floor, index) => {
                    const displayFloorNumber =
                      verticalAddition ? existingStoryCount + index + 1 : index + 1;
                    const widthMax =
                      index === 0
                        ? maxHouseWidthFt
                        : Number(plannedFloors[index - 1]?.width_ft) || maxHouseWidthFt || null;
                    const depthMax =
                      index === 0
                        ? maxHouseDepthFt
                        : Number(plannedFloors[index - 1]?.depth_ft) || maxHouseDepthFt || null;
                    const floorArea =
                      Number(floor?.width_ft) > 0 && Number(floor?.depth_ft) > 0
                        ? Number(floor.width_ft) * Number(floor.depth_ft)
                        : null;
                    const otherFloorHeight = plannedFloors.reduce((sum, item, itemIndex) => {
                      if (itemIndex === index) return sum;
                      const itemHeight = Number(item?.height_ft);
                      return itemHeight > 0 ? sum + itemHeight : sum;
                    }, 0);
                    const heightMax =
                      heightCeiling == null
                        ? FIELD_RULES.planned_floor_height.max
                        : Math.max(0, heightCeiling - otherFloorHeight);
                    const floorValid =
                      floorArea != null &&
                      (widthMax == null || Number(floor.width_ft) <= Number(widthMax)) &&
                      (depthMax == null || Number(floor.depth_ft) <= Number(depthMax)) &&
                      Number(floor.height_ft) > 0 &&
                      Number(floor.height_ft) <= heightMax &&
                      result.fitsHeight !== false &&
                      (verticalAddition || result.fitsEnvelope !== false) &&
                      (!groundAddition || result.fitsAttachment !== false) &&
                      (project?.id !== "adu" || result.fitsSeparation !== false);
                    const displayFloorLabel =
                      groundAddition && index === 0
                        ? "New ground-floor addition"
                        : groundAddition
                          ? `Addition floor ${index + 1}`
                          : `Floor ${displayFloorNumber}`;
                    return (
                      <fieldset className="floor-row" key={index}>
                        <legend className="sr-only">{displayFloorLabel}</legend>
                        <div className="floor-row-id" aria-hidden="true">
                          <span className="floor-row-num">{displayFloorNumber}</span>
                          <span className="floor-row-label">{displayFloorLabel}</span>
                        </div>
                        <div className="floor-row-fields">
                          <NumberField
                            label="Width (ft)"
                            value={floor?.width_ft ?? ""}
                            onChange={(value) => setFloorDimension(index, "width_ft", value)}
                            fieldKey="planned_floor_dimension"
                            max={widthMax ?? undefined}
                            step="0.5"
                            help={
                              index > 0
                                ? widthMax == null
                                  ? "The floor below has no width yet."
                                  : `Maximum ${fmt(widthMax, 1)} ft — cannot exceed the floor below.`
                                : zoningVerified
                                  ? widthMax == null
                                    ? "Frontage: Not available. Enter the planned width manually."
                                    : `Maximum ${fmt(widthMax, 1)} ft.`
                                  : widthMax == null
                                    ? "Frontage: Not available. Enter the planned width manually."
                                    : "Zoning setbacks are not applied."
                            }
                          />
                          <NumberField
                            label="Depth (ft)"
                            value={floor?.depth_ft ?? ""}
                            onChange={(value) => setFloorDimension(index, "depth_ft", value)}
                            fieldKey="planned_floor_dimension"
                            max={depthMax ?? undefined}
                            step="0.5"
                            help={
                              index > 0
                                ? depthMax == null
                                  ? "The floor below has no depth yet."
                                  : `Maximum ${fmt(depthMax, 1)} ft — cannot exceed the floor below.`
                                : zoningVerified
                                  ? depthMax == null
                                    ? "Depth: Not available. Enter the planned depth manually."
                                    : `Maximum ${fmt(depthMax, 1)} ft.`
                                  : depthMax == null
                                    ? "Depth: Not available. Enter the planned depth manually."
                                    : "Zoning setbacks are not applied."
                            }
                          />
                          <NumberField
                            label={
                              project?.id === "addition"
                                ? "Addition wall/level height (ft)"
                                : "Height (ft)"
                            }
                            value={floor?.height_ft ?? ""}
                            onChange={(value) => setFloorDimension(index, "height_ft", value)}
                            fieldKey="planned_floor_height"
                            max={heightMax}
                            step="0.5"
                            help={
                              zoningVerified
                                ? heightCeiling == null
                                  ? `Default ${FLOOR_TO_FLOOR_FT} ft · no district height limit is loaded.`
                                  : `Maximum ${fmt(heightMax, 1)} ft for this floor · combined height checked against the ${fmt(heightCeiling, 1)} ft zoning limit.`
                                : `Default ${FLOOR_TO_FLOOR_FT} ft · zoning height is not checked.`
                            }
                          />
                          {/* The maxima are not arbitrary: floor 1 is capped by
                              zoning, every floor above by the one beneath it. */}
                          <span
                            className="floor-row-lock"
                            title={
                              index === 0
                                ? zoningVerified
                                  ? lotDimensionsAvailable
                                    ? `Limited by ${district.code} zoning: ${fmt(widthMax, 1)} × ${fmt(depthMax, 1)} ft.`
                                    : "Recorded frontage and depth are not available."
                                  : lotDimensionsAvailable
                                    ? `Limited to the parcel workspace: ${fmt(widthMax, 1)} × ${fmt(depthMax, 1)} ft. Zoning setbacks are not applied.`
                                    : "Recorded frontage and depth are not available."
                                : "Cannot exceed the floor below."
                            }
                            aria-hidden="true"
                          >
                            <LockGlyph />
                          </span>
                        </div>
                        <div
                          className={
                            floorArea == null
                              ? "floor-row-area"
                              : floorValid
                                ? "floor-row-area done"
                                : "floor-row-area invalid"
                          }
                        >
                          <span>Floor area</span>
                          <strong>
                            {floorArea == null ? "—" : fmt(floorArea)}
                            {floorArea != null && <em> sq ft</em>}
                          </strong>
                          <span className="floor-row-status" aria-hidden="true">
                            {floorArea == null ? "" : floorValid ? "✓" : "!"}
                          </span>
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
                <p className="planned-total">
                  Planned total: <strong>{plannedTotal == null ? "—" : `${fmt(plannedTotal)} sq ft`}</strong>
                  {result.plannedFootprint != null && (
                    <> · largest floor {fmt(result.plannedFootprint)} sq ft</>
                  )}
                  {result.plannedHeight != null && <> · height {fmt(result.plannedHeight, 1)} ft</>}
                </p>
                {zoningVerified && heightCeiling != null && heightUsed != null && (
                  <p
                    className={`remaining-buildable-area height-allowance${
                      result.fitsHeight === false ? " invalid" : ""
                    }`}
                    role={result.fitsHeight === false ? "alert" : "status"}
                  >
                    <span>Height allowance left</span>
                    <strong>
                      {heightExceededBy > 0
                        ? `${fmt(heightExceededBy, 1)} ft over`
                        : `${fmt(heightRemaining, 1)} ft`}
                    </strong>
                  </p>
                )}
                {zoningVerified && project?.id === "addition" && (
                  <p className="remaining-buildable-area" role="status">
                    <span>
                      {verticalAddition
                        ? "Remaining floor area allowed"
                        : "Remaining ground footprint within setback rules"}
                    </span>
                    <strong>{remainingSetbackArea == null ? "—" : fmt(remainingSetbackArea)} sq ft</strong>
                  </p>
                )}
              </>
            )}
          </div>

          <div className="actions">
            <button type="button" className="secondary" onClick={onBack}>← Back</button>
            {onContinue ? (
              <button type="button" className="primary" onClick={onContinue}>
                See cost &amp; zoning check <span aria-hidden="true">→</span>
              </button>
            ) : (
              <span className="form-hint">
                Cost and zoning results require verified Marco zoning rules.
              </span>
            )}
          </div>
        </div>

        <aside className="card preview-card">
          <div className="preview-head">
            <div>
              <p className="eyebrow">{plan2d ? "2D site plan" : "3D property preview"}</p>
              <h2>{parcel?.address ?? "Planned building"}</h2>
            </div>
            {/* The plan comes first: it is where the footprint is set. The
                massing is the same building seen from the side. */}
            <div className="preview-toggle" role="group" aria-label="Preview mode">
              <button
                type="button"
                className={plan2d ? "active" : ""}
                aria-pressed={plan2d}
                onClick={() => setPlan2d(true)}
                disabled={!lotDimensionsAvailable}
              >
                Plan
              </button>
              <button
                type="button"
                className={plan2d ? "" : "active"}
                aria-pressed={!plan2d}
                onClick={() => setPlan2d(false)}
                disabled={!lotDimensionsAvailable}
              >
                3D
              </button>
            </div>
          </div>
          <p className="preview-note">
            {!lotDimensionsAvailable
              ? "The parcel was matched, but its recorded frontage and depth are not available."
              : plan2d
              ? zoningVerified
                ? "Drag each floor to place it and its handles to size it. Dimensions are preliminary and are not a survey."
                : "Drag each floor to place it and its handles to size it inside the parcel. Zoning setbacks are not applied."
              : "Drag to orbit and use the mouse wheel to zoom. Dimensions are preliminary and are not a survey."}
          </p>
          {!lotDimensionsAvailable ? (
            <div className="preview-placeholder lot-dimensions-unavailable" role="status">
              <strong>Lot dimensions not available</strong>
              <span>Frontage: Not available</span>
              <span>Depth: Not available</span>
              <small>The initial 25 × 100 ft starter lot is not used for selected parcels.</small>
            </div>
          ) : plan2d ? (
            <SitePlan2D
              lotWidthFt={lotWidthFt}
              lotDepthFt={lotDepthFt}
              zoningVerified={zoningVerified}
              setbacks={{
                front: district.front_yard_min_ft,
                side:
                  district.side_yard_total_min_ft != null
                    ? district.side_yard_total_min_ft / 2
                    : district.side_yard_one_min_ft,
                rear: district.rear_yard_min_ft,
              }}
              existingBuilding={
                hasExistingHouse
                  ? {
                      footprintSqft: result.existingFootprint,
                      location: result.existingLocation,
                      position: result.existingPosition,
                      additionLocation: result.additionLocation,
                    }
                  : null
              }
              placementMode={
                project?.id === "adu"
                  ? "adu"
                  : groundAddition
                    ? "addition"
                    : "free"
              }
              floors={result.plannedDimensions ?? []}
              maxWidthFt={selectedFloor === 0 ? maxHouseWidthFt : selectedFloorMaxWidthFt}
              maxDepthFt={selectedFloor === 0 ? maxHouseDepthFt : selectedFloorMaxDepthFt}
              positions={floorPositions}
              selectedFloor={selectedFloor}
              streetName={streetNameFor(parcel, streetEdge)}
              proposedLabel={
                project?.id === "adu"
                  ? "Proposed ADU"
                  : groundAddition
                    ? "Proposed addition"
                    : "Proposed building"
              }
              onSelectFloor={setSelectedFloor}
              onResize={setFootprint}
              onMove={moveFloor}
              onExistingMove={moveExistingStructure}
              onAdditionSideChange={setDraggedAdditionSide}
              onResetPosition={(index) => moveFloor(index, null)}
              onFillEnvelope={fillEnvelope}
            />
          ) : (
          <BuildingPreview3D
            lotWidthFt={lotWidthFt}
            lotDepthFt={lotDepthFt}
            floors={result.plannedDimensions ?? []}
            plannedOriginsFt={result.floorRects}
            defaultFloorHeightFt={FLOOR_TO_FLOOR_FT}
            northAngleDeg={streetEdge?.northAngleDeg ?? northAngleFromParcel(parcel?.parcel_geojson_wgs84)}
            streetName={streetNameFor(parcel, streetEdge)}
            parcelGeojson={parcel?.parcel_geojson_wgs84}
            existingBuilding={
              hasExistingHouse
                ? {
                    footprintSqft: result.existingFootprint,
                    stories: result.existingStories,
                    totalAreaSqft: result.existingArea,
                    location: result.existingLocation,
                    position: result.existingPosition,
                    additionLocation: result.additionLocation,
                    placementMode:
                      project?.id === "adu"
                        ? "adu"
                        : result.additionLocation === "above"
                          ? "vertical"
                          : "addition",
                  }
                : null
            }
            setbacks={{
              front: district.front_yard_min_ft,
              side:
                district.side_yard_total_min_ft != null
                  ? district.side_yard_total_min_ft / 2
                  : district.side_yard_one_min_ft,
              rear: district.rear_yard_min_ft,
            }}
          />
          )}
          {!zoningVerified && (
            <div className="preview-zoning-flag-row">
              <button
                type="button"
                className="preview-zoning-flag"
                aria-label="Zoning district not verified"
              >
                <span aria-hidden="true">⚑</span>
                <span className="preview-zoning-tooltip" role="tooltip">
                  Zoning district not verified
                </span>
              </button>
            </div>
          )}
        </aside>
      </section>
    </>
  );
}

function Results({ project, muni, district, lot, parcelSource, parcel, streetEdge, result, costModel, selectedTier, onSelectTier, adu, onBack, onContinue }) {
  const orientedLot = streetOrientedLotDims(parcel, lot, streetEdge);
  const lotWidthFt = orientedLot.width_ft;
  const lotDepthFt = orientedLot.depth_ft;
  const lotDimensionsAvailable = Number(lotWidthFt) > 0 && Number(lotDepthFt) > 0;

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

      {/* Two panels, matching step 2: the choice on the left, what the choice
          applies to on the right. Prices are deliberately absent here — the
          level is picked on what it is, and the figures follow in the report. */}
      <section className="workspace-grid">
        <BuildLevelPicker
          costModel={costModel}
          selectedTier={selectedTier}
          onSelectTier={onSelectTier}
        />
        <div className="card result-card">
          <section className="result-3d-preview" aria-label="3D property preview">
            <p className="eyebrow">3D property preview</p>
            <h3>{parcel?.address ?? `${muni.name}, ${muni.state_code}`}</h3>
            <p className="preview-note">
              Drag to orbit and use the mouse wheel to zoom. Dimensions are preliminary and are not a survey.
            </p>
            {lotDimensionsAvailable ? (
              <BuildingPreview3D
              lotWidthFt={lotWidthFt}
              lotDepthFt={lotDepthFt}
              floors={result.plannedDimensions ?? []}
              plannedOriginsFt={result.floorRects}
              defaultFloorHeightFt={FLOOR_TO_FLOOR_FT}
              lotAreaSqft={result.lotArea}
              northAngleDeg={streetEdge?.northAngleDeg ?? northAngleFromParcel(parcel?.parcel_geojson_wgs84)}
              streetName={streetNameFor(parcel, streetEdge)}
              parcelGeojson={parcel?.parcel_geojson_wgs84}
              existingBuilding={
                project?.id === "addition" || project?.id === "adu"
                  ? {
                      footprintSqft: result.existingFootprint,
                      stories: result.existingStories,
                      totalAreaSqft: result.existingArea,
                      location: result.existingLocation,
                      position: result.existingPosition,
                      additionLocation: result.additionLocation,
                      placementMode:
                        project?.id === "adu"
                          ? "adu"
                          : result.additionLocation === "above"
                            ? "vertical"
                            : "addition",
                    }
                  : null
              }
              setbacks={{
                front: district.front_yard_min_ft,
                // What the envelope actually insets per side: the combined
                // requirement halved, or the per-side minimum when that is all
                // the ordinance gives. Mirrors rectEnvelope in lib/envelope.js.
                side:
                  district.side_yard_total_min_ft != null
                    ? district.side_yard_total_min_ft / 2
                    : district.side_yard_one_min_ft,
                rear: district.rear_yard_min_ft,
              }}
              />
            ) : (
              <div className="preview-placeholder lot-dimensions-unavailable" role="status">
                <strong>Lot dimensions not available</strong>
                <span>Frontage: Not available</span>
                <span>Depth: Not available</span>
              </div>
            )}
          </section>
          {project?.id === "adu" && (
            <div className="adu-result-note">
              {result.aduSizeCapped ? (
                <>
                  Capped at district {district.code}’s {fmt(result.aduMaxSizeSqft)} sq ft ADU size
                  limit — the lot itself could take{" "}
                  {fmt(result.availableBuildingArea)} sq ft.
                </>
              ) : (
                <>This is the property’s remaining zoning capacity—not confirmation that an ADU of this size is permitted.</>
              )}
              {adu?.known && adu.allowed && (
                <span className="adu-conditions">
                  {adu.detachedAllowed === false && " A detached ADU is not permitted here."}
                  {adu.detachedAllowed === true && " Detached ADUs are permitted."}
                  {adu.parkingRequired === true && " Off-street parking is required."}
                </span>
              )}
            </div>
          )}
        </div>
      </section>

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
function AnswerSummary({ project, muni, parcel, parcelSource, district, result, costModel }) {
  const rates = TIER_ORDER.map((tier) => tierRate(costModel, tier)).filter((value) => value != null);
  const { maxArea, plannedArea, fitsPlan } = result;
  const costArea = result.estimateArea; // planned size when given, else the max
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
          {maxArea == null ? (
            <strong className="answer-pending">Needs one more input</strong>
          ) : (
            <strong>
              {fmt(maxArea)} <em>sq ft</em>
            </strong>
          )}
        </div>
        {plannedArea != null && (
          <div>
            <span>Your planned size{fitsPlan == null ? "" : fitsPlan ? " · fits" : " · exceeds max"}</span>
            <strong>
              {fmt(plannedArea)} <em>sq ft</em>
            </strong>
          </div>
        )}
        <div>
          <span>Preliminary cost{plannedArea != null ? " for your plan" : ""}, Essential to Premium</span>
          {costArea == null || low == null ? (
            <strong className="answer-pending">—</strong>
          ) : (
            <strong>
              ${fmt(costArea * low)} – ${fmt(costArea * high)}
            </strong>
          )}
        </div>
      </div>

      <ul className="answer-caveats">
        <li>
          Based on public NJGIN parcel data, which the State states is not survey data and does not
          represent legal boundaries.{" "}
          A survey is required to confirm.
        </li>
        {parcelSource === "njgin" && (
          <li>
            The boundary was read live from the State's parcel service, but district {district?.code} was selected
            by hand, not matched to this parcel by geometry. If the district is wrong, every figure above is wrong.
          </li>
        )}
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
/**
 * Plain-language review of the lot against the district's loaded rules. Only
 * checks backed by fields that actually exist in the district record are
 * reported — an absent limit is silence, never a pass.
 */
function zoningFindings({ result, district, lot, projectType, muni }) {
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

  // Lot area, width, and depth minimums are not checked here. ComplianceNotes
  // reports them from lotViolations(), which covers the parcel path as well as
  // manual entry — repeating them would read as two separate problems.

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

function ZoningCheck({ result, district, lot, projectType, muni }) {
  const findings = zoningFindings({ result, district, lot, projectType, muni });
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
            Setbacks, coverage, story count, height, and floor-area ratio are all satisfied by the figures above;
            lot minimums are reported with the property details. This covers the loaded zoning rules only — not
            permitted uses, overlay or historic districts, flood zones, easements, or deed restrictions.
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

/**
 * Plain-language compliance flags: dimensional non-conformities against the
 * district minimums, and the height limit when it governs instead of the
 * permitted story count.
 */
function ComplianceNotes({ district, lot, parcel, result, muniName }) {
  const recorded = parcel ? recordedRectDims(parcel) : null;
  const measured = parcel
    ? {
        areaSqft: Number(parcel.lot_area_sqft) || null,
        widthFt: Number(recorded?.width_ft) || null,
        depthFt: Number(recorded?.depth_ft) || null,
      }
    : { areaSqft: Number(lot.area_sqft) || null, widthFt: Number(lot.width_ft) || null, depthFt: Number(lot.depth_ft) || null };
  const violations = lotViolations(district, measured);

  if (violations.length === 0 && !result.heightLimited) return null;

  return (
    <div className="compliance-notes">
      {violations.length > 0 && (
        <div className="compliance-flag" role="note">
          <strong>Non-conforming lot — {violations.length === 1 ? "1 minimum not met" : `${violations.length} minimums not met`}</strong>
          <ul>
            {violations.map((v) => (
              <li key={v.label}>
                {v.label} is {fmt(v.value)} {v.unit}; district {district.code} requires at least{" "}
                {fmt(v.min)} {v.unit}.
              </li>
            ))}
          </ul>
          <span>
            Undersized lots of record can often still be built on, but the allowance is{" "}
            {muniName}’s determination — confirm before relying on these figures.
          </span>
        </div>
      )}
      {result.heightLimited && (
        <p className="fine">
          The {fmt(district.max_height_ft)} ft height limit governs: it fits about{" "}
          {result.storiesByHeight} floor{result.storiesByHeight === 1 ? "" : "s"} at{" "}
          {FLOOR_TO_FLOOR_FT} ft floor-to-floor, fewer than the {result.permittedStories} stories
          the district permits. Figures use {result.stories}.
        </p>
      )}
    </div>
  );
}

function projectResultTitle(projectType) {
  if (projectType === "addition") return "Remaining addition capacity";
  if (projectType === "adu") return "Potential ADU capacity";
  return "Maximum new house capacity";
}

function plannedSizeLabel(projectType) {
  if (projectType === "addition") return "Planned addition size";
  if (projectType === "adu") return "Planned ADU size";
  return "Planned house size";
}

/**
 * Reference context for the calculation above: what this property is, and the
 * district limits the four steps were driven by. Deliberately does not repeat
 * the derived figures — those belong to the step chain.
 */
function PropertyTable({ parcel, result, district, projectType }) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  const recordedDimensions = parcel ? recordedRectDims(parcel) : null;
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
            <tr>
              <td>Frontage</td>
              <td>
                {recordedDimensions
                  ? `${fmt(recordedDimensions.width_ft, 1)} ft`
                  : "Not available"}
              </td>
            </tr>
            <tr>
              <td>Depth</td>
              <td>
                {recordedDimensions
                  ? `${fmt(recordedDimensions.depth_ft, 1)} ft`
                  : "Not available"}
              </td>
            </tr>
          </>
        )}
        <tr><td>Lot area</td><td>{fmt(result.lotArea)} sq ft</td></tr>
        <tr><td>Zoning district</td><td>{district.code}{district.name ? ` — ${district.name}` : ""}</td></tr>
        {district.min_lot_area_sqft != null && (
          <tr><td>Minimum lot area</td><td>{fmt(district.min_lot_area_sqft)} sq ft</td></tr>
        )}
        {/* Setbacks drive the envelope but were the one input the table never
            named, so the reader could not check the first step of the
            calculation against the ordinance. */}
        <tr>
          <td>Front setback</td>
          <td>
            {district.front_yard_min_ft != null ? `${fmt(district.front_yard_min_ft)} ft` : "Not specified"}
            {district.front_yard_prevailing_rule && (
              <span className="table-note"> (or the prevailing block average)</span>
            )}
          </td>
        </tr>
        <tr>
          <td>Side setback</td>
          <td>
            {district.side_yard_total_min_ft != null
              ? `${fmt(district.side_yard_total_min_ft)} ft combined`
              : district.side_yard_one_min_ft != null
                ? `${fmt(district.side_yard_one_min_ft)} ft each`
                : "Not specified"}
            {district.side_yard_total_min_ft != null && district.side_yard_one_min_ft != null && (
              <span className="table-note"> · {fmt(district.side_yard_one_min_ft)} ft minimum one side</span>
            )}
          </td>
        </tr>
        <tr>
          <td>Rear setback</td>
          <td>{district.rear_yard_min_ft != null ? `${fmt(district.rear_yard_min_ft)} ft` : "Not specified"}</td>
        </tr>
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
        <tr>
          <td>
            Approx. envelope
            {result.approximation && <span className="table-note"> (recorded lot rectangle)</span>}
          </td>
          <td>{fmt(envelopeAreaOf(result))} sq ft</td>
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

/**
 * Step 3's left panel: pick a build level on what it is, not what it costs.
 *
 * Prices are deliberately withheld here so the choice is made on scope and
 * finish — the figures follow in the report, against the level chosen. The
 * inclusion list is shared across levels: it describes what a per-square-foot
 * price covers at any level, which is exactly the boundary a client needs
 * before comparing them.
 */
function BuildLevelPicker({ costModel, selectedTier, onSelectTier }) {
  const scope = costModel?.cost_scope;
  return (
    <div className="card form-card build-level-picker">
      <div className="section-heading">
        <span className="section-icon" aria-hidden="true">$</span>
        <div>
          {/* No step eyebrow: the page heading above already says Step 3. */}
          <h2>Choose your build level</h2>
          <p>Pick the level of finish you have in mind. Costs follow in your report.</p>
        </div>
      </div>

      <div className="level-options" role="radiogroup" aria-label="Build level">
        {PACKAGES.map((pkg) => {
          const tier = costModel?.build_cost_tiers?.find((item) => item.tier === pkg.id);
          const selected = pkg.id === selectedTier;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? "level-option selected" : "level-option"}
              onClick={() => onSelectTier?.(pkg.id)}
              key={pkg.id}
            >
              <span className="level-option-head">
                <span className="tier-mark" aria-hidden="true" />
                <strong>{pkg.label}</strong>
              </span>
              <span className="level-option-desc">{pkg.description}</span>
              {tier?.notes && <span className="level-option-notes">{tier.notes}</span>}
            </button>
          );
        })}
      </div>

      {scope?.includes?.length > 0 && (
        <div className="level-includes">
          <strong>What every level includes</strong>
          <ul>
            {scope.includes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {scope?.excludes?.length > 0 && (
        <div className="level-includes">
          <strong>Billed separately</strong>
          <ul>
            {scope.excludes.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {scope.contingency_pct && (
              <li>
                A contingency reserve — {scope.contingency_pct.min}–{scope.contingency_pct.max}%
                recommended
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function CostCard({ result, costModel, projectType, selectedTier, onSelectTier }) {
  const hasExistingHouse = projectType === "addition" || projectType === "adu";
  const usingPlanned = result.plannedArea != null;
  const maxLabel = projectType === "adu" ? "potential ADU capacity" : hasExistingHouse ? "remaining addition capacity" : "total allowable area";
  const basisLabel = usingPlanned ? "your planned size" : `the ${maxLabel}`;
  const verified = costModel?.provenance === "verified";
  return (
    <div className="card result-card">
      <h3>
        Preliminary build cost
        {costModel && (
          <span className={`provenance-flag ${costModel.provenance}`}>
            {verified ? "✓ Verified Price" : "✕ Estimated"}
          </span>
        )}
      </h3>
      <p className="card-intro">
        Planning ranges based on {basisLabel}
        {result.estimateArea != null ? ` (${fmt(result.estimateArea)} sq ft)` : ""}, not a contractor quote. All
        three levels are shown so the spread is visible — the finishes, not the floor area, are what move the number.
      </p>
      {!costModel && <p className="fine">No rate card is loaded for this municipality yet.</p>}
      {costModel &&
        (verified ? (
          <div className="provenance-note verified" role="note">
            <strong>✓ Verified Price</strong>
            <span>Based on Marco Designs’ real figures from homes built in this area.</span>
          </div>
        ) : (
          <div className="provenance-note estimated" role="alert">
            <strong>✕ Rough estimate</strong>
            <span>
              This is a projection based on regional cost variables — not local build history. Actual
              costs may include expenses not accounted for here.
            </span>
          </div>
        ))}
      {costModel && hasExistingHouse && result.estimateArea == null && (
        <div className="cost-unavailable">
          Enter the existing number of stories or total square feet to estimate remaining floor area and construction cost.
        </div>
      )}
      {costModel && result.estimateArea != null && (
        <>
        <div className="cost-tiers" role="radiogroup" aria-label="Build level">
          {TIER_ORDER.map((tierName) => {
            const tier = costModel.build_cost_tiers.find((item) => item.tier === tierName);
            if (!tier) return null;
            const hasRange = tier.rate_per_sqft_max != null;
            const selected = tierName === selectedTier;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? "cost-tier selected" : "cost-tier"}
                onClick={() => onSelectTier?.(tierName)}
                key={tierName}
              >
                <div className="cost-tier-head">
                  <div>
                    <strong>
                      <span className="tier-mark" aria-hidden="true" />
                      {TIER_LABELS[tierName]}
                    </strong>
                    <span className="tier-desc">{TIER_DESCRIPTIONS[tierName]}</span>
                    <span className="tier-rate">
                      {hasRange
                        ? `$${fmt(tier.rate_per_sqft, 2)}–$${fmt(tier.rate_per_sqft_max, 2)} / sq ft`
                        : `$${fmt(tier.rate_per_sqft, 2)} / sq ft`}
                    </span>
                  </div>
                  <b>
                    {hasRange
                      ? `$${fmt(result.estimateArea * tier.rate_per_sqft)} – $${fmt(result.estimateArea * tier.rate_per_sqft_max)}`
                      : `$${fmt(result.estimateArea * tier.rate_per_sqft)}`}
                  </b>
                </div>
                {tier.notes && <p className="tier-notes">{tier.notes}</p>}
              </button>
            );
          })}
        </div>
        <p className="tier-hint">
          Select a build level to carry it through to your report.
        </p>
        </>
      )}
      {costModel?.provenance === "estimated" && result.estimateArea != null && (
        <p className="fine">
          Based on a ${fmt(costModel.regional_baseline_per_sqft, 2)}/sq ft regional baseline × {costModel.local_cost_factor} local factor.
        </p>
      )}
      <CostScope scope={costModel?.cost_scope} estimateArea={result.estimateArea} costModel={costModel} selectedTier={selectedTier} />
    </div>
  );
}

/**
 * The boundary around the number. A per-square-foot price covers the house
 * itself; land, site work, design, permits and a contingency reserve are all
 * separate. Without this the total reads as the whole project cost, which is
 * the exact surprise the estimate exists to prevent.
 */
function CostScope({ scope, estimateArea, costModel, selectedTier }) {
  if (!scope) return null;
  const includes = scope.includes ?? [];
  const excludes = scope.excludes ?? [];
  const pct = scope.contingency_pct;

  // Contingency is a share of construction cost, so it follows the build
  // level the client selected.
  const chosen = costModel?.build_cost_tiers?.find((t) => t.tier === selectedTier);
  const base = chosen && estimateArea != null ? estimateArea * Number(chosen.rate_per_sqft) : null;

  return (
    <div className="cost-scope">
      <div className="cost-scope-cols">
        <div>
          <strong>What this price includes</strong>
          <ul>{includes.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
        <div>
          <strong>Billed separately</strong>
          <ul>
            {excludes.map((item) => <li key={item}>{item}</li>)}
            {pct && (
              <li>
                A contingency reserve — {pct.min}–{pct.max}% recommended
                {base != null && ` (about $${fmt((base * pct.min) / 100)}–$${fmt((base * pct.max) / 100)})`}
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * Print-friendly site drawing for the review/export report. It uses the same
 * lot axes, setback envelope, floor dimensions, and saved floor origins as the
 * Step 2 editor, so the exported drawing is a static record of what the client
 * actually planned rather than a second approximation.
 */
function ReviewSiteDrawing({
  project,
  district,
  lot,
  parcel,
  streetEdge,
  result,
  floors,
  existingStoryCount,
}) {
  const orientedLot = streetOrientedLotDims(parcel, lot, streetEdge);
  const lotWidth = Number(orientedLot.width_ft);
  const lotDepth = Number(orientedLot.depth_ft);
  if (!(lotWidth > 0) || !(lotDepth > 0)) {
    return (
      <figure className="review-site-plan">
        <div className="review-plan-title">
          <div>
            <h4>Lot and planned floor placement</h4>
            <p>Recorded lot dimensions are unavailable; no default dimensions were used.</p>
          </div>
        </div>
        <div className="preview-placeholder lot-dimensions-unavailable" role="status">
          <strong>Lot dimensions not available</strong>
          <span>Frontage: Not available</span>
          <span>Depth: Not available</span>
        </div>
      </figure>
    );
  }
  const sideSetback =
    district.side_yard_total_min_ft != null
      ? Number(district.side_yard_total_min_ft) / 2
      : Number(district.side_yard_one_min_ft) || 0;
  const setbacks = {
    front: Number(district.front_yard_min_ft) || 0,
    rear: Number(district.rear_yard_min_ft) || 0,
    side: sideSetback,
  };
  const envelope = envelopeRect(lotWidth, lotDepth, setbacks);
  const hasExisting = project?.id === "addition" || project?.id === "adu";
  const existing = hasExisting
    ? existingRect(
        lotWidth,
        lotDepth,
        result.existingFootprint,
        result.existingLocation,
        result.existingPosition
      )
    : null;
  const savedPositions = Array.isArray(result.floorRects)
    ? result.floorRects.map((rect) => (rect ? { x0: rect.x0, y0: rect.y0 } : null))
    : [];
  const floorRects = computeFloorRects({
    lotWidthFt: lotWidth,
    lotDepthFt: lotDepth,
    envelope,
    existing,
    additionLocation: result.additionLocation,
    placementMode:
      project?.id === "adu"
        ? "adu"
        : project?.id === "addition" && result.additionLocation !== "above"
          ? "addition"
          : "free",
    floors,
    positions: savedPositions,
  });

  const viewWidth = 760;
  const viewHeight = 420;
  const planArea = { x: 54, y: 42, width: 420, height: 300 };
  const scale = Math.min(planArea.width / lotWidth, planArea.height / lotDepth);
  const planWidth = lotWidth * scale;
  const planHeight = lotDepth * scale;
  const originX = planArea.x + (planArea.width - planWidth) / 2;
  const originY = planArea.y + (planArea.height - planHeight) / 2;
  const sx = (value) => originX + value * scale;
  const sy = (value) => originY + (lotDepth - value) * scale;
  const streetY = sy(0);
  const completeFloorCount = floorRects.filter(Boolean).length;
  const calloutGap = completeFloorCount > 4 ? 55 : 66;
  const calloutStartY = Math.max(60, 198 - ((completeFloorCount - 1) * calloutGap) / 2);
  const streetName = streetNameFor(parcel, streetEdge);

  return (
    <figure className="review-site-plan">
      <div className="review-plan-title">
        <div>
          <h4>Lot and planned floor placement</h4>
          <p>Conceptual plan view · dimensions in feet · not a survey</p>
        </div>
        <span>{fmt(lotWidth, 1)}′ × {fmt(lotDepth, 1)}′ lot</span>
      </div>
      <svg
        className="review-site-plan-svg"
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        role="img"
        aria-label={`${fmt(lotWidth, 1)} by ${fmt(lotDepth, 1)} foot lot with zoning setback lines and ${completeFloorCount} planned floor${completeFloorCount === 1 ? "" : "s"}`}
      >
        <rect
          x={originX - 12}
          y={streetY}
          width={planWidth + 24}
          height={42}
          className="review-plan-street"
        />
        <text
          x={originX + planWidth / 2}
          y={streetY + 25}
          textAnchor="middle"
          className="review-plan-street-label"
        >
          {streetName || "Street"} · front
        </text>

        <rect
          x={originX}
          y={originY}
          width={planWidth}
          height={planHeight}
          className="review-plan-lot"
        />
        {envelope.x1 > envelope.x0 && envelope.y1 > envelope.y0 && (
          <rect
            x={sx(envelope.x0)}
            y={sy(envelope.y1)}
            width={(envelope.x1 - envelope.x0) * scale}
            height={(envelope.y1 - envelope.y0) * scale}
            className="review-plan-envelope"
          />
        )}

        {existing && (
          <rect
            x={sx(existing.x0)}
            y={sy(existing.y1)}
            width={(existing.x1 - existing.x0) * scale}
            height={(existing.y1 - existing.y0) * scale}
            className="review-plan-existing"
          />
        )}

        {floorRects.map((rect, index) => {
          if (!rect) return null;
          const color = floorColor(index);
          return (
            <rect
              key={`review-floor-${index}`}
              x={sx(rect.x0)}
              y={sy(rect.y1)}
              width={(rect.x1 - rect.x0) * scale}
              height={(rect.y1 - rect.y0) * scale}
              fill={color.fill}
              stroke={color.stroke}
              className="review-plan-floor"
            />
          );
        })}

        <text
          x={originX + planWidth / 2}
          y={originY - 13}
          textAnchor="middle"
          className="review-plan-dimension"
        >
          Lot width {fmt(lotWidth, 1)}′
        </text>
        <text
          x={originX - 17}
          y={originY + planHeight / 2}
          textAnchor="middle"
          className="review-plan-dimension"
          transform={`rotate(-90 ${originX - 17} ${originY + planHeight / 2})`}
        >
          Lot depth {fmt(lotDepth, 1)}′
        </text>

        {setbacks.front > 0 && (
          <text
            x={originX + planWidth / 2}
            y={sy(envelope.y0) - 6}
            textAnchor="middle"
            className="review-plan-setback-label"
          >
            Front setback {fmt(setbacks.front, 1)}′
          </text>
        )}
        {setbacks.rear > 0 && (
          <text
            x={originX + planWidth / 2}
            y={sy(envelope.y1) + 13}
            textAnchor="middle"
            className="review-plan-setback-label"
          >
            Rear setback {fmt(setbacks.rear, 1)}′
          </text>
        )}
        {setbacks.side > 0 && (
          <text
            x={sx(envelope.x0) + 5}
            y={originY + 17}
            textAnchor="start"
            className="review-plan-setback-label"
          >
            Side setback {fmt(setbacks.side, 1)}′
          </text>
        )}
        <text
          x={sx(envelope.x1) - 5}
          y={sy(envelope.y1) + 28}
          textAnchor="end"
          className="review-plan-zone-label"
        >
          Zoning setback line
        </text>

        {floorRects.map((rect, index) => {
          if (!rect) return null;
          const floor = floors[index];
          const color = floorColor(index);
          const calloutY = calloutStartY + index * calloutGap;
          const centerX = sx((rect.x0 + rect.x1) / 2);
          const centerY = sy((rect.y0 + rect.y1) / 2);
          const calloutX = 520;
          return (
            <g key={`review-callout-${index}`} className="review-plan-callout">
              <polyline
                points={`${centerX},${centerY} ${calloutX - 22},${calloutY} ${calloutX},${calloutY}`}
                fill="none"
                stroke={color.stroke}
              />
              <rect
                x={calloutX + 4}
                y={calloutY - 18}
                width="13"
                height="13"
                rx="3"
                fill={color.fill}
                stroke={color.stroke}
              />
              <text x={calloutX + 25} y={calloutY - 8} className="review-plan-floor-name">
                Floor {existingStoryCount + index + 1}
              </text>
              <text x={calloutX + 25} y={calloutY + 10} className="review-plan-floor-dims">
                {fmt(floor.widthFt, 1)}′ × {fmt(floor.depthFt, 1)}′ · {fmt(floor.heightFt, 1)}′ high
              </text>
              <text x={calloutX + 25} y={calloutY + 27} className="review-plan-floor-area">
                {fmt(floor.areaSqft)} sq ft
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="review-plan-key">
        <span><i className="lot-line" aria-hidden="true" />Lot boundary</span>
        <span><i className="zone-line" aria-hidden="true" />Zoning setback / buildable area</span>
        {existing && <span><i className="existing-shape" aria-hidden="true" />Existing structure</span>}
      </figcaption>
    </figure>
  );
}

function Review({ project, muni, district, lot, parcel, streetEdge, result, costModel, selectedTier, onBack }) {
  const chosenTier = costModel?.build_cost_tiers.find((item) => item.tier === selectedTier);
  const hasExistingHouse = project?.id === "addition" || project?.id === "adu";
  const plannedFloors = result.plannedDimensions ?? [];
  const reviewExistingStoryCount =
    project?.id === "addition" && result.additionLocation === "above"
      ? Math.ceil(
          Number(result.existingStories) ||
            (Number(result.existingArea) > 0 && Number(result.existingFootprint) > 0
              ? Number(result.existingArea) / Number(result.existingFootprint)
              : 1)
        )
      : 0;
  const zoningRules = [
    ["Minimum lot area", district.min_lot_area_sqft, "sq ft"],
    ["Minimum lot width", district.min_lot_width_ft, "ft"],
    ["Minimum lot depth", district.min_lot_depth_ft, "ft"],
    ["Front setback", district.front_yard_min_ft, "ft"],
    ["Rear setback", district.rear_yard_min_ft, "ft"],
    [
      "Side setback",
      district.side_yard_one_min_ft ??
        (district.side_yard_total_min_ft != null ? district.side_yard_total_min_ft / 2 : null),
      "ft each",
    ],
    ["Total side yards", district.side_yard_total_min_ft, "ft"],
    ["Maximum coverage", district.max_building_coverage_pct, "%"],
    ["Maximum FAR", district.max_far, ""],
    ["Maximum stories", district.max_stories, ""],
    ["Maximum height", district.max_height_ft, "ft"],
  ];
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
              {project?.id === "addition" && (
                <div>
                  <span>Addition location</span>
                  <strong>{{
                    side_left: "Left-side addition",
                    side_right: "Right-side addition",
                    front: "Front addition",
                    back: "Back addition",
                    above: "Above the existing house",
                  }[result.additionLocation] ?? "Above the existing house"}</strong>
                </div>
              )}
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
          {result.plannedArea != null && (
            <div>
              <span>Planned size{result.fitsPlan == null ? "" : result.fitsPlan ? " (fits)" : " (exceeds max)"}</span>
              <strong>
                {fmt(result.plannedArea)} sq ft
                {result.planDelta != null &&
                  (result.fitsPlan
                    ? ` — ${fmt(result.planDelta)} to spare`
                    : ` — ${fmt(Math.abs(result.planDelta))} over`)}
              </strong>
            </div>
          )}
          {result.plannedHeight != null && (
            <div><span>Planned total height</span><strong>{fmt(result.plannedHeight, 1)} ft</strong></div>
          )}
          {/* The client's selected build level, carrying the provenance flag:
              the printed report is where a reader is most likely to mistake a
              projection for a quote, so the label travels with the price. */}
          <div>
            <span>
              {TIER_LABELS[selectedTier]} cost estimate
              {costModel && (
                <span className={`provenance-flag inline ${costModel.provenance}`}>
                  {costModel.provenance === "verified" ? "✓ Verified" : "✕ Estimated"}
                </span>
              )}
            </span>
            <strong>
              {chosenTier && result.estimateArea != null
                ? chosenTier.rate_per_sqft_max != null
                  ? `$${fmt(result.estimateArea * chosenTier.rate_per_sqft)} – $${fmt(result.estimateArea * chosenTier.rate_per_sqft_max)}`
                  : `$${fmt(result.estimateArea * chosenTier.rate_per_sqft)}`
                : "Needs floor-area input"}
            </strong>
          </div>
          {parcel ? (
            <div><span>Block / Lot</span><strong>{parcel.block ?? "—"} / {parcel.lot ?? "—"}</strong></div>
          ) : (
            <div><span>Manual dimensions</span><strong>{fmt(lot.width_ft)}′ × {fmt(lot.depth_ft)}′</strong></div>
          )}
        </div>

        <section className="review-detail-section" aria-labelledby="zoning-rules-title">
          <div className="review-detail-heading">
            <div>
              <p className="eyebrow">District standards</p>
              <h3 id="zoning-rules-title">{district.code} zoning rules used</h3>
            </div>
            <span>{district.name}</span>
          </div>
          <dl className="review-rules">
            {zoningRules.map(([label, value, unit]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value == null ? "Not specified" : `${fmt(value, 2)}${unit ? ` ${unit}` : ""}`}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="review-detail-section" aria-labelledby="floor-schedule-title">
          <div className="review-detail-heading">
            <div>
              <p className="eyebrow">Planned building</p>
              <h3 id="floor-schedule-title">Floor dimensions and area</h3>
            </div>
            <span>
              Lot {fmt(result.lotArea)} sq ft · planned {fmt(result.plannedArea ?? 0)} sq ft ·{" "}
              {fmt(result.plannedHeight ?? 0, 1)} ft high
            </span>
          </div>
          <ReviewSiteDrawing
            project={project}
            district={district}
            lot={lot}
            parcel={parcel}
            streetEdge={streetEdge}
            result={result}
            floors={plannedFloors}
            existingStoryCount={reviewExistingStoryCount}
          />
          {plannedFloors.length > 0 ? (
            <div className="review-floor-table-wrap">
              <table className="review-floor-table">
                <thead>
                  <tr>
                    <th>Floor</th>
                    <th>Width</th>
                    <th>Depth</th>
                    <th>Height</th>
                    <th>Floor area</th>
                  </tr>
                </thead>
                <tbody>
                  {plannedFloors.map((floor, index) => (
                    <tr key={index}>
                      <th>Floor {reviewExistingStoryCount + index + 1}</th>
                      <td>{fmt(floor.widthFt, 1)} ft</td>
                      <td>{fmt(floor.depthFt, 1)} ft</td>
                      <td>{fmt(floor.heightFt, 1)} ft</td>
                      <td>{fmt(floor.areaSqft)} sq ft</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan="3">Total planned building</th>
                    <td>{fmt(result.plannedHeight, 1)} ft</td>
                    <td>{fmt(result.plannedArea)} sq ft</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="review-empty">No floor dimensions were entered; estimates use the maximum zoning capacity.</p>
          )}
        </section>

        <SurveyNotice />
        {project?.id === "adu" && (
          <p className="adu-review-note">
            ADU capacity is preliminary. {muni.name} must confirm that an ADU is permitted and determine applicable size,
            location, setback, parking, utility, and occupancy requirements.
          </p>
        )}
        <CostScope scope={costModel?.cost_scope} estimateArea={result.estimateArea} costModel={costModel} selectedTier={selectedTier} />
        <p className="report-disclaimer">
          This report is for early planning only. It is not a zoning determination, site plan, survey, architectural drawing,
          construction estimate, or approval to build. Confirm requirements with {muni.name} and licensed professionals.
        </p>
        <p className="report-licenses">
          Figures are planning estimates for discussion purposes and are not a quote or contract. Final pricing is set
          by your approved design and selections.
          <br />
          Marco Design LLC · NJ New Home Builder Lic. #0053907 · NJ Home Improvement Lic. #13VH12052000
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
