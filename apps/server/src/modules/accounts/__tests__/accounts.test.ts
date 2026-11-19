import { afterAll, afterEach, beforeAll, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { fakeProviders, request, startTestServer, type TestServer, testDataDir } from "../../../../test/helpers";
import type { Socket } from "../../../shared/ws";
import {
  findAccount,
  isAccountId,
  listAccounts,
  mcpBaseFor,
  refreshAccounts,
  runOnRunner,
  runnerIds,
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
import { env } from "../../../config/env";
import * as macRunner from "../services/mac-runner.service";
import { macRunnerConnected, runnerSocket } from "../services/mac-runner.service";

const macUrl = process.env.MAC_RUNNER_URL ?? "";
const realFetch = globalThis.fetch;
let server: TestServer;

type MacHandler = (path: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubMac(handler: MacHandler) {
  const calls: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith(macUrl)) return realFetch(input, init);
    const path = target.slice(macUrl.length);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    return handler(path, init);
  }) as typeof fetch);
  return { calls, restore: () => spy.mockRestore() };
}

const restores: Array<() => void> = [];

function runnerSocketFake() {
  const sent: Array<{ type: string; id: string; op?: string }> = [];
  const ws = {
    readyState: 1,
    data: { kind: "runner" },
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

function turnRequest(provider: TurnRequest["provider"] = "claude"): TurnRequest {
  return { turnId: `turn-${Math.random().toString(36).slice(2)}`, provider } as unknown as TurnRequest;
}

beforeAll(async () => {
  server = await startTestServer();
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
  test("probes the VPS and reports the Mac offline when it does not answer", async () => {
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
    const mac = accounts.find((account) => account.id === "mac:claude");
    expect(mac?.status).toBe("offline");
    expect(mac?.detail).toStartWith("Mac fora do ar:");
  });

  test("reads the Mac over HTTP and marks missing CLIs", async () => {
    const mac = stubMac(() => Response.json([{ provider: "claude", status: "ready", detail: "ok", models: [] }]));
    restores.push(mac.restore);
    const accounts = await refreshAccounts();
    expect(mac.calls).toEqual(["GET /accounts"]);
    expect(accounts.find((account) => account.id === "mac:claude")?.status).toBe("ready");
    expect(accounts.find((account) => account.id === "mac:codex")).toMatchObject({
      status: "missing",
      detail: "CLI não instalada no Mac.",
    });
  });

  test("reports an HTTP error from the Mac", async () => {
    const mac = stubMac(() => new Response("no", { status: 500 }));
    restores.push(mac.restore);
    const accounts = await refreshAccounts();
    expect(accounts.find((account) => account.id === "mac:claude")?.detail).toBe(
      "Mac fora do ar: runner respondeu 500",
    );
  });

  test("reads the Mac through the connected app and refreshes when it connects", async () => {
    const runner = runnerSocketFake();
    await until(() => runner.sent.some((message) => message.op === "accounts"));
    runner.say({
      type: "response",
      id: runner.sent.find((message) => message.op === "accounts")?.id,
      ok: true,
      result: [{ provider: "codex", status: "ready", detail: "app", models: [] }],
    });
    await until(async () => (await listAccounts()).some((a) => a.id === "mac:codex" && a.detail === "app"));
    const before = runner.sent.length;
    const failing = refreshAccounts();
    await until(() => runner.sent.slice(before).some((message) => message.op === "accounts"));
    const asked = runner.sent.slice(before).find((message) => message.op === "accounts");
    runner.say({ type: "response", id: asked?.id, ok: false, error: "quebrou" });
    const accounts = await failing;
    expect(accounts.find((account) => account.id === "mac:codex")?.detail).toBe("Mac fora do ar: quebrou");
    runner.close();
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

  test("validates ids and picks the MCP base per runner", () => {
    expect(runnerIds).toEqual(["vps", "mac"]);
    expect(isAccountId("vps:claude")).toBe(true);
    expect(isAccountId("mac:grok")).toBe(true);
    expect(isAccountId("pc:claude")).toBe(false);
    expect(isAccountId("vps")).toBe(false);
    expect(mcpBaseFor("mac")).toBe(process.env.PUBLIC_MCP_BASE as string);
    expect(mcpBaseFor("vps")).toStartWith("http://127.0.0.1:");
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

  test("runs on the connected Mac app without code", async () => {
    const runner = runnerSocketFake();
    const events: ProviderEvent[] = [];
    const request = turnRequest("codex");
    const running = runOnRunner("mac", request, new AbortController().signal, (event) => events.push(event));
    const start = runner.sent.find((message) => message.type === "turn.start") as unknown as {
      turn: TurnRequest & { code: unknown };
    };
    expect(start.turn.code).toBeNull();
    runner.say({ type: "turn.event", id: request.turnId, event: { type: "done", ok: true } });
    runner.say({ type: "turn.end", id: request.turnId });
    await running;
    expect(events).toEqual([{ type: "done", ok: true }]);
  });

  test("streams a remote turn over HTTP", async () => {
    let sentBody: unknown;
    const mac = stubMac((_path, init) => {
      sentBody = JSON.parse(String(init?.body));
      const lines = ['{"type":"text","part":"p","text":"oi"}\n', "\n", "lixo\n", '{"type":"done","ok":true}\n'];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
            controller.close();
          },
        }),
      );
    });
    restores.push(mac.restore);
    const events: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(mac.calls).toEqual(["POST /turns"]);
    expect((sentBody as { code: unknown }).code).toBeNull();
    expect(events).toEqual([
      { type: "text", part: "p", text: "oi" },
      { type: "done", ok: true },
    ]);
  });

  test("reports a refused remote turn", async () => {
    const mac = stubMac(() => new Response("ocupado", { status: 503 }));
    restores.push(mac.restore);
    const events: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: "Runner do Mac respondeu 503: ocupado" }]);
  });

  test("reports a refused remote turn whose body cannot be read", async () => {
    const mac = stubMac(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("broken body"));
            },
          }),
          { status: 500 },
        ),
    );
    restores.push(mac.restore);
    const events: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: "Runner do Mac respondeu 500: " }]);
  });

  test("reports a remote stream that closes early or a runner that is down", async () => {
    const empty = stubMac(() => new Response(""));
    restores.push(empty.restore);
    const events: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: "Runner do Mac fechou a conexão." }]);
    empty.restore();

    const down = stubMac(() => {
      throw new TypeError("connection refused");
    });
    restores.push(down.restore);
    const failed: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => failed.push(event));
    expect(failed).toEqual([{ type: "done", ok: false, message: "Runner do Mac caiu: connection refused" }]);
  });

  test("cancels a remote turn and aborts the stream after the grace period", async () => {
    jest.useFakeTimers();
    let streamSignal: AbortSignal | undefined;
    let opened!: () => void;
    const streaming = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const mac = stubMac((path, init) => {
      if (path.endsWith("/cancel")) return new Response(null, { status: 202 });
      streamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"type":"text","part":"p","text":"a"}\n'));
            streamSignal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            opened();
          },
        }),
      );
    });
    restores.push(mac.restore);
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const request = turnRequest();
    const running = runOnRunner("mac", request, controller.signal, (event) => events.push(event));
    await streaming;
    await until(() => events.length > 0);
    controller.abort();
    await until(() => mac.calls.length === 2);
    expect(mac.calls[1]).toBe(`POST /turns/${request.turnId}/cancel`);
    jest.advanceTimersByTime(5000);
    await running;
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: "cancelled" });
  });

  test("closes as cancelled when an aborted stream simply ends", async () => {
    const controller = new AbortController();
    const mac = stubMac((path) => {
      if (path.endsWith("/cancel")) return Promise.reject(new Error("gone"));
      controller.abort();
      return new Response("");
    });
    restores.push(mac.restore);
    jest.useFakeTimers();
    const events: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), controller.signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: "cancelled" }]);
  });

  test("keeps a done event when the stream fails afterwards", async () => {
    const mac = stubMac(
      () =>
        new Response(
          new ReadableStream({
            pulls: 0,
            pull(controller) {
              this.pulls++;
              if (this.pulls === 1) controller.enqueue(new TextEncoder().encode('{"type":"done","ok":true}\n'));
              else controller.error(new Error("cut"));
            },
          } as UnderlyingDefaultSource<Uint8Array> & { pulls: number }),
        ),
    );
    restores.push(mac.restore);
    const events: ProviderEvent[] = [];
    await runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: true }]);
  });
});

describe("without a Mac runner url", () => {
  test("reports the Mac as offline and fails remote turns with the reason", async () => {
    const saved = env.MAC_RUNNER_URL;
    delete (env as { MAC_RUNNER_URL?: string }).MAC_RUNNER_URL;
    const register = spyOn(macRunner, "onMacRunnerChange").mockImplementation(() => () => true);
    let fresh: typeof import("../services/accounts.service");
    try {
      fresh = await import(`../services/accounts.service?${"no-mac-url"}`);
    } finally {
      env.MAC_RUNNER_URL = saved;
      register.mockRestore();
    }
    const missing = "Mac não conectado e MAC_RUNNER_URL não definida.";
    const accounts = await fresh.refreshAccounts();
    expect(accounts.find((account) => account.id === "mac:claude")?.detail).toBe(`Mac fora do ar: ${missing}`);
    const events: ProviderEvent[] = [];
    await fresh.runOnRunner("mac", turnRequest(), new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: "done", ok: false, message: missing }]);
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
