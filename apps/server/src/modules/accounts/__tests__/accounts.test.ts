import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { fakeProviders, request, startTestServer, type TestServer, testDataDir } from "../../../../test/helpers";
import type { Socket } from "../../../shared/ws";
import * as devices from "../../devices/services/devices.service";
import {
  findAccount,
  isAccountId,
  listAccounts,
  mcpBaseFor,
  refreshAccounts,
  runnerIds,
  runnerTarget,
  runOnRunner,
} from "../services/accounts.service";
import {
  clearLimit,
  emitFault,
  formatReset,
  injectedFault,
  isLimitError,
  isLimitReply,
  limitOf,
  markLimited,
  parseResetAt,
  providerName,
} from "../services/limits.service";
import {
  disconnectMacDevice,
  macRunnerConnected,
  macRunnerConnections,
  runnerSocket,
} from "../services/mac-runner.service";

let server: TestServer;

const restores: Array<() => void> = [];

function runnerSocketFake(key = "mac-a-device", name = "MacBook", rank = 1) {
  const sent: Array<{ type: string; id: string; op?: string }> = [];
  const ws = {
    readyState: 1,
    data: { kind: "runner", deviceKey: key, rank, deviceName: name, userId: "u1" },
    send: (raw: string) => {
      sent.push(JSON.parse(raw));
    },
    close() {},
    ping() {},
    terminate() {},
  };
  runnerSocket.open(ws as unknown as Socket);
  const close = () => {
    ws.readyState = 3;
    runnerSocket.close(ws as unknown as Socket, 1000, "");
  };
  restores.push(close);
  return {
    sent,
    say: (message: unknown) => runnerSocket.message(ws as unknown as Socket, JSON.stringify(message)),
    close,
  };
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

async function refreshWith(fakes: Array<[ReturnType<typeof runnerSocketFake>, unknown[] | string]>) {
  let settled = false;
  const running = refreshAccounts().finally(() => {
    settled = true;
  });
  const answered = new Set<string>();
  while (!settled) {
    for (const [fake, result] of fakes)
      for (const message of fake.sent)
        if (message.op === "accounts" && !answered.has(message.id)) {
          answered.add(message.id);
          fake.say(
            typeof result === "string"
              ? { type: "response", id: message.id, ok: false, error: result }
              : { type: "response", id: message.id, ok: true, result },
          );
        }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return running;
}

function turnRequest(provider: TurnRequest["provider"] = "claude"): TurnRequest {
  return { turnId: `turn-${Math.random().toString(36).slice(2)}`, provider } as unknown as TurnRequest;
}

beforeAll(async () => {
  server = await startTestServer();
});

beforeEach(() => {
  for (const live of macRunnerConnections()) disconnectMacDevice(live.key, 1000, "test");
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  jest.useRealTimers();
  setSystemTime();
  delete process.env.BOTS_FAULTS_FILE;
});

afterAll(async () => {
  await server.close();
});

describe("limits", () => {
  test("recognizes limit replies and errors", () => {
    expect(isLimitReply("You've hit your limit · resets 3pm")).toBe(true);
    expect(isLimitReply("tudo certo")).toBe(false);
    expect(isLimitReply(`usage limit reached ${"x".repeat(400)}`)).toBe(false);
    expect(isLimitError("429 Too Many Requests")).toBe(true);
    expect(isLimitError("boom")).toBe(false);
    expect(isLimitError(null)).toBe(false);
    expect(isLimitError(undefined)).toBe(false);
  });

  test("parses every reset format", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(parseResetAt("limit|1763560800", now)?.toISOString()).toBe("2025-11-19T14:00:00.000Z");
    expect(parseResetAt("resets 2026-11-20T08:30:00Z", now)?.toISOString()).toBe("2026-11-20T08:30:00.000Z");
    expect(parseResetAt("try again in 1 day, 2 hours and 5 minutes", now)?.toISOString()).toBe(
      "2026-11-20T14:05:00.000Z",
    );
    expect(parseResetAt("resets in 0 minutes", now)).toBeNull();
    expect(parseResetAt("resets at 3pm", now, "UTC")?.toISOString()).toBe("2026-11-19T15:00:00.000Z");
    expect(parseResetAt("resets at 12am", now, "UTC")?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(parseResetAt("resets 9:30 (America/Sao_Paulo)", now, "UTC")?.toISOString()).toBe("2026-11-19T12:30:00.000Z");
    expect(parseResetAt("resets 13:00 (Not/AZone)", now, "UTC")?.toISOString()).toBe("2026-11-19T13:00:00.000Z");
    expect(parseResetAt("resets at 25:00", now, "UTC")).toBeNull();
    expect(parseResetAt("resets at 10:75", now, "UTC")).toBeNull();
    expect(parseResetAt("nada aqui", now)).toBeNull();
    expect(parseResetAt("resets at 3pm", now)).toBeInstanceOf(Date);
  });

  test("marks, reads, expires and clears a limit", () => {
    const known = markLimited("vps:claude", "resets in 2 hours");
    expect(known.known).toBe(true);
    expect(limitOf("vps:claude")).toBe(known);
    clearLimit("vps:claude");
    expect(limitOf("vps:claude")).toBeNull();
    const unknown = markLimited("vps:codex", "quota", "UTC");
    expect(unknown.known).toBe(false);
    expect(unknown.until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect(limitOf("vps:codex")).toBeNull();
  });

  test("formats the reset time relative to now", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(formatReset(new Date("2026-11-19T18:00:00Z"), now)).toBe("às 15:00");
    expect(formatReset(new Date("2026-11-20T18:00:00Z"), now)).toBe("amanhã às 15:00");
    expect(formatReset(new Date("2026-11-25T18:00:00Z"), now)).toBe("dia 25/11 às 15:00");
    expect(formatReset(new Date())).toStartWith("às ");
  });

  test("names providers and injects faults from a file", () => {
    expect(providerName("codex")).toBe("Codex");
    expect(providerName("claude")).toBe("Claude");
    expect(injectedFault("vps:claude")).toBeNull();
    const file = join(testDataDir(), "faults.json");
    writeFileSync(file, JSON.stringify({ "vps:claude": "fora do ar" }));
    process.env.BOTS_FAULTS_FILE = file;
    expect(injectedFault("vps:claude")).toBe("fora do ar");
    expect(injectedFault("vps:codex")).toBeNull();
    process.env.BOTS_FAULTS_FILE = join(testDataDir(), "missing.json");
    expect(injectedFault("vps:claude")).toBeNull();
    rmSync(file);
    const events: ProviderEvent[] = [];
    emitFault("falhou", (event) => events.push(event));
    expect(events).toEqual([
      { type: "text", part: "fault", text: "falhou" },
      { type: "done", ok: false, message: "falhou" },
    ]);
  });
});

describe("accounts", () => {
  test("probes the VPS and shows the Mac slot offline when no Mac is on the account", async () => {
    fakeProviders.probes.grok = { provider: "grok", status: "logged_out", detail: "entre", models: [] };
    const first = refreshAccounts();
    expect(refreshAccounts()).toBe(first);
    const accounts = await first;
    expect(accounts.map((account) => account.id)).toEqual([
      "vps:claude",
      "vps:codex",
      "vps:grok",
      "vps:cursor",
      "mac:claude",
      "mac:codex",
      "mac:grok",
      "mac:cursor",
    ]);
    expect(accounts.find((account) => account.id === "vps:grok")).toMatchObject({
      status: "logged_out",
      label: "Grok (VPS)",
    });
    expect(accounts.find((account) => account.id === "vps:grok")).not.toHaveProperty("device");
    expect(accounts.find((account) => account.id === "mac:claude")).toMatchObject({
      status: "offline",
      label: "Claude · assinatura (Mac)",
      detail: "Nenhum Mac na conta: entre no app runelay bots no Mac.",
      device: null,
    });
  });

  test("lists accounts per Mac and names each one", async () => {
    const first = runnerSocketFake("aaaa1111-device", "MacBook");
    const second = runnerSocketFake("BBBB2222-device", "Mac mini", 2);
    const accounts = await refreshWith([
      [first, [{ provider: "codex", status: "ready", detail: "app", models: [] }]],
      [second, []],
    ]);
    expect(accounts.find((account) => account.id === "mac:codex")).toMatchObject({
      status: "ready",
      label: "Codex · MacBook",
      device: { id: "aaaa1111-device", name: "MacBook", connected: true },
    });
    expect(accounts.find((account) => account.id === "mac:claude")).toMatchObject({
      status: "missing",
      detail: "CLI não instalada no Mac.",
    });
    expect(accounts.find((account) => account.id === "mac-bbbb2222:claude")).toMatchObject({
      status: "missing",
      label: "Claude · Mac mini",
    });
    first.close();
    second.close();
  });

  test("shows a registered Mac that is closed as disconnected and reports a failing probe", async () => {
    const listed = spyOn(devices, "listRegisteredDevices").mockResolvedValue([
      {
        id: "off-device",
        keyId: "k1",
        userId: "u1",
        name: "iMac",
        model: null,
        osVersion: null,
        appVersion: null,
        machineId: null,
        registeredAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "on-device",
        keyId: "k2",
        userId: "u1",
        name: "MacBook",
        model: null,
        osVersion: null,
        appVersion: null,
        machineId: null,
        registeredAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    restores.push(() => listed.mockRestore());
    const runner = runnerSocketFake("on-device", "MacBook");
    const accounts = await refreshWith([[runner, "quebrou"]]);
    expect(accounts.find((account) => account.id === "mac:claude")).toMatchObject({
      status: "offline",
      label: "Claude · iMac",
      detail: "Mac desconectado: abra o app runelay bots nele.",
      device: { id: "off-device", name: "iMac", connected: false },
    });
    expect(accounts.find((account) => account.id === "mac-ondevice:claude")?.detail).toBe("Mac fora do ar: quebrou");
    const events: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: "Mac desconectado." }]);
    runner.close();
  });

  test("gives colliding short ids distinct prefixes and a fallback for odd keys", async () => {
    const a = runnerSocketFake("same0000-a", "A", 1);
    const b = runnerSocketFake("same0000-b", "B", 2);
    const c = runnerSocketFake("---", "C", 3);
    const d = runnerSocketFake("same0000-d", "D", 4);
    const ids = (
      await refreshWith([
        [a, []],
        [b, []],
        [c, []],
        [d, []],
      ])
    )
      .filter((item) => item.provider === "claude" && item.runner === "mac")
      .map((x) => x.id);
    expect(ids).toEqual(["mac:claude", "mac-same0000:claude", "mac-mac:claude", "mac-same0000x:claude"]);
    for (const runner of [a, b, c, d]) runner.close();
  });

  test("a Mac refresh that fails on connect does not break the runner", async () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
      if (String(line).startsWith("accounts:")) throw new Error("log sink down");
    });
    restores.push(() => log.mockRestore());
    const runner = runnerSocketFake();
    const answered = new Set<string>();
    await until(() => {
      for (const message of runner.sent)
        if (message.op === "accounts" && !answered.has(message.id)) {
          answered.add(message.id);
          runner.say({ type: "response", id: message.id, ok: true, result: [] });
        }
      return logs.some((line) => line.startsWith("accounts:"));
    });
    expect(logs.find((line) => line.startsWith("accounts:"))).toContain("mac:claude=");
    expect(macRunnerConnected()).toBe(true);
    runner.close();
  });

  test("serves the cache, refreshes it when stale and finds accounts", async () => {
    await refreshAccounts();
    const cached = await listAccounts();
    expect(await listAccounts()).toBe(cached);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect(await listAccounts()).not.toBe(cached);
    expect((await findAccount("vps:claude"))?.status).toBe("ready");
    expect(await findAccount("vps:none")).toBeUndefined();
    setSystemTime(new Date(Date.now() + 60_000));
    const offline = await findAccount("mac:claude");
    expect(offline?.status).toBe("offline");
  });

  test("validates ids, picks the runner target and the MCP base", () => {
    expect(runnerIds).toEqual(["vps", "mac"]);
    expect(isAccountId("vps:claude")).toBe(true);
    expect(isAccountId("mac:grok")).toBe(true);
    expect(isAccountId("mac-ab12cd34:grok")).toBe(true);
    expect(isAccountId("mac-AB:grok")).toBe(false);
    expect(isAccountId("pc:claude")).toBe(false);
    expect(isAccountId("vps")).toBe(false);
    expect(runnerTarget({ id: "mac-ab12:claude", runner: "mac" })).toBe("mac-ab12");
    expect(runnerTarget({ id: "mac:claude", runner: "mac" })).toBe("mac");
    expect(runnerTarget({ id: "weird:claude", runner: "mac" })).toBe("mac");
    expect(runnerTarget({ id: "vps:claude", runner: "vps" })).toBe("vps");
    expect(mcpBaseFor()).toStartWith("http://127.0.0.1:");
  });
});

describe("runOnRunner", () => {
  test("emits an injected fault instead of running", async () => {
    const file = join(testDataDir(), "faults-run.json");
    writeFileSync(file, JSON.stringify({ "vps:claude": "falha injetada" }));
    process.env.BOTS_FAULTS_FILE = file;
    const events: ProviderEvent[] = [];
    await runOnRunner("vps", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: "falha injetada" });
    expect(fakeProviders.turns).toHaveLength(0);
  });

  test("runs on the VPS through the provider", async () => {
    const events: ProviderEvent[] = [];
    await runOnRunner("vps", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(fakeProviders.turns).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
  });

  test("runs on the right Mac without code", async () => {
    const first = runnerSocketFake("first000-device", "A", 1);
    const second = runnerSocketFake("second00-device", "B", 2);
    const events: ProviderEvent[] = [];
    const request = turnRequest("codex");
    const running = runOnRunner("mac-second00", request, new AbortController().signal, (event) => events.push(event));
    await until(() => second.sent.some((message) => message.type === "turn.start"));
    expect(first.sent.some((message) => message.type === "turn.start")).toBe(false);
    const start = second.sent.find((message) => message.type === "turn.start") as unknown as {
      turn: TurnRequest & { code: unknown };
    };
    expect(start.turn.code).toBeNull();
    second.say({ type: "turn.event", id: request.turnId, event: { type: "done", ok: true } });
    second.say({ type: "turn.end", id: request.turnId });
    await running;
    expect(events).toEqual([{ type: "done", ok: true }]);
    first.close();
    second.close();
  });

  test("fails a turn for a Mac that is not on the account", async () => {
    const events: ProviderEvent[] = [];
    await runOnRunner("mac-nowhere", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: "Mac desconectado." }]);
    const none: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => none.push(event));
    expect(none).toEqual([{ type: "done", ok: false, message: "Mac desconectado." }]);
  });
});

describe("routes", () => {
  test("GET /accounts lists and refreshes, POST /accounts/refresh refreshes", async () => {
    const listed = await request<Array<{ id: string }>>("/accounts");
    expect(listed.status).toBe(200);
    expect(listed.body.some((account) => account.id === "vps:claude")).toBe(true);
    fakeProviders.probes.claude = { provider: "claude", status: "logged_out", detail: "saiu", models: [] };
    const refreshed = await request<Array<{ id: string; status: string }>>("/accounts?refresh=1");
    expect(refreshed.body.find((account) => account.id === "vps:claude")?.status).toBe("logged_out");
    fakeProviders.probes.claude = { provider: "claude", status: "ready", detail: "voltou", models: [] };
    const posted = await request<Array<{ id: string; detail: string }>>("/accounts/refresh", {
      method: "POST",
      body: "{not json",
    });
    expect(posted.status).toBe(200);
    expect(posted.body.find((account) => account.id === "vps:claude")?.detail).toBe("voltou");
  });
});
