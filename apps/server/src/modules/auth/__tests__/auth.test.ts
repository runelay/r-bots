import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../../db/schema/auth";
import { type AuthModule, createAuthModule, isPublicRoute } from "..";
import { safeEqual, signSessionCookie } from "../services/accounts-access.service";
import { resolveAuthSecret } from "../services/auth-secret.service";

const base = "http://127.0.0.1:2999";
let dir: string;
let mod: AuthModule;

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

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const request = req(path, init);
  const outcome = await mod.authenticate(request);
  if (outcome instanceof Response) return outcome;
  const principal = outcome.kind === "principal" ? outcome.principal : null;
  const response = await mod.handle(request, principal);
  return response ?? Response.json({ ok: true, principal }, { status: 200 });
}

const owner = { name: "Dono", email: "owner@example.com", password: "correct horse battery" };
let ownerToken = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-auth-"));
  mod = createAuthModule({
    db: await freshDb(),
    env: { BETTER_AUTH_URL: base },
    dataDir: join(dir, "data"),
    repoDir: join(dir, "repo"),
    serverDir: join(dir, "server"),
    host: "127.0.0.1",
    port: 2999,
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("secret", () => {
  test("generates once into the data dir with mode 600 and prefers env", () => {
    const dataDir = join(dir, "secret-data");
    const first = resolveAuthSecret({ env: {}, dataDir });
    expect(first.generated).toBe(true);
    expect(first.source).toBe("data-file");
    expect(statSync(join(dataDir, "auth.secret")).mode & 0o777).toBe(0o600);
    const again = resolveAuthSecret({ env: {}, dataDir });
    expect(again).toEqual({ secret: first.secret, source: "data-file", generated: false });
    const fromEnv = resolveAuthSecret({ env: { BETTER_AUTH_SECRET: first.secret }, dataDir: dir });
    expect(fromEnv).toEqual({ secret: first.secret, source: "env", generated: false });
  });
});

describe("routes", () => {
  test("public routes", () => {
    expect(isPublicRoute("GET", "/health")).toBe(true);
    expect(isPublicRoute("POST", "/api/auth/sign-in/email")).toBe(true);
    expect(isPublicRoute("GET", "/device")).toBe(true);
    expect(isPublicRoute("POST", "/auth/setup")).toBe(true);
    expect(isPublicRoute("POST", "/mcp/bot/session")).toBe(true);
    expect(isPublicRoute("GET", "/bots")).toBe(false);
    expect(isPublicRoute("GET", "/runner/connect")).toBe(false);
    expect(isPublicRoute("POST", "/auth/invites")).toBe(false);
  });

  test("protected route without token is 401", async () => {
    const response = await call("/bots");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
});

describe("first owner", () => {
  test("setup is open while there is no user", async () => {
    const response = await call("/auth/setup");
    expect(await response.json()).toEqual({ ok: true, needsOwner: true });
  });

  test("rejects invalid input", async () => {
    const response = await call("/auth/setup", { method: "POST", body: JSON.stringify({ name: "x", email: "bad" }) });
    expect(response.status).toBe(400);
  });

  test("creates the owner once and returns a working token", async () => {
    const response = await call("/auth/setup", { method: "POST", body: JSON.stringify(owner) });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { token: string; user: { role: string } };
    expect(body.user.role).toBe("owner");
    ownerToken = body.token;
    const me = await call("/auth/me", { token: ownerToken });
    const meBody = (await me.json()) as { user: { email: string }; cookie: { name: string; value: string } };
    expect(meBody.user.email).toBe(owner.email);
    expect(meBody.cookie.value).toBe(ownerToken);
    const closed = await call("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ ...owner, email: "other@example.com" }),
    });
    expect(closed.status).toBe(409);
  });

  test("open sign up is closed", async () => {
    const response = await call("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name: "x", email: "x@example.com", password: "another long password" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("sign in by password returns a bearer token", async () => {
    const response = await call("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: owner.password }),
    });
    expect(response.status).toBe(200);
    const token = response.headers.get("set-auth-token") ?? "";
    expect(token.length).toBeGreaterThan(20);
    const ok = await call("/bots", { token });
    expect(ok.status).toBe(200);
  });
});

describe("invites", () => {
  let code = "";

  test("only the owner invites", async () => {
    const response = await call("/auth/invites", { method: "POST", token: ownerToken, body: JSON.stringify({}) });
    expect(response.status).toBe(201);
    code = ((await response.json()) as { code: string }).code;
    expect(code.startsWith("rbi_")).toBe(true);
    const list = (await (await call("/auth/invites", { token: ownerToken })).json()) as { invites: unknown[] };
    expect(list.invites).toHaveLength(1);
  });

  test("member joins with the code once and cannot invite", async () => {
    const member = { name: "Membro", email: "member@example.com", password: "member long password", code };
    const response = await call("/auth/invites/accept", { method: "POST", body: JSON.stringify(member) });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { token: string; user: { role: string } };
    expect(body.user.role).toBe("member");
    const again = await call("/auth/invites/accept", {
      method: "POST",
      body: JSON.stringify({ ...member, email: "dup@example.com" }),
    });
    expect(again.status).toBe(400);
    const denied = await call("/auth/invites", { method: "POST", token: body.token, body: "{}" });
    expect(denied.status).toBe(403);
  });

  test("revoked invite stops working", async () => {
    const created = (await (
      await call("/auth/invites", { method: "POST", token: ownerToken, body: JSON.stringify({ email: "a@b.co" }) })
    ).json()) as { id: string; code: string };
    const removed = await call(`/auth/invites/${created.id}`, { method: "DELETE", token: ownerToken });
    expect(removed.status).toBe(200);
    const response = await call("/auth/invites/accept", {
      method: "POST",
      body: JSON.stringify({ name: "A", email: "a@b.co", password: "some long password", code: created.code }),
    });
    expect(response.status).toBe(400);
  });
});

describe("runner key", () => {
  test("issued from a session, accepted on the runner socket, rotated on reissue", async () => {
    const first = await call("/auth/runner-key", { method: "POST", token: ownerToken });
    expect(first.status).toBe(201);
    const { key } = (await first.json()) as { key: string };
    expect(key.startsWith("rbk_")).toBe(true);
    const socket = await call("/runner/connect", { token: key, headers: { upgrade: "websocket" } });
    expect(((await socket.json()) as { principal: { method: string } }).principal.method).toBe("api-key");
    const fromKey = await call("/auth/runner-key", { method: "POST", token: key });
    expect(fromKey.status).toBe(403);
    await call("/auth/runner-key", { method: "POST", token: ownerToken });
    const stale = await call("/runner/connect", { token: key });
    expect(stale.status).toBe(401);
  });
});

describe("sessions", () => {
  test("cookie sessions from a foreign origin are refused on writes", async () => {
    const me = (await (await call("/auth/me", { token: ownerToken })).json()) as {
      cookie: { name: string; value: string };
    };
    const cookie = `${me.cookie.name}=${encodeURIComponent(me.cookie.value)}`;
    const foreign = await call("/bots", { method: "POST", headers: { cookie, origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    const same = await call("/bots", { method: "POST", headers: { cookie, origin: base } });
    expect(same.status).toBe(200);
  });

  test("sign out revokes the token", async () => {
    const signIn = await call("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: owner.password }),
    });
    const token = signIn.headers.get("set-auth-token") ?? "";
    const out = await call("/api/auth/sign-out", { method: "POST", token, headers: { origin: base } });
    expect(out.status).toBe(200);
    expect((await call("/bots", { token })).status).toBe(401);
  });

  test("login is rate limited", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const response = await call("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "x-forwarded-for": "10.9.9.9" },
        body: JSON.stringify({ email: owner.email, password: "wrong password here" }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });

  test("device page is served", async () => {
    const response = await call("/device?user_code=ABCD");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Liberar");
  });
});

describe("helpers", () => {
  test("safeEqual and cookie signing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(signSessionCookie("a.b", "s")).toBe("a.b");
    expect(signSessionCookie("token", "secret").startsWith("token.")).toBe(true);
  });
});
