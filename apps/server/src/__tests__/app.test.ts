import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { makeBot } from "../../test/engine-helpers";
import { fakeRunelay, request, startTestServer, type TestServer } from "../../test/helpers";
import * as macRunner from "../modules/accounts/services/mac-runner.service";
import type { AuthModule } from "../modules/auth";
import { useAuthModule } from "../modules/auth/gate";
import * as desktop from "../modules/browser/services/desktop.service";
import * as live from "../modules/browser/services/live-view.service";
import * as codeRoutes from "../modules/code/routes/code.routes";
import * as botCode from "../modules/code/services/bot-code.service";
import * as status from "../modules/status/routes/status.routes";
import type { Res } from "../shared/http";
import type { Socket } from "../shared/ws";

let server: TestServer;
const restores: Array<() => void> = [];

function track<T extends { mockRestore(): void }>(spy: T) {
  restores.push(() => spy.mockRestore());
  return spy;
}

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  useAuthModule(null);
});

afterAll(async () => {
  await server.close();
});

type Events = { open: Socket[]; message: string[]; close: number[]; pong: number };

function recordSocket(handler: typeof macRunner.runnerSocket) {
  const events: Events = { open: [], message: [], close: [], pong: 0 };
  track(spyOn(handler, "open").mockImplementation((ws) => events.open.push(ws)));
  track(spyOn(handler, "message").mockImplementation((_ws, message) => events.message.push(String(message))));
  track(spyOn(handler, "close").mockImplementation((_ws, code) => events.close.push(code)));
  if (handler.pong)
    track(
      spyOn(handler, "pong").mockImplementation(() => {
        events.pong++;
      }),
    );
  return events;
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

function connect(path: string, protocols?: string[]) {
  const ws = new WebSocket(`${server.url.replace("http", "ws")}${path}`, protocols);
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("refused")), { once: true });
  });
  return { ws, opened };
}

describe("HTTP routing", () => {
  test("serves health and meta and answers 404 for unknown routes", async () => {
    expect((await request("/health")).body).toEqual({ ok: true });
    const meta = await request<{ engine: string }>("/meta");
    expect(meta.body.engine).toBe("multi-provider");
    expect((await request("/nowhere/at/all")).status).toBe(404);
    expect((await request("/health", { method: "POST" })).status).toBe(404);
    expect((await request("/meta", { method: "DELETE" })).status).toBe(404);
  });

  test("serves the GET-only shortcuts", async () => {
    const computer = await request<{ ok: boolean; code: string }>("/computer/health");
    expect(computer.body).toMatchObject({ ok: false, code: "COMPUTER_UNAVAILABLE" });
    const accounts = await request<Array<{ id: string }>>("/accounts");
    expect(accounts.body.some((account) => account.id === "vps:claude")).toBe(true);
    const voices = await request<{ error: string }>("/voice/voices");
    expect(voices.status).toBe(503);
    expect(voices.body.error).toContain("ElevenLabs");
    fakeRunelay.route("GET", "/skills", { data: { items: [], nextCursor: null } });
    const skills = await request("/skills");
    expect(fakeRunelay.apiCalls.some((call) => call.path.startsWith("/skills"))).toBe(true);
    expect(skills.status).toBeLessThan(500);
  });

  test("routes connectors by shape", async () => {
    const invalid = await request<{ field: string }>("/connectors/Bad%20Name/install", { method: "POST" });
    expect([invalid.status, invalid.body.field]).toEqual([400, "name"]);
    fakeRunelay.tool("list_connections", () => [{ name: "github", status: "ok" }]);
    const listed = await request<Array<{ name: string }>>("/connectors/refresh", { method: "POST" });
    expect(listed.body.map((item) => item.name)).toEqual(["github"]);
    expect((await request("/connectors/refresh")).status).toBe(404);
  });

  test("routes GET-only paths and falls through for other methods", async () => {
    expect((await request("/skills", { method: "POST" })).status).toBe(404);
    expect((await request("/voice/voices", { method: "PUT" })).status).toBe(404);
    expect((await request("/computer/health", { method: "POST" })).status).toBe(404);
    const accounts = await request("/accounts", { method: "PATCH" });
    expect(accounts.status).toBe(404);
  });

  test("turns a failing handler into a 500 with the reason", async () => {
    track(spyOn(console, "error").mockImplementation(() => undefined));
    track(
      spyOn(status, "handleMeta").mockImplementation(() => {
        throw new Error("meta exploded");
      }),
    );
    const response = await request<{ ok: boolean; error: string }>("/meta");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, error: "meta exploded" });
  });

  test("reports non-Error failures and closes a stream that already started", async () => {
    const errors = track(spyOn(console, "error").mockImplementation(() => undefined));
    track(
      spyOn(status, "handleHealth").mockImplementation(() => {
        throw "plain failure";
      }),
    );
    const plain = await request<{ error: string }>("/health");
    expect(plain.body.error).toBe("plain failure");
    track(
      spyOn(status, "handleStatus").mockImplementation((res: Res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        throw new Error("mid stream");
      }),
    );
    const partial = await request("/status");
    expect(partial.status).toBe(200);
    expect(partial.text).toBe("partial");
    expect(errors).toHaveBeenCalled();
  });

  test("lets the auth gate block a request", async () => {
    useAuthModule({
      authenticate: async () => Response.json({ ok: false, code: "unauthorized" }, { status: 401 }),
      handle: async () => null,
    } as unknown as AuthModule);
    const blocked = await request<{ code: string }>("/meta");
    expect(blocked.status).toBe(401);
    expect((await request("/nowhere")).status).toBe(401);
  });
});

describe("websocket upgrades", () => {
  test("refuses the runner without credentials and accepts it with them", async () => {
    const refused = await fetch(`${server.url}/runner/connect`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(refused.status).toBe(401);
    const events = recordSocket(macRunner.runnerSocket);
    const data = { kind: "runner" as const, deviceKey: "d1", rank: 1, deviceName: "Mac", userId: "u1" };
    track(spyOn(macRunner, "runnerUpgradeData").mockReturnValue(data));
    const runner = connect("/runner/connect");
    await runner.opened;
    await until(() => events.open.length === 1);
    expect(events.open[0].data).toEqual(data);
    runner.ws.send("hello");
    (runner.ws as unknown as { pong(): void }).pong();
    await until(() => events.message.length === 1 && events.pong === 1);
    runner.ws.close(1000);
    await until(() => events.close.length === 1);
    expect(events.message).toEqual(["hello"]);
    expect(events.close).toEqual([1000]);
  });

  test("answers 400 when the upgrade handshake is broken", async () => {
    const data = { kind: "runner" as const, deviceKey: "d1", rank: 1, deviceName: "Mac", userId: "u1" };
    track(spyOn(macRunner, "runnerUpgradeData").mockReturnValue(data));
    const broken = await fetch(`${server.url}/runner/connect`, { headers: { upgrade: "websocket" } });
    expect(broken.status).toBe(400);
    expect(await broken.text()).toBe("Upgrade failed");
  });

  test("relays preview sockets with and without a subprotocol", async () => {
    const events = recordSocket(codeRoutes.previewSocket);
    track(
      spyOn(codeRoutes, "previewUpgradeTarget").mockImplementation((req) =>
        req.url?.startsWith("/app")
          ? {
              port: 5310,
              path: "/app",
              protocols: (req.headers["sec-websocket-protocol"] ?? "")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            }
          : null,
      ),
    );
    const withProtocol = connect("/app", ["vite-hmr"]);
    await withProtocol.opened;
    expect(withProtocol.ws.protocol).toBe("vite-hmr");
    const plain = connect("/app");
    await plain.opened;
    await until(() => events.open.length === 2);
    expect(events.open.map((ws) => ws.data.kind)).toEqual(["preview", "preview"]);
    withProtocol.ws.close();
    plain.ws.close();
    await until(() => events.close.length === 2);
  });

  test("opens desktop and live sockets only for bots that can use them", async () => {
    const desktopEvents = recordSocket(desktop.desktopSocket);
    const liveEvents = recordSocket(live.liveSocket);
    const bot = await makeBot();
    const missing = await fetch(`${server.url}/bots/${bot.id}/browser/live`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(missing.status).toBe(404);
    const unknown = await fetch(`${server.url}/bots/nobody/browser/live`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(unknown.status).toBe(404);
    track(spyOn(botCode, "botIsCoding").mockRejectedValue(new Error("no workspace")));
    expect(
      (
        await fetch(`${server.url}/bots/${bot.id}/browser/live`, {
          headers: { upgrade: "websocket", connection: "Upgrade" },
        })
      ).status,
    ).toBe(404);

    bot.capabilities = { ...bot.capabilities, desktop: true, browser: true };
    const desk = connect(`/bots/${bot.id}/desktop/live`);
    await desk.opened;
    await until(() => desktopEvents.open.length === 1);
    expect(desktopEvents.open[0].data).toEqual({ kind: "desktop", botId: bot.id });

    const browser = connect(`/bots/${bot.id}/browser/live`);
    await browser.opened;
    await until(() => liveEvents.open.length === 1);
    expect(liveEvents.open[0].data).toEqual({ kind: "live", botId: bot.id });
    const notLive = await fetch(`${server.url}/bots/${bot.id}/browser`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(notLive.status).toBe(404);
    desk.ws.close();
    browser.ws.close();
    await until(() => desktopEvents.close.length === 1 && liveEvents.close.length === 1);
  });
});
