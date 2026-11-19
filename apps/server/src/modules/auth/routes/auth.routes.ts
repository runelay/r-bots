import { ValidationError } from "../../../shared/errors";
import {
  type AccessService,
  InviteInvalidError,
  SetupClosedError,
  signSessionCookie,
} from "../services/accounts-access.service";
import type { Principal } from "../services/auth.middleware";
import { type Auth, authBasePath, devicePagePath, ownerRole } from "../services/auth.service";
import { devicePage } from "./device-page";

export interface AuthRouteDeps {
  auth: Auth;
  access: AccessService;
  secret: string;
  required?: () => boolean;
  now?: () => number;
}

export const authMethods = { password: true, passkey: true, device: true, invites: true, passwordReset: false };

const attemptsWindowMs = 60_000;
const attemptsMax = 5;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

async function readJson(request: Request) {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("JSON inválido.", "body");
  }
}

function failure(error: unknown) {
  if (error instanceof ValidationError) return json({ ok: false, error: error.message, field: error.field }, 400);
  if (error instanceof SetupClosedError) return json({ ok: false, error: error.message, code: "setup_closed" }, 409);
  if (error instanceof InviteInvalidError)
    return json({ ok: false, error: error.message, code: "invite_invalid" }, 400);
  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500)
    return json({ ok: false, error: (error as Error).message || "Pedido inválido." }, status);
  throw error;
}

export function createAuthRoutes(deps: AuthRouteDeps) {
  const now = deps.now ?? Date.now;
  const attempts = new Map<string, { count: number; resetAt: number }>();

  function limited(request: Request, scope: string) {
    const key = `${scope}:${clientKey(request)}`;
    const current = attempts.get(key);
    const at = now();
    if (!current || current.resetAt <= at) {
      attempts.set(key, { count: 1, resetAt: at + attemptsWindowMs });
      return null;
    }
    current.count += 1;
    if (current.count <= attemptsMax) return null;
    const retryAfter = Math.ceil((current.resetAt - at) / 1000);
    return Response.json(
      { ok: false, error: "Muitas tentativas. Espere um minuto.", code: "rate_limited" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }

  async function me(principal: Principal, request: Request) {
    const body: Record<string, unknown> = {
      ok: true,
      user: { id: principal.userId, name: principal.name, email: principal.email, role: principal.role },
      method: principal.method,
      expiresAt: principal.expiresAt ?? null,
    };
    const header = request.headers.get("authorization") ?? "";
    const token = header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : "";
    if (principal.method === "session" && token) {
      const context = await deps.auth.$context;
      body.cookie = { name: context.authCookies.sessionToken.name, value: signSessionCookie(token, deps.secret) };
    }
    return json(body);
  }

  async function handle(request: Request, principal: Principal | null): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === authBasePath || path.startsWith(`${authBasePath}/`)) return await deps.auth.handler(request);
      if (path === devicePagePath && method === "GET")
        return new Response(devicePage(authBasePath), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-frame-options": "DENY",
          },
        });
      if (path === "/auth/setup" && method === "GET")
        return json({
          ok: true,
          needsOwner: await deps.access.needsOwner(),
          required: deps.required?.() ?? true,
          methods: authMethods,
        });
      if (path === "/auth/setup" && method === "POST") {
        const blocked = limited(request, "setup");
        if (blocked) return blocked;
        return json({ ok: true, ...(await deps.access.setupOwner(await readJson(request))) }, 201);
      }
      if (path === "/auth/invites/accept" && method === "POST") {
        const blocked = limited(request, "invite");
        if (blocked) return blocked;
        return json({ ok: true, ...(await deps.access.acceptInvite(await readJson(request))) }, 201);
      }
      if (!path.startsWith("/auth/")) return null;
      if (!principal) return json({ ok: false, error: "Entre de novo para continuar.", code: "unauthorized" }, 401);
      if (path === "/auth/me" && method === "GET") return await me(principal, request);
      if (path === "/auth/runner-key" && method === "POST") {
        if (principal.method !== "session")
          return json({ ok: false, error: "Use a sessão do app para gerar a chave.", code: "forbidden" }, 403);
        return json({ ok: true, ...(await deps.access.issueRunnerKey(request.headers, principal.userId)) }, 201);
      }
      if (path === "/auth/invites" || path.startsWith("/auth/invites/")) {
        if (principal.role !== ownerRole)
          return json({ ok: false, error: "Só o dono pode convidar.", code: "forbidden" }, 403);
        if (path === "/auth/invites" && method === "GET")
          return json({ ok: true, invites: await deps.access.listInvites() });
        if (path === "/auth/invites" && method === "POST")
          return json(
            { ok: true, ...(await deps.access.createInvite(principal.userId, await readJson(request))) },
            201,
          );
        const id = decodeURIComponent(path.slice("/auth/invites/".length));
        if (id && method === "DELETE") {
          await deps.access.revokeInvite(id);
          return json({ ok: true });
        }
      }
      return null;
    } catch (error) {
      return failure(error);
    }
  }

  return { handle };
}
