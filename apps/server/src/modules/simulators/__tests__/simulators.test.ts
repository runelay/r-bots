import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { codeProcesses, makeRepo } from "../../../../test/code-helpers";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { Req } from "../../../shared/http";
import type { Socket } from "../../../shared/ws";
import * as macRunner from "../../accounts/services/mac-runner.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import { forgetServer, getServer, listServers, stopAllDevServers } from "../../code/services/dev-server.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { startProjectServer } from "../../servers/services/servers.service";
import { registerSimulatorTools } from "../services/simulator-tools.service";
import { expoScheme, expoUrl, hasDevClient, listDevices, openExpo, parseDevices } from "../services/simulators.service";
import { isTunnelUpgrade, tunnelSocket, tunnelUpgradeData } from "../services/tunnel.service";

let server: TestServer;
const spies: Mock<(...args: never[]) => unknown>[] = [];
const listeners: net.Server[] = [];
let counter = 0;

function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const created = spyOn(target, key as never) as unknown as Mock<(...args: never[]) => unknown>;
  spies.push(created);
  return created;
}

function deviceCalls(reply: (op: string, body: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
  spy(macRunner, "macDeviceCall").mockImplementation((async (op: string, body: Record<string, unknown>) => {
    calls.push({ op, body });
    return reply(op, body);
  }) as never);
  return calls;
}

function echoServer(port = 0) {
  return new Promise<number>((done) => {
    const item = net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
    item.listen({ port, host: "127.0.0.1" }, () => {
      listeners.push(item);
      done((item.address() as net.AddressInfo).port);
    });
  });
}

async function expoServer(files: Record<string, string>) {
  counter++;
  codeProcesses((call) => {
    if (call.command !== "bash") return undefined;
    const env = call.options.env as Record<string, string>;
    const item = net.createServer((socket) => socket.end());
    item.listen({ port: Number(env.PORT), host: "127.0.0.1" }, () => listeners.push(item));
    return { hang: true };
  });
  const repo = await makeRepo(`expo-${counter}`, {
    files: { "package.json": JSON.stringify({ scripts: { start: "expo start" } }), ...files },
  });
  const { server: launched, ready } = await startProjectServer({ path: repo.path, script: "start", startedBy: "user" });
  await ready;
  return { repo, id: launched.id };
}

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
});

afterEach(async () => {
  for (const item of spies.splice(0)) item.mockRestore();
  spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  stopAllDevServers();
  for (const item of listServers()) {
    const live = getServer(item.id);
    if (live?.child) live.child.kill();
    if (live) {
      await live.done;
      forgetServer(live);
    }
  }
  spyOn(process, "kill").mockRestore();
  await Promise.all(listeners.splice(0).map((item) => new Promise((done) => item.close(done))));
});

describe("simulators service", () => {
  test("parses the device list from the Mac", async () => {
    expect(
      parseDevices({
        devices: [
          { udid: "A", name: "iPhone", runtime: "iOS 26.5", state: "Booted" },
          { udid: "avd:Pixel", name: "Pixel", runtime: "Android", state: "Shutdown", platform: "android" },
          { name: "sem udid" },
          null,
        ],
        android: { sdk: true, adb: false },
        maestro: { installed: true, version: "2.0.10" },
      }),
    ).toEqual({
      devices: [
        { udid: "A", name: "iPhone", runtime: "iOS 26.5", state: "Booted", platform: "ios" },
        { udid: "avd:Pixel", name: "Pixel", runtime: "Android", state: "Shutdown", platform: "android" },
      ],
      android: { sdk: true, adb: false },
      maestro: { installed: true, version: "2.0.10" },
    });
    expect(parseDevices({})).toEqual({
      devices: [],
      android: { sdk: false, adb: false },
      maestro: { installed: false, version: null },
    });
    deviceCalls(() => ({ devices: [] }));
    expect((await listDevices()).devices).toEqual([]);
  });

  test("finds the Expo scheme and the dev client", async () => {
    codeProcesses();
    const repo = await makeRepo(`scheme-${++counter}`, {
      files: {
        "a/app.json": JSON.stringify({ expo: { scheme: "conty" } }),
        "b/app.config.json": JSON.stringify({ expo: { scheme: ["many", "x"] } }),
        "c/app.config.ts": 'type X = { scheme: string };\nexport default { scheme: "spark" };\n',
        "d/app.json": "{",
        "e/package.json": JSON.stringify({ dependencies: { "expo-dev-client": "~1" } }),
        "f/package.json": "{",
      },
    });
    expect(await expoScheme(repo.path, "a")).toBe("conty");
    expect(await expoScheme(repo.path, "b")).toBe("many");
    expect(await expoScheme(repo.path, "c")).toBe("spark");
    expect(await expoScheme(repo.path, "d")).toBeNull();
    expect(await hasDevClient(repo.path, "e")).toBe(true);
    expect(await hasDevClient(repo.path, "f")).toBe(false);
    expect(expoUrl(8081, "go", null)).toBe("exp://127.0.0.1:8081");
    expect(expoUrl(8081, "dev", "conty")).toBe(
      "conty://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081&disableOnboarding=1",
    );
    expect(expoUrl(8081, "dev", null)).toBe("exp://127.0.0.1:8081");
  });

  test("opens an Expo server through the Mac tunnel", async () => {
    const { id } = await expoServer({
      "app.json": JSON.stringify({ expo: { scheme: "conty" } }),
      "package.json": JSON.stringify({ scripts: { start: "expo start" }, dependencies: { "expo-dev-client": "1" } }),
    });
    const calls = deviceCalls((op) => (op === "sim.tunnel" ? { localPort: 19000 } : { url: "ok" }));
    const opened = await openExpo({ serverId: id, udid: "U1" });
    expect(opened).toEqual({
      url: "conty://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A19000&disableOnboarding=1",
      localPort: 19000,
      client: "dev",
      bridged: [],
      missing: [],
    });
    expect(calls.map((call) => call.op)).toEqual(["sim.tunnel", "sim.open_url"]);
    expect(calls[1].body.udid).toBe("U1");
    expect((await openExpo({ serverId: id, client: "go" })).url).toBe("exp://127.0.0.1:19000");
    for (const item of spies.splice(0)) item.mockRestore();
    deviceCalls(() => ({ localPort: "x" }));
    await expect(openExpo({ serverId: id })).rejects.toThrow("não abriu a ponte");
    await expect(openExpo({ serverId: "nope" })).rejects.toThrow("não está no ar");
  });

  test("bridges the local API ports the app points to", async () => {
    const api = await expoServer({});
    const apiPort = getServer(api.id)?.port as number;
    const other = await expoServer({});
    const otherPort = getServer(other.id)?.port as number;
    const { id } = await expoServer({
      ".env": `EXPO_PUBLIC_API_URL=http://localhost:${apiPort}\nEXPO_PUBLIC_X=http://127.0.0.1:${otherPort}/v1\nEXPO_PUBLIC_SITE=https://conty.com\nSECRET_URL=http://localhost:1\n`,
      ".env.local": "EXPO_PUBLIC_DOWN=http://localhost:65000\n",
    });
    const metroPort = getServer(id)?.port as number;
    const local = `EXPO_PUBLIC_SELF=http://localhost:${metroPort}\n`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(getServer(id)?.target.path as string, ".env.development"), local);
    const calls = deviceCalls((op, body) =>
      op === "sim.tunnel" ? { localPort: body.port === metroPort ? 19000 : body.port === apiPort ? apiPort : 1 } : {},
    );
    const opened = await openExpo({ serverId: id, client: "go" });
    expect(opened.bridged).toEqual([apiPort]);
    expect(opened.missing.sort((a, b) => a - b)).toEqual([otherPort, 65000].sort((a, b) => a - b));
    expect(calls.filter((call) => call.op === "sim.tunnel").map((call) => call.body.port)).toEqual([
      metroPort,
      ...[apiPort, otherPort].sort((a, b) => a - b),
    ]);
  });

  test("refuses servers that are not Metro", async () => {
    codeProcesses((call) => {
      if (call.command !== "bash") return undefined;
      const env = call.options.env as Record<string, string>;
      const item = net.createServer((socket) => socket.end());
      item.listen({ port: Number(env.PORT), host: "127.0.0.1" }, () => listeners.push(item));
      return { hang: true };
    });
    const repo = await makeRepo(`vite-${++counter}`, {
      files: { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) },
    });
    const { server: launched, ready } = await startProjectServer({ path: repo.path, script: "dev", startedBy: "user" });
    await ready;
    await expect(openExpo({ serverId: launched.id })).rejects.toThrow("não é um Metro");
  });
});

describe("tunnel", () => {
  test("accepts only devices and registered ports", async () => {
    expect(isTunnelUpgrade("/runner/tunnel")).toBe(true);
    expect(isTunnelUpgrade("/runner/connect")).toBe(false);
    const req = new Req(new Request("http://x/runner/tunnel?port=1"));
    spy(macRunner, "runnerUpgradeData").mockImplementation((() => null) as never);
    expect(tunnelUpgradeData(req, new URL("http://x/runner/tunnel?port=1")).status).toBe(401);
    for (const item of spies.splice(0)) item.mockRestore();
    spy(macRunner, "runnerUpgradeData").mockImplementation((() => ({ deviceKey: "d1" })) as never);
    expect(tunnelUpgradeData(req, new URL("http://x/runner/tunnel?port=1")).status).toBe(404);
    expect(tunnelUpgradeData(req, new URL("http://x/runner/tunnel?port=abc")).status).toBe(404);
    const { id } = await expoServer({});
    const port = getServer(id)?.port as number;
    expect(tunnelUpgradeData(req, new URL(`http://x/runner/tunnel?port=${port}`))).toEqual({
      status: 200,
      data: { kind: "tunnel", port, deviceKey: "d1" },
    });
  });

  function fakeClient(port: number) {
    const sent: Buffer[] = [];
    let closed = false;
    const client = {
      data: { kind: "tunnel", port },
      readyState: 1,
      send: (chunk: Buffer) => sent.push(Buffer.from(chunk)),
      close: () => {
        closed = true;
      },
    } as unknown as Socket;
    return { client, sent, closed: () => closed };
  }

  test("pipes bytes both ways and closes with the upstream", async () => {
    const port = await echoServer();
    const { client, sent, closed } = fakeClient(port);
    tunnelSocket.open(client);
    tunnelSocket.message(client, "hello ");
    tunnelSocket.message(client, Buffer.from("tunnel"));
    for (let i = 0; i < 200 && Buffer.concat(sent).toString() !== "hello tunnel"; i++) await Bun.sleep(5);
    expect(Buffer.concat(sent).toString()).toBe("hello tunnel");
    tunnelSocket.message(client, "again");
    for (let i = 0; i < 200 && !Buffer.concat(sent).toString().endsWith("again"); i++) await Bun.sleep(5);
    expect(Buffer.concat(sent).toString()).toEndWith("again");
    tunnelSocket.close(client, 1000, "");
    expect(closed()).toBe(false);
    const other = fakeClient(port);
    tunnelSocket.message(other.client, "ignored");
    tunnelSocket.close(other.client, 1000, "");
  });

  test("falls back to IPv6 and closes when nothing listens", async () => {
    const dead = await new Promise<number>((done) => {
      const item = net.createServer();
      item.listen({ port: 0, host: "127.0.0.1" }, () => {
        const port = (item.address() as net.AddressInfo).port;
        item.close(() => done(port));
      });
    });
    const { client, closed } = fakeClient(dead);
    tunnelSocket.open(client);
    for (let i = 0; i < 200 && !closed(); i++) await Bun.sleep(5);
    expect(closed()).toBe(true);
    tunnelSocket.close(client, 1000, "");
  });

  test("closes the client when the upstream ends", async () => {
    const port = await new Promise<number>((done) => {
      const item = net.createServer((socket) => socket.end("bye"));
      item.listen({ port: 0, host: "127.0.0.1" }, () => {
        listeners.push(item);
        done((item.address() as net.AddressInfo).port);
      });
    });
    const { client, sent, closed } = fakeClient(port);
    (client as unknown as { readyState: number }).readyState = 3;
    tunnelSocket.open(client);
    for (let i = 0; i < 200 && !closed(); i++) await Bun.sleep(5);
    expect(closed()).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("simulator tools and routes", () => {
  function harness() {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const context = {
      botId: "bot1",
      sessionId: "s1",
      turnId: "turn1",
      runId: () => "run1",
      log: {
        emit: (event: { type: string; data: Record<string, unknown> }) => events.push(event),
      } as unknown as EventLog,
      origin: null,
      ownerCallId: null,
      signal: new AbortController().signal,
      onCallStart: () => undefined,
      onCallEnd: () => undefined,
      onCallSettled: () => undefined,
      emitDecision: () => undefined,
      requestApproval: async () => ({ choice: "approve", interactionId: "i1" }),
      bot: { id: "bot1", name: "Bot", role: "dev" } as BotDefinition,
      decisions: { autoApprove: false, threshold: 0.7 },
      request: "",
      provider: "claude",
    } as unknown as ToolContext;
    const tools = new Map<
      string,
      (
        args: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }>
    >();
    registerSimulatorTools(
      { registerTool: (name: string, _c: unknown, handler: never) => tools.set(name, handler) } as unknown as McpServer,
      context,
    );
    return {
      events,
      call: (name: string, args: Record<string, unknown> = {}) =>
        (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>)(args),
    };
  }

  test("runs every simulator tool through the Mac", async () => {
    const calls = deviceCalls((op) => {
      if (op === "sim.list") return { devices: [{ udid: "U1", name: "iPhone", state: "Booted" }] };
      if (op === "sim.screenshot") return { base64: "aW1n", width: 10, height: 20 };
      if (op === "sim.tunnel") return { localPort: 19001 };
      return { ok: true };
    });
    const { call, events } = harness();
    expect((await call("simulator_list")).content[0].text).toContain("U1");
    expect((await call("simulator_boot", { udid: "U1" })).content[0].text).toContain("Ligado");
    expect((await call("simulator_shutdown", { udid: "U1" })).content[0].text).toBe("Desligado.");
    expect((await call("simulator_open_url", { url: "conty://x" })).content[0].text).toBe("Aberto.");
    const shot = await call("simulator_screenshot", {});
    expect(shot.content[0]).toEqual({ type: "image", data: "aW1n", mimeType: "image/jpeg" });
    expect((await call("simulator_tap", { text: "Entrar" })).content[0].text).toBe("Tocado.");
    expect((await call("simulator_type", { text: "oi" })).content[0].text).toBe("Digitado.");
    expect((await call("simulator_open_expo", { server: "nope" })).isError).toBe(true);
    const { id } = await expoServer({});
    expect((await call("simulator_open_expo", { server: id, udid: "U1", client: "go" })).content[0].text).toContain(
      "exp://127.0.0.1:19001",
    );
    const missing = await expoServer({ ".env": "EXPO_PUBLIC_API_URL=http://localhost:65001\n" });
    expect((await call("simulator_open_expo", { server: missing.id })).content[0].text).toContain("localhost:65001");
    const api = await expoServer({});
    const apiPort = getServer(api.id)?.port as number;
    for (const item of spies.splice(0)) item.mockRestore();
    deviceCalls((op, body) => (op === "sim.tunnel" ? { localPort: body.port } : {}));
    const bridged = await expoServer({ ".env": `EXPO_PUBLIC_API_URL=http://localhost:${apiPort}\n` });
    expect((await call("simulator_open_expo", { server: bridged.id })).content[0].text).toContain(
      `Ponte também para localhost:${apiPort}`,
    );
    expect(calls.map((item) => item.op)).toContain("sim.open_url");
    expect(events.filter((event) => event.type === "call.settled").length).toBeGreaterThanOrEqual(9);
  });

  test("lists and opens through the routes", async () => {
    deviceCalls((op) => (op === "sim.list" ? { devices: [] } : { localPort: 19002 }));
    expect((await request("/simulators")).body).toMatchObject({ devices: [] });
    expect((await request("/simulators/open-expo", { method: "POST", body: {} })).status).toBe(400);
    expect((await request("/simulators/open-expo", { method: "POST", body: "[]" })).status).toBe(400);
    expect((await request("/simulators/open-expo", { method: "POST", body: { server: "nope" } })).status).toBe(502);
    const { id } = await expoServer({});
    const opened = await request<{ url: string }>("/simulators/open-expo", {
      method: "POST",
      body: { server: id, udid: "U1", client: "go" },
    });
    expect(opened.body.url).toBe("exp://127.0.0.1:19002");
    expect((await request("/simulators/x", { method: "DELETE" })).status).toBe(404);
  });

  test("reports a Mac without simulator support", async () => {
    spy(macRunner, "macRunnerSupports").mockImplementation((() => false) as never);
    await expect(macRunner.macDeviceCall("sim.list", {})).rejects.toThrow("ainda não controla simuladores");
    writeFileSync(join(process.env.HOST_HOME as string, "unused.txt"), "");
  });
});
