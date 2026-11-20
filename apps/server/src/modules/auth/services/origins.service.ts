import type { Auth } from "./auth.service";

const maxInstances = 32;

function firstValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

export function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const proto = firstValue(request.headers.get("x-forwarded-proto"));
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1);
  const host = firstValue(request.headers.get("x-forwarded-host")) || request.headers.get("host") || url.host;
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

export function normalizeOrigin(value: string) {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export interface OriginRegistryOptions {
  known?: string[];
  save?: (origins: string[]) => void | Promise<void>;
}

export function createOriginRegistry(options: OriginRegistryOptions = {}) {
  const known = new Set(options.known?.map(normalizeOrigin).filter((value): value is string => Boolean(value)));

  function list() {
    return [...known];
  }

  async function remember(value: string) {
    const origin = normalizeOrigin(value);
    if (!origin || known.has(origin)) return false;
    known.add(origin);
    await options.save?.(list());
    return true;
  }

  function trusts(origin: string, request: Request) {
    return origin === requestOrigin(request) || known.has(origin);
  }

  return { list, remember, trusts };
}

export type OriginRegistry = ReturnType<typeof createOriginRegistry>;

export function createAuthPool(build: (origin: string) => Auth, fallback: string) {
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
    forRequest: (request: Request) => forOrigin(requestOrigin(request)),
    forOrigin,
    size: () => instances.size,
  };
}
