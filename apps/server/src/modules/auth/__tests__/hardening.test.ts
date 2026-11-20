import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../../test/db-helpers";
import { buildRequestContext, setRequestContext } from "../../../shared/http";
import { type AuthModule, createAuthModule, type Principal, previewHostOf } from "..";
import {
  gate,
  isLocalExec,
  notifyUserRevoked,
  onUserRevoked,
  principalOf,
  requestAllowed,
  useAuthModule,
} from "../gate";
import { forAuthHandler } from "../routes/auth.routes";
import { carriesPreviewCookie } from "../services/auth.middleware";
import { appClientId, clientIpHeader, sessionMaxAgeMs } from "../services/auth.service";

const port = 2995;
const base = `http://127.0.0.1:${port}`;
const password = "correct horse battery";
let dir: string;
let mod: AuthModule;
let ownerToken = "";
let ownerId = "";
let memberToken = "";
let memberId = "";
const restores: Array<() => void> = [];

function req(path: string, init: RequestInit & { token?: string; peer?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const request = new Request(`${base}${path}`, { ...init, headers });
  const context = buildRequestContext(request, init.peer ?? "127.0.0.1", port);
  if (context) setRequestContext(request, context);
  return request;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-hardening-"));
  mod = createAuthModule({
    db: await freshDb(),
    env: { BOTS_ALLOWED_HOSTS: "bots.example.ts.net:10447", BOTS_PREVIEW_ORIGIN: "https://preview.example.ts.net" },
    dataDir: join(dir, "data"),
    repoDir: join(dir, "repo"),
    serverDir: join(dir, "server"),
    host: "127.0.0.1",
    port,
  });
  const owner = await mod.access.setupOwner(
    { name: "Dona", email: "dona@example.com", password },
    readFileSync(mod.setupToken.issue(), "utf8").trim(),
  );
  ownerToken = owner.token;
  ownerId = owner.user.id;
  const invite = await mod.access.createInvite(ownerId, {});
  const member = await mod.access.acceptInvite({
    code: invite.code,
    name: "Membro",
    email: "membro@example.com",
    password,
  });
  memberToken = member.token;
  memberId = member.user.id;
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  useAuthModule(null);
  onUserRevoked(null);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("gate", () => {
  test("refuses an unknown Host with 421 before any auth instance is built", async () => {
    useAuthModule(mod);
    const evil = await gate(req("/health", { headers: { host: "evil.example" } }));
    expect(evil?.status).toBe(421);
    expect(await evil?.json()).toMatchObject({ code: "misdirected" });
    expect(await gate(req("/health", { headers: { host: "bots.example.ts.net:10447" } }))).toBeNull();
    expect(await gate(req("/health"))).toBeNull();
    expect(await gate(req("/health", { headers: { host: "preview.example.ts.net" } }))).toBeNull();
    expect(previewHostOf("https://Preview.Example:8443/x")).toBe("preview.example:8443");
    expect(previewHostOf("nada")).toBe("");
    expect(previewHostOf(undefined)).toBe("");
  });

  test("applies the owner policy right after authentication", async () => {
    useAuthModule(mod);
    const create = req("/bots", { method: "POST", token: memberToken, body: "{}" });
    const refused = await gate(create);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({
      ok: false,
      error: "Só o dono da conta pode fazer isso.",
      code: "forbidden",
    });
    expect(principalOf(create)).toBeNull();
    const list = req("/bots", { token: memberToken });
    expect(await gate(list)).toBeNull();
    expect(principalOf(list)?.role).toBe("member");
    expect(await gate(req("/bots", { method: "POST", token: ownerToken, body: "{}" }))).toBeNull();
    expect((await gate(req("/vault/secrets", { token: memberToken })))?.status).toBe(403);
  });

  test("lets the secret helper reach /vault/exec only from loopback without proxy headers", async () => {
    useAuthModule(mod);
    const local = req("/vault/exec/ticket-1", { method: "POST" });
    expect(isLocalExec(local)).toBe(true);
    expect(await gate(local)).toBeNull();
    expect(requestAllowed(local)).toBe(true);
    const proxied = req("/vault/exec/ticket-1", { method: "POST", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect((await gate(proxied))?.status).toBe(404);
    const tailnet = req("/vault/exec/ticket-1", { method: "POST", headers: { "tailscale-user-login": "a@b.c" } });
    expect((await gate(tailnet))?.status).toBe(404);
    const remote = req("/vault/exec/ticket-1", { method: "POST", peer: "10.0.0.5" });
    expect((await gate(remote))?.status).toBe(404);
    expect((await gate(req("/vault/exec/ticket-1")))?.status).toBe(404);
    expect(isLocalExec(req("/vault/exec", { method: "POST" }))).toBe(false);
    expect(isLocalExec(req("/vault/exec/a/b", { method: "POST" }))).toBe(false);
    expect(isLocalExec(req("/bots/exec/a", { method: "POST" }))).toBe(false);
  });

  test("route-level check refuses requests without a principal while auth is on", async () => {
    expect(requestAllowed(req("/bots"))).toBe(true);
    useAuthModule(mod);
    expect(requestAllowed(req("/bots"))).toBe(false);
    expect(requestAllowed(req("/health"))).toBe(true);
    const signed = req("/bots", { token: ownerToken });
    await gate(signed);
    expect(requestAllowed(signed)).toBe(true);
  });

  test("hides the api-key endpoints of better-auth from every client", async () => {
    useAuthModule(mod);
    for (const path of [
      "/api/auth/api-key/create",
      "/api/auth/api-key/update",
      "/api/auth/api-key/list",
      "/api/auth/api-key",
    ]) {
      const response = await gate(
        req(path, {
          method: "POST",
          token: ownerToken,
          headers: { origin: base },
          body: JSON.stringify({ name: "x" }),
        }),
      );
      expect(response?.status).toBe(404);
    }
  });

  test("a request with the preview cookie never authenticates by session cookie", async () => {
    const context = await mod.auth.$context;
    const signed = `${context.authCookies.sessionToken.name}=${encodeURIComponent(ownerToken)}`;
    expect(carriesPreviewCookie(new Headers({ cookie: "a=1; rb_preview=x" }))).toBe(true);
    expect(carriesPreviewCookie(new Headers({ cookie: "rb_previewx=1" }))).toBe(false);
    const viaCookie = await mod.authenticate(req("/bots", { headers: { cookie: `rb_preview=abc; ${signed}` } }));
    expect((viaCookie as Response).status).toBe(401);
    const viaToken = await mod.authenticate(req("/bots", { token: ownerToken, headers: { cookie: "rb_preview=abc" } }));
    expect(viaToken).toMatchObject({ kind: "principal" });
    const handed = forAuthHandler(req("/api/auth/get-session", { headers: { cookie: `rb_preview=abc; ${signed}` } }));
    expect(handed.headers.get("cookie")).toBeNull();
    expect(handed.headers.get(clientIpHeader)).toBe("127.0.0.1");
    const plain = forAuthHandler(
      req("/api/auth/get-session", { headers: { cookie: signed, [clientIpHeader]: "6.6.6.6" } }),
    );
    expect(plain.headers.get("cookie")).toBe(signed);
    expect(plain.headers.get(clientIpHeader)).toBe("127.0.0.1");
  });

  test("a cookie websocket upgrade must name a trusted origin", async () => {
    const upgrade = await mod.authenticate(
      req("/bots/x/browser/live", { headers: { upgrade: "websocket", cookie: "a=1" } }),
    );
    expect((upgrade as Response).status).toBe(403);
  });

  test("sessions older than the absolute cap are refused", async () => {
    const getSession = spyOn(mod.auth.api, "getSession").mockResolvedValueOnce({
      user: { id: ownerId, email: "dona@example.com", name: "Dona", role: "owner" },
      session: {
        id: "s",
        createdAt: new Date(Date.now() - sessionMaxAgeMs - 1000),
        expiresAt: new Date(Date.now() + 1000),
      },
    } as never);
    restores.push(() => getSession.mockRestore());
    expect(((await mod.authenticate(req("/bots", { token: "t" }))) as Response).status).toBe(401);
  });
});

describe("auth routes", () => {
  test("the device page ships a strict CSP with a fresh nonce and clears the preview cookie", async () => {
    const first = (await mod.handle(req("/device"), null)) as Response;
    const second = (await mod.handle(req("/device"), null)) as Response;
    const csp = first.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(10);
    expect(second.headers.get("content-security-policy")).not.toBe(csp);
    for (const part of [
      "default-src 'none'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'none'",
    ])
      expect(csp).toContain(part);
    expect(first.headers.get("set-cookie")).toBe("rb_preview=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    const html = await first.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain("Só libere se foi você que pediu agora");
    expect(html).toContain('id="setup-form"');
  });

  test("shows who asked for a device code, from where and when", async () => {
    const forwarded = { "tailscale-user-login": "a@b.c", "x-forwarded-for": "100.64.1.2" };
    const code = (await mod.handle(
      req("/api/auth/device/code", {
        method: "POST",
        headers: forwarded,
        body: JSON.stringify({ client_id: appClientId }),
      }),
      null,
    )) as Response;
    expect(code.status).toBe(200);
    const { user_code: userCode, expires_in: expiresIn } = (await code.json()) as {
      user_code: string;
      expires_in: number;
    };
    expect(expiresIn).toBeLessThanOrEqual(600);
    const principal = { userId: ownerId, role: "owner", method: "session" } as Principal;
    const info = (await mod.handle(req(`/auth/device/info?user_code=${userCode}`), principal)) as Response;
    expect(await info.json()).toMatchObject({ ok: true, clientName: "app r/bots para Mac", ip: "100.64.1.2" });
    const missing = (await mod.handle(req("/auth/device/info?user_code=NOPE"), principal)) as Response;
    expect(missing.status).toBe(404);
    expect(((await mod.handle(req("/auth/device/info"), principal)) as Response).status).toBe(404);
    const refused = (await mod.handle(
      req("/api/auth/device/code", { method: "POST", body: JSON.stringify({ client_id: "x" }) }),
      null,
    )) as Response;
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const noJson = (await mod.handle(req("/api/auth/device/code", { method: "POST", body: "{" }), null)) as Response;
    expect(noJson.status).toBeGreaterThanOrEqual(400);
  });

  test("locks an account after repeated wrong passwords even across addresses", async () => {
    const attempt = (ip: string, secret: string, email = "membro@example.com") =>
      mod.handle(
        req("/api/auth/sign-in/email", {
          method: "POST",
          headers: { origin: base, "tailscale-user-login": "a", "x-forwarded-for": ip },
          body: JSON.stringify({ email, password: secret }),
        }),
        null,
      ) as Promise<Response>;
    for (let index = 0; index < 5; index++)
      expect((await attempt(`10.9.0.${index}`, "wrong password!")).status).toBe(401);
    const locked = await attempt("10.9.1.1", password);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: "account_locked" });
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await attempt("10.9.1.2", password, "dona@example.com")).status).toBe(200);
    const noBody = (await mod.handle(
      req("/api/auth/sign-in/email", { method: "POST", headers: { origin: base }, body: "x" }),
      null,
    )) as Response;
    expect(noBody.status).toBeGreaterThanOrEqual(400);
  });

  test("rejects an oversized avatar from its declared length", async () => {
    const principal = { userId: ownerId, role: "owner", method: "session" } as Principal;
    const response = (await mod.handle(
      req("/auth/me/avatar", { method: "PUT", headers: { "content-length": String(3 * 1024 * 1024) }, body: "x" }),
      principal,
    )) as Response;
    expect(response.status).toBe(413);
  });
});

describe("revocation", () => {
  test("banning or deleting a user drops sessions, keys and devices", async () => {
    const revoked: Array<[string, string[]]> = [];
    onUserRevoked((userId, ids) => revoked.push([userId, ids]));
    const registered = await mod.auth.api.createApiKey({
      body: { name: "device", userId: memberId, metadata: { kind: "device" } },
    });
    await mod.devices.insert({
      id: "member-mac",
      apiKeyId: registered.id,
      userId: memberId,
      name: "Mac",
      model: null,
      osVersion: null,
      appVersion: null,
      machineId: null,
      registeredAt: new Date(),
      createdAt: new Date(),
    });
    expect(await mod.devices.touchKey(registered.id, Date.now() + 365 * 86_400_000)).toBe(true);
    expect(await mod.devices.touchKey(registered.id)).toBe(false);
    const authed = await mod.authenticate(req("/runner/connect", { token: registered.key }));
    expect(authed).toMatchObject({ principal: { device: { id: "member-mac", name: "Mac" } } });
    const lookup = spyOn(mod.devices, "byApiKey").mockRejectedValueOnce(new Error("db down"));
    const degraded = await mod.authenticate(req("/runner/connect", { token: registered.key }));
    lookup.mockRestore();
    expect((degraded as { principal: Principal }).principal.device).toBeUndefined();
    const context = await mod.auth.$context;
    await context.internalAdapter.updateUser(memberId, { banned: true });
    expect(revoked).toEqual([]);
    const headers = new Headers({ authorization: `Bearer ${ownerToken}` });
    await mod.auth.api.banUser({ headers, body: { userId: memberId } });
    await Bun.sleep(0);
    expect((await mod.devices.list(memberId)).length).toBe(0);
    expect(((await mod.authenticate(req("/bots", { token: memberToken }))) as Response).status).toBe(401);
    expect(((await mod.authenticate(req("/bots", { token: registered.key }))) as Response).status).toBe(401);
    notifyUserRevoked("x", []);
    const third = await mod.access.createInvite(ownerId, {});
    const temp = await mod.access.acceptInvite({ code: third.code, name: "T", email: "t@example.com", password });
    await mod.auth.api.setRole({ headers, body: { userId: temp.user.id, role: "member" } });
    expect(((await mod.authenticate(req("/bots", { token: temp.token }))) as Response).status).toBe(401);
    const fourth = await mod.access.createInvite(ownerId, {});
    const gone = await mod.access.acceptInvite({ code: fourth.code, name: "G", email: "g@example.com", password });
    await mod.auth.api.removeUser({ headers, body: { userId: gone.user.id } });
    expect(await mod.devices.list(gone.user.id)).toEqual([]);
  });

  test("a failing revocation is logged and does not break the admin action", async () => {
    const errors: unknown[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args[0]);
    });
    restores.push(() => error.mockRestore());
    const revoke = spyOn(mod.devices, "revokeUser").mockRejectedValueOnce(new Error("db down"));
    restores.push(() => revoke.mockRestore());
    const fifth = await mod.access.createInvite(ownerId, {});
    const user = await mod.access.acceptInvite({ code: fifth.code, name: "F", email: "f@example.com", password });
    await mod.auth.api.banUser({
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
      body: { userId: user.user.id },
    });
    expect(errors).toContain("auth: could not revoke the user's credentials");
  });
});
