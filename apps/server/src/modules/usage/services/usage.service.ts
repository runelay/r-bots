import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSetting, writeSetting } from "../../../db/settings";
import {
  macRunnerConnected,
  macRunnerSupports,
  macUsageBuckets,
  macUsageLimits,
} from "../../accounts/services/mac-runner.service";
import { engineOf, listBots } from "../../bots/services/bots.service";
import { type Counters, type SessionRow, type UsageProvider, type UsageRow, UsageScanner } from "./usage-scan.service";

type Environment = "vps" | "mac";

export interface LimitWindow {
  kind: "session" | "weekly" | "monthly" | "weekly_model";
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  pacePercent: number | null;
}

export interface LimitAccount {
  id: string;
  environment: Environment;
  provider: UsageProvider;
  label: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  windows: LimitWindow[];
  failover: Array<{ botId: string; botName: string; to: string; toLabel: string }>;
}

interface RawClaudeUsage {
  five_hour?: { utilization?: number | null; resets_at?: string | null } | null;
  seven_day?: { utilization?: number | null; resets_at?: string | null } | null;
  limits?: Array<{
    kind?: string;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  }>;
}

interface RawCodexWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface RawCodexLimits {
  planType?: string | null;
  primary?: RawCodexWindow | null;
  secondary?: RawCodexWindow | null;
}

const zone = "America/Sao_Paulo";
const scanner = new UsageScanner();
const pricesKey = "usage.prices";
const pricesUrl = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const providerLabels: Record<UsageProvider, string> = { claude: "Claude", codex: "Codex" };

let limitsCache: { at: number; value: LimitAccount[] } | null = null;
let limitsPending: Promise<LimitAccount[]> | null = null;
let macSnapshot: {
  at: number;
  since: number;
  rows: UsageRow[];
  sessions: SessionRow[];
  error: string | null;
  scannedAt: string | null;
} | null = null;
let macPending: Promise<void> | null = null;

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function paceOf(resetsAt: string | null, windowMinutes: number | null) {
  if (!resetsAt || !windowMinutes) return null;
  const duration = windowMinutes * 60_000;
  const left = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(left)) return null;
  const elapsed = Math.max(0, Math.min(1, (duration - left) / duration));
  return Math.round((1 - elapsed) * 100);
}

export function stableReset(value: string | null) {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(Math.round(at / 60_000) * 60_000).toISOString();
}

function makeWindow(
  kind: LimitWindow["kind"],
  label: string,
  used: number,
  resetsAt: string | null,
  windowMinutes: number | null,
): LimitWindow {
  const usedPercent = clampPercent(used);
  resetsAt = stableReset(resetsAt);
  return {
    kind,
    label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt,
    windowMinutes,
    pacePercent: paceOf(resetsAt, windowMinutes),
  };
}

export function claudeWindows(raw: RawClaudeUsage): LimitWindow[] {
  const windows: LimitWindow[] = [];
  const limits = Array.isArray(raw.limits) ? raw.limits : [];
  const session = limits.find((item) => item.kind === "session");
  const weekly = limits.find((item) => item.kind === "weekly_all");
  const sessionUsed = session?.percent ?? raw.five_hour?.utilization;
  const sessionReset = session?.resets_at ?? raw.five_hour?.resets_at ?? null;
  if (typeof sessionUsed === "number") windows.push(makeWindow("session", "Sessão", sessionUsed, sessionReset, 300));
  const weeklyUsed = weekly?.percent ?? raw.seven_day?.utilization;
  const weeklyReset = weekly?.resets_at ?? raw.seven_day?.resets_at ?? null;
  if (typeof weeklyUsed === "number") windows.push(makeWindow("weekly", "Semanal", weeklyUsed, weeklyReset, 10_080));
  for (const item of limits) {
    if (item.kind !== "weekly_scoped" || typeof item.percent !== "number") continue;
    const name = item.scope?.model?.display_name;
    if (!name) continue;
    windows.push(makeWindow("weekly_model", `Semanal · ${name}`, item.percent, item.resets_at ?? null, 10_080));
  }
  return windows;
}

export function codexWindows(raw: RawCodexLimits): LimitWindow[] {
  const windows: LimitWindow[] = [];
  const free = raw.planType === "free" || raw.planType === "go";
  const add = (window: RawCodexWindow | null | undefined, fallbackMinutes: number) => {
    if (!window || typeof window.usedPercent !== "number") return;
    const minutes = window.windowDurationMins ?? fallbackMinutes;
    const kind = minutes <= 360 ? "session" : minutes <= 10_080 ? "weekly" : "monthly";
    const label = kind === "session" ? "Sessão" : kind === "weekly" ? "Semanal" : "Mensal";
    windows.push(
      makeWindow(
        kind,
        label,
        window.usedPercent,
        window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
        minutes,
      ),
    );
  };
  add(raw.primary, free ? 43_200 : 300);
  add(raw.secondary, 10_080);
  return windows;
}

async function claudeIdentity() {
  try {
    const parsed = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")) as {
      oauthAccount?: { displayName?: string; organizationName?: string };
    };
    return parsed.oauthAccount?.displayName || parsed.oauthAccount?.organizationName || null;
  } catch {
    return null;
  }
}

async function vpsClaudeLimits(): Promise<Omit<LimitAccount, "failover">> {
  const base = { id: "vps:claude", environment: "vps" as const, provider: "claude" as const, plan: null };
  const name = await claudeIdentity();
  const label = `Claude ${name ?? "VPS"}`;
  try {
    const credentials = JSON.parse(await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string };
    };
    const oauth = credentials.claudeAiOauth;
    if (!oauth?.accessToken) return { ...base, label, ok: false, error: "Claude não está logado na VPS.", windows: [] };
    if (oauth.expiresAt && oauth.expiresAt < Date.now())
      return {
        ...base,
        label,
        plan: oauth.subscriptionType ?? null,
        ok: false,
        error: "O login do Claude na VPS expirou. Ele renova no próximo turno.",
        windows: [],
      };
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-code/2.1.328",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      return {
        ...base,
        label,
        plan: oauth.subscriptionType ?? null,
        ok: false,
        error: `A Anthropic respondeu ${response.status} ao ler os limites.`,
        windows: [],
      };
    return {
      ...base,
      label,
      plan: oauth.subscriptionType ?? null,
      ok: true,
      error: null,
      windows: claudeWindows((await response.json()) as RawClaudeUsage),
    };
  } catch (error) {
    return {
      ...base,
      label,
      ok: false,
      error: `Não deu para ler os limites do Claude: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        200,
      ),
      windows: [],
    };
  }
}

export function readCodexRateLimits(binary = "codex", timeoutMs = 20_000) {
  return new Promise<RawCodexLimits>((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "runelay_bots" }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
    try {
      child = Bun.spawn([binary, "app-server"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const finish = (error: Error | null, value?: RawCodexLimits) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const timer = setTimeout(() => finish(new Error("o Codex não respondeu a tempo")), timeoutMs);
    const send = (payload: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        child.stdin.flush();
      } catch {}
    };
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            if (message.id === 1) {
              send({ jsonrpc: "2.0", method: "initialized" });
              send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
            } else if (message.id === 2) {
              if (message.error) return finish(new Error(message.error.message ?? "erro do Codex"));
              const result = message.result ?? {};
              const byId = result.rateLimitsByLimitId as Record<string, RawCodexLimits> | undefined;
              return finish(null, byId?.codex ?? (result.rateLimits as RawCodexLimits) ?? {});
            }
          }
        }
      } catch {}
      finish(new Error("o Codex fechou sem responder"));
    })();
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "runelay_bots", title: "runelay bots", version: "1.0.0" } },
    });
  });
}

async function vpsCodexLimits(): Promise<Omit<LimitAccount, "failover">> {
  const base = { id: "vps:codex", environment: "vps" as const, provider: "codex" as const, label: "Codex VPS" };
  try {
    const raw = await readCodexRateLimits();
    return { ...base, plan: raw.planType ?? null, ok: true, error: null, windows: codexWindows(raw) };
  } catch (error) {
    return {
      ...base,
      plan: null,
      ok: false,
      error: `Não deu para ler os limites do Codex: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        200,
      ),
      windows: [],
    };
  }
}

async function macLimits(): Promise<Array<Omit<LimitAccount, "failover">>> {
  const offline = (provider: UsageProvider, error: string) => ({
    id: `mac:${provider}`,
    environment: "mac" as const,
    provider,
    label: `${providerLabels[provider]} Mac`,
    plan: null,
    ok: false,
    error,
    windows: [],
  });
  if (!macRunnerConnected()) return [];
  if (!macRunnerSupports("usage"))
    return [
      offline("claude", "Atualize o app no Mac para ler os limites de lá."),
      offline("codex", "Atualize o app no Mac para ler os limites de lá."),
    ];
  try {
    const result = await macUsageLimits();
    return (["claude", "codex"] as const).map((provider) => {
      const entry = result[provider] as
        | { ok?: boolean; error?: string; label?: string; plan?: string; raw?: unknown }
        | undefined;
      if (!entry) return offline(provider, "O Mac não mandou os limites.");
      const label = `${providerLabels[provider]} ${entry.label || "Mac"}`;
      if (!entry.ok || !entry.raw)
        return { ...offline(provider, entry.error ?? "O Mac não conseguiu ler os limites."), label };
      const windows =
        provider === "claude" ? claudeWindows(entry.raw as RawClaudeUsage) : codexWindows(entry.raw as RawCodexLimits);
      const plan = provider === "codex" ? ((entry.raw as RawCodexLimits).planType ?? null) : (entry.plan ?? null);
      return {
        id: `mac:${provider}`,
        environment: "mac" as const,
        provider,
        label,
        plan,
        ok: true,
        error: null,
        windows,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [offline("claude", message), offline("codex", message)];
  }
}

function accountLabel(account: string) {
  const [runner, provider] = account.split(":");
  const name =
    provider === "codex"
      ? "Codex"
      : provider === "claude"
        ? "Claude"
        : provider === "grok"
          ? "Grok"
          : provider === "cursor"
            ? "Cursor"
            : provider;
  return `${name} (${runner?.startsWith("mac") ? "Mac" : "VPS"})`;
}

function failoversFor(accountId: string) {
  const result: LimitAccount["failover"] = [];
  for (const bot of listBots()) {
    const engine = engineOf(bot);
    if (engine.account !== accountId || !engine.fallback) continue;
    result.push({
      botId: bot.id,
      botName: bot.name,
      to: engine.fallback.account,
      toLabel: accountLabel(engine.fallback.account),
    });
  }
  return result;
}

async function computeLimits() {
  const [claude, codex, mac] = await Promise.all([vpsClaudeLimits(), vpsCodexLimits(), macLimits()]);
  return [claude, codex, ...mac].map((account) => ({ ...account, failover: failoversFor(account.id) }));
}

export function usageLimits(refresh = false) {
  if (!refresh && limitsCache && Date.now() - limitsCache.at < 90_000) return Promise.resolve(limitsCache.value);
  if (limitsPending) return limitsPending;
  limitsPending = computeLimits()
    .then((value) => {
      limitsCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      limitsPending = null;
    });
  return limitsPending;
}

interface PriceEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  provider_specific_entry?: { fast?: number } | null;
}

let prices: { at: number; table: Record<string, PriceEntry> } | null = null;
let pricesPending: Promise<Record<string, PriceEntry>> | null = null;

async function priceTable() {
  if (prices && Date.now() - prices.at < 24 * 3_600_000) return prices.table;
  if (pricesPending) return pricesPending;
  pricesPending = (async () => {
    const stored = await readSetting<{ at: number; table: Record<string, PriceEntry> } | null>(pricesKey, null);
    if (stored && Date.now() - stored.at < 24 * 3_600_000) {
      prices = stored;
      return stored.table;
    }
    try {
      const response = await fetch(pricesUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(String(response.status));
      const full = (await response.json()) as Record<string, PriceEntry>;
      const table: Record<string, PriceEntry> = {};
      for (const [key, value] of Object.entries(full)) {
        if (!value || typeof value !== "object" || typeof value.input_cost_per_token !== "number") continue;
        if (/claude|gpt|codex|^o\d|grok/.test(key)) table[key] = value;
      }
      prices = { at: Date.now(), table };
      try {
        await writeSetting(pricesKey, prices);
      } catch {}
      return table;
    } catch {
      prices = { at: Date.now() - 23 * 3_600_000, table: stored?.table ?? {} };
      return prices.table;
    }
  })().finally(() => {
    pricesPending = null;
  });
  return pricesPending;
}

function priceFor(table: Record<string, PriceEntry>, model: string) {
  const clean = model.replace(/\[[^\]]*\]$/, "").trim();
  const candidates = [
    clean,
    clean.replace(/-\d{8}$/, ""),
    `openai/${clean}`,
    `azure/${clean}`,
    `azure_ai/${clean}`,
    `anthropic/${clean}`,
  ];
  for (const key of candidates) if (table[key]) return table[key];
  return null;
}

function costOf(price: PriceEntry | null, speed: string, c: Counters) {
  if (!price) return null;
  const input = price.input_cost_per_token ?? 0;
  const multiplier = speed === "fast" ? (price.provider_specific_entry?.fast ?? 1) : 1;
  const read = price.cache_read_input_token_cost ?? input;
  const write = price.cache_creation_input_token_cost ?? input;
  const write1h = price.cache_creation_input_token_cost_above_1hr ?? write;
  const output = price.output_cost_per_token ?? 0;
  const parts = {
    input: c[0] * input * multiplier,
    cacheRead: c[1] * read * multiplier,
    cacheWrite: (c[2] * write + c[3] * write1h) * multiplier,
    output: c[4] * output * multiplier,
  };
  return {
    ...parts,
    total: parts.input + parts.cacheRead + parts.cacheWrite + parts.output,
    savings: c[1] * Math.max(0, input - read) * multiplier,
  };
}

const ranges: Record<string, number> = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400, "90d": 90 * 86_400 };

function dayKey(hour: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(hour * 1000),
  );
}

function refreshMac(since: number) {
  if (macPending) return macPending;
  macPending = (async () => {
    if (!macRunnerConnected()) {
      macSnapshot = {
        at: Date.now(),
        since,
        rows: macSnapshot?.rows ?? [],
        sessions: macSnapshot?.sessions ?? [],
        error: "O app do Mac está fechado. Os números do Mac podem estar desatualizados.",
        scannedAt: macSnapshot?.scannedAt ?? null,
      };
      return;
    }
    if (!macRunnerSupports("usage")) {
      macSnapshot = {
        at: Date.now(),
        since,
        rows: [],
        sessions: [],
        error: "Atualize o app no Mac para somar o uso de lá.",
        scannedAt: null,
      };
      return;
    }
    try {
      const result = await macUsageBuckets(since);
      macSnapshot = {
        at: Date.now(),
        since,
        rows: (result.rows as UsageRow[]) ?? [],
        sessions: (result.sessions as SessionRow[]) ?? [],
        error: null,
        scannedAt: String(result.scannedAt ?? new Date().toISOString()),
      };
    } catch (error) {
      macSnapshot = {
        at: Date.now(),
        since,
        rows: macSnapshot?.rows ?? [],
        sessions: macSnapshot?.sessions ?? [],
        error: `Não deu para ler o uso do Mac: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
        scannedAt: macSnapshot?.scannedAt ?? null,
      };
    }
  })().finally(() => {
    macPending = null;
  });
  return macPending;
}

async function macRows(since: number) {
  const stale = !macSnapshot || Date.now() - macSnapshot.at > 120_000 || macSnapshot.since > since;
  if (stale) {
    const work = refreshMac(Math.floor(Date.now() / 1000) - ranges["90d"] - 86_400);
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, macSnapshot ? 3000 : 8000))]);
  }
  if (!macSnapshot)
    return { at: Date.now(), since, rows: [], sessions: [], error: null, scannedAt: null, pending: true };
  return { ...macSnapshot, pending: macPending !== null && !macSnapshot.scannedAt };
}

export async function usageSummary(rangeKey: string, provider: string | null, environment: string | null) {
  const span = ranges[rangeKey] ?? ranges["30d"];
  const now = Math.floor(Date.now() / 1000);
  const since = Math.floor((now - span) / 3600) * 3600;
  const hourly = rangeKey === "24h";
  const wantVps = !environment || environment === "vps";
  const wantMac = !environment || environment === "mac";
  const [vps, mac, table] = await Promise.all([
    wantVps ? scanner.snapshot() : null,
    wantMac ? macRows(since) : null,
    priceTable(),
  ]);
  const sources: Array<{ env: Environment; rows: UsageRow[]; sessions: SessionRow[] }> = [];
  if (vps) sources.push({ env: "vps", rows: vps.rows, sessions: vps.sessions });
  if (mac) sources.push({ env: "mac", rows: mac.rows, sessions: mac.sessions });
  const keep = (p: string, h: number) => h >= since && (!provider || provider === p);
  const totals = {
    processed: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    requests: 0,
    sessions: 0,
    costUsd: 0,
    savingsUsd: 0,
    unpricedTokens: 0,
  };
  const costByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const series = new Map<string, { bucket: string; provider: UsageProvider; tokens: number; costUsd: number }>();
  const speeds = new Map<string, { speed: string; tokens: number; costUsd: number }>();
  const detail = new Map<
    string,
    {
      day: string;
      provider: UsageProvider;
      model: string;
      environment: Environment;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
      processed: number;
      requests: number;
      costUsd: number | null;
    }
  >();
  for (const source of sources) {
    for (const row of source.rows) {
      if (!keep(row.p, row.h)) continue;
      const c = row.c;
      const write = c[2] + c[3];
      const processed = c[0] + c[1] + write + c[4];
      const cost = costOf(priceFor(table, row.m), row.s, c);
      totals.processed += processed;
      totals.input += c[0];
      totals.cacheRead += c[1];
      totals.cacheWrite += write;
      totals.output += c[4];
      totals.reasoning += c[5];
      totals.requests += c[6];
      if (cost) {
        totals.costUsd += cost.total;
        totals.savingsUsd += cost.savings;
        costByType.input += cost.input;
        costByType.cacheRead += cost.cacheRead;
        costByType.cacheWrite += cost.cacheWrite;
        costByType.output += cost.output;
      } else totals.unpricedTokens += processed;
      const bucket = hourly ? new Date(row.h * 1000).toISOString() : dayKey(row.h);
      const seriesKey = `${bucket}|${row.p}`;
      const point = series.get(seriesKey) ?? { bucket, provider: row.p, tokens: 0, costUsd: 0 };
      point.tokens += processed;
      point.costUsd += cost?.total ?? 0;
      series.set(seriesKey, point);
      const speed = speeds.get(row.s) ?? { speed: row.s, tokens: 0, costUsd: 0 };
      speed.tokens += processed;
      speed.costUsd += cost?.total ?? 0;
      speeds.set(row.s, speed);
      const day = dayKey(row.h);
      const detailKey = `${day}|${row.p}|${row.m}|${source.env}`;
      const entry = detail.get(detailKey) ?? {
        day,
        provider: row.p,
        model: row.m,
        environment: source.env,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        processed: 0,
        requests: 0,
        costUsd: cost ? 0 : null,
      };
      entry.input += c[0];
      entry.cacheRead += c[1];
      entry.cacheWrite += write;
      entry.output += c[4];
      entry.processed += processed;
      entry.requests += c[6];
      if (cost) entry.costUsd = (entry.costUsd ?? 0) + cost.total;
      detail.set(detailKey, entry);
    }
    totals.sessions += source.sessions.filter((session) => keep(session.p, session.h)).length;
  }
  return {
    range: rangeKey in ranges ? rangeKey : "30d",
    since: new Date(since * 1000).toISOString(),
    until: new Date(now * 1000).toISOString(),
    granularity: hourly ? "hour" : "day",
    timeZone: zone,
    totals,
    costByType,
    series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    speeds: [...speeds.values()].sort((a, b) => b.costUsd - a.costUsd),
    detail: [...detail.values()].sort((a, b) => b.day.localeCompare(a.day) || b.processed - a.processed),
    environments: {
      vps: wantVps ? { ok: true, error: null, scannedAt: vps?.scannedAt ?? null, pending: false } : null,
      mac: wantMac
        ? {
            ok: !mac?.error && !mac?.pending,
            error: mac?.pending
              ? "Somando o histórico do Mac pela primeira vez. Pode levar alguns minutos."
              : (mac?.error ?? null),
            scannedAt: mac?.scannedAt ?? null,
            pending: Boolean(mac?.pending),
          }
        : null,
    },
    pricing: { source: "LiteLLM (preço de API)", updatedAt: prices ? new Date(prices.at).toISOString() : null },
  };
}

export function warmUsage() {
  setTimeout(() => {
    void scanner
      .snapshot(0)
      .catch((error) => console.log(`usage: scan falhou: ${error instanceof Error ? error.message : String(error)}`));
    void priceTable().catch(() => undefined);
  }, 15_000).unref();
}

export function limitsCheckedAt() {
  return new Date(limitsCache?.at ?? Date.now()).toISOString();
}
