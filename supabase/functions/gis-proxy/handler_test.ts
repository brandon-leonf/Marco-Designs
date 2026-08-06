// Tests for the zoning-layer proxy.
//
//   deno test --allow-none supabase/functions/gis-proxy/
//
// Everything the proxy refuses is a security property, so each refusal is
// asserted rather than assumed: the authorization gate, the address checks that
// stop server-side request forgery, redirect handling, and the response cap. No
// network, no database and no Supabase stack — handler.ts takes its dependencies
// as arguments precisely so this file can supply hostile ones.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleProxyRequest, type ProxyDeps } from "./handler.ts";
import { blockedAddressReason, vetUrlShape } from "./vet.ts";

const LAYER = "https://services2.arcgis.com/abc/arcgis/rest/services/Zoning/FeatureServer/0/query";

/** A dependency set that answers predictably; each test overrides what it needs. */
function deps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    verifyAdmin: () => Promise.resolve(true),
    resolveDns: () => Promise.resolve(["93.184.216.34"]),
    fetchUpstream: () =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
          headers: { "Content-Type": "application/json", "Set-Cookie": "session=leaked" },
        })
      ),
    ...overrides,
  };
}

function proxyRequest(body: unknown, headers: Record<string, string> = { authorization: "Bearer jwt" }) {
  return new Request("https://project.supabase.co/functions/v1/gis-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const errorOf = async (response: Response) => (await response.json()).error as string;

/* ------------------------------------------------------------- authorization */

Deno.test("a request with no Authorization header is rejected before anything else", async () => {
  let verified = false;
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }, {}),
    deps({ verifyAdmin: () => { verified = true; return Promise.resolve(true); } })
  );
  assertEquals(response.status, 401);
  assert(!verified, "the admin check should not run without an Authorization header");
});

Deno.test("a signed-in non-admin is refused", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({ verifyAdmin: () => Promise.resolve(false) })
  );
  assertEquals(response.status, 403);
  assertStringIncludes(await errorOf(response), "admin_users");
});

Deno.test("the target is never fetched when authorization fails", async () => {
  let fetched = false;
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      verifyAdmin: () => Promise.resolve(false),
      fetchUpstream: () => { fetched = true; return Promise.resolve(new Response("")); },
    })
  );
  assertEquals(response.status, 403);
  assert(!fetched, "an unauthorized caller must not cause an upstream request");
});

Deno.test("an admin check that throws reports unavailable rather than allowing through", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({ verifyAdmin: () => Promise.reject(new Error("database unreachable")) })
  );
  assertEquals(response.status, 503);
  assertStringIncludes(await errorOf(response), "database unreachable");
});

/* -------------------------------------------------------------------- method */

Deno.test("only POST is accepted, and OPTIONS preflights succeed", async () => {
  const options = await handleProxyRequest(
    new Request("https://project.supabase.co/functions/v1/gis-proxy", {
      method: "OPTIONS",
      headers: { origin: "https://brandon-leonf.github.io" },
    }),
    deps()
  );
  assertEquals(options.status, 204);
  assertEquals(
    options.headers.get("Access-Control-Allow-Origin"),
    "https://brandon-leonf.github.io"
  );

  const get = await handleProxyRequest(
    new Request("https://project.supabase.co/functions/v1/gis-proxy"),
    deps()
  );
  assertEquals(get.status, 405);
});

Deno.test("an upstream method other than GET or POST is refused", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER, method: "DELETE" }),
    deps()
  );
  assertEquals(response.status, 400);
  assertStringIncludes(await errorOf(response), "Only GET and POST");
});

/* ------------------------------------------------------- address refusals */

Deno.test("addresses that must never be reachable are all recognised", () => {
  const mustBlock = [
    ["169.254.169.254", "cloud metadata"],
    ["127.0.0.1", "loopback"],
    ["10.0.0.5", "private 10/8"],
    ["172.16.0.1", "private 172.16/12"],
    ["172.31.255.255", "private 172.16/12 upper bound"],
    ["192.168.1.1", "private 192.168/16"],
    ["100.64.0.1", "carrier NAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["198.18.0.1", "benchmarking"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fc00::1", "IPv6 unique-local"],
    ["fd12:3456::1", "IPv6 unique-local"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata address"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["64:ff9b::169.254.169.254", "NAT64-embedded metadata address"],
  ];
  for (const [address, why] of mustBlock) {
    assert(blockedAddressReason(address) !== null, `${address} (${why}) must be blocked`);
  }

  for (const address of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assertEquals(blockedAddressReason(address), null, `${address} should be allowed`);
  }
});

Deno.test("a public host resolving to an internal address is refused", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: "https://zoning.example.gov/arcgis/rest/services/Z/FeatureServer/0" }),
    deps({ resolveDns: () => Promise.resolve(["169.254.169.254"]) })
  );
  assertEquals(response.status, 403);
  assertStringIncludes(await errorOf(response), "169.254.169.254");
});

Deno.test("one internal answer among several public ones is enough to refuse", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: "https://zoning.example.gov/arcgis/rest/services/Z/FeatureServer/0" }),
    deps({ resolveDns: () => Promise.resolve(["93.184.216.34", "10.1.2.3"]) })
  );
  assertEquals(response.status, 403);
  assertStringIncludes(await errorOf(response), "10.1.2.3");
});

Deno.test("a host that does not resolve is refused rather than attempted", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: "https://nope.example.gov/arcgis/rest/services/Z/FeatureServer/0" }),
    deps({ resolveDns: () => Promise.reject(new Error("NXDOMAIN")) })
  );
  assertEquals(response.status, 502);
  assertStringIncludes(await errorOf(response), "could not be resolved");
});

Deno.test("hosts that can only be internal are refused without a lookup", async () => {
  const targets = [
    "http://localhost/arcgis/rest/services/Z/FeatureServer/0",
    "http://gis.local/arcgis/rest/services/Z/FeatureServer/0",
    "http://gis.internal/arcgis/rest/services/Z/FeatureServer/0",
    "http://metadata.google.internal/computeMetadata/v1beta1/zoning.json",
    "http://intranet/arcgis/rest/services/Z/FeatureServer/0",
    "http://169.254.169.254/latest/meta-data/zoning.json",
  ];
  for (const url of targets) {
    let resolved = false;
    const response = await handleProxyRequest(
      proxyRequest({ url }),
      deps({ resolveDns: () => { resolved = true; return Promise.resolve(["1.1.1.1"]); } })
    );
    assert(response.status === 403, `${url} should be refused, got ${response.status}`);
    assert(!resolved || url.includes("169.254"), `${url} should not need a DNS lookup`);
  }
});

Deno.test("obfuscated loopback and metadata spellings are refused", async () => {
  // Every one of these is a way of writing 127.0.0.1 or 169.254.169.254 that a
  // hand-rolled IP parser would miss. They are caught because `new URL()`
  // normalizes each to its dotted quad before the address check runs — asserted
  // here rather than assumed, since the whole address layer rests on it.
  const spellings = [
    "2130706433", // decimal 127.0.0.1
    "0x7f000001", // hex
    "017700000001", // octal
    "127.1", // short form
    "2852039166", // decimal 169.254.169.254
    "0xA9FEA9FE", // hex metadata address
  ];
  for (const host of spellings) {
    let fetched = false;
    const response = await handleProxyRequest(
      proxyRequest({ url: `http://${host}/arcgis/rest/services/Z/FeatureServer/0` }),
      deps({ fetchUpstream: () => { fetched = true; return Promise.resolve(new Response("")); } })
    );
    assertEquals(response.status, 403, `${host} should be refused`);
    assert(!fetched, `${host} must not be fetched`);
  }
});

/* -------------------------------------------------------------- url shapes */

Deno.test("only GIS-shaped URLs are forwarded", () => {
  const allowed = [
    "https://services2.arcgis.com/x/arcgis/rest/services/Zoning/FeatureServer/0/query",
    "https://gis.town.gov/arcgis/rest/services/Zoning/MapServer",
    "https://maps.town.gov/server/rest/services/Zoning/FeatureServer",
    "https://www.arcgis.com/sharing/rest/content/items/0123456789abcdef0123456789abcdef",
    "https://gis.town.gov/geoserver/ows?service=WFS&request=GetCapabilities",
    "https://gis.town.gov/wfs?service=wfs&request=GetFeature",
    "https://opendata.town.gov/datasets/zoning.geojson",
  ];
  for (const url of allowed) {
    const vetted = vetUrlShape(url);
    assert(vetted.ok, `${url} should be allowed: ${vetted.ok === false ? vetted.reason : ""}`);
  }

  const refused = [
    "https://api.github.com/user",
    "https://example.gov/admin/delete-everything",
    "https://mail.google.com/mail/u/0/",
    "file:///etc/passwd",
    "gopher://example.gov/",
    "https://user:pass@gis.town.gov/arcgis/rest/services/Z/FeatureServer/0",
    "https://gis.town.gov:22/arcgis/rest/services/Z/FeatureServer/0",
    "https://gis.town.gov:9200/arcgis/rest/services/Z/FeatureServer/0",
    "not a url at all",
  ];
  for (const url of refused) {
    assert(!vetUrlShape(url).ok, `${url} should be refused`);
  }
});

/* --------------------------------------------------------------- redirects */

Deno.test("a redirect to an internal host is not followed", async () => {
  let hops = 0;
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      fetchUpstream: () => {
        hops += 1;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/zoning.json" },
          })
        );
      },
    })
  );
  assertEquals(response.status, 403);
  assertEquals(hops, 1, "the redirect target must not be fetched");
  // The message has to name both the redirect and the address, because the
  // operator pasted a public URL and never saw the internal one.
  const reason = await errorOf(response);
  assertStringIncludes(reason, "will not follow");
  assertStringIncludes(reason, "169.254.169.254");
});

Deno.test("a redirect to another public GIS endpoint is followed and re-checked", async () => {
  const seen: string[] = [];
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      fetchUpstream: (request) => {
        seen.push(request.url);
        if (seen.length === 1) {
          return Promise.resolve(
            new Response(null, {
              status: 301,
              headers: { location: "https://gis2.example.gov/arcgis/rest/services/Z/FeatureServer/0" },
            })
          );
        }
        return Promise.resolve(new Response('{"ok":true}', {
          headers: { "Content-Type": "application/json" },
        }));
      },
    })
  );
  assertEquals(response.status, 200);
  assertEquals(seen.length, 2);
  assertStringIncludes(seen[1], "gis2.example.gov");
  assertEquals(response.headers.get("X-Gis-Proxy-Target"), "https://gis2.example.gov");
});

Deno.test("a redirect loop stops at the hop limit", async () => {
  let hops = 0;
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      fetchUpstream: () => {
        hops += 1;
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: LAYER } })
        );
      },
    })
  );
  assertEquals(response.status, 502);
  assert(hops <= 4, `expected at most 4 requests, made ${hops}`);
});

/* ------------------------------------------------------ request hygiene */

Deno.test("only Accept and Content-Type are forwarded upstream", async () => {
  const sentHeaders: Headers[] = [];
  await handleProxyRequest(
    proxyRequest({
      url: LAYER,
      method: "POST",
      body: "f=json&where=1%3D1",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        // A caller must not be able to make the proxy carry these.
        Authorization: "Bearer someone-elses-token",
        Cookie: "session=secret",
        "X-Forwarded-For": "10.0.0.1",
      },
    }),
    deps({
      fetchUpstream: (request) => {
        sentHeaders.push(request.headers);
        return Promise.resolve(new Response("{}", { headers: { "Content-Type": "application/json" } }));
      },
    })
  );
  assertEquals(sentHeaders.length, 1);
  const sent = sentHeaders[0];
  assertEquals(sent.get("content-type"), "application/x-www-form-urlencoded");
  assertEquals(sent.get("accept"), "application/json");
  assertEquals(sent.get("authorization"), null);
  assertEquals(sent.get("cookie"), null);
  assertEquals(sent.get("x-forwarded-for"), null);
});

Deno.test("the upstream body and method reach the service unchanged", async () => {
  let method = "";
  let body = "";
  await handleProxyRequest(
    proxyRequest({ url: LAYER, method: "POST", body: "f=json&resultOffset=1000" }),
    deps({
      fetchUpstream: async (request) => {
        method = request.method;
        body = await request.text();
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    })
  );
  assertEquals(method, "POST");
  assertEquals(body, "f=json&resultOffset=1000");
});

/* ----------------------------------------------------- response hygiene */

Deno.test("Set-Cookie is not passed back to the browser", async () => {
  const response = await handleProxyRequest(proxyRequest({ url: LAYER }), deps());
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals((await response.json()).type, "FeatureCollection");
});

Deno.test("an upstream error status is relayed rather than flattened", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      fetchUpstream: () =>
        Promise.resolve(new Response('{"error":{"code":403}}', {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })),
    })
  );
  // The importer's own error handling reads the ArcGIS error body, so the status
  // and the body both have to survive the hop.
  assertEquals(response.status, 403);
  assertStringIncludes(await response.text(), '"code":403');
});

Deno.test("a response past the byte cap is refused, by declared length or by stream", async () => {
  const declared = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      maxResponseBytes: 1024,
      fetchUpstream: () =>
        Promise.resolve(new Response("x".repeat(64), {
          headers: { "Content-Length": "999999999", "Content-Type": "application/json" },
        })),
    })
  );
  assertEquals(declared.status, 413);

  // A server that lies about (or omits) Content-Length must still be capped.
  const streamed = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      maxResponseBytes: 1024,
      fetchUpstream: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(512));
              },
            }),
            { headers: { "Content-Type": "application/json" } }
          )
        ),
    })
  );
  assertEquals(streamed.status, 413);
  assertStringIncludes(await errorOf(streamed), "over the");
});

Deno.test("a response within the cap comes back whole", async () => {
  const payload = JSON.stringify({ features: new Array(200).fill({ type: "Feature" }) });
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      fetchUpstream: () =>
        Promise.resolve(new Response(payload, { headers: { "Content-Type": "application/json" } })),
    })
  );
  assertEquals(response.status, 200);
  assertEquals(await response.text(), payload);
});

/* ------------------------------------------------------------- transport */

Deno.test("an upstream that never answers becomes a gateway timeout", async () => {
  const response = await handleProxyRequest(
    proxyRequest({ url: LAYER }),
    deps({
      timeoutMs: 50,
      fetchUpstream: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        }),
    })
  );
  assertEquals(response.status, 504);
  assertStringIncludes(await errorOf(response), "did not respond within");
});

Deno.test("a malformed request body is a 400, not a crash", async () => {
  const response = await handleProxyRequest(
    new Request("https://project.supabase.co/functions/v1/gis-proxy", {
      method: "POST",
      headers: { authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: "{not json",
    }),
    deps()
  );
  assertEquals(response.status, 400);
});

Deno.test("a request with no url is a 400", async () => {
  const response = await handleProxyRequest(proxyRequest({}), deps());
  assertEquals(response.status, 400);
  assertStringIncludes(await errorOf(response), "valid absolute URL");
});
