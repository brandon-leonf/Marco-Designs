// One place where the importer's network requests go out.
//
// Most published GIS services send `Access-Control-Allow-Origin`, and those are
// fetched straight from the browser: no server in the path, nothing between the
// operator and the municipality's own data, and nothing to deploy. Some services
// send no CORS headers at all, and a browser cannot read those — not because the
// layer is restricted, but because the server never says it may be shared.
//
// For that case there is `supabase/functions/gis-proxy`, and this module is the
// only thing that knows about it. The order matters and is deliberate: direct
// first, always, and the proxy only after a direct attempt has already failed.
// A town whose service is open never touches our infrastructure, the proxy stays
// a fallback rather than a dependency, and the importer keeps working unchanged
// when the function is not deployed.
//
// The awkward part of the design is not ours to fix: a browser reports a CORS
// refusal and a dead host identically, as `TypeError: Failed to fetch`, with no
// detail (that opacity is the point of the CORS model). So the retry cannot be
// conditional on the cause — anything that fails without a response gets one
// attempt through the proxy, and if that fails too the caller is told about both.

/** Requests that have gone through the proxy, so a caller can report the route. */
let proxyRequests = 0;
export const proxyRequestCount = () => proxyRequests;

/**
 * Fetch a GIS URL, falling back to the proxy when the browser cannot.
 *
 * Returns `{ response, viaProxy }`. A non-2xx status is a normal return, not a
 * throw: ArcGIS reports failure in the body, WFS in an XML exception, and both
 * callers read those themselves.
 */
export async function gisFetch(url, { method = "GET", headers = {}, body = null, signal } = {}) {
  try {
    const response = await fetch(url, { method, headers, body, signal });
    return { response, viaProxy: false };
  } catch (directError) {
    if (directError?.name === "AbortError") throw directError;

    const proxyUrl = proxyEndpoint();
    if (!proxyUrl) throw unreachable(url, directError, null);

    let response;
    try {
      response = await postToProxy(proxyUrl, { url, method, headers, body, signal });
    } catch (proxyError) {
      if (proxyError?.name === "AbortError") throw proxyError;
      throw unreachable(url, directError, proxyError);
    }

    // The function not being deployed is the one proxy failure with a specific
    // remedy, and it arrives as a 404 from the Supabase gateway rather than as a
    // network error, so it is worth telling apart from a refusal by the proxy.
    if (response.status === 404) {
      throw unreachable(
        url,
        directError,
        new Error(
          "the gis-proxy function is not deployed to this Supabase project (run " +
            "`supabase functions deploy gis-proxy`)"
        )
      );
    }
    // A refusal *by* the proxy — not by the upstream service — is our own
    // message and should reach the operator as written rather than as a status.
    if (response.status >= 400 && isProxyRefusal(response)) {
      throw new Error(`${await refusalMessage(response)} (target: ${url})`);
    }

    proxyRequests += 1;
    return { response, viaProxy: true };
  }
}

/**
 * POST the request the browser could not make itself.
 *
 * The target goes in the JSON body rather than in a query parameter so it stays
 * out of URLs, logs and referrers, and so an ArcGIS form body passes through
 * without a second round of encoding.
 */
async function postToProxy(proxyUrl, { url, method, headers, body, signal }) {
  const { accessToken, anonKey } = await proxyCredentials();
  if (!accessToken) {
    throw new Error("no config-admin session is signed in, so the proxy cannot be used");
  }

  return fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(anonKey ? { apikey: anonKey } : {}),
    },
    body: JSON.stringify({
      url,
      method,
      body: typeof body === "string" ? body : body ? String(body) : null,
      headers: Object.fromEntries(
        Object.entries(headers ?? {}).filter(([name]) =>
          /^(accept|content-type)$/i.test(name)
        )
      ),
    }),
    signal,
  });
}

/**
 * The signed-in session's token.
 *
 * `supabase.js` is imported lazily and only on a proxy attempt. It reads
 * `import.meta.env` at module scope, which does not exist under Node — and
 * `npm run test:gis` imports these GIS modules directly. Keeping the import
 * inside this function is what lets that verification run without a browser.
 */
async function proxyCredentials() {
  try {
    const { supabase } = await import("../supabase.js");
    const { data } = (await supabase?.auth.getSession()) ?? {};
    return {
      accessToken: data?.session?.access_token ?? null,
      anonKey: viteEnv("VITE_SUPABASE_ANON_KEY"),
    };
  } catch {
    return { accessToken: null, anonKey: null };
  }
}

/**
 * Where the proxy lives, or null when there is none.
 *
 * Derived from the Supabase project URL so deploying the function is the only
 * step — there is no second setting to keep in sync with it. `VITE_GIS_PROXY_URL`
 * overrides that for a proxy hosted somewhere else.
 */
function proxyEndpoint() {
  const explicit = viteEnv("VITE_GIS_PROXY_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const supabaseUrl = viteEnv("VITE_SUPABASE_URL");
  return supabaseUrl ? `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/gis-proxy` : null;
}

function viteEnv(name) {
  try {
    // Vite replaces `import.meta.env` at build time; under Node it is undefined,
    // and reading a property of it would throw rather than return nothing.
    return import.meta.env?.[name] || null;
  } catch {
    return null;
  }
}

/** Whether a failing response came from our own proxy rather than the service. */
function isProxyRefusal(response) {
  // The proxy answers its own refusals as JSON and never sets this header on
  // them; an upstream error it relays always carries the header.
  return !response.headers.get("X-Gis-Proxy-Target");
}

async function refusalMessage(response) {
  try {
    const body = await response.json();
    return body?.error ?? `The zoning proxy returned HTTP ${response.status}.`;
  } catch {
    return `The zoning proxy returned HTTP ${response.status}.`;
  }
}

/**
 * The message for a service neither route could reach.
 *
 * Both attempts are named, because which one to act on differs: a service that
 * refused CORS *and* has no proxy behind it is a deployment task, while one the
 * proxy also could not reach is either offline or genuinely private.
 */
function unreachable(url, directError, proxyError) {
  const host = safeHost(url);
  if (!proxyError) {
    return new Error(
      `${host} could not be reached from the browser. The service may be offline, or it may ` +
        "not allow cross-origin requests — deploy the gis-proxy function to fetch services " +
        "that don't, or download the layer and upload the file instead."
    );
  }
  return new Error(
    `${host} could not be reached directly (the service sends no CORS headers, or is offline), ` +
      `and the proxy could not reach it either: ${proxyError.message}. Download the layer ` +
      "from its own portal and upload the file instead."
  );
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
