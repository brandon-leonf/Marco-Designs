import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Null when env vars are missing so the app can render setup instructions
// instead of crashing at import time.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

/**
 * One municipality with its districts, cost model, and tiers in a single
 * nested PostgREST query. RLS (migration 0006) makes all of this read-only.
 */
export async function fetchMunicipalities() {
  const { data, error } = await supabase
    .from("municipalities")
    .select(
      `id, name, slug, county, state_code, last_updated, source_url,
       zoning_districts (*),
       build_cost_models (
         id, provenance, regional_baseline_per_sqft, local_cost_factor, effective_date,
         build_cost_tiers ( tier, rate_per_sqft, provenance, formula_reference )
       )`
    )
    .order("name");
  if (error) throw error;
  return data;
}

/** Address search against imported NJGIN parcels (RPC, read-only). */
export async function searchParcels(muniSlug, query, limit = 15) {
  const { data, error } = await supabase.rpc("search_parcels", {
    p_muni_slug: muniSlug,
    p_query: query,
    p_limit: limit,
  });
  if (error) throw error;
  return data;
}

/**
 * Authoritative zoning check for a parcel polygon. The database intersects
 * the parcel with the municipality's zoning layer and returns the dominant
 * district or an explicit no-layer/conflict/unmapped status. The UI must not
 * fall back to a manually selected district for a found parcel.
 */
export async function resolveParcelZoning(parcelId) {
  const { data, error } = await supabase.rpc("resolve_parcel_zoning", {
    p_parcel_id: parcelId,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * One parcel + its buildable envelope, computed by PostGIS on the real
 * polygon. insetFt should be the LARGEST applicable setback (conservative
 * uniform inset — per-edge offsetting is the rules engine's job).
 */
export async function fetchParcelEnvelope(parcelId, insetFt) {
  const { data, error } = await supabase.rpc("parcel_envelope", {
    p_parcel_id: parcelId,
    p_inset_ft: insetFt,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}
