import { ValidationError } from "../../../shared/errors";
import {
  type AccessService,
  InviteInvalidError,
  SetupClosedError,
  signSessionCookie,
} from "../services/accounts-access.service";
import type { Principal } from "../services/auth.middleware";
import { type Auth, authBasePath, devicePagePath, ownerRole } from "../services/auth.service";
import { AvatarNotFoundError, type AvatarService, avatarBasePath, avatarMaxBytes } from "../services/avatar.service";
import { devicePage } from "./device-page";

export interface AuthRouteDeps {
  auth: Auth;
  authFor?: (request: Request) => Auth;
  access: AccessService;
  avatars?: AvatarService;
  secret: string;
  providers?: string[];
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
  if (error instanceof AvatarNotFoundError) return json({ ok: false, error: error.message, code: "not_found" }, 404);
  if (error instanceof InviteInvalidError)
    return json({ ok: false, error: error.message, code: "invite_invalid" }, 400);
  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500)
    return json({ ok: false, error: (error as Error).message || "Pedido inválido." }, status);
  throw error;
}

async function avatar(avatars: AvatarService, request: Request, principal: Principal) {
  if (request.method === "DELETE") return json({ ok: true, ...(await avatars.remove(principal.userId)) });
  if (request.method !== "PUT" && request.method !== "POST") return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > avatarMaxBytes)
    return json({ ok: false, error: "A imagem passa de 2 MB.", field: "image", code: "too_large" }, 413);
  return json({
    ok: true,
    ...(await avatars.save(principal.userId, request.headers.get("content-type") ?? "", bytes)),
  });
}

async function serveAvatar(avatars: AvatarService, path: string) {
  const [userId = "", file = ""] = path.slice(avatarBasePath.length + 1).split("/");
  const found = await avatars.read(decodeURIComponent(userId), file);
  if (!found) return json({ ok: false, error: "Foto não encontrada.", code: "not_found" }, 404);
  return new Response(found.stream, {
    headers: {
      "content-type": found.mime,
      "content-length": String(found.size),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
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
      user: {
        id: principal.userId,
        name: principal.name,
        email: principal.email,
        role: principal.role,
        image: (await deps.avatars?.imageOf(principal.userId)) ?? null,
      },
      method: principal.method,
      expiresAt: principal.expiresAt ?? null,
    };
    const header = request.headers.get("authorization") ?? "";
    const token = header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : "";
    if (principal.method === "session" && token) {
      const context = await (deps.authFor?.(request) ?? deps.auth).$context;
      body.cookie = { name: context.authCookies.sessionToken.name, value: signSessionCookie(token, deps.secret) };
    }
    return json(body);
  }

  async function handle(request: Request, principal: Principal | null): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === authBasePath || path.startsWith(`${authBasePath}/`))
        return await (deps.authFor?.(request) ?? deps.auth).handler(request);
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
          required: true,
          methods: authMethods,
        });
      if (path === "/auth/providers" && method === "GET")
        return json({ ok: true, providers: deps.providers ?? [], methods: authMethods });
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
      if (deps.avatars && path === "/auth/me/avatar") return await avatar(deps.avatars, request, principal);
      if (deps.avatars && path.startsWith(`${avatarBasePath}/`) && method === "GET")
        return await serveAvatar(deps.avatars, path);
      if (path === "/auth/invites" || path.startsWith("/auth/invites/")) {
        if (principal.role !== ownerRole || principal.method === "internal")
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
