import { timingSafeEqual } from "node:crypto";
import { type Auth, apiKeyPrefix, authBasePath, devicePagePath, memberRole } from "./auth.service";

export interface Principal {
  userId: string;
  email: string;
  name: string;
  role: string;
  method: "session" | "api-key" | "internal";
  sessionId?: string;
  apiKeyId?: string;
  expiresAt?: string;
}

export type AuthOutcome = { kind: "public" } | { kind: "principal"; principal: Principal };

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function isPublicRoute(method: string, pathname: string) {
  if (pathname === "/health") return true;
  if (pathname === authBasePath || pathname.startsWith(`${authBasePath}/`)) return true;
  if (pathname === devicePagePath && method === "GET") return true;
  if (pathname === "/auth/setup" && (method === "GET" || method === "POST")) return true;
  if (pathname === "/auth/providers" && method === "GET") return true;
  if (pathname === "/auth/invites/accept" && method === "POST") return true;
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "mcp" && parts.length === 3) return true;
  if (parts[0] === "preview") return true;
  return false;
}

export function unauthorized(message = "Entre de novo para continuar.") {
  return Response.json(
    { ok: false, error: message, code: "unauthorized" },
    { status: 401, headers: { "www-authenticate": 'Bearer realm="runelay-bots"', "cache-control": "no-store" } },
  );
}

function forbidden(message: string) {
  return Response.json({ ok: false, error: message, code: "forbidden" }, { status: 403 });
}

export function readToken(headers: Headers) {
  const header = headers.get("authorization") ?? "";
  if (header.slice(0, 7).toLowerCase() === "bearer ") {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const apiKey = headers.get("x-api-key")?.trim();
  return apiKey || null;
}

function isUpgrade(request: Request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export interface InternalCredential {
  token: () => string;
  principal: () => Promise<Principal>;
}

export interface AuthenticatorOptions {
  trustedOrigins: string[];
  internal?: InternalCredential;
}

function matchesInternal(given: string, expected: string) {
  if (expected.length < 24) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuthenticator(auth: Auth, options: AuthenticatorOptions) {
  const trusted = new Set(options.trustedOrigins.map((origin) => new URL(origin).origin));

  async function fromApiKey(key: string): Promise<Principal | null> {
    const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
    if (!result?.valid || !result.key) return null;
    const context = await auth.$context;
    const found = await context.internalAdapter.findUserById(result.key.referenceId);
    if (!found || (found as { banned?: boolean | null }).banned) return null;
    return {
      userId: found.id,
      email: found.email,
      name: found.name,
      role: (found as { role?: string | null }).role ?? memberRole,
      method: "api-key",
      apiKeyId: result.key.id,
    };
  }

  async function fromSession(headers: Headers): Promise<Principal | null> {
    const result = await auth.api.getSession({ headers }).catch(() => null);
    if (!result) return null;
    return {
      userId: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: (result.user as { role?: string | null }).role ?? memberRole,
      method: "session",
      sessionId: result.session.id,
      expiresAt: new Date(result.session.expiresAt).toISOString(),
    };
  }

  return async function authenticate(request: Request): Promise<AuthOutcome | Response> {
    const url = new URL(request.url);
    if (isPublicRoute(request.method, url.pathname)) return { kind: "public" };
    const token = readToken(request.headers);
    if (token && options.internal && matchesInternal(token, options.internal.token()))
      return { kind: "principal", principal: await options.internal.principal() };
    if (token?.startsWith(apiKeyPrefix)) {
      const principal = await fromApiKey(token);
      return principal ? { kind: "principal", principal } : unauthorized();
    }
    if (!token && (isUpgrade(request) || !safeMethods.has(request.method))) {
      const origin = request.headers.get("origin");
      if (origin && !trusted.has(origin)) return forbidden("Origem não permitida.");
    }
    const principal = await fromSession(request.headers);
    return principal ? { kind: "principal", principal } : unauthorized();
  };
}

export type Authenticator = ReturnType<typeof createAuthenticator>;
