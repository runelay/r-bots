import { afterAll, afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { fakeProviders, resetData } from "../../../../test/helpers";
import {
  type CodexResponder,
  fakeCodexAppServer,
  resetUsageTables,
  writeFixture,
} from "../../../../test/usage-helpers";
import * as settings from "../../../db/settings";
import * as accounts from "../../accounts/services/accounts.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import * as botsService from "../../bots/services/bots.service";
import * as usageRepository from "../repositories/usage.repository";

type Service = typeof import("../services/usage.service");

const home = await mkdtemp(join(os.tmpdir(), "rb-usage-home-"));
const previousHome = process.env.HOST_HOME;
process.env.HOST_HOME = home;
const restores: Array<() => void> = [];
let tag = 0;

async function fresh(): Promise<Service> {
  tag += 1;
  return (await import(`../services/usage.service.ts?usage-${tag}`)) as Service;
}

function track<T extends { mockRestore(): void }>(spy: T) {
  restores.push(() => spy.mockRestore());
  return spy;
}

async function discover() {
  await accounts.refreshAccounts();
}

function bots(list: Array<Partial<BotDefinition>>) {
  track(spyOn(botsService, "listBots").mockReturnValue(list as BotDefinition[]));
}

function fetchReplies(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  track(
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch),
  );
  return calls;
}

const codexOk =
  (limits: Record<string, unknown>): CodexResponder =>
  (message) => {
    if (message.id === 1)
      return ["not json", JSON.stringify({ method: "noise" }), JSON.stringify({ id: 1, result: {} })];
    if (message.id === 2) return [JSON.stringify({ id: 2, result: limits })];
    return undefined;
  };

beforeEach(async () => {
  await resetData();
  await resetUsageTables();
  await rm(join(home, ".claude"), { recursive: true, force: true });
  await rm(join(home, ".claude.json"), { force: true });
  await rm(join(home, ".codex"), { recursive: true, force: true });
  await rm(join(home, ".claude-2"), { recursive: true, force: true });
  await rm(join(home, ".codex-2"), { recursive: true, force: true });
  await discover();
});

afterEach(async () => {
  jest.useRealTimers();
  jest.setSystemTime();
  for (const restore of restores.splice(0).reverse()) restore();
});

afterAll(async () => {
  process.env.HOST_HOME = previousHome;
  await accounts.refreshAccounts();
  await rm(home, { recursive: true, force: true });
});

describe("limit windows", () => {
  test("claude windows prefer the limits list and fall back to five_hour/seven_day", async () => {
    const { claudeWindows } = await fresh();
    const reset = new Date(Math.round((Date.now() + 150 * 60_000) / 60_000) * 60_000).toISOString();
    const windows = claudeWindows({
      limits: [
        { kind: "session", percent: 42.345, resets_at: reset },
        { kind: "weekly_all", percent: 120 },
        { kind: "weekly_scoped", percent: 10, resets_at: reset, scope: { model: { display_name: "Opus" } } },
        { kind: "weekly_scoped", percent: 5, scope: { model: null } },
        { kind: "weekly_scoped", percent: null },
      ],
      seven_day: { utilization: 1, resets_at: "not a date" },
    });
    expect(windows).toEqual([
      {
        kind: "session",
        label: "Sessão",
        usedPercent: 42.3,
        remainingPercent: 57.7,
        resetsAt: reset,
        windowMinutes: 300,
        pacePercent: 50,
      },
      {
        kind: "weekly",
        label: "Semanal",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: null,
        windowMinutes: 10_080,
        pacePercent: null,
      },
      {
        kind: "weekly_model",
        label: "Semanal · Opus",
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: reset,
        windowMinutes: 10_080,
        pacePercent: 1,
      },
    ]);
    expect(claudeWindows({ five_hour: { utilization: -3 }, seven_day: null, limits: undefined })).toEqual([
      {
        kind: "session",
        label: "Sessão",
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: null,
        windowMinutes: 300,
        pacePercent: null,
      },
    ]);
  });

  test("claude resets that jitter between reads land on the same minute", async () => {
    const { claudeWindows, stableReset } = await fresh();
    const reads = [
      "2026-11-20T03:59:59.509217+00:00",
      "2026-11-20T03:59:59.730163+00:00",
      "2026-11-20T04:00:00.10+00:00",
    ];
    const resets = reads.map(
      (value) => claudeWindows({ five_hour: { utilization: 95, resets_at: value } })[0]?.resetsAt,
    );
    expect(new Set(resets)).toEqual(new Set(["2026-11-20T04:00:00.000Z"]));
    expect(stableReset(null)).toBeNull();
  });

  test("codex windows classify by duration and use the plan fallback", async () => {
    const { codexWindows } = await fresh();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    expect(
      codexWindows({
        planType: "pro",
        primary: { usedPercent: 12, resetsAt },
        secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: null },
      }).map((window) => [window.kind, window.label, window.windowMinutes, window.resetsAt]),
    ).toEqual([
      ["session", "Sessão", 300, new Date(Math.round(resetsAt / 60) * 60_000).toISOString()],
      ["weekly", "Semanal", 10_080, null],
    ]);
    expect(
      codexWindows({ planType: "free", primary: { usedPercent: 1 }, secondary: { windowDurationMins: 60 } }).map(
        (window) => [window.kind, window.label, window.windowMinutes],
      ),
    ).toEqual([["monthly", "Mensal", 43_200]]);
    expect(codexWindows({ planType: "go", primary: null })).toEqual([]);
  });
});

describe("readCodexRateLimits", () => {
  test("speaks JSON-RPC to codex app-server and returns the codex limits", async () => {
    const server = fakeCodexAppServer(codexOk({ rateLimitsByLimitId: { codex: { planType: "plus" } } }));
    restores.push(server.restore);
    const { readCodexRateLimits } = await fresh();
    expect(await readCodexRateLimits("codex-bin")).toEqual({ planType: "plus" });
    expect(server.commands).toEqual([["codex-bin", "app-server"]]);
    expect(server.killed).toEqual(["SIGTERM"]);
  });

  test("falls back to rateLimits and to an empty object", async () => {
    const { readCodexRateLimits } = await fresh();
    let server = fakeCodexAppServer(codexOk({ rateLimits: { planType: "team" } }));
    expect(await readCodexRateLimits()).toEqual({ planType: "team" });
    server.restore();
    server = fakeCodexAppServer((message) =>
      message.id === 1 ? [JSON.stringify({ id: 1 })] : message.id === 2 ? [JSON.stringify({ id: 2 })] : undefined,
    );
    restores.push(server.restore);
    expect(await readCodexRateLimits()).toEqual({});
  });

  test("rejects on an RPC error, on close without answer, on timeout and when spawn throws", async () => {
    const { readCodexRateLimits } = await fresh();
    let server = fakeCodexAppServer((message) =>
      message.id === 1
        ? [JSON.stringify({ id: 1 })]
        : message.id === 2
          ? [JSON.stringify({ id: 2, error: { message: "not logged in" } })]
          : undefined,
    );
    await expect(readCodexRateLimits()).rejects.toThrow("not logged in");
    server.restore();
    server = fakeCodexAppServer((message) =>
      message.id === 1
        ? [JSON.stringify({ id: 1 })]
        : message.id === 2
          ? [JSON.stringify({ id: 2, error: {} })]
          : undefined,
    );
    await expect(readCodexRateLimits()).rejects.toThrow("erro do Codex");
    server.restore();
    server = fakeCodexAppServer(() => "close");
    await expect(readCodexRateLimits()).rejects.toThrow("o Codex fechou sem responder");
    server.restore();
    server = fakeCodexAppServer(() => "error");
    await expect(readCodexRateLimits()).rejects.toThrow("o Codex fechou sem responder");
    server.restore();
    server = fakeCodexAppServer(() => undefined);
    await expect(readCodexRateLimits("codex", 5)).rejects.toThrow("o Codex não respondeu a tempo");
    server.restore();
    server = fakeCodexAppServer(() => "throw");
    await expect(readCodexRateLimits("codex", 5)).rejects.toThrow("o Codex não respondeu a tempo");
    server.restore();
    const spawn = track(
      spyOn(Bun, "spawn").mockImplementation(() => {
        throw "no binary";
      }),
    );
    await expect(readCodexRateLimits()).rejects.toThrow("no binary");
    spawn.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await expect(readCodexRateLimits()).rejects.toThrow("ENOENT");
  });
});

describe("usageLimits", () => {
  test("reads the limits of each account with its own login, the failover target, then caches", async () => {
    await writeFixture(join(home, ".claude.json"), { oauthAccount: { displayName: "Ana" } });
    await writeFixture(join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 60_000, subscriptionType: "max" },
    });
    await writeFixture(join(home, ".claude-2", ".claude.json"), { oauthAccount: { displayName: "Bia" } });
    await writeFixture(join(home, ".claude-2", ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok2", subscriptionType: "team" },
    });
    await discover();
    const calls = fetchReplies((_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer tok"
        ? Response.json({ five_hour: { utilization: 20 } })
        : Response.json({ seven_day: { utilization: 9 } }),
    );
    const server = fakeCodexAppServer(codexOk({ rateLimits: { planType: "pro", primary: { usedPercent: 3 } } }));
    restores.push(server.restore);
    bots([
      {
        id: "b1",
        name: "One",
        engine: { account: "vps:claude", model: "m", effort: null, fallback: { account: "vps:codex", model: "m" } },
      },
      { id: "b2", name: "Two", engine: { account: "claude-2:claude", model: "m", effort: null, fallback: null } },
      {
        id: "b3",
        name: "Three",
        engine: { account: "vps:codex", model: "m", effort: null, fallback: { account: "vps:claude", model: "m" } },
      },
      { id: "b4", name: "Four", engine: { account: "vps:codex", model: "m", effort: null, fallback: null } },
      { id: "b5", name: "Five", engine: { account: "vps:grok", model: "m", effort: null, fallback: null } },
    ] as unknown as Array<Partial<BotDefinition>>);
    const service = await fresh();
    const limits = await service.usageLimits();
    expect(calls.every((call) => call.url === "https://api.anthropic.com/api/oauth/usage")).toBe(true);
    expect(
      limits.map((account) => [account.id, account.label, account.plan, account.isDefault, account.ok, account.error]),
    ).toEqual([
      ["vps:claude", "Claude Ana", "max", true, true, null],
      ["claude-2:claude", "Claude Bia", "team", false, true, null],
      ["vps:codex", "Codex", "pro", true, true, null],
    ]);
    expect(limits[0].windows.map((window) => [window.kind, window.usedPercent])).toEqual([["session", 20]]);
    expect(limits[1].windows.map((window) => [window.kind, window.usedPercent])).toEqual([["weekly", 9]]);
    expect(limits[0].failover).toEqual([{ botId: "b1", botName: "One", to: "claude-2:claude", toLabel: "Claude Bia" }]);
    expect(limits[1].failover).toEqual([{ botId: "b2", botName: "Two", to: "vps:claude", toLabel: "Claude Ana" }]);
    expect(limits[2].failover).toEqual([{ botId: "b3", botName: "Three", to: "vps:claude", toLabel: "Claude Ana" }]);
    expect(await service.usageLimits()).toBe(limits);
    expect(calls).toHaveLength(2);
    const checked = Date.parse(service.limitsCheckedAt());
    expect(Math.abs(checked - Date.now())).toBeLessThan(5000);
    const [a, b] = [service.usageLimits(true), service.usageLimits(true)];
    expect(a).toBe(b);
    expect(await a).not.toBe(limits);
    expect(calls).toHaveLength(4);
  });

  test("reports each Claude login problem and Codex failure", async () => {
    bots([]);
    const server = fakeCodexAppServer(() => "close");
    restores.push(server.restore);
    const claudeOf = async () => {
      await discover();
      return (await (await fresh()).usageLimits())[0];
    };

    let account = await claudeOf();
    expect([account.label, account.ok, account.error]).toEqual([
      "Claude",
      false,
      expect.stringContaining("Não deu para ler os limites do Claude:"),
    ]);

    await writeFixture(join(home, ".claude.json"), { oauthAccount: { organizationName: "Org" } });
    await writeFixture(join(home, ".claude", ".credentials.json"), { claudeAiOauth: {} });
    account = await claudeOf();
    expect([account.label, account.error]).toEqual(["Claude Org", "Claude Org não está logado."]);

    await writeFixture(join(home, ".claude.json"), "{");
    await writeFixture(join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "t", expiresAt: Date.now() - 1, subscriptionType: "pro" },
    });
    account = await claudeOf();
    expect([account.label, account.plan, account.error]).toEqual([
      "Claude",
      "pro",
      "O login do Claude expirou. Ele renova no próximo turno.",
    ]);

    await writeFixture(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "t" } });
    fetchReplies(() => new Response("no", { status: 429 }));
    account = await claudeOf();
    expect([account.plan, account.error]).toEqual([null, "A Anthropic respondeu 429 ao ler os limites."]);

    const all = await (await fresh()).usageLimits();
    expect(all[1]).toMatchObject({
      id: "vps:codex",
      ok: false,
      plan: null,
      error: "Não deu para ler os limites do Codex: o Codex fechou sem responder",
      windows: [],
    });
    expect(all).toHaveLength(2);

    track(spyOn(accounts, "accountPath").mockReturnValue(null));
    expect((await (await fresh()).usageLimits())[0].error).toBe("Claude não tem diretório de configuração.");

    fakeProviders.probes.codex = { provider: "codex", status: "missing", detail: "", models: [] };
    await discover();
    expect((await (await fresh()).usageLimits()).map((item) => item.id)).toEqual(["vps:claude"]);
  });

  test("reads Codex limits from the directory of an extra Codex account", async () => {
    bots([]);
    await writeFixture(join(home, ".codex-2", "auth.json"), { tokens: {} });
    await discover();
    expect(
      (await accounts.listAccounts())
        .filter((item) => item.provider !== "grok" && item.provider !== "cursor")
        .map((item) => item.id),
    ).toEqual(["vps:claude", "codex-2:codex"]);
    await writeFixture(join(home, ".codex", "auth.json"), { tokens: {} });
    await discover();
    const server = fakeCodexAppServer(codexOk({ rateLimits: { planType: "plus" } }));
    restores.push(server.restore);
    const spawn = Bun.spawn as unknown as { mock: { calls: Array<[string[], { env: Record<string, string> }]> } };
    const limits = await (await fresh()).usageLimits();
    expect(limits.map((item) => item.id)).toEqual(["vps:claude", "vps:codex", "codex-2:codex"]);
    const homes = spawn.mock.calls.map((call) => call[1].env.CODEX_HOME ?? null);
    expect(homes).toContain(join(home, ".codex-2"));
    expect(homes).toContain(null);
  });
});

const hourOf = (ms: number) => Math.floor(ms / 3_600_000) * 3600;

function claudeLine(at: number, model: string, usage: Record<string, unknown>, sessionId = "s1") {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    sessionId,
    requestId: `r-${Math.random()}`,
    message: { id: `m-${Math.random()}`, model, usage },
  });
}

const priceTableFixture = {
  "claude-a": {
    input_cost_per_token: 1,
    output_cost_per_token: 2,
    cache_read_input_token_cost: 0.5,
    cache_creation_input_token_cost: 1.5,
    cache_creation_input_token_cost_above_1hr: 3,
    provider_specific_entry: { fast: 2 },
  },
  "openai/gpt-z": { input_cost_per_token: 0.1 },
};

describe("usageSummary", () => {
  test("adds the logs of every account priced from the stored table, grouped by day, model, speed and account", async () => {
    jest.useFakeTimers();
    const now = Date.now();
    await settings.writeSetting("usage.prices", { at: now, table: priceTableFixture });
    await writeFixture(
      join(home, ".claude", "projects", "p", "a.jsonl"),
      `${[
        claudeLine(now - 2 * 3_600_000, "claude-a[1m]", {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 6,
          cache_creation: { ephemeral_1h_input_tokens: 2 },
          output_tokens: 3,
          speed: "fast",
        }),
        claudeLine(now - 3 * 3_600_000, "claude-a-20250101", { input_tokens: 1, output_tokens: 1 }, "s2"),
        claudeLine(now - 3 * 3_600_000, "unknown-model", { input_tokens: 5 }, "s3"),
        claudeLine(now - 40 * 86_400_000, "claude-a", { input_tokens: 1000 }, "s4"),
      ].join("\n")}\n`,
    );
    await writeFixture(
      join(home, ".codex", "sessions", "r.jsonl"),
      `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-z" } })}\n${JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now - 3_600_000).toISOString(),
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 20, output_tokens: 1 } } },
      })}\n`,
    );
    await writeFixture(join(home, ".claude-2", ".credentials.json"), {});
    await writeFixture(join(home, ".claude-2", ".claude.json"), { oauthAccount: { displayName: "Bia" } });
    await writeFixture(
      join(home, ".claude-2", "projects", "q", "b.jsonl"),
      `${claudeLine(now - 2 * 3_600_000, "claude-a", { input_tokens: 7 }, "s9")}\n`,
    );
    await discover();
    const service = await fresh();
    const summary = await service.usageSummary("bogus", null, null);
    expect(summary.range).toBe("30d");
    expect(summary.granularity).toBe("day");
    expect(summary.scannedAt).toEqual(expect.any(String));
    expect(summary.accounts.map((item) => [item.id, item.label, item.processed, item.requests, item.sessions])).toEqual(
      [
        ["vps:claude", "Claude", 23 + 2 + 5, 3, 3],
        ["claude-2:claude", "Claude Bia", 7, 1, 1],
        ["vps:codex", "Codex", 21, 1, 0],
      ],
    );
    const bia = await service.usageSummary("30d", null, "claude-2:claude");
    expect(bia.totals).toMatchObject({ input: 7, requests: 1, sessions: 1, costUsd: 7 });
    expect(bia.accounts.map((item) => item.id)).toEqual(["claude-2:claude"]);
    expect(bia.detail[0]).toMatchObject({ account: "claude-2:claude", model: "claude-a" });
    await rm(join(home, ".claude-2"), { recursive: true, force: true });
    await discover();
    const gone = await (await fresh()).usageSummary("30d", null, null);
    expect(gone.accounts.map((item) => [item.id, item.label])).toContainEqual(["claude-2:claude", "claude-2:claude"]);
    expect(gone.accounts.at(-1)?.id).toBe("claude-2:claude");
    expect(summary.totals).toEqual({
      processed: 23 + 2 + 5 + 21 + 7,
      input: 10 + 1 + 5 + 20 + 7,
      cacheRead: 4,
      cacheWrite: 6,
      output: 3 + 1 + 1,
      reasoning: 0,
      requests: 5,
      sessions: 4,
      costUsd: 2 * (10 + 2 + 4 * 1.5 + 2 * 3 + 6) + 3 + 2 + 7,
      savingsUsd: 4 * 0.5 * 2,
      unpricedTokens: 5,
    });
    expect(summary.costByType).toEqual({ input: 20 + 1 + 2 + 7, cacheRead: 4, cacheWrite: 24, output: 12 + 2 });
    expect(summary.speeds.map((speed) => speed.speed)).toEqual(["fast", "standard"]);
    expect(summary.detail.find((row) => row.model === "unknown-model")?.costUsd).toBeNull();
    expect(summary.detail.find((row) => row.model === "gpt-z")).toMatchObject({ account: "vps:codex", costUsd: 2 });
    expect(summary.series.every((point, i, all) => i === 0 || all[i - 1].bucket <= point.bucket)).toBe(true);
    expect(summary.pricing).toEqual({ source: "LiteLLM (preço de API)", updatedAt: new Date(now).toISOString() });

    const claudeOnly = await service.usageSummary("24h", "claude", "vps:claude");
    expect(claudeOnly.granularity).toBe("hour");
    expect(claudeOnly.totals.requests).toBe(3);
    expect(claudeOnly.series[0].bucket).toBe(new Date(hourOf(now - 3 * 3_600_000) * 1000).toISOString());
  });

  test("downloads prices when the stored table is stale and keeps the old table when the download fails", async () => {
    jest.useFakeTimers();
    await settings.writeSetting("usage.prices", { at: 0, table: { old: { input_cost_per_token: 9 } } });
    const calls = fetchReplies(() =>
      Response.json({
        "claude-a": { input_cost_per_token: 1 },
        "gpt-y": { input_cost_per_token: 2 },
        "llama-3": { input_cost_per_token: 3 },
        "claude-free": { output_cost_per_token: 1 },
        "claude-null": null,
      }),
    );
    const service = await fresh();
    const [first] = await Promise.all([service.usageSummary("7d", null, null), service.usageSummary("7d", null, null)]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    ]);
    const stored = await settings.readSetting<{ at: number; table: Record<string, unknown> }>("usage.prices", {
      at: 0,
      table: {},
    });
    expect(Object.keys(stored.table).sort()).toEqual(["claude-a", "gpt-y"]);
    expect(first.pricing.updatedAt).toBe(new Date(stored.at).toISOString());

    for (const restore of restores.splice(0).reverse()) restore();
    await settings.writeSetting("usage.prices", { at: 0, table: { old: { input_cost_per_token: 9 } } });
    fetchReplies(() => new Response("down", { status: 503 }));
    const failed = await (await fresh()).usageSummary("90d", null, null);
    expect(Date.parse(failed.pricing.updatedAt ?? "")).toBeLessThan(Date.now() - 22 * 3_600_000);

    await resetData();
    fetchReplies(() => Promise.reject(new Error("offline")));
    expect((await (await fresh()).usageSummary("30d", null, null)).totals.costUsd).toBe(0);
  });
});

describe("failures", () => {
  test("keeps going when the price file cannot be written", async () => {
    jest.useFakeTimers();
    const write = track(
      spyOn(settings, "writeSetting").mockImplementation(() => {
        throw new Error("readonly database");
      }),
    );
    fetchReplies(() => Response.json({ "claude-a": { input_cost_per_token: 1 } }));
    const summary = await (await fresh()).usageSummary("30d", null, null);
    expect(summary.pricing.updatedAt).not.toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("warmUsage", () => {
  test("logs a failed scan and swallows a failed price load", async () => {
    jest.useFakeTimers();
    track(
      spyOn(usageRepository, "loadUsageIndex").mockImplementation(() => {
        throw new Error("database locked");
      }),
    );
    await writeFixture(
      join(home, ".claude", "projects", "a.jsonl"),
      `${claudeLine(Date.now() - 3_600_000, "claude-a", { input_tokens: 1 })}\n`,
    );
    const readJson = track(
      spyOn(settings, "readSetting").mockImplementation(() => {
        throw new Error("disk gone");
      }),
    );
    const logs: string[] = [];
    track(spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line))));
    const service = await fresh();
    service.warmUsage();
    jest.advanceTimersByTime(15_000);
    jest.useRealTimers();
    for (let i = 0; i < 100 && logs.length === 0; i++) await Bun.sleep(1);
    expect(readJson).toHaveBeenCalled();
    expect(logs[0]).toBe("usage: scan falhou: database locked");
  });

  test("scans the VPS logs and loads prices after 15 seconds", async () => {
    jest.useFakeTimers();
    await writeFixture(
      join(home, ".claude", "projects", "a.jsonl"),
      `${claudeLine(Date.now() - 3_600_000, "claude-a", { input_tokens: 1 })}\n`,
    );
    const calls = fetchReplies(() => Response.json({}));
    const service = await fresh();
    service.warmUsage();
    expect(calls).toHaveLength(0);
    jest.advanceTimersByTime(15_000);
    jest.useRealTimers();
    for (let i = 0; i < 50 && calls.length === 0; i++) await Bun.sleep(1);
    expect(calls).toHaveLength(1);
  });
});
