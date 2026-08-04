import { supabase } from "./supabase.js";
import { serializeZoningRule } from "./zoningRules.js";
import { stateNameFor } from "./states.js";

/**
 * Admin-side data access. Everything here requires a signed-in Supabase user
 * whose email is listed in admin_users (migration 0009). RLS enforces that on
 * the server; the UI checks it up front only to show a friendly message.
 */

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

/**
 * The admin_users SELECT policy only reveals rows to config admins, so a
 * non-empty result doubles as an authorization check.
 */
export async function checkIsAdmin(email) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("email")
    .eq("email", email.toLowerCase());
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * RLS silently updates zero rows when the policy rejects a write, so every
 * update chains .select() and treats an empty result as a permission failure.
 */
function assertWritten(rows, what) {
  if (!rows || rows.length === 0) {
    throw new Error(
      `The ${what} update wrote no rows. Your account is signed in but not ` +
        "listed in admin_users, or the record no longer exists."
    );
  }
}

/**
 * Every zoning district owns its rule values. Keep the complete blank shape in
 * the insert payload instead of relying on database defaults, so a district
 * created after another one can never appear to inherit that district's
 * setbacks, build limits, permitted uses, notes, or ADU configuration.
 */
function blankDistrictFields() {
  return {
    permitted_uses: [],
    notes: null,
    min_lot_area_sqft: null,
    min_lot_width_ft: null,
    min_lot_depth_ft: null,
    front_yard_min_ft: null,
    front_yard_prevailing_rule: false,
    side_yard_one_min_ft: null,
    side_yard_total_min_ft: null,
    rear_yard_min_ft: null,
    max_height_ft: null,
    max_stories: null,
    max_building_coverage_pct: null,
    max_impervious_coverage_pct: null,
    max_far: null,
    extra_rules: {},
  };
}

export async function saveDistrict(districtId, fields) {
  const { data, error } = await supabase
    .from("zoning_districts")
    .update(fields)
    .eq("id", districtId)
    .select("id");
  if (error) throw error;
  assertWritten(data, "zoning district");
}

/** Replace all normalized rules for one district in a single DB transaction. */
export async function replaceZoningRules(municipalityId, districtId, rules) {
  const payload = (rules ?? []).map((rule) => {
    const serialized = serializeZoningRule(rule);
    return Object.fromEntries(
      Object.entries(serialized).filter(([, value]) => value !== undefined)
    );
  });
  const { data, error } = await supabase.rpc("admin_replace_zoning_rules", {
    p_municipality_id: municipalityId,
    p_district_id: districtId,
    p_rules: payload,
  });
  if (error) throw error;
  if (Number(data) !== payload.length) {
    throw new Error(`Expected to publish ${payload.length} zoning rules; database reported ${data}.`);
  }
  return Number(data);
}

/**
 * Stamp `last_updated` with today, on publish.
 *
 * Publishing is a claim that the rules now on file are the ones that were
 * checked, so the date moves with it and the town list stops reporting a
 * currency that a publish has already overtaken.
 *
 * This is now the only writer of the column. `source_url` is set when the town
 * is created and has no editor after that — there was one, and it was removed
 * along with the panel it lived in.
 */
export async function touchMunicipality(municipalityId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("municipalities")
    .update({ last_updated: today })
    .eq("id", municipalityId)
    .select("id");
  if (error) throw error;
  assertWritten(data, "municipality");
}

/**
 * Save the cost model + its three tiers. The DB provenance_fields CHECK
 * requires baseline/factor to be set for estimated models and NULL for
 * legacy verified ones. Each tier row carries {rate_per_sqft,
 * rate_per_sqft_max, notes, formula_reference}; projected tiers may use a
 * min–max range and client-facing notes.
 */
export async function saveCostModel(municipalityId, existingModelId, model, tierRows) {
  let modelId = existingModelId;

  if (modelId) {
    const { data, error } = await supabase
      .from("build_cost_models")
      .update(model)
      .eq("id", modelId)
      .select("id");
    if (error) throw error;
    assertWritten(data, "cost model");
  } else {
    const { data, error } = await supabase
      .from("build_cost_models")
      .insert({ ...model, municipality_id: municipalityId })
      .select("id");
    if (error) throw error;
    assertWritten(data, "cost model");
    modelId = data[0].id;
  }

  const rows = tierRows.map((row) => ({
    ...row,
    cost_model_id: modelId,
    provenance: model.provenance,
  }));
  const { data: tierData, error: tierError } = await supabase
    .from("build_cost_tiers")
    .upsert(rows, { onConflict: "cost_model_id,tier" })
    .select("id");
  if (tierError) throw tierError;
  assertWritten(tierData, "cost tier");
}

/**
 * Add a state, so municipalities can be filed under it.
 *
 * `ignoreDuplicates` rather than an error on conflict: a state already being on
 * file is the outcome the caller wanted, and older rows were created implicitly
 * by the municipality form before states were added explicitly.
 */
export async function createState({ code, name }) {
  const upper = code.trim().toUpperCase();
  const { error } = await supabase
    .from("states")
    .upsert(
      { code: upper, name: name.trim() || stateNameFor(upper) },
      { onConflict: "code", ignoreDuplicates: true }
    );
  if (error) throw error;
  return upper;
}

/**
 * Create the municipality only. Districts are added explicitly afterward, so
 * no starter district is inserted here — a district created as a side effect
 * of naming a town was one nobody chose the code for.
 *
 * The state row must exist first (FK); ON CONFLICT DO NOTHING keeps that safe
 * when it already does. `sourceUrl` and `lastUpdated` are the operator's
 * provenance claim and are carried through from the form rather than stamped.
 */
export async function createMunicipality({
  name,
  stateCode,
  county,
  slug,
  sourceUrl,
  lastUpdated,
}) {
  const code = stateCode.toUpperCase();
  // Creating a town into a state nobody added yet still has to satisfy the FK.
  // Named properly rather than as its own code, so a state that arrives this
  // way is indistinguishable from one added from the state list.
  const { error: stateError } = await supabase
    .from("states")
    .upsert({ code, name: stateNameFor(code) }, { onConflict: "code", ignoreDuplicates: true });
  if (stateError) throw stateError;

  const { data: muniData, error: muniError } = await supabase
    .from("municipalities")
    .insert({
      state_code: code,
      name,
      slug,
      county: county || null,
      // Both are the operator's claim about the ordinance, not a timestamp of
      // this insert — blank stays blank rather than being filled in with today.
      source_url: sourceUrl || null,
      last_updated: lastUpdated || null,
    })
    .select("id");
  if (muniError) throw muniError;
  assertWritten(muniData, "municipality");
  return muniData[0].id;
}

/**
 * Correct an existing municipality's name, state or county.
 *
 * The slug deliberately stays as it was created. It is the durable config id:
 * the public RPCs look a town up by it and the repo keys
 * `config/towns/<slug>.json` on it, so a spelling fix to the display name is
 * not a reason to break those references. The state row is upserted first for
 * the same reason it is on create — `state_code` is a foreign key.
 */
export async function updateMunicipality(municipalityId, { name, stateCode, county }) {
  const code = stateCode.toUpperCase();
  const { error: stateError } = await supabase
    .from("states")
    .upsert({ code, name: stateNameFor(code) }, { onConflict: "code", ignoreDuplicates: true });
  if (stateError) throw stateError;

  // `last_updated` is left alone on purpose: it reports how current the town's
  // zoning data is, which renaming it does not change.
  const { data, error } = await supabase
    .from("municipalities")
    .update({ name, state_code: code, county: county || null })
    .eq("id", municipalityId)
    .select("id");
  if (error) throw error;
  assertWritten(data, "municipality update");
}

/**
 * What deleting a municipality would take with it. Shown before the fact,
 * because parcels are an NJGIN re-import rather than an undo.
 */
export async function municipalityImpact(municipalityId) {
  const [districts, parcels, zoningAreas] = await Promise.all([
    supabase.from("zoning_districts").select("id", { count: "exact", head: true })
      .eq("municipality_id", municipalityId),
    supabase.from("parcels").select("id", { count: "exact", head: true })
      .eq("municipality_id", municipalityId),
    supabase.from("zoning_areas").select("id", { count: "exact", head: true })
      .eq("municipality_id", municipalityId),
  ]);
  for (const r of [districts, parcels, zoningAreas]) if (r.error) throw r.error;
  return {
    districts: districts.count ?? 0,
    parcels: parcels.count ?? 0,
    zoningAreas: zoningAreas.count ?? 0,
  };
}

/**
 * How many zoning polygons each municipality has, keyed by id.
 *
 * The municipality list reports readiness, and "no zoning layer loaded" is the
 * one gap that cannot be seen in the nested config query — a town can have
 * districts and rules on file and still have nothing to intersect a parcel
 * with. Ids only, counted in the database; the geometry stays where it is.
 */
export async function zoningAreaCounts() {
  const { data, error } = await supabase.from("zoning_areas").select("municipality_id");
  if (error) throw error;
  const counts = new Map();
  for (const row of data ?? []) {
    counts.set(row.municipality_id, (counts.get(row.municipality_id) ?? 0) + 1);
  }
  return counts;
}

/** Replace one municipality's zoning polygons after the setup wizard has
 * validated their codes. Geometry arrives as WGS84 GeoJSON and is transformed
 * to the database's NJ State Plane storage projection by the RPC. */
export async function publishZoningLayer(
  municipalityId,
  features,
  { sourceUrl, sourceDate = null, srid = 4326 } = {}
) {
  const { data, error } = await supabase.rpc("admin_publish_zoning_layer", {
    p_municipality_id: municipalityId,
    p_features: features,
    p_source_url: sourceUrl || "Admin zoning setup",
    p_source_date: sourceDate,
    p_srid: srid,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Delete a municipality and everything hanging off it.
 *
 * Parcels go first and explicitly: their foreign key has no ON DELETE CASCADE,
 * so leaving them would fail the whole delete on a constraint violation.
 * Districts, the cost model, its tiers and the zoning polygons all cascade.
 */
export async function deleteMunicipality(municipalityId) {
  const { error: parcelError } = await supabase
    .from("parcels")
    .delete()
    .eq("municipality_id", municipalityId);
  if (parcelError) throw parcelError;

  const { data, error } = await supabase
    .from("municipalities")
    .delete()
    .eq("id", municipalityId)
    .select("id");
  if (error) throw error;
  assertWritten(data, "municipality delete");
}

/**
 * Delete one zoning district. Any zoning polygons pointing at it are set to
 * NULL by the schema, which resolve_parcel_zoning reports as `rules_missing` —
 * parcels there stop resolving rather than resolving to the wrong rules.
 */
export async function deleteDistrict(districtId) {
  const { data, error } = await supabase
    .from("zoning_districts")
    .delete()
    .eq("id", districtId)
    .select("id");
  if (error) throw error;
  assertWritten(data, "district delete");
}

/** Add one district to an existing municipality. */
export async function createDistrict(municipalityId, code, name) {
  const { data, error } = await supabase
    .from("zoning_districts")
    .insert({
      municipality_id: municipalityId,
      code,
      name: name || null,
      ...blankDistrictFields(),
    })
    .select("id");
  if (error) throw error;
  assertWritten(data, "district");
  return data[0].id;
}
