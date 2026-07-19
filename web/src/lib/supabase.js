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
