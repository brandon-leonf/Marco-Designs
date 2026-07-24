import { supabase } from "./supabase.js";

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

export async function saveDistrict(districtId, fields) {
  const { data, error } = await supabase
    .from("zoning_districts")
    .update(fields)
    .eq("id", districtId)
    .select("id");
  if (error) throw error;
  assertWritten(data, "zoning district");
}

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
 * Save the cost model + its three tier rates. The DB provenance_fields CHECK
 * requires baseline/factor to be set for estimated models and NULL for
 * verified ones, so the caller must pass them accordingly.
 */
export async function saveCostModel(municipalityId, existingModelId, model, tierRates) {
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

  const rows = Object.entries(tierRates).map(([tier, rate]) => ({
    cost_model_id: modelId,
    tier,
    rate_per_sqft: rate,
    provenance: model.provenance,
    formula_reference: "config_editor",
  }));
  const { data: tierData, error: tierError } = await supabase
    .from("build_cost_tiers")
    .upsert(rows, { onConflict: "cost_model_id,tier" })
    .select("id");
  if (tierError) throw tierError;
  assertWritten(tierData, "cost tier");
}
