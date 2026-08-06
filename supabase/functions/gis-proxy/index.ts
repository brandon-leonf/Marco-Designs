// gis-proxy — fetch a municipal zoning layer on the browser's behalf.
//
// Most published ArcGIS and WFS services allow cross-origin requests, and the
// importer in web/src/lib/gis talks to those directly: no server, nothing to
// deploy, nothing between the operator and the municipality's own data. Some
// services do not send CORS headers, and a browser cannot read those at all —
// not because the data is restricted, but because the server never says it is
// shareable. This function exists for exactly that case, and is only reached
// after a direct attempt has already failed.
//
// It is not a general proxy. The caller must be a config admin listed in
// admin_users, the target has to look like a GIS endpoint, and it has to resolve
// to a public address. See vet.ts for what is refused and why.
//
// Deploy:
//   supabase functions deploy gis-proxy --project-ref <ref>
//
// The frontend finds it at ${VITE_SUPABASE_URL}/functions/v1/gis-proxy with no
// extra configuration, and carries on working without it if it is not deployed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleProxyRequest, type ProxyDeps } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const deps: ProxyDeps = {
  /**
   * Authorization is the database's answer, not this function's.
   *
   * The client is created with the caller's own JWT and the anon key, so
   * `is_config_admin()` (migration 0009) evaluates against `auth.jwt()` exactly
   * as it does for every other admin write. The service-role key is deliberately
   * not used anywhere in this function: it would bypass RLS, and nothing here
   * needs to.
   *
   * The platform's own `verify_jwt` gate is not sufficient on its own — the anon
   * key is itself a valid project JWT, so any visitor could pass it.
   */
  async verifyAdmin(request) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("The function is missing SUPABASE_URL or SUPABASE_ANON_KEY.");
    }
    const authorization = request.headers.get("authorization") ?? "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.rpc("is_config_admin");
    if (error) throw new Error(error.message);
    return data === true;
  },

  async resolveDns(host, type) {
    return await Deno.resolveDns(host, type);
  },

  fetchUpstream(request) {
    return fetch(request);
  },
};

Deno.serve((request) => handleProxyRequest(request, deps));
