import { randomBytes } from "node:crypto";
import { ValidationError } from "../../../shared/errors";
import { requestContext } from "../../../shared/http";
import {
  type AccessService,
  InviteInvalidError,
  SetupClosedError,
  SetupTokenError,
  signSessionCookie,
} from "../services/accounts-access.service";
import { carriesPreviewCookie, type Principal, previewCookieName } from "../services/auth.middleware";
import { type Auth, authBasePath, clientIpHeader, devicePagePath, ownerRole } from "../services/auth.service";
import { AvatarNotFoundError, type AvatarService, avatarBasePath, avatarMaxBytes } from "../services/avatar.service";
import { createDeviceRequests, type DeviceRequests } from "../services/device-requests.service";
import { type AccountLockout, createAccountLockout, createWindowLimiter } from "../services/rate-limit.service";
import { setupTokenHeader } from "../services/setup-token.service";
import { devicePage } from "./device-page";

export interface AuthRouteDeps {
  auth: Auth;
  authFor?: (request: Request) => Auth;
  access: AccessService;
  avatars?: AvatarService;
  secret: string;
  providers?: string[];
  now?: () => number;
  lockout?: AccountLockout;
  deviceRequests?: DeviceRequests;
  setupTokenRequired?: () => boolean;
}

export const authMethods = { password: true, passkey: true, device: true, invites: true, passwordReset: false };

const attemptsRule = { windowMs: 60_000, max: 5 };
const blockedAuthPaths = [`${authBasePath}/api-key`];

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function tooMany(retryAfter: number, code = "rate_limited", error = "Muitas tentativas. Espere um minuto.") {
  return Response.json(
    { ok: false, error, code },
    { status: 429, headers: { "retry-after": String(retryAfter), "cache-control": "no-store" } },
  );
}

export function forAuthHandler(request: Request) {
  const headers = new Headers(request.headers);
  headers.set(clientIpHeader, requestContext(request).clientIp);
  if (carriesPreviewCookie(headers)) headers.delete("cookie");
  return new Request(request, { headers });
}

async function jsonOf(source: Request | Response): Promise<Record<string, unknown> | null> {
  try {
    const value = (await source.clone().json()) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isBlockedAuthPath(path: string) {
  return blockedAuthPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function devicePageResponse() {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "img-src data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
  ].join("; ");
  return new Response(devicePage(authBasePath, nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": csp,
      "set-cookie": `${previewCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
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
  if (error instanceof SetupTokenError)
    return json({ ok: false, error: error.message, code: "setup_token_required" }, 403);
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
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > avatarMaxBytes)
    return json({ ok: false, error: "A imagem passa de 2 MB.", field: "image", code: "too_large" }, 413);
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
  const found = await avatars.read(userId, file);
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
  const limiter = createWindowLimiter(now);
  const lockout = deps.lockout ?? createAccountLockout({ now });
  const deviceRequests = deps.deviceRequests ?? createDeviceRequests(now);

  function limited(request: Request, scope: string) {
    const blocked = limiter.hit(`${scope}:${requestContext(request).clientIp}`, attemptsRule);
    return blocked ? tooMany(blocked.retryAfter) : null;
  }

  async function signInEmail(request: Request, auth: Auth) {
    const body = await jsonOf(request);
    const email = typeof body?.email === "string" ? body.email : "";
    const locked = email ? lockout.locked(email) : null;
    if (locked)
      return tooMany(locked.retryAfter, "account_locked", "Muitas tentativas erradas nesta conta. Espere um pouco.");
    const response = await auth.handler(request);
    if (email && (response.status === 401 || response.status === 403)) lockout.failed(email);
    if (email && response.ok) lockout.succeeded(email);
    return response;
  }

  async function deviceCode(request: Request, auth: Auth, clientIp: string) {
    const response = await auth.handler(request);
    if (!response.ok) return response;
    const body = await jsonOf(response);
    const form = await jsonOf(request);
    if (typeof body?.user_code === "string")
      deviceRequests.record(body.user_code, typeof form?.client_id === "string" ? form.client_id : "", clientIp);
    return response;
  }

  async function authHandler(request: Request, path: string) {
    if (isBlockedAuthPath(path)) return json({ ok: false, error: "Rota não encontrada.", code: "not_found" }, 404);
    const auth = deps.authFor?.(request) ?? deps.auth;
    const forwarded = forAuthHandler(request);
    if (path === `${authBasePath}/sign-in/email` && request.method === "POST") return signInEmail(forwarded, auth);
    if (path === `${authBasePath}/device/code` && request.method === "POST")
      return deviceCode(forwarded, auth, requestContext(request).clientIp);
    return auth.handler(forwarded);
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
    const path = requestContext(request).pathname;
    const method = request.method;
    try {
      if (path === authBasePath || path.startsWith(`${authBasePath}/`)) return await authHandler(request, path);
      if (path === devicePagePath && method === "GET") return devicePageResponse();
      if (path === "/auth/setup" && method === "GET") {
        const needsOwner = await deps.access.needsOwner();
        return json({
          ok: true,
          needsOwner,
          required: true,
          setupTokenRequired: needsOwner && (deps.setupTokenRequired?.() ?? false),
          methods: authMethods,
        });
      }
      if (path === "/auth/providers" && method === "GET")
        return json({ ok: true, providers: deps.providers ?? [], methods: authMethods });
      if (path === "/auth/setup" && method === "POST") {
        const blocked = limited(request, "setup");
        if (blocked) return blocked;
        return json(
          {
            ok: true,
            ...(await deps.access.setupOwner(await readJson(request), request.headers.get(setupTokenHeader))),
          },
          201,
        );
      }
      if (path === "/auth/invites/accept" && method === "POST") {
        const blocked = limited(request, "invite");
        if (blocked) return blocked;
        return json({ ok: true, ...(await deps.access.acceptInvite(await readJson(request))) }, 201);
      }
      if (!path.startsWith("/auth/")) return null;
      if (!principal) return json({ ok: false, error: "Entre de novo para continuar.", code: "unauthorized" }, 401);
      if (path === "/auth/me" && method === "GET") return await me(principal, request);
      if (path === "/auth/device/info" && method === "GET") {
        const code = new URL(request.url).searchParams.get("user_code") ?? "";
        const info = code ? deviceRequests.lookup(code) : null;
        if (!info) return json({ ok: false, error: "Pedido não encontrado ou vencido.", code: "not_found" }, 404);
        return json({ ok: true, ...info });
      }
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
        const id = path.slice("/auth/invites/".length);
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
