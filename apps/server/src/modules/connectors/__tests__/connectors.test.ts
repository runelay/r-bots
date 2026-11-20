import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { eq } from "drizzle-orm";
import { fakeRunelay, request, startTestServer, type TestServer } from "../../../../test/helpers";
import { getDb } from "../../../db/client";
import { settings } from "../../../db/tables";
import { type BotDefinition, connectorsOf } from "../../bots/services/bots.service";
import { resetIntegrationCache, writeStored } from "../../integrations/services/integration-store.service";
import {
  classifyTool,
  getCatalog,
  installCatalogItem,
  isReadOnlySql,
  listConnections,
  type RunelayApiError,
  reconnectSource,
  removeSource,
  runelayApi,
  runelayCall,
  runelayEnabled,
  searchTools,
  touchesDatabase,
} from "../services/runelay.service";

const realFetch = globalThis.fetch;
const restores: Array<() => unknown> = [];
let server: TestServer;

const catalog = {
  sections: [
    {
      id: "work",
      title: "Trabalho",
      items: [
        { id: "linear", name: "Linear", featured: true, auth: "oauth", icon: "l.svg" },
        { id: "resend", name: "Resend", auth: "api_key", tokenUrl: "https://resend/keys", icon: "" },
        { id: "docs", auth: "none", installed: false, status: "idle", sourceName: "docs" },
        { id: "github", name: "GitHub", installed: true },
      ],
    },
    { id: "empty", title: "Só destaque", items: [{ id: "gmail", name: "Gmail", featured: true }] },
  ],
};

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore();
});

afterAll(async () => {
  await server.close();
});

describe("runelayCall", () => {
  test("parses JSON results and returns plain text as is", async () => {
    expect(runelayEnabled()).toBe(true);
    fakeRunelay.tool("echo", (args) => ({ got: args.value }));
    fakeRunelay.tool("hello", () => "olá");
    const [json, text] = await Promise.all([runelayCall("echo", { value: 3 }), runelayCall("hello", {})]);
    expect(json).toEqual({ got: 3 });
    expect(text).toBe("olá");
  });

  test("raises tool errors with their text or a default", async () => {
    fakeRunelay.tool("broken", () => {
      throw new Error("deu ruim");
    });
    await expect(runelayCall("broken", {})).rejects.toThrow("deu ruim");
    fakeRunelay.tool("silent", () => {
      throw new Error("");
    });
    await expect(runelayCall("silent", {})).rejects.toThrow("Falha em silent.");
  });

  test("reconnects once on a session error", async () => {
    let calls = 0;
    fakeRunelay.tool("flaky", () => {
      calls++;
      if (calls === 1) throw new Error("session expired");
      return { ok: true };
    });
    expect(await runelayCall("flaky", {})).toEqual({ ok: true });
    fakeRunelay.tool("dead", () => {
      throw new Error("socket closed");
    });
    await expect(runelayCall("dead", {})).rejects.toThrow("socket closed");
    expect(fakeRunelay.toolCalls.filter((call) => call.name === "dead")).toHaveLength(2);
  });

  test("drops the client when the connection closes", async () => {
    const clients: Client[] = [];
    const original = Client.prototype.connect;
    const connect = spyOn(Client.prototype, "connect").mockImplementation(function (
      this: Client,
      ...args: Parameters<Client["connect"]>
    ) {
      clients.push(this);
      return original.apply(this, args);
    });
    restores.push(() => connect.mockRestore());
    fakeRunelay.tool("ping", () => "pong");
    fakeRunelay.tool("boom", () => {
      throw new Error("fetch failed");
    });
    await expect(runelayCall("boom", {})).rejects.toThrow("fetch failed");
    expect(await runelayCall("ping", {})).toBe("pong");
    const latest = clients.at(-1) as Client;
    await latest.close();
    const before = clients.length;
    expect(await runelayCall("ping", {})).toBe("pong");
    expect(clients.length).toBe(before + 1);
    await clients.at(-1)?.close();
  });
});

describe("listConnections", () => {
  test("maps statuses and labels, caches and refreshes", async () => {
    let list: unknown[] = [
      { name: "linear_server", status: "ok", toolCount: 12, icon: "l.svg" },
      { name: "my-custom_thing", status: "needs_auth" },
      { name: "broken", status: "weird" },
      { name: "off", status: "ok", enabled: false },
    ];
    fakeRunelay.tool("list_connections", () => list);
    const first = await listConnections(true);
    expect(first).toEqual([
      { name: "linear_server", label: "Linear", icon: "l.svg", status: "ok", toolCount: 12, reconnectUrl: null },
      {
        name: "my-custom_thing",
        label: "My Custom Thing",
        icon: null,
        status: "needs_auth",
        toolCount: 0,
        reconnectUrl: process.env.RUNELAY_RECONNECT_URL as string,
      },
      {
        name: "broken",
        label: "Broken",
        icon: null,
        status: "error",
        toolCount: 0,
        reconnectUrl: process.env.RUNELAY_RECONNECT_URL as string,
      },
    ]);
    expect(connectorsOf({ connectors: { allowed: [], memory: true } } as unknown as BotDefinition).allowed).toEqual([
      "linear_server",
    ]);
    list = [];
    expect(await listConnections()).toBe(first);
    expect(await listConnections(true)).toEqual([]);
  });
});

describe("searchTools", () => {
  test("filters by allowed connectors and scopes a single source", async () => {
    fakeRunelay.tool("search_tools", (args) => [
      {
        name: "linear.list_issues",
        description: "x".repeat(700),
        inputSchema: { type: "object" },
        source: args.source,
      },
      { name: "github.get_pr", inputSchema: {} },
      { name: "gmail.send", description: "envia" },
    ]);
    const single = await searchTools("issues", ["linear"], 2);
    expect(single).toEqual([
      { name: "linear.list_issues", description: "x".repeat(600), inputSchema: { type: "object" } },
    ]);
    expect(fakeRunelay.toolCalls.at(-1)?.args).toEqual({ query: "issues", limit: 6, source: "linear" });
    const many = await searchTools("x", ["linear", "github"]);
    expect(many.map((item) => item.name)).toEqual(["linear.list_issues", "github.get_pr"]);
    expect(many[1].description).toBe("");
    expect(fakeRunelay.toolCalls.at(-1)?.args).toEqual({ query: "x", limit: 24 });
    expect(await searchTools("x", ["linear", "github"], 1)).toHaveLength(1);
    fakeRunelay.tool("search_tools", () => ({ not: "a list" }));
    expect(await searchTools("x", ["linear"])).toEqual([]);
  });
});

describe("classifyTool", () => {
  test("read-only sql is a read and anything else in sql touches the database", async () => {
    expect(classifyTool("supabase.execute_sql", { query: "select count(*) from users" })).toBe("read");
    expect(classifyTool("supabase.execute_sql", { query: "with a as (select 1) select * from a" })).toBe("read");
    expect(classifyTool("supabase.execute_sql", { query: "select 1; delete from x" })).toBe("outbound");
    expect(classifyTool("supabase.execute_sql", { query: "select * into t from x" })).toBe("outbound");
    expect(classifyTool("supabase.execute_sql", { query: "select nextval('s')" })).toBe("outbound");
    expect(touchesDatabase("supabase.apply_migration")).toBe(true);
    expect(touchesDatabase("linear.save_issue")).toBe(false);
  });

  test("classifies reads, writes and outbound actions", async () => {
    expect(classifyTool("gmail.send_email")).toBe("outbound");
    expect(classifyTool("linear.list_messages")).toBe("read");
    expect(classifyTool("supabase.execute_sql", { query: "delete from x" })).toBe("outbound");
    expect(classifyTool("supabase.query", { sql: "select 1" })).toBe("read");
    expect(classifyTool("linear.get_issue")).toBe("read");
    expect(classifyTool("linear.get_and_update")).toBe("write");
    expect(classifyTool("linear.save_issue")).toBe("write");
    expect(classifyTool("whoami")).toBe("read");
    expect(classifyTool("supabase.run_query", { statement: "select * from users" })).toBe("read");
    expect(classifyTool("supabase.run_query", { statement: 42, params: { op: "delete" } })).toBe("outbound");
    expect(classifyTool("supabase.run_query", { params: { op: "lookup" } })).toBe("write");
  });

  test("accepts only single read-only SQL statements", async () => {
    expect(isReadOnlySql("select 1;")).toBe(true);
    expect(isReadOnlySql("  WITH x AS (select 1) select * from x")).toBe(true);
    expect(isReadOnlySql("explain select * from t")).toBe(true);
    expect(isReadOnlySql("select 'delete; drop' as label -- update here\n")).toBe(true);
    expect(isReadOnlySql('select "insert" /* drop table */ from t')).toBe(true);
    expect(isReadOnlySql("select $tag$ delete $tag$ as body")).toBe(true);
    expect(isReadOnlySql("")).toBe(false);
    expect(isReadOnlySql("select 1; delete from t")).toBe(false);
    expect(isReadOnlySql("delete from t")).toBe(false);
    expect(isReadOnlySql("select * from t for update")).toBe(false);
    expect(isReadOnlySql("select pg_sleep(10)")).toBe(false);
    expect(isReadOnlySql("select nextval('s')")).toBe(false);
    expect(isReadOnlySql("select * into backup from t")).toBe(false);
  });

  test("detects tools that touch a database", async () => {
    expect(touchesDatabase("supabase.list_tables")).toBe(true);
    expect(touchesDatabase("neon.run_sql")).toBe(true);
    expect(touchesDatabase("github.apply_migration")).toBe(true);
    expect(touchesDatabase("linear.list_issues")).toBe(false);
  });
});

describe("runelayApi", () => {
  test("returns data and maps HTTP failures", async () => {
    fakeRunelay.route("GET", "/thing", { data: { a: 1 } });
    expect(await runelayApi("GET", "/thing")).toEqual({ a: 1 });
    fakeRunelay.route("POST", "/thing", (call) => ({ data: call.body }));
    expect(await runelayApi("POST", "/thing", { b: 2 })).toEqual({ b: 2 });
    const statuses: Array<[number, number]> = [
      [404, 404],
      [500, 502],
      [401, 502],
      [403, 502],
      [422, 400],
    ];
    for (const [given, expected] of statuses) {
      fakeRunelay.route("GET", "/fail", { status: given, body: { error: { message: `erro ${given}` } } });
      const error = (await runelayApi("GET", "/fail").catch((caught) => caught)) as RunelayApiError;
      expect([error.status, error.message]).toEqual([expected, `erro ${given}`]);
    }
    fakeRunelay.route("GET", "/fail", { status: 200, body: { error: { message: "veio erro" } } });
    expect(await runelayApi("GET", "/fail").catch((caught) => caught.status)).toBe(400);
    fakeRunelay.route("GET", "/fail", { status: 409, body: { error: null } });
    expect(await runelayApi("GET", "/fail").catch((caught) => caught.message)).toBe("runelay respondeu 409.");
  });

  test("handles bodies that are not JSON and network failures", async () => {
    const base = process.env.RUNELAY_API_URL ?? "";
    let mode: "html" | "throw" | "plain" = "html";
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const target = input instanceof Request ? input.url : String(input);
      if (!target.startsWith(base)) return realFetch(input, init);
      if (mode === "throw") throw new TypeError("refused");
      if (mode === "plain") return Promise.reject("plain");
      return new Response("<html>", { status: 502 });
    }) as typeof fetch);
    restores.push(() => spy.mockRestore());
    expect(await runelayApi("GET", "/x").catch((caught) => [caught.status, caught.message])).toEqual([
      502,
      "runelay respondeu 502.",
    ]);
    mode = "throw";
    expect(await runelayApi("GET", "/x").catch((caught) => [caught.status, caught.message])).toEqual([
      502,
      "runelay não respondeu: refused",
    ]);
    mode = "plain";
    expect(await runelayApi("GET", "/x").catch((caught) => caught.message)).toBe("runelay não respondeu: plain");
  });
});

describe("catalog", () => {
  test("splits featured items and normalizes fields", async () => {
    fakeRunelay.route("GET", "/catalog", { data: catalog });
    const result = await getCatalog("lin");
    expect(fakeRunelay.apiCalls.at(-1)?.path).toBe("/catalog?query=lin");
    expect(result.featured.map((item) => item.id)).toEqual(["linear", "gmail"]);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].items).toEqual([
      {
        id: "resend",
        name: "Resend",
        description: "",
        icon: null,
        auth: "api_key",
        tokenUrl: "https://resend/keys",
        featured: false,
        installed: false,
        sourceName: null,
        status: null,
      },
      {
        id: "docs",
        name: "docs",
        description: "",
        icon: null,
        auth: "none",
        tokenUrl: null,
        featured: false,
        installed: false,
        sourceName: "docs",
        status: "idle",
      },
      expect.objectContaining({ id: "github", auth: "oauth", installed: true }),
    ]);
    fakeRunelay.route("GET", "/catalog", { data: null });
    expect(await getCatalog("")).toEqual({ featured: [], sections: [] });
    expect(fakeRunelay.apiCalls.at(-1)?.path).toBe("/catalog");
  });

  test("installs, reconnects and removes sources", async () => {
    fakeRunelay.route("GET", "/catalog", { data: catalog });
    fakeRunelay.route("POST", "/catalog/install", (call) => ({
      data: { name: `src-${(call.body as { id: string }).id}`, status: "ok", error: null },
    }));
    fakeRunelay.route("POST", "/sources/src-linear/oauth", { data: { authorizationUrl: "https://auth/linear" } });
    fakeRunelay.route("POST", "/sources/src-docs/oauth", { data: null });
    expect(await installCatalogItem("linear")).toEqual({
      sourceName: "src-linear",
      status: "ok",
      error: null,
      authorizationUrl: "https://auth/linear",
    });
    expect(await installCatalogItem("resend", "tok")).toMatchObject({
      sourceName: "src-resend",
      authorizationUrl: null,
    });
    expect(
      fakeRunelay.apiCalls.find(
        (call) => call.path === "/catalog/install" && (call.body as { id: string }).id === "resend",
      )?.body,
    ).toEqual({ id: "resend", token: "tok" });
    fakeRunelay.route("POST", "/catalog/install", { data: { name: "src-docs", status: "error" } });
    expect(await installCatalogItem("docs")).toEqual({
      sourceName: "src-docs",
      status: "error",
      error: null,
      authorizationUrl: null,
    });
    const missing = (await installCatalogItem("nope").catch((error) => error)) as RunelayApiError;
    expect([missing.status, missing.message]).toEqual([404, 'Não existe conector "nope" no catálogo.']);
    const installed = (await installCatalogItem("github").catch((error) => error)) as RunelayApiError;
    expect([installed.status, installed.message]).toEqual([409, "GitHub já está instalado."]);
    const noToken = (await installCatalogItem("resend").catch((error) => error)) as RunelayApiError;
    expect([noToken.status, noToken.message]).toEqual([400, "Resend pede um token."]);
    fakeRunelay.route("GET", "/catalog", { data: null });
    expect((await installCatalogItem("linear").catch((error) => error)).status).toBe(404);

    expect(await reconnectSource("src-linear")).toEqual({
      sourceName: "src-linear",
      authorizationUrl: "https://auth/linear",
    });
    expect(await reconnectSource("src-docs")).toEqual({ sourceName: "src-docs", authorizationUrl: null });
    fakeRunelay.route("DELETE", "/sources/src-linear", { data: null });
    expect(await removeSource("src-linear")).toEqual({ ok: true, sourceName: "src-linear" });
  });
});

describe("routes", () => {
  test("GET /connectors lists and refreshes connections", async () => {
    let status = "ok";
    fakeRunelay.tool("list_connections", () => [{ name: "github", status }]);
    const listed = await request<Array<{ name: string; status: string }>>("/connectors?refresh=1");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ name: "github", status: "ok" })]);
    status = "needs_auth";
    const cached = await request<Array<{ status: string }>>("/connectors");
    expect(cached.body[0].status).toBe("ok");
    const refreshed = await request<Array<{ status: string }>>("/connectors/refresh", { method: "POST", body: "x" });
    expect(refreshed.body[0].status).toBe("needs_auth");
    fakeRunelay.tool("list_connections", () => {
      throw new Error("indisponível");
    });
    const failed = await request<{ error: string }>("/connectors/refresh", { method: "POST" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("runelay não respondeu: indisponível");
  });

  test("connector actions", async () => {
    fakeRunelay.route("GET", "/catalog", { data: catalog });
    const listed = await request<{ featured: unknown[] }>("/connectors/catalog?query=%20lin%20");
    expect(listed.status).toBe(200);
    expect(listed.body.featured).toHaveLength(2);
    expect(fakeRunelay.apiCalls.at(-1)?.path).toBe("/catalog?query=lin");

    const invalid = await request<{ field: string }>("/connectors/Bad%20Name/install", { method: "POST" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.field).toBe("name");

    fakeRunelay.route("POST", "/catalog/install", { data: { name: "src-resend", status: "ok", error: null } });
    const installed = await request<{ sourceName: string }>("/connectors/resend/install", {
      method: "POST",
      body: { token: "  tok  " },
    });
    expect(installed.status).toBe(201);
    expect(fakeRunelay.apiCalls.at(-1)?.body).toEqual({ id: "resend", token: "tok" });

    const blankToken = await request<{ error: string }>("/connectors/resend/install", {
      method: "POST",
      body: { token: "   " },
    });
    expect(blankToken.status).toBe(400);
    expect(blankToken.body.error).toBe("Resend pede um token.");
    const badBody = await request<{ error: string }>("/connectors/resend/install", { method: "POST", body: "{x" });
    expect(badBody.status).toBe(400);

    fakeRunelay.route("POST", "/sources/src-linear/oauth", { data: { authorizationUrl: "https://a" } });
    const reconnected = await request("/connectors/src-linear/reconnect", { method: "POST", body: "{x" });
    expect(reconnected.body).toEqual({ sourceName: "src-linear", authorizationUrl: "https://a" });

    fakeRunelay.route("DELETE", "/sources/src-linear", { data: null });
    const removed = await request("/connectors/src-linear", { method: "DELETE" });
    expect(removed.body).toEqual({ ok: true, sourceName: "src-linear" });

    const unknown = await request("/connectors/src-linear", { method: "PATCH" });
    expect(unknown.status).toBe(404);

    fakeRunelay.route("GET", "/catalog", { data: { sections: [{ id: "x", title: "X" }] } });
    const broken = await request<{ error: string }>("/connectors/catalog");
    expect(broken.status).toBe(502);
    expect(broken.body.error).toStartWith("runelay não respondeu:");

    const putList = await request("/connectors", { method: "PUT" });
    expect(putList.status).toBe(404);
  });
});

async function forgetStoredRunelay() {
  await getDb().delete(settings).where(eq(settings.key, "integration:runelay"));
  await resetIntegrationCache();
}

describe("configuration", () => {
  const anyBot = { connectors: { allowed: [], memory: true } } as unknown as BotDefinition;

  test("refuses to work when runelay is not configured", async () => {
    const saved = process.env.RUNELAY_MCP_TOKEN;
    delete process.env.RUNELAY_MCP_TOKEN;
    restores.push(() => {
      process.env.RUNELAY_MCP_TOKEN = saved;
    });
    expect(runelayEnabled()).toBe(false);
    await expect(runelayCall("anything", {})).rejects.toThrow("runelay não está configurado no servidor.");
    const error = (await runelayApi("GET", "/x").catch((caught) => caught)) as RunelayApiError;
    expect([error.status, error.message]).toEqual([503, "runelay não está configurado no servidor."]);
    const listed = await request<{ error: string }>("/connectors");
    expect([listed.status, listed.body.error]).toEqual([503, "runelay não está configurado no servidor."]);
  });

  test("forgets known connectors when the app clears the credentials", async () => {
    fakeRunelay.tool("list_connections", () => [{ name: "notion", status: "ok" }]);
    await listConnections(true);
    expect(connectorsOf(anyBot).allowed).toEqual(["notion"]);
    restores.push(forgetStoredRunelay);
    await writeStored("runelay", "", null);
    expect(runelayEnabled()).toBe(false);
    expect(connectorsOf(anyBot).allowed).toEqual([]);
  });

  test("reloads connections when the app saves runelay credentials", async () => {
    fakeRunelay.tool("list_connections", () => [{ name: "notion", status: "ok" }]);
    await runelayCall("list_connections", {});
    const close = spyOn(Client.prototype, "close").mockRejectedValueOnce(new Error("already closed"));
    restores.push(() => close.mockRestore());
    restores.push(forgetStoredRunelay);
    await writeStored("runelay", fakeRunelay.token, fakeRunelay.mcpUrl);
    expect(close).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 10_000 && !connectorsOf(anyBot).allowed.includes("notion"); attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(connectorsOf(anyBot).allowed).toEqual(["notion"]);
    fakeRunelay.route("GET", "/thing", { data: { from: "stored" } });
    expect(await runelayApi("GET", "/thing")).toEqual({ from: "stored" });
    const calls = fakeRunelay.toolCalls.length;
    await writeStored("jev", "jev-secret-123", null);
    restores.push(async () => {
      await getDb().delete(settings).where(eq(settings.key, "integration:jev"));
      await resetIntegrationCache();
    });
    expect(fakeRunelay.toolCalls.length).toBe(calls);
  });

  test("ignores a failed reload after a credential change", async () => {
    fakeRunelay.tool("list_connections", () => {
      throw new Error("not yet");
    });
    restores.push(forgetStoredRunelay);
    await writeStored("runelay", fakeRunelay.token, fakeRunelay.mcpUrl);
    for (
      let attempt = 0;
      attempt < 10_000 && !fakeRunelay.toolCalls.some((call) => call.name === "list_connections");
      attempt++
    )
      await new Promise((resolve) => setImmediate(resolve));
    expect(fakeRunelay.toolCalls.some((call) => call.name === "list_connections")).toBe(true);
  });

  test("derives the API base from the MCP url when none is set", async () => {
    const saved = process.env.RUNELAY_API_URL;
    delete process.env.RUNELAY_API_URL;
    restores.push(() => {
      process.env.RUNELAY_API_URL = saved;
    });
    fakeRunelay.route("GET", "/thing", { data: { from: "mcp origin" } });
    expect(await runelayApi("GET", "/thing")).toEqual({ from: "mcp origin" });
  });
});
