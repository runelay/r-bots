import { requestContext } from "../../../shared/http";
import type { Principal } from "./auth.middleware";
import type { Auth } from "./auth.service";
import { ownerRole } from "./auth.service";

const maxInstances = 32;
export const maxRememberedOrigins = 16;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function firstValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

export function normalizeOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hostHeader(request: Request) {
  return (request.headers.get("host") || new URL(request.url).host).toLowerCase();
}

function forwardedOrigin(request: Request) {
  const url = new URL(request.url);
  const proto = firstValue(request.headers.get("x-forwarded-proto"));
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1);
  const host = firstValue(request.headers.get("x-forwarded-host")) || hostHeader(request);
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

export function sameHost(host: string, origin: string) {
  try {
    const parsed = new URL(origin);
    return new URL(`${parsed.protocol}//${host}`).host === parsed.host;
  } catch {
    return false;
  }
}

export function requestOrigin(request: Request, known: string[] = []) {
  const url = new URL(request.url);
  if (requestContext(request).viaProxy) return forwardedOrigin(request) ?? url.origin;
  const host = hostHeader(request);
  const match = known.find((origin) => sameHost(host, origin));
  if (match) return match;
  try {
    return new URL(`${url.protocol}//${host}`).origin;
  } catch {
    return url.origin;
  }
}

export function effectiveHost(request: Request) {
  if (requestContext(request).viaProxy) {
    const forwarded = firstValue(request.headers.get("x-forwarded-host"));
    if (forwarded) return forwarded.toLowerCase();
  }
  return hostHeader(request);
}

export function parseAllowedHosts(value: string | undefined) {
  const origins: string[] = [];
  const hosts: string[] = [];
  for (const item of (value ?? "").split(",").map((entry) => entry.trim().toLowerCase())) {
    if (!item) continue;
    if (item.includes("://")) {
      const origin = normalizeOrigin(item);
      if (origin) origins.push(origin);
    } else hosts.push(item);
  }
  return { origins, hosts };
}

export interface OriginRegistryOptions {
  known?: string[];
  save?: (origins: string[]) => void | Promise<void>;
  allowedHosts?: string;
  port?: number;
}

export function createOriginRegistry(options: OriginRegistryOptions = {}) {
  const known = new Set(options.known?.map(normalizeOrigin).filter((value): value is string => Boolean(value)));
  const allowed = parseAllowedHosts(options.allowedHosts);

  function remembered() {
    return [...known];
  }

  function list() {
    return [...new Set([...allowed.origins, ...known])];
  }

  function originOf(request: Request) {
    return requestOrigin(request, list());
  }

  function loopbackAllowed(host: string, request: Request) {
    let parsed: URL;
    try {
      parsed = new URL(`http://${host}`);
    } catch {
      return false;
    }
    if (!loopbackHosts.has(parsed.hostname)) return false;
    const port = Number(parsed.port || 80);
    const listen = requestContext(request).listenPort;
    return port === options.port || (listen !== null && port === listen);
  }

  function hostAllowed(request: Request) {
    const host = effectiveHost(request);
    if (!host) return false;
    if (loopbackAllowed(host, request)) return true;
    if (requestContext(request).viaProxy && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d+)?$/.test(host)) return true;
    if (allowed.hosts.includes(host)) return true;
    return list().some((origin) => sameHost(host, origin));
  }

  async function remember(value: string, principal?: Principal | null) {
    if (!principal || principal.role !== ownerRole || principal.method === "internal") return false;
    const origin = normalizeOrigin(value);
    if (!origin || known.has(origin) || allowed.origins.includes(origin)) return false;
    if (known.size >= maxRememberedOrigins) return false;
    known.add(origin);
    await options.save?.(remembered());
    return true;
  }

  function trusts(origin: string, request: Request) {
    return origin === originOf(request) || list().includes(origin);
  }

  return { list, remembered, remember, trusts, originOf, hostAllowed };
}

export type OriginRegistry = ReturnType<typeof createOriginRegistry>;

export function misdirected() {
  return Response.json(
    { ok: false, error: "Endereço não reconhecido por este servidor.", code: "misdirected" },
    { status: 421, headers: { "cache-control": "no-store" } },
  );
}

export function createAuthPool(
  build: (origin: string) => Auth,
  fallback: string,
  resolve: (request: Request) => string = (request) => requestOrigin(request),
) {
  const instances = new Map<string, Auth>();
  const fallbackAuth = build(fallback);

  function forOrigin(origin: string) {
    if (origin === fallback) return fallbackAuth;
    const found = instances.get(origin);
    if (found) {
      instances.delete(origin);
      instances.set(origin, found);
      return found;
    }
    const created = build(origin);
    instances.set(origin, created);
    if (instances.size > maxInstances) {
      const oldest = instances.keys().next().value;
      if (oldest !== undefined) instances.delete(oldest);
    }
    return created;
  }

  return {
    fallback: fallbackAuth,
    forRequest: (request: Request) => forOrigin(resolve(request)),
    forOrigin,
    size: () => instances.size,
  };
}
