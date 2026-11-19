import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../../db/schema/auth";
import { type AuthModule, createAuthModule, isPublicRoute, type Principal } from "..";
import { authActive, authEnabled, gate, initAuth, principalOf, useAuthModule } from "../gate";
import { readToken } from "../services/auth.middleware";
import { apiKeyPrefix, appClientId, memberRole } from "../services/auth.service";

const base = "http://127.0.0.1:2999";
let dir: string;
let mod: AuthModule;
let ownerToken = "";
let apiKey = "";
const restores: Array<() => void> = [];

async function freshDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  const empty = await generateSQLiteDrizzleJson({});
  const current = await generateSQLiteDrizzleJson(schema as Record<string, unknown>);
  for (const statement of await generateSQLiteMigration(empty, current)) sqlite.run(statement);
  return db;
}

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${base}${path}`, { ...init, headers });
}

async function handle(request: Request) {
  const outcome = await mod.authenticate(request);
  if (outcome instanceof Response) return outcome;
  const principal = outcome.kind === "principal" ? outcome.principal : null;
  return (await mod.handle(request, principal)) ?? Response.json({ ok: true, principal });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-auth-gate-"));
  mod = createAuthModule({
    db: await freshDb(),
    env: { BETTER_AUTH_URL: base },
    dataDir: join(dir, "data"),
    repoDir: join(dir, "repo"),
    serverDir: join(dir, "server"),
    host: "127.0.0.1",
    port: 2999,
  });
  const setup = await handle(
    req("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ name: "Dona", email: "dona@example.com", password: "correct horse battery" }),
    }),
  );
  ownerToken = ((await setup.json()) as { token: string }).token;
  const key = await handle(req("/auth/runner-key", { method: "POST", token: ownerToken }));
  apiKey = ((await key.json()) as { key: string }).key;
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  useAuthModule(null);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readToken and public routes", () => {
  test("reads bearer and api key headers", () => {
    expect(readToken(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(readToken(new Headers({ authorization: "bearer   xyz  " }))).toBe("xyz");
    expect(readToken(new Headers({ authorization: "Bearer   ", "x-api-key": " k1 " }))).toBe("k1");
    expect(readToken(new Headers({ authorization: "Basic abc" }))).toBeNull();
    expect(readToken(new Headers({ "x-api-key": "   " }))).toBeNull();
    expect(readToken(new Headers())).toBeNull();
  });

  test("keeps only the documented routes public", () => {
    expect(isPublicRoute("GET", "/api/auth")).toBe(true);
    expect(isPublicRoute("POST", "/device")).toBe(false);
    expect(isPublicRoute("GET", "/auth/setup")).toBe(true);
    expect(isPublicRoute("PUT", "/auth/setup")).toBe(false);
    expect(isPublicRoute("POST", "/auth/invites/accept")).toBe(true);
    expect(isPublicRoute("GET", "/auth/invites/accept")).toBe(false);
    expect(isPublicRoute("GET", "/preview/abc/5310/")).toBe(true);
    expect(isPublicRoute("GET", "/mcp/a")).toBe(false);
    expect(isPublicRoute("GET", "/api/authx")).toBe(false);
  });
});

describe("authenticate", () => {
  test("accepts an api key from either header", async () => {
    expect(apiKey.startsWith(apiKeyPrefix)).toBe(true);
    const outcome = await mod.authenticate(req("/bots", { headers: { "x-api-key": apiKey } }));
    expect(outcome).toMatchObject({
      kind: "principal",
      principal: { email: "dona@example.com", role: "owner", method: "api-key" },
    });
    const bearer = await mod.authenticate(req("/bots", { token: apiKey }));
    expect((bearer as { principal: Principal }).principal.apiKeyId).toBeString();
  });

  test("refuses unknown, failing, orphan and banned api keys", async () => {
    expect(((await mod.authenticate(req("/bots", { token: `${apiKeyPrefix}nope` }))) as Response).status).toBe(401);
    const verify = spyOn(mod.auth.api, "verifyApiKey").mockRejectedValueOnce(new Error("db down"));
    restores.push(() => verify.mockRestore());
    expect(((await mod.authenticate(req("/bots", { token: apiKey }))) as Response).status).toBe(401);
    const context = await mod.auth.$context;
    const find = spyOn(context.internalAdapter, "findUserById");
    restores.push(() => find.mockRestore());
    find.mockResolvedValueOnce(null);
    expect(((await mod.authenticate(req("/bots", { token: apiKey }))) as Response).status).toBe(401);
    find.mockResolvedValueOnce({ id: "u", email: "e", name: "n", banned: true } as never);
    expect(((await mod.authenticate(req("/bots", { token: apiKey }))) as Response).status).toBe(401);
    find.mockResolvedValueOnce({ id: "u", email: "e@x.co", name: "N", role: null } as never);
    const member = (await mod.authenticate(req("/bots", { token: apiKey }))) as { principal: Principal };
    expect(member.principal).toMatchObject({ userId: "u", role: memberRole, method: "api-key" });
  });

  test("checks sessions and defaults the role", async () => {
    const session = (await mod.authenticate(req("/bots", { token: ownerToken }))) as { principal: Principal };
    expect(session.principal).toMatchObject({ method: "session", role: "owner" });
    expect(Number.isNaN(Date.parse(session.principal.expiresAt as string))).toBe(false);
    const getSession = spyOn(mod.auth.api, "getSession");
    restores.push(() => getSession.mockRestore());
    getSession.mockResolvedValueOnce({
      user: { id: "u2", email: "m@x.co", name: "M", role: null },
      session: { id: "s2", expiresAt: new Date("2030-01-01T00:00:00Z") },
    } as never);
    const member = (await mod.authenticate(req("/bots", { token: "t" }))) as { principal: Principal };
    expect(member.principal).toEqual({
      userId: "u2",
      email: "m@x.co",
      name: "M",
      role: memberRole,
      method: "session",
      sessionId: "s2",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    getSession.mockRejectedValueOnce(new Error("broken"));
    expect(((await mod.authenticate(req("/bots", { token: "t" }))) as Response).status).toBe(401);
  });

  test("refuses cookie upgrades from foreign origins and lets public routes through", async () => {
    const upgrade = await mod.authenticate(
      req("/bots/x/browser/live", { headers: { upgrade: "websocket", origin: "https://evil.example" } }),
    );
    expect((upgrade as Response).status).toBe(403);
    expect(await (upgrade as Response).json()).toEqual({
      ok: false,
      error: "Origem não permitida.",
      code: "forbidden",
    });
    const noOrigin = await mod.authenticate(req("/bots/x/browser/live", { headers: { upgrade: "websocket" } }));
    expect((noOrigin as Response).status).toBe(401);
    const trusted = await mod.authenticate(req("/bots", { method: "POST", headers: { origin: base } }));
    expect((trusted as Response).status).toBe(401);
    expect(await mod.authenticate(req("/health"))).toEqual({ kind: "public" });
  });
});

describe("device authorization", () => {
  test("issues codes only to the app client", async () => {
    const ok = await handle(
      req("/api/auth/device/code", { method: "POST", body: JSON.stringify({ client_id: appClientId }) }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty("device_code");
    const denied = await handle(
      req("/api/auth/device/code", { method: "POST", body: JSON.stringify({ client_id: "someone-else" }) }),
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });
});

describe("gate", () => {
  test("is off unless BOTS_AUTH is on", async () => {
    expect(authEnabled({})).toBe(false);
    expect(authEnabled({ BOTS_AUTH: "ON" })).toBe(true);
    expect(authEnabled()).toBe(false);
    expect(await initAuth({ BOTS_AUTH: "off" })).toBeNull();
    expect(authActive()).toBe(false);
    expect(await gate(req("/bots"))).toBeNull();
  });

  test("initializes the real module when turned on", async () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    restores.push(() => log.mockRestore());
    const created = await initAuth({
      BOTS_AUTH: "on",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    });
    expect(created?.baseURL).toBe(base);
    expect(authActive()).toBe(true);
    expect(logs).toContain(`auth on (${base}, secret from env)`);
    const blocked = await gate(req("/bots"));
    expect(blocked?.status).toBe(401);
  });

  test("records the principal, honors the bypass and passes public routes", async () => {
    useAuthModule(mod);
    const request = req("/bots", { token: ownerToken });
    expect(await gate(request)).toBeNull();
    expect(principalOf(request)?.email).toBe("dona@example.com");
    expect(principalOf(req("/bots"))).toBeNull();
    expect(await gate(req("/bots"), () => true)).toBeNull();
    expect(await gate(req("/health"))).toBeNull();
    const me = await gate(req("/auth/me", { token: ownerToken }));
    expect(me?.status).toBe(200);
  });
});
