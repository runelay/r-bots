import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { request, startTestServer, type TestServer } from "../../test/helpers";
import { apiRoots, bodyLimitFor, checkBody, nonRunnerMessageLimit, routeTable } from "../app";
import * as accounts from "../modules/accounts/routes/accounts.routes";
import type { AuthModule, Principal } from "../modules/auth";
import { useAuthModule } from "../modules/auth/gate";
import * as bots from "../modules/bots/routes/bots.routes";
import * as code from "../modules/code/routes/code.routes";
import * as previewRoutes from "../modules/code/routes/preview.routes";
import * as computer from "../modules/computer/routes/computer.routes";
import * as connectors from "../modules/connectors/routes/connectors.routes";
import * as devices from "../modules/devices/routes/devices.routes";
import * as mcp from "../modules/engine/routes/mcp.routes";
import * as environments from "../modules/environments/routes/environments.routes";
import * as github from "../modules/github/routes/github.routes";
import * as groups from "../modules/groups/routes/groups.routes";
import * as integrations from "../modules/integrations/routes/integrations.routes";
import * as jobs from "../modules/jobs/routes/jobs.routes";
import * as linear from "../modules/linear/routes/linear.routes";
import * as providers from "../modules/providers/routes/providers.routes";
import * as review from "../modules/review/routes/review.routes";
import * as sections from "../modules/sections/routes/sections.routes";
import * as serverVersion from "../modules/server-version/routes/server-version.routes";
import * as servers from "../modules/servers/routes/servers.routes";
import * as preferences from "../modules/settings/routes/preferences.routes";
import * as simulators from "../modules/simulators/routes/simulators.routes";
import * as skills from "../modules/skills/routes/skills.routes";
import * as metrics from "../modules/status/routes/metrics.routes";
import * as status from "../modules/status/routes/status.routes";
import * as tests from "../modules/tests/routes/tests.routes";
import * as tools from "../modules/tools/routes/tools.routes";
import * as usage from "../modules/usage/routes/usage.routes";
import * as vault from "../modules/vault/routes/vault.routes";
import * as voice from "../modules/voice/routes/voice.routes";
import { Res, sendJson } from "../shared/http";

let server: TestServer;
const restores: Array<() => void> = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  useAuthModule(null);
  delete process.env.BOTS_PREVIEW_ORIGIN;
});

afterAll(async () => {
  await server.close();
});

const member: Principal = { userId: "m", email: "m@x.co", name: "M", role: "member", method: "session" };

function fakeAuth(principal: Principal | null) {
  useAuthModule({
    authenticate: async () => (principal ? { kind: "principal", principal } : { kind: "public" }),
    handle: async () => null,
  } as unknown as AuthModule);
}

describe("router table", () => {
  test("derives the API roots from the routes so previews never shadow them", () => {
    for (const root of ["vault", "integrations", "devices", "usage", "jobs", "status", "bots", "code", "mcp"])
      expect(apiRoots.has(root)).toBe(true);
    for (const root of ["api", "auth", "device", "runner", "preview"]) expect(apiRoots.has(root)).toBe(true);
    expect(routeTable.every((entry) => apiRoots.has(entry.root))).toBe(true);
    expect(apiRoots.has("assets")).toBe(false);
  });
});

describe("routing through the table", () => {
  test("every root reaches its module", async () => {
    const vault = await request<{ error: string }>("/vault/secrets");
    expect([vault.status, vault.body.error]).toEqual([401, "O cofre só responde ao app r/bots."]);
    const integrations = await request<{ integrations: unknown[] }>("/integrations");
    expect(Array.isArray(integrations.body.integrations)).toBe(true);
    const devices = await request<{ code: string }>("/devices");
    expect([devices.status, devices.body.code]).toEqual([401, "unauthorized"]);
    expect(Array.isArray((await request("/sections")).body)).toBe(true);
    expect((await request("/groups")).status).toBe(200);
    expect((await request("/jobs")).status).not.toBe(404);
    const usageHandler = spyOn(usage, "handleUsageRoute").mockImplementation(async (res) =>
      sendJson(res, 200, { usage: true }),
    );
    restores.push(() => usageHandler.mockRestore());
    expect((await request("/usage/summary")).body).toEqual({ usage: true });
    expect(Array.isArray((await request("/code/repos")).body)).toBe(true);
    expect((await request("/mcp/nobody/none", { method: "POST", body: {} })).status).toBeGreaterThanOrEqual(400);
    const refreshed = await request<unknown[]>("/accounts/refresh", { method: "POST" });
    expect(Array.isArray(refreshed.body)).toBe(true);
    const controller = new AbortController();
    const stream = await fetch(`${server.url}/status/stream`, { signal: controller.signal });
    const reader = stream.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"type":"snapshot"');
    controller.abort();
  });
});

describe("dispatch of every route entry", () => {
  test("sends each root, method and shape to its own handler with the parsed path", async () => {
    const routes: Array<[Record<string, unknown>, string, string, string]> = [
      [status, "handleHealth", "GET", "/health"],
      [code, "handleCodeRoute", "GET", "/code/repos"],
      [status, "handleMeta", "GET", "/meta"],
      [mcp, "handleMcp", "POST", "/mcp/bot-1/session-1"],
      [vault, "handleVaultRoute", "GET", "/vault/secrets"],
      [integrations, "handleIntegrations", "GET", "/integrations"],
      [accounts, "handleAccounts", "GET", "/accounts"],
      [accounts, "handleAccountsRefresh", "POST", "/accounts/refresh"],
      [accounts, "handleAccountRoutes", "DELETE", "/accounts/acc-1"],
      [devices, "handleDevices", "GET", "/devices"],
      [usage, "handleUsageRoute", "GET", "/usage/limits"],
      [voice, "handleVoices", "GET", "/voice/voices"],
      [skills, "handleSkills", "GET", "/skills"],
      [sections, "handleSections", "GET", "/sections"],
      [groups, "handleGroups", "GET", "/groups"],
      [github, "handleGitHub", "GET", "/github/pulls"],
      [linear, "handleLinear", "GET", "/linear/views"],
      [review, "handleReview", "GET", "/review"],
      [jobs, "handleJobs", "GET", "/jobs"],
      [preferences, "handlePreferences", "GET", "/preferences"],
      [servers, "handleServers", "GET", "/servers"],
      [tests, "handleTests", "GET", "/tests"],
      [simulators, "handleSimulators", "GET", "/simulators"],
      [status, "handleStatus", "GET", "/status"],
      [status, "handleStatusStream", "GET", "/status/stream"],
      [metrics, "handleMetrics", "GET", "/metrics"],
      [environments, "handleEnvironments", "GET", "/environments"],
      [providers, "handleProviders", "GET", "/providers/versions"],
      [tools, "handleTools", "GET", "/tools"],
      [serverVersion, "handleServerVersion", "GET", "/server/version"],
      [computer, "handleComputerHealth", "GET", "/computer/health"],
      [connectors, "handleConnectorActions", "POST", "/connectors/github/install"],
      [connectors, "handleConnections", "GET", "/connectors"],
      [bots, "handleBots", "GET", "/bots"],
    ];
    const seen: Array<{ name: string; args: unknown[] }> = [];
    for (const [module, name] of routes) {
      const handler = spyOn(module, name as never).mockImplementation(((...args: unknown[]) => {
        seen.push({ name, args: args.filter((arg) => typeof arg === "string" || Array.isArray(arg)) });
        const res = args.find((arg) => arg instanceof Res) as Res;
        sendJson(res, 200, { route: name });
      }) as never);
      restores.push(() => (handler as unknown as { mockRestore(): void }).mockRestore());
    }
    for (const [, name, method, path] of routes) {
      const reply = await request<{ route: string }>(path, { method });
      expect([path, reply.status, reply.body.route]).toEqual([path, 200, name]);
    }
    expect(seen.map((item) => item.name)).toEqual(routes.map(([, name]) => name));
    expect(seen.find((item) => item.name === "handleMcp")?.args).toEqual(["bot-1", "session-1"]);
    expect(seen.find((item) => item.name === "handleAccountRoutes")?.args).toEqual(["DELETE", ["accounts", "acc-1"]]);
    expect(seen.find((item) => item.name === "handleConnectorActions")?.args).toEqual([
      "POST",
      ["connectors", "github", "install"],
    ]);
    expect(seen.find((item) => item.name === "handleConnections")?.args).toEqual(["GET"]);
  });
});

describe("request hardening", () => {
  test("refuses encoded separators and dot segments before routing", async () => {
    const encoded = await fetch(`${server.url}/%62ots/..%2Fvault`);
    expect(encoded.status).toBe(400);
    expect(await encoded.json()).toEqual({ ok: false, error: "Caminho inválido.", code: "bad_path" });
    expect(encoded.headers.get("x-content-type-options")).toBe("nosniff");
    const decoded = await request("/%68ealth");
    expect(decoded.body).toEqual({ ok: true });
  });

  test("adds the security headers to every API answer", async () => {
    const health = await request("/health");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");
    expect(health.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(health.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(health.headers.get("permissions-policy")).toContain("microphone=()");
    expect(health.headers.get("cache-control")).toBe("no-store");
    const missing = await request("/nowhere");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("caps request bodies per route from the declared length", async () => {
    expect(bodyLimitFor("GET", ["bots"])).toBeNull();
    expect(bodyLimitFor("POST", ["bots", "b", "uploads"])).toBeNull();
    expect(bodyLimitFor("POST", ["mcp", "b", "s"])).toBe(32 * 1024 * 1024);
    expect(bodyLimitFor("POST", ["voice", "x"])).toBe(32 * 1024 * 1024);
    expect(bodyLimitFor("POST", ["bots", "b", "voice", "x"])).toBe(32 * 1024 * 1024);
    expect(bodyLimitFor("PUT", ["auth", "me", "avatar"])).toBe(2 * 1024 * 1024);
    expect(bodyLimitFor("POST", ["api", "auth", "sign-in", "email"])).toBe(16 * 1024);
    expect(bodyLimitFor("POST", ["auth", "setup"])).toBe(16 * 1024);
    expect(bodyLimitFor("POST", ["auth", "invites", "accept"])).toBe(16 * 1024);
    expect(bodyLimitFor("PATCH", ["bots", "b"])).toBe(4 * 1024 * 1024);
    expect(bodyLimitFor("POST", ["groups", "g"])).toBe(4 * 1024 * 1024);
    expect(bodyLimitFor("POST", ["code", "x"])).toBe(1024 * 1024);
    expect(bodyLimitFor("PUT", ["integrations", "jev"])).toBe(64 * 1024);
    const big = await fetch(`${server.url}/integrations/jev`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "x".repeat(65 * 1024),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({
      ok: false,
      error: "O corpo da requisição passa do limite desta rota.",
      code: "too_large",
    });
    const auth = await fetch(`${server.url}/auth/setup`, { method: "POST", body: "x".repeat(17 * 1024) });
    expect(auth.status).toBe(413);
    const chunked = checkBody(
      new Request("http://x/integrations/jev", { method: "PUT", headers: { "transfer-encoding": "chunked" } }),
      ["integrations", "jev"],
    );
    expect(chunked?.status).toBe(411);
    const odd = checkBody(
      new Request("http://x/integrations/jev", { method: "PUT", headers: { "content-length": "-1" } }),
      ["integrations", "jev"],
    );
    expect(odd?.status).toBe(400);
    expect(checkBody(new Request("http://x/integrations/jev", { method: "PUT" }), ["integrations", "jev"])).toBeNull();
    expect(checkBody(new Request("http://x/bots/b/uploads", { method: "POST" }), ["bots", "b", "uploads"])).toBeNull();
  });

  test("the router itself refuses a protected route when the gate left no principal", async () => {
    fakeAuth(null);
    const refused = await request<{ code: string }>("/bots");
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("unauthorized");
    expect((await request("/health")).status).toBe(200);
    const live = await fetch(`${server.url}/bots/x/browser/live`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(live.status).toBe(401);
  });

  test("a member reaches normal routes and is refused on owner routes", async () => {
    fakeAuth(member);
    expect((await request("/bots")).status).toBe(200);
    const create = await request<{ code: string }>("/bots", { method: "POST", body: { name: "x" } });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("forbidden");
    expect((await request("/jobs")).status).toBe(403);
  });

  test("with a preview origin, API routes are refused on that host and previews only run there", async () => {
    process.env.BOTS_PREVIEW_ORIGIN = "https://preview.example.ts.net";
    const onPreview = await request("/health", { headers: { host: "preview.example.ts.net" } });
    expect(onPreview.status).toBe(404);
    expect((await request("/health")).status).toBe(200);
  });

  test("closes a non-runner socket that sends a message over the limit", async () => {
    const closes: number[] = [];
    const relay = spyOn(previewRoutes, "previewUpgradeTarget").mockImplementation(() => ({
      port: 1,
      path: "/hmr",
      protocols: [],
    }));
    const open = spyOn(previewRoutes.previewSocket, "open").mockImplementation(() => undefined);
    const message = spyOn(previewRoutes.previewSocket, "message").mockImplementation(() => undefined);
    const close = spyOn(previewRoutes.previewSocket, "close").mockImplementation(() => undefined);
    restores.push(() => {
      relay.mockRestore();
      open.mockRestore();
      message.mockRestore();
      close.mockRestore();
    });
    const isPreview = spyOn(previewRoutes, "isPreviewTraffic").mockReturnValue(true);
    restores.push(() => isPreview.mockRestore());
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/hmr`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
    const closed = new Promise<void>((resolve) =>
      ws.addEventListener("close", (event) => {
        closes.push(event.code);
        resolve();
      }),
    );
    ws.send("small");
    ws.send("x".repeat(nonRunnerMessageLimit + 1));
    await closed;
    expect(closes).toEqual([1009]);
    expect(message).toHaveBeenCalledTimes(1);
  });
});
