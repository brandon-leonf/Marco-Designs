/**
 * @typedef {Object} ZoningRule
 * @property {string} id
 * @property {string} municipalityId
 * @property {string} districtId
 * @property {typeof RULE_CATEGORIES[number]} category
 * @property {typeof RULE_APPLIES_TO[number]} appliesTo
 * @property {typeof RULE_SIDES[number] | null} side
 * @property {typeof RULE_TYPES[number]} ruleType
 * @property {{metric:string, operator:string, value:number, secondValue?:number|null}|null} condition
 * @property {{value?:number|null, formula?:string, unit:typeof RULE_UNITS[number]}} calculation
 * @property {typeof RULE_COMBINE_METHODS[number]} combineMethod
 * @property {number} priority
 * @property {string} sourceSection
 * @property {string} sourceUrl
 * @property {string} effectiveDate
 * @property {string} expirationDate
 */

export const RULE_CATEGORIES = [
  "SETBACK",
  "FAR",
  "BUILDING_COVERAGE",
  "IMPERVIOUS_COVERAGE",
  "HEIGHT",
  "STORIES",
  "LOT_AREA",
  "LOT_WIDTH",
  "LOT_DEPTH",
  "PERMITTED_USE",
];
export const RULE_APPLIES_TO = [
  "PRINCIPAL_BUILDING",
  "ACCESSORY_BUILDING",
  "GARAGE",
  "DECK",
  "POOL",
  "ALL_STRUCTURES",
];
export const RULE_SIDES = ["FRONT", "REAR", "LEFT", "RIGHT", "EACH_SIDE", "COMBINED_SIDE"];
export const RULE_TYPES = ["FIXED", "PERCENTAGE", "FORMULA", "CONDITIONAL", "PIECEWISE", "NEIGHBOR_AVERAGE"];
export const RULE_OPERATORS = [">", ">=", "<", "<=", "=", "BETWEEN"];
export const RULE_UNITS = ["FT", "SQFT", "PERCENT", "RATIO", "STORIES"];
export const RULE_COMBINE_METHODS = ["MAX", "MIN", "REPLACE", "ADD"];
export const BASELINE_RULE_SOURCE = "Published district dimensional rules";

const createRuleId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const METRIC_ALIASES = {
  GROSS_BUILDING_AREA: "grossBuildingArea",
  LOT_AREA: "lotArea",
  LOT_WIDTH: "lotWidth",
  LOT_DEPTH: "lotDepth",
  BUILDING_HEIGHT: "buildingHeight",
  STORIES: "stories",
};

const numberOrNull = (value) => {
  const parsed = Number(value);
  return value === "" || value == null || !Number.isFinite(parsed) ? null : parsed;
};

export function normalizeZoningRule(rule, defaults = {}) {
  const condition = rule?.condition ?? null;
  const calculation = rule?.calculation ?? {};
  return {
    id: String(rule?.id ?? defaults.id ?? createRuleId()),
    municipalityId: String(rule?.municipalityId ?? rule?.municipality_id ?? defaults.municipalityId ?? ""),
    districtId: String(rule?.districtId ?? rule?.district_id ?? defaults.districtId ?? ""),
    category: rule?.category ?? "SETBACK",
    appliesTo: rule?.appliesTo ?? rule?.applies_to ?? "PRINCIPAL_BUILDING",
    side: rule?.side ?? null,
    ruleType: rule?.ruleType ?? rule?.rule_type ?? "FIXED",
    condition: condition
      ? {
          metric: condition.metric ?? "GROSS_BUILDING_AREA",
          operator: condition.operator ?? ">",
          value: numberOrNull(condition.value) ?? 0,
          secondValue: numberOrNull(condition.secondValue ?? condition.second_value),
        }
      : null,
    calculation: {
      value: numberOrNull(calculation.value),
      formula: calculation.formula ?? "",
      unit: calculation.unit ?? "FT",
    },
    combineMethod: rule?.combineMethod ?? rule?.combine_method ?? "MAX",
    priority: Number.isFinite(Number(rule?.priority)) ? Number(rule.priority) : 100,
    sourceSection: rule?.sourceSection ?? rule?.source_section ?? BASELINE_RULE_SOURCE,
    sourceUrl: rule?.sourceUrl ?? rule?.source_url ?? "",
    effectiveDate: rule?.effectiveDate ?? rule?.effective_date ?? "",
    expirationDate: rule?.expirationDate ?? rule?.expiration_date ?? "",
  };
}

export function serializeZoningRule(rule) {
  const normalized = normalizeZoningRule(rule);
  const conditional = ["CONDITIONAL", "PIECEWISE"].includes(normalized.ruleType);
  const persistentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(normalized.id)
      ? normalized.id
      : undefined;
  return {
    id: persistentId,
    municipality_id: Number(normalized.municipalityId),
    district_id: Number(normalized.districtId),
    category: normalized.category,
    applies_to: normalized.appliesTo,
    side: normalized.category === "SETBACK" ? normalized.side : null,
    rule_type: normalized.ruleType,
    condition: conditional ? normalized.condition : null,
    calculation: {
      ...(normalized.calculation.value == null ? {} : { value: normalized.calculation.value }),
      ...(normalized.calculation.formula ? { formula: normalized.calculation.formula } : {}),
      unit: normalized.calculation.unit,
    },
    combine_method: normalized.combineMethod,
    priority: normalized.priority,
    source_section: normalized.sourceSection,
    source_url: normalized.sourceUrl || null,
    effective_date: normalized.effectiveDate || null,
    expiration_date: normalized.expirationDate || null,
  };
}

function legacyRule(district, suffix, values) {
  return normalizeZoningRule(
    {
      id: `legacy:${district.id}:${suffix}`,
      municipalityId: district.municipality_id,
      districtId: district.id,
      sourceSection: BASELINE_RULE_SOURCE,
      sourceUrl: district.source_url,
      ...values,
    }
  );
}

/** Fallback for databases that have not applied migration 0019 yet. */
export function rulesFromLegacyDistrict(district) {
  if (!district) return [];
  const rules = [];
  const add = (suffix, value, values) => {
    if (numberOrNull(value) == null) return;
    rules.push(legacyRule(district, suffix, {
      ...values,
      calculation: { value: Number(value), unit: values.calculation.unit },
    }));
  };
  add("front", district.front_yard_min_ft, { category: "SETBACK", side: "FRONT", ruleType: district.front_yard_prevailing_rule ? "NEIGHBOR_AVERAGE" : "FIXED", combineMethod: "MAX", calculation: { unit: "FT" } });
  add("rear", district.rear_yard_min_ft, { category: "SETBACK", side: "REAR", ruleType: "FIXED", combineMethod: "MAX", calculation: { unit: "FT" } });
  add("side-one", district.side_yard_one_min_ft, { category: "SETBACK", side: "EACH_SIDE", ruleType: "FIXED", combineMethod: "MAX", calculation: { unit: "FT" } });
  add("side-total", district.side_yard_total_min_ft, { category: "SETBACK", side: "COMBINED_SIDE", ruleType: "FIXED", combineMethod: "MAX", calculation: { unit: "FT" } });
  add("far", district.max_far, { category: "FAR", ruleType: "PERCENTAGE", combineMethod: "MIN", calculation: { unit: "RATIO" } });
  add("coverage", district.max_building_coverage_pct, { category: "BUILDING_COVERAGE", ruleType: "PERCENTAGE", combineMethod: "MIN", calculation: { unit: "PERCENT" } });
  add("impervious", district.max_impervious_coverage_pct, { category: "IMPERVIOUS_COVERAGE", ruleType: "PERCENTAGE", combineMethod: "MIN", calculation: { unit: "PERCENT" } });
  add("height", district.max_height_ft, { category: "HEIGHT", ruleType: "FIXED", combineMethod: "MIN", calculation: { unit: "FT" } });
  add("stories", district.max_stories, { category: "STORIES", ruleType: "FIXED", combineMethod: "MIN", calculation: { unit: "STORIES" } });
  add("lot-area", district.min_lot_area_sqft, { category: "LOT_AREA", ruleType: "FIXED", combineMethod: "MAX", calculation: { unit: "SQFT" } });
  add("lot-width", district.min_lot_width_ft, { category: "LOT_WIDTH", ruleType: "FIXED", combineMethod: "MAX", calculation: { unit: "FT" } });
  add("lot-depth", district.min_lot_depth_ft, { category: "LOT_DEPTH", ruleType: "FIXED", combineMethod: "MAX", calculation: { unit: "FT" } });
  return rules;
}

const baselineRuleKey = (rule) =>
  `${rule.category}:${rule.category === "SETBACK" ? rule.side ?? "" : ""}`;

/**
 * Keep the normalized fixed/percentage rows synchronized with the existing
 * Setbacks & Limits form while preserving every conditional or formula rule.
 * This lets the normalized model become the calculation source without
 * forcing admins to enter the same base values twice.
 */
export function synchronizeBaselineRules(district, draft, existingRules = []) {
  if (!district || !draft) return existingRules;
  const baselineDistrict = {
    ...district,
    municipality_id: district.municipality_id,
    front_yard_min_ft: numberOrNull(draft.front_yard_min_ft),
    rear_yard_min_ft: numberOrNull(draft.rear_yard_min_ft),
    side_yard_one_min_ft: numberOrNull(draft.side_yard_one_min_ft),
    side_yard_total_min_ft: numberOrNull(draft.side_yard_total_min_ft),
    min_lot_area_sqft: numberOrNull(draft.min_lot_area_sqft),
    min_lot_width_ft: numberOrNull(draft.min_lot_width_ft),
    min_lot_depth_ft: numberOrNull(draft.min_lot_depth_ft),
    front_yard_prevailing_rule: Boolean(draft.front_yard_prevailing_rule),
    max_building_coverage_pct: numberOrNull(draft.max_building_coverage_pct),
    max_impervious_coverage_pct: numberOrNull(draft.max_impervious_coverage_pct),
    max_stories: numberOrNull(draft.max_stories),
    max_far: numberOrNull(draft.max_far),
    max_height_ft: numberOrNull(draft.max_height_ft),
  };
  const normalizedExisting = existingRules.map((rule) => normalizeZoningRule(rule));
  const existingBaseline = new Map(
    normalizedExisting
      .filter((rule) => rule.sourceSection === BASELINE_RULE_SOURCE)
      .map((rule) => [baselineRuleKey(rule), rule])
  );
  const custom = normalizedExisting.filter(
    (rule) => rule.sourceSection !== BASELINE_RULE_SOURCE
  );
  const baseline = rulesFromLegacyDistrict(baselineDistrict).map((rule) => {
    const previous = existingBaseline.get(baselineRuleKey(rule));
    return previous ? { ...rule, id: previous.id } : rule;
  });
  return [...baseline, ...custom];
}

function metricContext(context = {}) {
  const result = { ...context };
  for (const [canonical, camel] of Object.entries(METRIC_ALIASES)) {
    const value = numberOrNull(context[canonical] ?? context[camel]);
    if (value != null) {
      result[canonical] = value;
      result[camel] = value;
    }
  }
  return result;
}

function tokenizeFormula(formula) {
  const tokens = String(formula ?? "").match(/\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/]/g) ?? [];
  if (tokens.join("").toLowerCase() !== String(formula ?? "").replace(/\s+/g, "").toLowerCase()) {
    throw new Error("Formula contains unsupported characters.");
  }
  return tokens;
}

/** Safe arithmetic evaluator: numbers, known metrics, + - * /, parentheses. */
export function evaluateFormula(formula, context = {}) {
  const tokens = tokenizeFormula(formula);
  const metrics = metricContext(context);
  let index = 0;
  const primary = () => {
    const token = tokens[index++];
    if (token === "(") {
      const value = expression();
      if (tokens[index++] !== ")") throw new Error("Formula has an unmatched parenthesis.");
      return value;
    }
    if (token === "+" || token === "-") {
      const value = primary();
      return token === "-" ? -value : value;
    }
    if (/^\d/.test(token ?? "")) return Number(token);
    const value = numberOrNull(metrics[token] ?? metrics[METRIC_ALIASES[token]]);
    if (value == null) throw new Error(`Formula metric ${token ?? ""} is unavailable.`);
    return value;
  };
  const product = () => {
    let value = primary();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index++];
      const next = primary();
      value = operator === "*" ? value * next : value / next;
    }
    return value;
  };
  const expression = () => {
    let value = product();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++];
      const next = product();
      value = operator === "+" ? value + next : value - next;
    }
    return value;
  };
  const result = expression();
  if (index !== tokens.length || !Number.isFinite(result)) throw new Error("Formula could not be evaluated.");
  return result;
}

function conditionMatches(condition, context) {
  if (!condition) return true;
  const metrics = metricContext(context);
  const actual = numberOrNull(metrics[condition.metric] ?? metrics[METRIC_ALIASES[condition.metric]]);
  if (actual == null) return false;
  const value = Number(condition.value);
  switch (condition.operator) {
    case ">": return actual > value;
    case ">=": return actual >= value;
    case "<": return actual < value;
    case "<=": return actual <= value;
    case "=": return actual === value;
    case "BETWEEN": return actual >= value && actual <= Number(condition.secondValue);
    default: return false;
  }
}

function isActiveOnDate(rule, date) {
  const day = String(date ?? new Date().toISOString().slice(0, 10));
  return (!rule.effectiveDate || rule.effectiveDate <= day) && (!rule.expirationDate || rule.expirationDate >= day);
}

function ruleKey(rule) {
  return `${rule.category}:${rule.category === "SETBACK" ? rule.side ?? "" : ""}`;
}

export function evaluateZoningRules(rules, context = {}, options = {}) {
  const appliesTo = options.appliesTo ?? "PRINCIPAL_BUILDING";
  const normalized = (rules ?? []).map((rule) => normalizeZoningRule(rule));
  const applicable = normalized
    .filter((rule) => rule.appliesTo === appliesTo || rule.appliesTo === "ALL_STRUCTURES")
    .filter((rule) => isActiveOnDate(rule, options.date))
    .filter((rule) => conditionMatches(rule.condition, context))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const values = new Map();
  const applied = [];
  for (const rule of applicable) {
    // A rule with neither a value nor a formula says nothing, so it does
    // nothing. Without this it would fall through as `Number(null)` — a blank
    // setback would publish as a 0 ft setback, which is the opposite of blank.
    // Same principle the FAR field states: blank is never treated as 0.
    if (rule.calculation.value == null && !rule.calculation.formula) continue;
    let value = rule.calculation.value;
    if (rule.calculation.formula) {
      try {
        value = evaluateFormula(rule.calculation.formula, context);
      } catch (error) {
        applied.push({ rule, value: null, error: error.message });
        continue;
      }
    }
    if (!Number.isFinite(Number(value))) continue;
    value = Number(value);
    const key = ruleKey(rule);
    const current = values.get(key);
    let next = value;
    if (current != null) {
      if (rule.combineMethod === "MAX") next = Math.max(current, value);
      else if (rule.combineMethod === "MIN") next = Math.min(current, value);
      else if (rule.combineMethod === "ADD") next = current + value;
      else if (rule.combineMethod === "REPLACE") next = value;
    }
    values.set(key, next);
    applied.push({ rule, value, result: next });
  }
  return { values, applied };
}

/** Convert normalized results into the effective flat district API. */
export function applyZoningRules(district, context = {}, options = {}) {
  if (!district) return null;
  const rules = district.zoning_rules?.length
    ? district.zoning_rules
    : rulesFromLegacyDistrict(district);
  const { values, applied } = evaluateZoningRules(rules, context, options);
  const get = (category, side = "") => values.get(`${category}:${side}`);
  const left = get("SETBACK", "LEFT");
  const right = get("SETBACK", "RIGHT");
  const each = get("SETBACK", "EACH_SIDE");
  const effectiveSide = Math.max(0, each ?? 0, left ?? 0, right ?? 0);
  const set = (key, value) => (value == null ? district[key] : value);
  return {
    ...district,
    front_yard_min_ft: set("front_yard_min_ft", get("SETBACK", "FRONT")),
    rear_yard_min_ft: set("rear_yard_min_ft", get("SETBACK", "REAR")),
    side_yard_one_min_ft: effectiveSide || district.side_yard_one_min_ft,
    side_yard_total_min_ft: set("side_yard_total_min_ft", get("SETBACK", "COMBINED_SIDE")),
    max_far: set("max_far", get("FAR")),
    max_building_coverage_pct: set("max_building_coverage_pct", get("BUILDING_COVERAGE")),
    max_impervious_coverage_pct: set("max_impervious_coverage_pct", get("IMPERVIOUS_COVERAGE")),
    max_height_ft: set("max_height_ft", get("HEIGHT")),
    max_stories: set("max_stories", get("STORIES")),
    min_lot_area_sqft: set("min_lot_area_sqft", get("LOT_AREA")),
    min_lot_width_ft: set("min_lot_width_ft", get("LOT_WIDTH")),
    min_lot_depth_ft: set("min_lot_depth_ft", get("LOT_DEPTH")),
    effective_zoning_rules: applied,
  };
}

/**
 * Things worth saying about a rule that are not reasons to stop publishing.
 *
 * A blank rule and a rule with no cited section are both ordinary states of
 * work in progress — a district is often entered before every section has been
 * looked up. Neither can produce a wrong answer: an incomplete rule is skipped
 * outright by `evaluateZoningRules`, and a missing citation is documentation.
 * They are reported rather than enforced so the rest of the district can go
 * live without waiting on them.
 */
export function zoningRuleNotes(rule) {
  const item = normalizeZoningRule(rule);
  const notes = [];
  if (item.calculation.value == null && !item.calculation.formula) {
    notes.push("No value or formula yet — this rule is skipped until one is entered.");
  }
  if (!item.sourceSection.trim()) notes.push("No source section cited.");
  return notes;
}

export function validateZoningRule(rule) {
  const item = normalizeZoningRule(rule);
  const issues = [];
  if (!item.municipalityId) issues.push("Municipality is required.");
  if (!item.districtId) issues.push("District is required.");
  if (!RULE_CATEGORIES.includes(item.category)) issues.push("Choose a valid category.");
  if (!RULE_APPLIES_TO.includes(item.appliesTo)) issues.push("Choose what the rule applies to.");
  if (item.category === "SETBACK" && !RULE_SIDES.includes(item.side)) issues.push("Setback rules need a side.");
  if (!RULE_TYPES.includes(item.ruleType)) issues.push("Choose a valid rule type.");
  if (!RULE_UNITS.includes(item.calculation.unit)) issues.push("Choose a valid calculation unit.");
  if (item.ruleType === "FORMULA" && !item.calculation.formula) issues.push("Formula rules need a formula.");
  if (item.calculation.formula) {
    try {
      if (tokenizeFormula(item.calculation.formula).length === 0) throw new Error();
    } catch {
      issues.push("Formula contains unsupported syntax.");
    }
  }
  if (["CONDITIONAL", "PIECEWISE"].includes(item.ruleType) && !item.condition) issues.push("Conditional rules need a condition.");
  if (item.condition && !String(item.condition.metric ?? "").trim()) issues.push("Condition metric is required.");
  if (item.condition && !RULE_OPERATORS.includes(item.condition.operator)) issues.push("Choose a valid condition operator.");
  if (item.condition?.operator === "BETWEEN" && item.condition.secondValue == null) {
    issues.push("BETWEEN conditions need a second value.");
  }
  if (!Number.isInteger(item.priority)) issues.push("Priority must be a whole number.");
  if (item.effectiveDate && item.expirationDate && item.expirationDate < item.effectiveDate) {
    issues.push("Expiration date cannot be before the effective date.");
  }
  return issues;
}
