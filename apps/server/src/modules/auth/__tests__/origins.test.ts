import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../../test/db-helpers";
import { type AuthModule, createAuthModule } from "..";
import type { Auth } from "../services/auth.service";
import { createAuthPool, createOriginRegistry, normalizeOrigin, requestOrigin } from "../services/origins.service";

const tailnet = "https://bots.example.ts.net:10447";
let dir: string;
let mod: AuthModule;
const saved: string[][] = [];

function signIn(url: string, headers: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "rb=1", ...headers },
    body: JSON.stringify({ email: "dona@example.com", password: "correct horse battery" }),
  });
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Dona", email: "dona@example.com", password: "correct horse battery" }),
    }),
    null,
  );
  expect(created?.status).toBe(201);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("request origin", () => {
  test("comes from the forwarded host and protocol, then the host header, then the url", () => {
    const forwarded = new Request("http://127.0.0.1:2000/x", {
      headers: {
        host: "bots.example.ts.net:10447",
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "a.example:1, b",
      },
    });
    expect(requestOrigin(forwarded)).toBe("https://a.example:1");
    const hosted = new Request("http://127.0.0.1:2000/x", {
      headers: { host: "bots.example.ts.net:10447", "x-forwarded-proto": "ftp" },
    });
    expect(requestOrigin(hosted)).toBe("http://bots.example.ts.net:10447");
    expect(requestOrigin(new Request("http://127.0.0.1:2000/x"))).toBe("http://127.0.0.1:2000");
    const broken = new Request("http://127.0.0.1:2000/x", { headers: { "x-forwarded-host": "exa mple" } });
    expect(requestOrigin(broken)).toBe("http://127.0.0.1:2000");
    expect(normalizeOrigin("https://a.example/caminho")).toBe("https://a.example");
    expect(normalizeOrigin("nada")).toBeNull();
    expect(normalizeOrigin("file:///tmp/x")).toBeNull();
  });

  test("the registry trusts the request's own origin and remembered ones, and saves new ones once", async () => {
    const writes: string[][] = [];
    const registry = createOriginRegistry({ known: ["https://um.example/a"], save: (list) => void writes.push(list) });
    const request = new Request("http://127.0.0.1:2000/x", {
      headers: { host: "dois.example", "x-forwarded-proto": "https" },
    });
    expect(registry.trusts("https://dois.example", request)).toBe(true);
    expect(registry.trusts("https://um.example", request)).toBe(true);
    expect(registry.trusts("https://evil.example", request)).toBe(false);
    expect(await registry.remember("https://tres.example/x")).toBe(true);
    expect(await registry.remember("https://tres.example")).toBe(false);
    expect(await registry.remember("nada")).toBe(false);
    expect(writes).toEqual([["https://um.example", "https://tres.example"]]);
    expect(await createOriginRegistry().remember("https://quatro.example")).toBe(true);
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
    expect(await mod.origins.remember("https://novo.example.ts.net")).toBe(true);
    expect(saved.at(-1)).toEqual(["https://perfil.example.ts.net:10447", "https://novo.example.ts.net"]);
    const write = new Request("http://127.0.0.1:2996/bots", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect((await mod.authenticate(write)) as Response).toHaveProperty("status", 403);
  });
});
