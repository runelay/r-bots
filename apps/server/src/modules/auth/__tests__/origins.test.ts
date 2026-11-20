import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../../test/db-helpers";
import { buildRequestContext, setRequestContext } from "../../../shared/http";
import { type AuthModule, createAuthModule } from "..";
import type { Principal } from "../services/auth.middleware";
import type { Auth } from "../services/auth.service";
import {
  createAuthPool,
  createOriginRegistry,
  effectiveHost,
  maxRememberedOrigins,
  misdirected,
  normalizeOrigin,
  parseAllowedHosts,
  requestOrigin,
  sameHost,
} from "../services/origins.service";

const tailnet = "https://bots.example.ts.net:10447";
let dir: string;
let mod: AuthModule;
const saved: string[][] = [];

const ownerPrincipal: Principal = { userId: "u", email: "o@x.co", name: "O", role: "owner", method: "session" };

function through(request: Request, peer = "127.0.0.1", listenPort: number | null = null) {
  const context = buildRequestContext(request, peer, listenPort);
  if (context) setRequestContext(request, context);
  return request;
}

function signIn(url: string, headers: Record<string, string>) {
  return through(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "rb=1", ...headers },
      body: JSON.stringify({ email: "dona@example.com", password: "correct horse battery" }),
    }),
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-origins-"));
  mod = createAuthModule({
    db: await freshDb(),
    env: {},
    dataDir: join(dir, "data"),
    repoDir: join(dir, "repo"),
    serverDir: join(dir, "server"),
    host: "127.0.0.1",
    port: 2996,
    knownOrigins: ["https://perfil.example.ts.net:10447/qualquer", "lixo"],
    saveOrigins: (origins) => {
      saved.push(origins);
    },
  });
  const created = await mod.handle(
    new Request("http://127.0.0.1:2996/auth/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-setup-token": readFileSync(mod.setupToken.issue(), "utf8").trim(),
      },
      body: JSON.stringify({ name: "Dona", email: "dona@example.com", password: "correct horse battery" }),
    }),
    null,
  );
  expect(created?.status).toBe(201);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("request origin", () => {
  test("trusts forwarded host and protocol only through tailscale serve on loopback", () => {
    const headers = {
      host: "bots.example.ts.net:10447",
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "a.example:1, b",
    };
    const proxied = through(
      new Request("http://127.0.0.1:2000/x", { headers: { ...headers, "tailscale-user-login": "a@b.c" } }),
    );
    expect(requestOrigin(proxied)).toBe("https://a.example:1");
    expect(effectiveHost(proxied)).toBe("a.example:1");
    const spoofed = through(new Request("http://127.0.0.1:2000/x", { headers }));
    expect(requestOrigin(spoofed)).toBe("http://bots.example.ts.net:10447");
    expect(effectiveHost(spoofed)).toBe("bots.example.ts.net:10447");
    const remote = through(
      new Request("http://127.0.0.1:2000/x", { headers: { ...headers, "tailscale-user-login": "a@b.c" } }),
      "10.1.2.3",
    );
    expect(requestOrigin(remote)).toBe("http://bots.example.ts.net:10447");
    expect(requestOrigin(spoofed, ["https://bots.example.ts.net:10447"])).toBe("https://bots.example.ts.net:10447");
    expect(requestOrigin(new Request("http://127.0.0.1:2000/x"))).toBe("http://127.0.0.1:2000");
    const brokenProxy = through(
      new Request("http://127.0.0.1:2000/x", {
        headers: { "x-forwarded-host": "exa mple", "tailscale-headers-info": "x" },
      }),
    );
    expect(requestOrigin(brokenProxy)).toBe("http://127.0.0.1:2000");
    const noForwardedHost = through(
      new Request("http://127.0.0.1:2000/x", { headers: { host: "h.ts.net", "tailscale-headers-info": "x" } }),
    );
    expect(effectiveHost(noForwardedHost)).toBe("h.ts.net");
    const brokenHost = new Request("http://127.0.0.1:2000/x", { headers: { host: "exa mple" } });
    expect(requestOrigin(brokenHost)).toBe("http://127.0.0.1:2000");
    expect(normalizeOrigin("https://a.example/caminho")).toBe("https://a.example");
    expect(normalizeOrigin("nada")).toBeNull();
    expect(normalizeOrigin("file:///tmp/x")).toBeNull();
    expect(sameHost("a.example", "https://a.example")).toBe(true);
    expect(sameHost("a.example:443", "https://a.example")).toBe(true);
    expect(sameHost("a.example:8443", "https://a.example")).toBe(false);
    expect(sameHost("a.example", "lixo")).toBe(false);
    expect(parseAllowedHosts(" Bots.Example:10447 , https://x.example/a, ftp://y, ,")).toEqual({
      origins: ["https://x.example"],
      hosts: ["bots.example:10447"],
    });
    expect(parseAllowedHosts(undefined)).toEqual({ origins: [], hosts: [] });
  });

  test("the registry trusts the request's own origin and remembered ones, and only the owner adds them", async () => {
    const writes: string[][] = [];
    const registry = createOriginRegistry({
      known: ["https://um.example/a"],
      save: (list) => void writes.push(list),
      allowedHosts: "https://env.example",
    });
    const request = new Request("http://127.0.0.1:2000/x", { headers: { host: "dois.example" } });
    expect(registry.trusts("http://dois.example", request)).toBe(true);
    expect(registry.trusts("https://um.example", request)).toBe(true);
    expect(registry.trusts("https://env.example", request)).toBe(true);
    expect(registry.trusts("https://evil.example", request)).toBe(false);
    expect(await registry.remember("https://tres.example/x")).toBe(false);
    expect(await registry.remember("https://tres.example/x", { ...ownerPrincipal, role: "member" })).toBe(false);
    expect(await registry.remember("https://tres.example/x", { ...ownerPrincipal, method: "internal" })).toBe(false);
    expect(await registry.remember("https://tres.example/x", ownerPrincipal)).toBe(true);
    expect(await registry.remember("https://tres.example", ownerPrincipal)).toBe(false);
    expect(await registry.remember("https://env.example", ownerPrincipal)).toBe(false);
    expect(await registry.remember("nada", ownerPrincipal)).toBe(false);
    expect(writes).toEqual([["https://um.example", "https://tres.example"]]);
    expect(registry.list()).toEqual(["https://env.example", "https://um.example", "https://tres.example"]);
    expect(await createOriginRegistry().remember("https://quatro.example", ownerPrincipal)).toBe(true);
    const full = createOriginRegistry();
    for (let index = 0; index < maxRememberedOrigins; index++)
      expect(await full.remember(`https://o${index}.example`, ownerPrincipal)).toBe(true);
    expect(await full.remember("https://extra.example", ownerPrincipal)).toBe(false);
    expect(full.remembered()).toHaveLength(maxRememberedOrigins);
  });

  test("the host allowlist takes the gateway port, env hosts, remembered origins and tailscale names", async () => {
    const registry = createOriginRegistry({
      known: ["https://perfil.example:10447"],
      allowedHosts: "bots.local:8080,https://env.example",
      port: 2000,
    });
    const at = (host: string, extra: Record<string, string> = {}, peer = "127.0.0.1") =>
      through(new Request("http://127.0.0.1:2000/x", { headers: { host, ...extra } }), peer, 41000);
    expect(registry.hostAllowed(at("127.0.0.1:2000"))).toBe(true);
    expect(registry.hostAllowed(at("localhost:41000"))).toBe(true);
    expect(registry.hostAllowed(at("[::1]:2000"))).toBe(true);
    expect(registry.hostAllowed(at("127.0.0.1:9999"))).toBe(false);
    expect(registry.hostAllowed(at("localhost"))).toBe(false);
    expect(registry.hostAllowed(at("bots.local:8080"))).toBe(true);
    expect(registry.hostAllowed(at("env.example"))).toBe(true);
    expect(registry.hostAllowed(at("perfil.example:10447"))).toBe(true);
    expect(registry.hostAllowed(at("evil.example"))).toBe(false);
    expect(registry.hostAllowed(at("box.tail1.ts.net"))).toBe(false);
    expect(registry.hostAllowed(at("box.tail1.ts.net", { "tailscale-user-login": "a@b.c" }))).toBe(true);
    expect(registry.hostAllowed(at("box.tail1.ts.net", { "tailscale-user-login": "a@b.c" }, "10.0.0.1"))).toBe(false);
    expect(registry.hostAllowed(at("exa mple"))).toBe(false);
    expect(registry.hostAllowed(at(""))).toBe(true);
    const blank = new Request("http://127.0.0.1:2000/x");
    blank.headers.delete("host");
    expect(registry.hostAllowed(blank)).toBe(true);
    expect(misdirected().status).toBe(421);
    expect(await misdirected().json()).toEqual({
      ok: false,
      error: "Endereço não reconhecido por este servidor.",
      code: "misdirected",
    });
  });

  test("the pool keeps one auth per origin, most recent first, up to the limit", () => {
    const built: string[] = [];
    const pool = createAuthPool((origin) => {
      built.push(origin);
      return { origin } as unknown as Auth;
    }, "http://127.0.0.1:2000");
    expect(pool.forOrigin("http://127.0.0.1:2000")).toBe(pool.fallback);
    const first = pool.forOrigin("https://a.example");
    expect(pool.forOrigin("https://a.example")).toBe(first);
    for (let index = 0; index < 33; index++) pool.forOrigin(`https://h${index}.example`);
    expect(pool.size()).toBe(32);
    expect(pool.forRequest(new Request("https://h32.example/x"))).toBe(pool.forOrigin("https://h32.example"));
    pool.forOrigin("https://a.example");
    expect(built.filter((origin) => origin === "https://a.example")).toHaveLength(2);
  });
});

describe("sign in from any address of the server", () => {
  test("accepts the origin the request arrived on, through the tailnet proxy and locally", async () => {
    const proxied = signIn("http://127.0.0.1:2996/api/auth/sign-in/email", {
      "tailscale-user-login": "dona@example.com",
      host: "bots.example.ts.net:10447",
      "x-forwarded-host": "bots.example.ts.net:10447",
      "x-forwarded-proto": "https",
      origin: tailnet,
    });
    const response = await mod.handle(proxied, null);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie")).toContain("__Secure-");
    const local = await mod.handle(
      signIn("http://localhost:2996/api/auth/sign-in/email", { origin: "http://localhost:2996" }),
      null,
    );
    expect(local?.status).toBe(200);
  });

  test("the session cookie the server hands out on an https origin opens pages on that origin", async () => {
    const forwarded = {
      "tailscale-user-login": "dona@example.com",
      host: "bots.example.ts.net:10447",
      "x-forwarded-host": "bots.example.ts.net:10447",
      "x-forwarded-proto": "https",
    };
    const signedIn = await mod.handle(
      signIn("http://127.0.0.1:2996/api/auth/sign-in/email", { ...forwarded, origin: tailnet }),
      null,
    );
    const token = signedIn?.headers.get("set-auth-token") ?? "";
    const meRequest = through(
      new Request("http://127.0.0.1:2996/auth/me", {
        headers: { ...forwarded, authorization: `Bearer ${token}` },
      }),
    );
    const outcome = await mod.authenticate(meRequest);
    expect(outcome).toHaveProperty("kind", "principal");
    const principal = (outcome as { principal: Parameters<AuthModule["handle"]>[1] }).principal;
    const me = (await (await mod.handle(meRequest, principal))?.json()) as { cookie: { name: string; value: string } };
    expect(me.cookie.name).toStartWith("__Secure-");
    const page = through(
      new Request("http://127.0.0.1:2996/bots/boss/artifacts/art_x/v/1.html", {
        headers: { ...forwarded, cookie: `${me.cookie.name}=${me.cookie.value}` },
      }),
    );
    expect(await mod.authenticate(page)).toHaveProperty("kind", "principal");
    const local = new Request("http://127.0.0.1:2996/bots", {
      headers: { cookie: `${me.cookie.name}=${me.cookie.value}` },
    });
    expect(await mod.authenticate(local)).toHaveProperty("status", 401);
  });

  test("refuses another site's origin and accepts a remembered profile origin", async () => {
    const foreign = await mod.handle(
      signIn("http://127.0.0.1:2996/api/auth/sign-in/email", {
        host: "bots.example.ts.net:10447",
        origin: "https://evil.example",
      }),
      null,
    );
    expect(foreign?.status).toBe(403);
    const remembered = await mod.handle(
      signIn("http://127.0.0.1:2996/api/auth/sign-in/email", { origin: "https://perfil.example.ts.net:10447" }),
      null,
    );
    expect(remembered?.status).toBe(200);
    expect(await mod.origins.remember("https://novo.example.ts.net")).toBe(false);
    expect(await mod.origins.remember("https://novo.example.ts.net", ownerPrincipal)).toBe(true);
    expect(saved.at(-1)).toEqual(["https://perfil.example.ts.net:10447", "https://novo.example.ts.net"]);
    const write = new Request("http://127.0.0.1:2996/bots", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect((await mod.authenticate(write)) as Response).toHaveProperty("status", 403);
  });
});
