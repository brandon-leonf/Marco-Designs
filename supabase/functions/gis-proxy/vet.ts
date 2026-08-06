// What the zoning-layer proxy is allowed to fetch.
//
// A proxy that forwards any URL an authenticated caller names is a
// server-side request forgery hole: the function runs inside Supabase's network
// and can reach addresses the caller cannot, including cloud metadata endpoints
// and any private service on the same network. So this module answers one
// question — may we fetch this? — and answers it conservatively, in three
// independent layers:
//
//   1. Shape.   The URL has to look like a GIS endpoint. This is not a security
//               boundary on its own, but it turns "open proxy" into "GIS proxy"
//               and makes any other use of it an obvious anomaly.
//   2. Port.    Only the ports GIS servers are published on.
//   3. Address. The host must resolve to a public address. Literal IPs are
//               checked directly; names are resolved and every answer checked,
//               because `zoning.evil.test` resolving to 169.254.169.254 is the
//               textbook version of this attack.
//
// Layer 3 is the one that matters, and it is applied to redirect targets too —
// a public host answering 302 to an internal one is otherwise a way straight
// through layers 1 and 2.
//
// Residual risk, stated rather than papered over: between resolving a name and
// fetching it, a DNS record with a very short TTL can change (DNS rebinding).
// Closing that needs the fetch pinned to the address that was checked, which
// Deno's fetch cannot express without breaking TLS certificate validation. The
// exposure is one request to an internal address by a caller who is already an
// authenticated config admin, and whose response still has to survive the
// checks above to be returned.

/** Ports GIS servers actually listen on. Anything else is refused. */
const ALLOWED_PORTS = new Set([
  "", // default for the scheme
  "80",
  "443",
  "6080", // ArcGIS Server HTTP
  "6443", // ArcGIS Server HTTPS
  "8080", // GeoServer / Tomcat
  "8443",
]);

/** URL shapes that belong to a zoning layer. */
const SHAPES: Array<[RegExp, string]> = [
  [/\/rest\/services\//i, "ArcGIS REST service"],
  [/\/(feature|map|image)server(\/\d+)?(\/query)?\/?$/i, "ArcGIS server endpoint"],
  [/\/sharing\/rest\/content\/items\/[0-9a-f]{32}/i, "ArcGIS portal item"],
  [/\/(wfs|ows|geoserver|qgisserver|mapserv)(\/|$)/i, "OGC service"],
  [/\.(geojson|json)$/i, "GeoJSON file"],
];

/** Host suffixes that can only name something inside a network. */
const PRIVATE_SUFFIXES = [
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".cluster.local",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

export type VetResult =
  | { ok: true; url: URL; shape: string }
  | { ok: false; status: number; reason: string };

/**
 * Check everything about a URL that can be checked without a network round
 * trip. `vetAddress` does the rest and has to be awaited separately.
 */
export function vetUrlShape(raw: string): VetResult {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, status: 400, reason: "The target is not a valid absolute URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      status: 400,
      reason: `Only http and https targets are proxied; got "${url.protocol}".`,
    };
  }
  // Credentials in the URL would be forwarded upstream, and are never part of a
  // published layer's address.
  if (url.username || url.password) {
    return { ok: false, status: 400, reason: "The target URL must not carry credentials." };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return {
      ok: false,
      status: 400,
      reason:
        `Port ${url.port} is not proxied. GIS services are published on 80, 443, ` +
        "6080, 6443, 8080 or 8443.",
    };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, status: 403, reason: `"${host}" is not a public host.` };
  }
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, status: 403, reason: `"${host}" names a private network host.` };
  }
  // A single-label name has no public DNS meaning; it can only resolve inside a
  // network's own search domain. Literal IPs are exempt and handled by address.
  if (!host.includes(".") && !host.includes(":") && !isIpLiteral(host)) {
    return { ok: false, status: 403, reason: `"${host}" is not a fully qualified host name.` };
  }

  const target = `${url.pathname}${url.search}`;
  const shape = SHAPES.find(([pattern]) => pattern.test(url.pathname))?.[1] ??
    (/[?&]service=wfs(&|$)/i.test(url.search) ? "OGC WFS request" : null);
  if (!shape) {
    return {
      ok: false,
      status: 403,
      reason:
        `"${target}" does not look like a GIS endpoint. This proxy forwards ArcGIS REST ` +
        "services, OGC WFS requests and GeoJSON files only.",
    };
  }

  return { ok: true, url, shape };
}

/**
 * Confirm the host resolves only to public addresses.
 *
 * `resolve` is injected so this is testable without DNS, and so the caller
 * decides what a resolver is. A name that does not resolve is refused: a proxy
 * that treats "cannot resolve" as "probably fine" has no address layer at all.
 */
export async function vetAddress(
  url: URL,
  resolve: (host: string, type: "A" | "AAAA") => Promise<string[]>
): Promise<{ ok: true; addresses: string[] } | { ok: false; status: number; reason: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIpLiteral(host)) {
    const blocked = blockedAddressReason(host);
    return blocked
      ? { ok: false, status: 403, reason: blocked }
      : { ok: true, addresses: [host] };
  }

  const settled = await Promise.allSettled([resolve(host, "A"), resolve(host, "AAAA")]);
  const addresses = settled
    .filter((entry): entry is PromiseFulfilledResult<string[]> => entry.status === "fulfilled")
    .flatMap((entry) => entry.value);

  if (addresses.length === 0) {
    return { ok: false, status: 502, reason: `"${host}" could not be resolved.` };
  }
  for (const address of addresses) {
    const blocked = blockedAddressReason(address);
    if (blocked) {
      return {
        ok: false,
        status: 403,
        reason: `"${host}" resolves to ${address}, which is not a public address.`,
      };
    }
  }
  return { ok: true, addresses };
}

/** Why an address may not be fetched, or null when it is public. */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIpv4(address);
  if (v4) return reasonForIpv4(v4);

  const v6 = parseIpv6(address);
  if (v6) {
    // An IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96) address carries a
    // v4 address in its low 32 bits and has to be judged as that address.
    const mapped = embeddedIpv4(v6);
    if (mapped) return reasonForIpv4(mapped) ?? null;
    return reasonForIpv6(v6);
  }
  return `"${address}" is not an address this proxy can check.`;
}

function reasonForIpv4(octets: number[]): string | null {
  const [a, b] = octets;
  const text = octets.join(".");
  const range = (label: string) => `${text} is ${label}`;

  if (a === 0) return range("an unspecified address");
  if (a === 10) return range("a private address (10/8)");
  if (a === 127) return range("a loopback address");
  if (a === 100 && b >= 64 && b <= 127) return range("a carrier-NAT address (100.64/10)");
  if (a === 169 && b === 254) return range("a link-local address (cloud metadata lives here)");
  if (a === 172 && b >= 16 && b <= 31) return range("a private address (172.16/12)");
  if (a === 192 && b === 168) return range("a private address (192.168/16)");
  if (a === 192 && b === 0 && octets[2] === 0) return range("IETF-reserved (192.0.0/24)");
  if (a === 198 && (b === 18 || b === 19)) return range("a benchmarking address (198.18/15)");
  if (a >= 224) return range("multicast or reserved");
  return null;
}

function reasonForIpv6(groups: number[]): string | null {
  const text = groups.map((group) => group.toString(16)).join(":");
  const isZero = groups.every((group) => group === 0);
  if (isZero) return `${text} is the unspecified address`;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return `${text} is the loopback address`;
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return `${text} is a unique-local address (fc00::/7)`;
  if ((groups[0] & 0xffc0) === 0xfe80) return `${text} is a link-local address (fe80::/10)`;
  if ((groups[0] & 0xff00) === 0xff00) return `${text} is a multicast address`;
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) {
    return `${text} is a discard-only address (100::/64)`;
  }
  return null;
}

/** The IPv4 address inside a v4-mapped or NAT64 IPv6 address, if there is one. */
function embeddedIpv4(groups: number[]): number[] | null {
  const isV4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isNat64 =
    groups[0] === 0x0064 && groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0);
  if (!isV4Mapped && !isNat64) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

/**
 * Strict dotted-quad parsing.
 *
 * Strictness is safe here because of what happens upstream of it. `2130706433`,
 * `0x7f000001`, `017700000001` and `127.1` are all ways of writing a loopback
 * address, and each is the sort of encoding a hand-rolled parser misses — but
 * the WHATWG URL parser normalizes every one of them to `127.0.0.1` before this
 * function ever sees the host. So the only spelling that reaches here is the
 * canonical one, and accepting a lenient variant would add nothing but ways to
 * get the range comparisons wrong.
 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** IPv6 parsing, including `::` compression and a trailing dotted-quad. */
function parseIpv6(host: string): number[] | null {
  const text = host.replace(/^\[|\]$/g, "").split("%")[0];
  if (!text.includes(":")) return null;

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const expand = (chunk: string): number[] | null => {
    if (chunk === "") return [];
    const groups: number[] = [];
    const pieces = chunk.split(":");
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      // A dotted-quad tail is only legal as the last piece.
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}
