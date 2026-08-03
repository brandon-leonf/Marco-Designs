import { createClient } from "@supabase/supabase-js";
import { resolveZoningAreas } from "./zoningLookup.js";

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
         id, provenance, regional_baseline_per_sqft, local_cost_factor, effective_date, cost_scope,
         build_cost_tiers ( tier, rate_per_sqft, rate_per_sqft_max, notes, provenance, formula_reference )
       )`
    )
    .order("name");
  if (error) throw error;
  return (data ?? []).map((municipality) => ({
    ...municipality,
    zoning_districts: (municipality.zoning_districts ?? []).map((district) => ({
      ...district,
      // The editor and calculator use whole floors. Older 2.5-story records
      // become 3 floors while max_height_ft remains the total-building cap.
      max_stories:
        district.max_stories == null && district.extra_rules?.max_stories_exact == null
          ? null
          : Math.ceil(
              Number(district.extra_rules?.max_stories_exact ?? district.max_stories)
            ),
    })),
  }));
}

/**
 * Whether any NJGIN parcels have actually been imported for a municipality.
 * Address search is only offered when they have — an empty parcels table is a
 * load-state fact the UI should state plainly, not a search that finds nothing.
 */
export async function hasParcels(municipalityId) {
  const { data, error } = await supabase
    .from("parcels")
    .select("id")
    .eq("municipality_id", municipalityId)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
}

/** Address search against imported NJGIN parcels (RPC, read-only). */
export async function searchParcels(muniSlug, query, limit = 15) {
  const { data, error } = await supabase.rpc("search_parcels", {
    p_muni_slug: muniSlug,
    p_query: query,
    p_limit: limit,
  });
  if (error) throw error;
  // Tagged like the live sources so the picker can group results by how much
  // is known about them — see lib/njgin.js and lib/geocode.js.
  return (data ?? []).map((row) => ({ ...row, kind: "parcel", scope: "muni" }));
}

/**
 * Connect a parcel discovered through the statewide NJGIN point query to a
 * locally imported polygon when one exists. The local id unlocks the PostGIS
 * parcel/zoning intersection; absence is a normal parcel-only result.
 */
export async function findImportedParcelByPin(municipalityId, pamsPin) {
  if (!municipalityId || !pamsPin) return null;
  const { data, error } = await supabase
    .from("parcels")
    .select("id, pams_pin, lot_area_sqft, lot_frontage_ft, lot_depth_ft, mod_iv")
    .eq("municipality_id", municipalityId)
    .eq("pams_pin", pamsPin)
    .order("id")
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return {
    parcel_id: row.id,
    pams_pin: row.pams_pin,
    address: row.mod_iv?.PROP_LOC ?? null,
    block: row.mod_iv?.PCLBLOCK ?? null,
    lot: row.mod_iv?.PCLLOT ?? null,
    prop_class: row.mod_iv?.PROP_CLASS ?? null,
    lot_area_sqft: row.lot_area_sqft,
    land_desc: row.mod_iv?.LAND_DESC ?? null,
    lot_frontage_ft: row.lot_frontage_ft,
    lot_depth_ft: row.lot_depth_ft,
  };
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

/**
 * A municipality's zoning polygons as GeoJSON (EPSG:4326), for the map.
 * PostGIS does the reprojection and simplification — see migration 0013.
 */
export async function fetchZoningGeojson(muniSlug) {
  const { data, error } = await supabase.rpc("municipality_zoning_geojson", {
    p_muni_slug: muniSlug,
  });
  if (error) throw error;
  return data ?? [];
}

/**
 * Verify a live statewide NJGIN parcel against Marco's published zoning layer.
 * The parcel remains in NJGIN; only its WGS84 geometry crosses this read-only
 * boundary, so a separate local parcel import is not required.
 */
export async function resolvePublishedZoning(muniSlug, parcelGeojson) {
  const areas = await fetchZoningGeojson(muniSlug);
  return resolveZoningAreas(areas, parcelGeojson);
}

/** Where the zoning layer came from and what it does not cover. */
export async function fetchZoningProvenance(muniSlug) {
  const { data, error } = await supabase.rpc("municipality_zoning_provenance", {
    p_muni_slug: muniSlug,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}
