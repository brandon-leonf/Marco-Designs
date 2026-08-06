// The gis-proxy request handler.
//
// Kept separate from index.ts, and given its dependencies rather than reaching
// for them, so handler_test.ts can exercise the authorization gate, the SSRF
// refusals, the redirect handling and the size cap without a network, a database
// or a running Supabase stack. index.ts supplies the real implementations.

import { vetAddress, vetUrlShape } from "./vet.ts";

/** Headers a caller may ask us to send upstream. Nothing else is forwarded. */
const FORWARDABLE_REQUEST_HEADERS = new Set(["accept", "content-type"]);

/**
 * Headers worth passing back. The rest of the upstream response's headers are
 * dropped — notably `set-cookie`, which would otherwise set a cookie for this
 * function's own origin on behalf of a third-party server.
 */
const FORWARDABLE_RESPONSE_HEADERS = new Set(["content-type", "content-encoding"]);

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 3;

export interface ProxyDeps {
  /** True when the request's caller is a config admin. */
  verifyAdmin(request: Request): Promise<boolean>;
  resolveDns(host: string, type: "A" | "AAAA"): Promise<string[]>;
  fetchUpstream(request: Request): Promise<Response>;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface ProxyRequestBody {
  url?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    // The caller is authenticated by JWT, not by origin, and this function is
    // reached from GitHub Pages, from localhost during development, and from
    // any future host the editor is served on. Authorization is the gate; the
    // origin is not one, so it is echoed rather than guessed at.
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function handleProxyRequest(request: Request, deps: ProxyDeps): Promise<Response> {
  const cors = corsHeaders(request.headers.get("origin"));
  const fail = (status: number, reason: string) =>
    new Response(JSON.stringify({ error: reason }), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") {
    return fail(405, "Send a POST whose JSON body carries the target url.");
  }

  // Authorization first: nothing about the request body should be parsed, logged
  // or acted on for a caller who is not entitled to use the proxy at all.
  if (!request.headers.get("authorization")) {
    return fail(401, "This proxy requires a signed-in config admin.");
  }
  let isAdmin: boolean;
  try {
    isAdmin = await deps.verifyAdmin(request);
  } catch (error) {
    return fail(503, `The admin check could not be completed: ${messageOf(error)}`);
  }
  if (!isAdmin) {
    return fail(403, "Only accounts listed in admin_users may use the zoning-layer proxy.");
  }

  let payload: ProxyRequestBody;
  try {
    payload = await request.json();
  } catch {
    return fail(400, "The request body must be JSON.");
  }

  const vetted = vetUrlShape(payload.url ?? "");
  if (!vetted.ok) return fail(vetted.status, vetted.reason);

  const method = (payload.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return fail(400, `Only GET and POST are proxied; got "${method}".`);
  }

  let target = vetted.url;
  let body = payload.body ?? null;
  let upstream: Response;

  // Redirects are followed here rather than by fetch, because each hop's
  // destination has to go through the same checks as the first one.
  for (let hop = 0; ; hop += 1) {
    const address = await vetAddress(target, deps.resolveDns);
    if (!address.ok) {
      // On a later hop the refused address is one the operator never typed, so
      // saying only "10.1.2.3 is a private address" would look like nonsense
      // against the public URL they pasted.
      return fail(
        address.status,
        hop === 0
          ? address.reason
          : `${vetted.url.host} redirected to a target this proxy will not follow: ${address.reason}`
      );
    }

    const timeout = AbortSignal.timeout(deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
    try {
      upstream = await deps.fetchUpstream(
        new Request(target.toString(), {
          method,
          headers: forwardableHeaders(payload.headers),
          body: method === "POST" ? body : null,
          redirect: "manual",
          signal: timeout,
        })
      );
    } catch (error) {
      const reason = timeout.aborted
        ? `${target.host} did not respond within ${(deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS) / 1000}s.`
        : `${target.host} could not be reached: ${messageOf(error)}`;
      return fail(504, reason);
    }

    const location = upstream.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(upstream.status) || !location) break;
    if (hop >= MAX_REDIRECTS) {
      return fail(502, `${target.host} redirected more than ${MAX_REDIRECTS} times.`);
    }

    const next = vetUrlShape(new URL(location, target).toString());
    if (!next.ok) {
      return fail(
        next.status,
        `${target.host} redirected to a target this proxy will not follow: ${next.reason}`
      );
    }
    target = next.url;
    // 301/302/303 turn the follow-up into a GET without a body, per RFC 9110.
    if (upstream.status !== 307 && upstream.status !== 308) body = null;
  }

  const limited = await readCapped(upstream, deps.maxResponseBytes ?? MAX_RESPONSE_BYTES);
  if (!limited.ok) return fail(413, limited.reason);

  const headers = new Headers(cors);
  for (const [name, value] of upstream.headers) {
    if (FORWARDABLE_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  // So a caller can tell a proxied answer from a direct one when reading logs or
  // debugging an import that behaved differently through the two paths.
  headers.set("X-Gis-Proxy-Target", target.origin);
  return new Response(limited.body, { status: upstream.status, headers });
}

function forwardableHeaders(requested: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requested ?? {})) {
    if (FORWARDABLE_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  if (!headers.has("accept")) headers.set("Accept", "application/json, application/xml, */*");
  // Some municipal ArcGIS deployments answer differently — or not at all — to a
  // request with no user agent.
  headers.set("User-Agent", "demarco-zoning-importer/1.0 (+https://github.com/brandon-leonf/Marco-Designs)");
  return headers;
}

/**
 * Read the body, refusing it past a byte ceiling.
 *
 * `Content-Length` is a claim, not a fact, so the stream is counted as it
 * arrives. Buffering rather than streaming through is deliberate: the cap has to
 * be enforced before anything is returned, and a zoning layer that legitimately
 * exceeds 25 MB should be imported from a file rather than through a function
 * with a memory limit.
 */
async function readCapped(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; body: ArrayBuffer } | { ok: false; reason: string }> {
  const declared = Number(response.headers.get("content-length"));
  const tooBig = (bytes: number) =>
    `The layer returned ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ` +
    `${(maxBytes / 1024 / 1024).toFixed(0)} MB the proxy will relay. Request the layer in ` +
    "pages, or download it and upload the file instead.";

  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: tooBig(declared) };
  }
  if (!response.body) return { ok: true, body: new ArrayBuffer(0) };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: tooBig(total) };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, body: body.buffer };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
