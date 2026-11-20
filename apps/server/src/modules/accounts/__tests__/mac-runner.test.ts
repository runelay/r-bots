import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { host, port } from "../../../config/env";
import { Req } from "../../../shared/http";
import type { Socket } from "../../../shared/ws";
import type { AuthModule } from "../../auth";
import { gate, notifyUserRevoked, useAuthModule } from "../../auth/gate";
import {
  disconnectMacDevice,
  disconnectMacUser,
  isRunnerUpgrade,
  MacRunnerUnavailable,
  macAccounts,
  macComputerCall,
  macComputerHealth,
  macDeviceCall,
  macDeviceLastSeen,
  macReadFile,
  macRunnerAuthorized,
  macRunnerConnected,
  macRunnerConnections,
  macRunnerInfo,
  macRunnerSupports,
  macSecretResolve,
  macTranscribeFile,
  macUsageBuckets,
  macUsageLimits,
  onMacRunnerChange,
  revokedCloseCode,
  runMacTurn,
  runnerConnectPath,
  runnerSocket,
  runnerUpgradeData,
  useMcpForwarder,
  watchMacComputerEvents,
} from "../services/mac-runner.service";

function device(key: string, rank: number, name = `Mac ${key}`, extra: Record<string, unknown> = {}) {
  return { kind: "runner", deviceKey: key, rank, deviceName: name, userId: "u1", owner: true, ...extra };
}

type Sent = {
  type: string;
  id: string;
  op?: string;
  body?: Record<string, unknown> | string;
  turn?: TurnRequest;
  status?: number;
  headers?: Record<string, string>;
};

function socket(data: Record<string, unknown> = device("main", 1)) {
  const sent: Sent[] = [];
  const closed: Array<[number, string]> = [];
  const ws = {
    readyState: 1,
    data,
    pings: 0,
    terminated: false,
    failPing: false,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Sent);
    },
    close(code: number, reason: string) {
      closed.push([code, reason]);
    },
    ping() {
      if (ws.failPing) throw new Error("ping failed");
      ws.pings++;
    },
    terminate() {
      ws.terminated = true;
    },
  };
  const as = ws as unknown as Socket;
  return {
    ws,
    as,
    sent,
    closed,
    open() {
      runnerSocket.open(as);
    },
    say(message: unknown) {
      runnerSocket.message(as, typeof message === "string" ? message : JSON.stringify(message));
    },
    answer(index: number, reply: Record<string, unknown>) {
      runnerSocket.message(as, JSON.stringify({ type: "response", id: sent[index].id, ...reply }));
    },
    drop() {
      ws.readyState = 3;
      runnerSocket.close(as, 1000, "");
    },
  };
}

const open: Array<ReturnType<typeof socket>> = [];

async function connect(data?: Record<string, unknown>) {
  const runner = socket(data);
  runner.open();
  open.push(runner);
  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
    for (const message of runner.sent.splice(0))
      if (message.type === "request") runner.say({ type: "response", id: message.id, ok: true, result: [] });
  }
  return runner;
}

function turn(id: string): TurnRequest {
  return { turnId: id, provider: "claude" } as unknown as TurnRequest;
}

beforeEach(() => {
  for (const live of macRunnerConnections()) disconnectMacDevice(live.key, 1000, "test");
});

afterEach(async () => {
  for (const runner of open.splice(0)) runner.drop();
  jest.useRealTimers();
  useAuthModule(null);
  useMcpForwarder(null);
});

describe("connection", () => {
  test("reports the runner as offline when nothing is connected", async () => {
    expect(macRunnerConnected()).toBe(false);
    expect(macRunnerInfo()).toEqual({ connected: false, connectedAt: null, version: null });
    expect(macRunnerSupports("computer")).toBe(false);
    await expect(macAccounts()).rejects.toBeInstanceOf(MacRunnerUnavailable);
    expect(isRunnerUpgrade(runnerConnectPath)).toBe(true);
    expect(isRunnerUpgrade("/runner")).toBe(false);
  });

  test("tracks hello, notifies listeners and replaces an older socket", async () => {
    const changes: boolean[] = [];
    const stop = onMacRunnerChange((connected) => changes.push(connected));
    const stopBroken = onMacRunnerChange(() => {
      throw new Error("listener broke");
    });
    const first = await connect();
    first.say({ type: "hello", version: "2.0", capabilities: ["computer"] });
    expect(macRunnerConnected()).toBe(true);
    expect(macRunnerInfo()).toMatchObject({ connected: true, version: "2.0" });
    expect(macRunnerSupports("computer")).toBe(true);
    expect(macRunnerSupports("voice")).toBe(false);
    const second = await connect();
    expect(first.closed).toEqual([[4000, "replaced"]]);
    expect(macRunnerSupports("computer")).toBe(false);
    first.drop();
    expect(macRunnerConnected()).toBe(true);
    second.drop();
    expect(macRunnerConnected()).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    stop();
    stopBroken();
  });

  test("ignores garbage, unknown responses and binary frames", async () => {
    const runner = await connect();
    runner.say("not json");
    runner.say({ type: "response", id: "nobody" });
    runner.say({ type: "turn.event", id: "nobody", event: { type: "text" } });
    runner.say({ type: "turn.end", id: "nobody" });
    runnerSocket.message(runner.as, Buffer.from("{}"));
    const pending = macUsageLimits();
    runner.answer(0, { ok: true, result: { claude: 1 } });
    expect(await pending).toEqual({ claude: 1 });
  });

  test("pings on a heartbeat and terminates a silent runner", async () => {
    jest.useFakeTimers();
    const runner = await connect();
    jest.advanceTimersByTime(15_000);
    expect(runner.ws.pings).toBe(1);
    runnerSocket.pong?.(runner.as);
    jest.advanceTimersByTime(15_000);
    expect(runner.ws.pings).toBe(2);
    runner.say({ type: "noop" });
    runner.ws.failPing = true;
    jest.advanceTimersByTime(15_000);
    expect(runner.ws.terminated).toBe(false);
    jest.advanceTimersByTime(15_000);
    expect(runner.ws.terminated).toBe(true);
    runnerSocket.pong?.({} as Socket);
    runnerSocket.message({} as Socket, "{}");
  });
});

describe("authorization", () => {
  test("refuses everything while auth is off", async () => {
    const req = new Req(new Request("http://127.0.0.1/runner/connect", { headers: { authorization: "Bearer x" } }));
    expect(macRunnerAuthorized(req)).toBe(false);
    expect(runnerUpgradeData(req)).toBeNull();
  });

  test("accepts only a device token from a signed in account", async () => {
    const principal = { userId: "u1", email: "a@b.c", name: "A", role: "owner", method: "session" as const };
    const devicePrincipal = {
      ...principal,
      method: "api-key" as const,
      apiKeyId: "key-1",
      device: { id: "dev-1", name: "MacBook", registeredAt: "2026-11-19T10:00:00.000Z" },
    };
    const undated = {
      ...devicePrincipal,
      role: "member",
      apiKeyId: undefined,
      device: { id: "dev-2", name: "", registeredAt: "" },
    };
    const touched: string[] = [];
    useAuthModule({
      authenticate: async (request: Request) => {
        const header = request.headers.get("authorization");
        if (header === "Bearer device") return { kind: "principal", principal: devicePrincipal };
        if (header === "Bearer undated") return { kind: "principal", principal: undated };
        if (header === "Bearer broken")
          return { kind: "principal", principal: { ...devicePrincipal, apiKeyId: "key-broken" } };
        return header ? { kind: "principal", principal } : { kind: "public" };
      },
      handle: async () => null,
      devices: {
        touchKey: async (id: string) => {
          touched.push(id);
          if (id === "key-broken") throw new Error("db down");
          return true;
        },
      },
    } as unknown as AuthModule);
    const signed = new Request("http://127.0.0.1/runner/connect", { headers: { authorization: "Bearer s" } });
    const fromDevice = new Request("http://127.0.0.1/runner/connect", { headers: { authorization: "Bearer device" } });
    const fromUndated = new Request("http://127.0.0.1/runner/connect", {
      headers: { authorization: "Bearer undated" },
    });
    const anonymous = new Request("http://127.0.0.1/runner/connect");
    for (const request of [signed, fromDevice, fromUndated, anonymous]) expect(await gate(request)).toBeNull();
    expect(macRunnerAuthorized(new Req(signed))).toBe(true);
    expect(macRunnerAuthorized(new Req(anonymous))).toBe(false);
    expect(runnerUpgradeData(new Req(signed))).toBeNull();
    expect(runnerUpgradeData(new Req(fromDevice))).toEqual({
      kind: "runner",
      deviceKey: "dev-1",
      rank: Date.parse("2026-11-19T10:00:00.000Z"),
      deviceName: "MacBook",
      userId: "u1",
      owner: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(touched).toEqual(["key-1"]);
    const broken = new Request("http://127.0.0.1/runner/connect", { headers: { authorization: "Bearer broken" } });
    expect(await gate(broken)).toBeNull();
    expect(runnerUpgradeData(new Req(broken))).toMatchObject({ deviceKey: "dev-1" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(touched).toEqual(["key-1", "key-broken"]);
    expect(runnerUpgradeData(new Req(fromUndated))).toMatchObject({
      deviceKey: "dev-2",
      rank: 0,
      deviceName: null,
      owner: false,
    });
    expect(runnerUpgradeData(new Req(anonymous))).toBeNull();
  });
});

describe("several Macs", () => {
  test("keeps one connection per device and prefers the oldest registered", async () => {
    const changes: Array<[boolean, string]> = [];
    const stop = onMacRunnerChange((connected, key) => changes.push([connected, key]));
    const newer = await connect(device("b", 200));
    const older = await connect(device("a", 100));
    older.say({ type: "hello", version: "3.1", capabilities: ["computer"] });
    expect(macRunnerConnected("a")).toBe(true);
    expect(macRunnerConnected("zzz")).toBe(false);
    expect(macRunnerSupports("computer")).toBe(true);
    expect(macRunnerSupports("computer", "b")).toBe(false);
    expect(macRunnerInfo()).toMatchObject({ connected: true, version: "3.1" });
    expect(macRunnerConnections().map((item) => [item.key, item.name, item.version])).toEqual([
      ["b", "Mac b", null],
      ["a", "Mac a", "3.1"],
    ]);
    older.sent.splice(0);
    newer.sent.splice(0);
    const health = macComputerHealth();
    const asked = older.sent.find((item) => item.op === "computer.health");
    expect(asked).toBeDefined();
    expect(newer.sent.some((item) => item.op === "computer.health")).toBe(false);
    newer.say({ type: "response", id: asked?.id, body: { ok: false } });
    older.say({ type: "response", id: asked?.id, body: { ok: true } });
    expect(await health).toEqual({ ok: true });
    newer.sent.splice(0);
    const listed = macAccounts("b");
    const listing = newer.sent.find((item) => item.op === "accounts");
    newer.say({ type: "response", id: listing?.id, ok: true, result: [] });
    expect(await listed).toEqual([]);
    await expect(macAccounts("zzz")).rejects.toThrow("não está conectado");
    expect(macDeviceLastSeen("a")).not.toBeNull();
    expect(macDeviceLastSeen("never")).toBeNull();
    const pendingOnNewer = macAccounts("b");
    newer.drop();
    await expect(pendingOnNewer).rejects.toThrow("desconectou");
    expect(macDeviceLastSeen("b")).not.toBeNull();
    expect(macRunnerConnected("a")).toBe(true);
    expect(changes.filter(([connected]) => !connected).map(([, key]) => key)).toEqual(["b"]);
    stop();
  });

  test("disconnects a revoked device and fails its running turn", async () => {
    const runner = await connect(device("dev-x", 1));
    const events: ProviderEvent[] = [];
    const finished = runMacTurn(turn("rv"), new AbortController().signal, (event) => events.push(event), "dev-x");
    expect(disconnectMacDevice("dev-x")).toBe(true);
    await finished;
    expect(runner.closed).toEqual([[revokedCloseCode, "revoked"]]);
    expect(events).toEqual([{ type: "done", ok: false, message: "O app runelay bots fechou no meio do turno." }]);
    expect(disconnectMacDevice("dev-x")).toBe(false);
    const broken = await connect(device("dev-y", 2));
    broken.ws.close = () => {
      throw new Error("already closed");
    };
    expect(disconnectMacDevice("dev-y")).toBe(true);
    expect(macRunnerConnected("dev-y")).toBe(false);
  });

  test("never picks a member's Mac by default and serves it only when addressed", async () => {
    const member = await connect(device("member-mac", 1, "Mac do membro", { userId: "u2", owner: false }));
    expect(macRunnerConnected()).toBe(false);
    expect(macRunnerInfo()).toMatchObject({ connected: false });
    await expect(macComputerHealth()).rejects.toThrow("não está conectado");
    const events: ProviderEvent[] = [];
    await runMacTurn(turn("m0"), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: "O app runelay bots não está conectado." }]);
    expect(macRunnerConnected("member-mac")).toBe(true);
    const listed = macAccounts("member-mac");
    const asked = member.sent.find((item) => item.op === "accounts");
    member.say({ type: "response", id: asked?.id, ok: true, result: [] });
    expect(await listed).toEqual([]);
    const owner = await connect(device("owner-mac", 50));
    expect(macRunnerInfo()).toMatchObject({ connected: true });
    owner.sent.splice(0);
    const health = macComputerHealth();
    const probe = owner.sent.find((item) => item.op === "computer.health");
    owner.say({ type: "response", id: probe?.id, body: { ok: true } });
    expect(await health).toEqual({ ok: true });
  });

  test("refuses a socket for the same device from another account and drops a revoked user", async () => {
    const mine = await connect(device("shared", 1));
    const stranger = await connect(device("shared", 1, "Mac", { userId: "u9" }));
    expect(stranger.closed).toEqual([[4003, "device conflict"]]);
    expect(mine.closed).toEqual([]);
    expect(macRunnerConnections().find((item) => item.key === "shared")?.userId).toBe("u1");
    await connect(device("other", 2));
    expect(disconnectMacUser("u1")).toBe(2);
    expect(disconnectMacUser("u1")).toBe(0);
    expect(macRunnerConnected("shared")).toBe(false);
    await connect(device("again", 3));
    notifyUserRevoked("u1", ["again"]);
    expect(macRunnerConnected("again")).toBe(false);
  });

  test("a replaced socket that fails to close is still dropped", async () => {
    const first = await connect(device("dup", 1));
    first.ws.close = () => {
      throw new Error("gone");
    };
    const second = await connect(device("dup", 1));
    expect(macRunnerConnections().filter((item) => item.key === "dup")).toHaveLength(1);
    second.say({ type: "hello", capabilities: ["turns"] });
    expect(macRunnerSupports("turns", "dup")).toBe(true);
  });

  test("closes a socket that is not tied to a device", async () => {
    const runner = socket({ kind: "runner", deviceKey: 5 });
    runner.open();
    expect(runner.closed).toEqual([[4003, "device required"]]);
    expect(macRunnerConnections()).toEqual([]);
    runner.say({ type: "hello" });
    runner.drop();
  });

  test("routes a turn to the device and tells when it is gone", async () => {
    const runner = await connect(device("t-dev", 1));
    const events: ProviderEvent[] = [];
    const finished = runMacTurn(turn("td"), new AbortController().signal, (event) => events.push(event), "t-dev");
    expect(runner.sent[0]).toMatchObject({ type: "turn.start", id: "td" });
    runner.say({ type: "turn.end", id: "td" });
    await finished;
    const gone: ProviderEvent[] = [];
    await runMacTurn(turn("tg"), new AbortController().signal, (event) => gone.push(event), "missing");
    expect(gone).toEqual([{ type: "done", ok: false, message: "Mac desconectado." }]);
  });
});

describe("mcp over the connection", () => {
  function mcpTurn(url: string): TurnRequest {
    return { turnId: "m1", provider: "claude", mcp: { url, token: "tk" } } as unknown as TurnRequest;
  }

  test("sends the MCP path when the app has the local proxy", async () => {
    const runner = await connect(device("px", 1));
    runner.say({ type: "hello", capabilities: ["mcp-proxy"] });
    void runMacTurn(mcpTurn("http://127.0.0.1:2000/mcp/bot/sess"), new AbortController().signal, () => {}, "px");
    expect(runner.sent[0].turn?.mcp).toEqual({ url: "/mcp/bot/sess", token: "tk" });
    runner.say({ type: "turn.end", id: "m1" });
    void runMacTurn(mcpTurn("not a url"), new AbortController().signal, () => {}, "px");
    expect(runner.sent[1].turn?.mcp).toEqual({ url: "not a url", token: "tk" });
    runner.say({ type: "turn.end", id: "m1" });
    const old = await connect(device("old", 2));
    void runMacTurn(mcpTurn("http://127.0.0.1:2000/mcp/bot/sess"), new AbortController().signal, () => {}, "old");
    expect(old.sent[0].turn?.mcp).toEqual({ url: "http://127.0.0.1:2000/mcp/bot/sess", token: "tk" });
    old.say({ type: "turn.end", id: "m1" });
  });

  test("forwards MCP calls to the server and returns status, headers and body", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    useMcpForwarder(async (path, init) => {
      calls.push({ path, init });
      return new Response('{"jsonrpc":"2.0"}', {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s1", "x-other": "no" },
      });
    });
    const runner = await connect(device("fw", 1));
    runner.say({
      type: "mcp.request",
      id: "q1",
      method: "post",
      path: "/mcp/bot/sess",
      headers: { Authorization: "Bearer tk", "Content-Type": "application/json", Cookie: "no", Accept: 3 },
      body: '{"jsonrpc":"2.0","method":"tools/list"}',
    });
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls[0].path).toBe("/mcp/bot/sess");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ authorization: "Bearer tk", "content-type": "application/json" });
    expect(calls[0].init.body).toBe('{"jsonrpc":"2.0","method":"tools/list"}');
    expect(runner.sent.at(-1)).toEqual({
      type: "mcp.response",
      id: "q1",
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      body: '{"jsonrpc":"2.0"}',
    } as Sent);
    runner.say({ type: "mcp.request", id: "q2", method: "DELETE", path: "/mcp/bot/sess", headers: null });
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls[1].init).toMatchObject({ method: "DELETE", headers: {} });
    expect(calls[1].init.body).toBeUndefined();
  });

  test("forwards to the local server by default", async () => {
    const seen: string[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return new Response("{}", { status: 202 });
    }) as typeof fetch);
    try {
      const runner = await connect(device("loop", 1));
      runner.say({ type: "mcp.request", id: "l1", method: "GET", path: "/mcp/bot/sess" });
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(seen).toEqual([`http://${host}:${port}/mcp/bot/sess`]);
      expect(runner.sent.find((item) => item.id === "l1")).toMatchObject({ status: 202, body: "{}" });
    } finally {
      spy.mockRestore();
    }
  });

  test("refuses paths outside the MCP route and reports a failing server", async () => {
    useMcpForwarder(async () => {
      throw new Error("refused");
    });
    const runner = await connect(device("bad", 1));
    runner.say({ type: "mcp.request", id: "r1", method: "POST", path: "/bots" });
    runner.say({ type: "mcp.request", id: "r2", method: "PUT", path: "/mcp/a/b" });
    runner.say({ type: "mcp.request", path: "/mcp/a/b" });
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(runner.sent.map((item) => [item.id, item.status])).toEqual([
      ["r1", 404],
      ["r2", 404],
      ["", 502],
    ]);
    expect(JSON.parse(String(runner.sent[2].body))).toEqual({ ok: false, error: "O servidor não respondeu ao MCP." });
    runner.say({ type: "mcp.request", id: "r3", method: "POST", path: "/mcp/a/b" });
    runner.ws.readyState = 3;
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(runner.sent).toHaveLength(3);
  });
});

describe("requests", () => {
  test("lists accounts or reports the runner error", async () => {
    const runner = await connect();
    const listed = macAccounts();
    expect(runner.sent[0]).toMatchObject({ type: "request", op: "accounts" });
    runner.answer(0, { ok: true, result: [{ provider: "claude" }] });
    expect(await listed).toEqual([{ provider: "claude" }] as never);
    const empty = macAccounts();
    runner.answer(1, {});
    expect(await empty).toEqual([]);
    const failed = macAccounts();
    runner.answer(2, { ok: false, error: "sem CLI" });
    await expect(failed).rejects.toThrow("sem CLI");
    const bare = macAccounts();
    runner.answer(3, { ok: false });
    await expect(bare).rejects.toThrow("O Mac não listou as contas.");
  });

  test("computer health and tool calls", async () => {
    const runner = await connect();
    const health = macComputerHealth();
    runner.answer(0, { body: { ok: true, screen: "on" } });
    expect(await health).toEqual({ ok: true, screen: "on" });
    const missing = macComputerHealth();
    runner.answer(1, {});
    expect(await missing).toEqual({ ok: false });
    const call = macComputerCall("click", { args: { x: 1 } });
    expect(runner.sent[2]).toMatchObject({ op: "computer.tool", tool: "click", body: { args: { x: 1 } } } as never);
    runner.answer(2, { status: 201, body: { ok: true, result: 3 } });
    expect(await call).toEqual({ status: 201, body: { ok: true, result: 3 } });
    const bare = macComputerCall("click", {});
    runner.answer(3, {});
    expect(await bare).toEqual({ status: 500, body: {} });
  });

  test("calls simulator operations on a Mac that supports them", async () => {
    const runner = await connect();
    await expect(macDeviceCall("sim.list", {})).rejects.toThrow("ainda não controla simuladores");
    runner.say({ type: "hello", capabilities: ["simulators"] });
    for (let i = 0; i < 100 && !macRunnerSupports("simulators"); i++) await Bun.sleep(2);
    const list = macDeviceCall("sim.list", { a: 1 });
    expect(runner.sent[0]).toMatchObject({ op: "sim.list", body: { a: 1 } } as never);
    runner.answer(0, { ok: true, result: { devices: [] } });
    expect(await list).toEqual({ devices: [] });
    const bare = macDeviceCall("sim.boot", {});
    runner.answer(1, {});
    expect(await bare).toEqual({});
    const failed = macDeviceCall("sim.boot", {});
    runner.answer(2, { ok: false });
    await expect(failed).rejects.toThrow("O Mac não conseguiu.");
    const reason = macDeviceCall("sim.boot", {});
    runner.answer(3, { ok: false, error: "sem xcode" });
    await expect(reason).rejects.toThrow("sem xcode");
  });

  test("reads a file, transcribes and reads usage", async () => {
    const runner = await connect();
    const file = macReadFile("~/a.txt", 10);
    runner.answer(0, { ok: true, result: { path: "/Users/a/a.txt", name: "a.txt", base64: btoa("oi") } });
    const read = await file;
    expect(read.path).toBe("/Users/a/a.txt");
    expect(read.name).toBe("a.txt");
    expect(read.bytes.toString()).toBe("oi");
    const bare = macReadFile("~/b.txt", 10);
    runner.answer(1, {});
    expect(await bare).toMatchObject({ path: "~/b.txt", name: "" });
    const failedFile = macReadFile("~/c", 1);
    runner.answer(2, { ok: false });
    await expect(failedFile).rejects.toThrow("O Mac não enviou o arquivo.");
    const failedFileReason = macReadFile("~/c", 1);
    runner.answer(3, { ok: false, error: "não existe" });
    await expect(failedFileReason).rejects.toThrow("não existe");

    const text = macTranscribeFile("AAAA", "a.m4a");
    expect(runner.sent[4].body).toEqual({ audioBase64: "AAAA", name: "a.m4a", locale: "pt-BR" });
    runner.answer(4, { ok: true, result: { text: "  olá  " } });
    expect(await text).toBe("olá");
    const empty = macTranscribeFile("AAAA", "a.m4a");
    runner.answer(5, {});
    expect(await empty).toBe("");
    const failedText = macTranscribeFile("AAAA", "a.m4a");
    runner.answer(6, { ok: false });
    await expect(failedText).rejects.toThrow("O Mac não transcreveu.");
    const failedTextReason = macTranscribeFile("AAAA", "a.m4a");
    runner.answer(7, { ok: false, error: "mudo" });
    await expect(failedTextReason).rejects.toThrow("mudo");

    const limits = macUsageLimits();
    runner.answer(8, {});
    expect(await limits).toEqual({});
    const failedLimits = macUsageLimits();
    runner.answer(9, { ok: false });
    await expect(failedLimits).rejects.toThrow("O Mac não leu os limites.");
    const failedLimitsReason = macUsageLimits();
    runner.answer(10, { ok: false, error: "x" });
    await expect(failedLimitsReason).rejects.toThrow("x");

    const buckets = macUsageBuckets(5);
    expect(runner.sent[11].body).toEqual({ since: 5 });
    runner.answer(11, { ok: true, result: { a: 1 } });
    expect(await buckets).toEqual({ a: 1 });
    const emptyBuckets = macUsageBuckets(5);
    runner.answer(12, {});
    expect(await emptyBuckets).toEqual({});
    const failedBuckets = macUsageBuckets(5);
    runner.answer(13, { ok: false });
    await expect(failedBuckets).rejects.toThrow("O Mac não leu o uso.");
    const failedBucketsReason = macUsageBuckets(5);
    runner.answer(14, { ok: false, error: "y" });
    await expect(failedBucketsReason).rejects.toThrow("y");

    const secret = macSecretResolve({ name: "s", botId: "b", botName: "B", tool: "t", domain: null });
    runner.answer(15, { ok: true, value: "v" });
    expect(await secret).toMatchObject({ type: "response", ok: true, value: "v" });
  });

  test("times out, cancels and fails when the runner drops", async () => {
    jest.useFakeTimers();
    const runner = await connect();
    const late = macComputerHealth();
    jest.advanceTimersByTime(5000);
    await expect(late).rejects.toThrow("O Mac não respondeu a tempo.");

    const controller = new AbortController();
    const cancelled = macComputerCall("click", {}, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow("Cancelado.");

    const answered = new AbortController();
    const done = macComputerCall("click", {}, answered.signal);
    runner.answer(2, { status: 200, body: { ok: true } });
    await done;
    answered.abort();

    const dropped = macUsageLimits();
    runner.drop();
    await expect(dropped).rejects.toThrow("O app runelay bots desconectou.");
  });
});

describe("computer events", () => {
  test("forwards valid events to every listener", async () => {
    const runner = await connect();
    const events: unknown[] = [];
    const stop = watchMacComputerEvents((event) => events.push(event));
    const stopBroken = watchMacComputerEvents(() => {
      throw new Error("bad listener");
    });
    runner.say({ type: "computer.event", event: { type: "stop", botId: "b1" } });
    runner.say({ type: "computer.event" });
    runner.say({ type: "computer.event", event: { type: 3 } });
    stop();
    stopBroken();
    runner.say({ type: "computer.event", event: { type: "stop" } });
    expect(events).toEqual([{ type: "stop", botId: "b1" }]);
  });
});

describe("runMacTurn", () => {
  test("streams events until the runner ends the turn", async () => {
    const runner = await connect();
    const events: ProviderEvent[] = [];
    const finished = runMacTurn(turn("t1"), new AbortController().signal, (event) => events.push(event));
    expect(runner.sent[0]).toMatchObject({ type: "turn.start", id: "t1" });
    runner.say({ type: "turn.event", id: "t1", event: { type: "text", part: "p", text: "oi" } });
    runner.say({ type: "turn.event", id: "t1" });
    runner.say({ type: "turn.event", id: "t1", event: { type: "done", ok: true } });
    runner.say({ type: "turn.end", id: "t1" });
    await finished;
    expect(events).toEqual([
      { type: "text", part: "p", text: "oi" },
      { type: "done", ok: true },
    ]);
  });

  test("closes a turn the runner ends without a reply", async () => {
    const runner = await connect();
    const events: ProviderEvent[] = [];
    const finished = runMacTurn(turn("t2"), new AbortController().signal, (event) => events.push(event));
    runner.say({ type: "turn.end", id: "t2" });
    await finished;
    expect(events).toEqual([{ type: "done", ok: false, message: "O Mac encerrou o turno sem resposta." }]);
  });

  test("cancels a turn and closes it after the grace period", async () => {
    jest.useFakeTimers();
    const runner = await connect();
    const events: ProviderEvent[] = [];
    const controller = new AbortController();
    const finished = runMacTurn(turn("t3"), controller.signal, (event) => events.push(event));
    controller.abort();
    expect(runner.sent[1]).toEqual({ type: "turn.cancel", id: "t3" } as Sent);
    jest.advanceTimersByTime(5000);
    await finished;
    expect(events).toEqual([{ type: "done", ok: false, message: "cancelled" }]);
  });

  test("skips the grace close when the turn already ended", async () => {
    jest.useFakeTimers();
    const runner = await connect();
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const finished = runMacTurn(turn("t4"), controller.signal, (event) => events.push(event));
    controller.abort();
    runner.say({ type: "turn.end", id: "t4" });
    await finished;
    jest.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
  });

  test("fails the turn when the runner drops or is missing", async () => {
    const runner = await connect();
    const events: ProviderEvent[] = [];
    const finished = runMacTurn(turn("t5"), new AbortController().signal, (event) => events.push(event));
    runner.drop();
    await finished;
    expect(events[0]).toEqual({ type: "done", ok: false, message: "O app runelay bots fechou no meio do turno." });

    const offline: ProviderEvent[] = [];
    const controller = new AbortController();
    const turnPromise = runMacTurn(turn("t6"), controller.signal, (event) => offline.push(event));
    await turnPromise;
    expect(offline).toEqual([{ type: "done", ok: false, message: "O app runelay bots não está conectado." }]);
  });

  test("still cancels quietly when the runner is gone", async () => {
    jest.useFakeTimers();
    const runner = await connect();
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const finished = runMacTurn(turn("t7"), controller.signal, (event) => events.push(event));
    runner.ws.readyState = 3;
    controller.abort();
    jest.advanceTimersByTime(5000);
    await finished;
    expect(events).toEqual([{ type: "done", ok: false, message: "cancelled" }]);
  });
});
