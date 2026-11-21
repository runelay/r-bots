import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readSetting, writeSetting } from "../../../db/settings";
import {
  type Account,
  accountDir,
  accountPath,
  listAccounts,
  siblingAccounts,
} from "../../accounts/services/accounts.service";
import { engineOf, listBots } from "../../bots/services/bots.service";
import {
  type Counters,
  type SessionRow,
  type UsageProvider,
  type UsageRow,
  UsageScanner,
  type UsageSource,
} from "./usage-scan.service";

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
  provider: UsageProvider;
  label: string;
  email: string | null;
  plan: string | null;
  isDefault: boolean;
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
const usageProviders: readonly string[] = ["claude", "codex"];

async function usageAccounts() {
  return (await listAccounts()).filter((account) => usageProviders.includes(account.provider));
}

async function physical(path: string) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function usageSources(): Promise<UsageSource[]> {
  const accounts = await usageAccounts();
  const groups = new Map<string, UsageSource>();
  for (const account of accounts) {
    const dir = accountPath(account.id);
    if (!dir) continue;
    const provider = account.provider as UsageProvider;
    const root = join(dir, provider === "claude" ? "projects" : "sessions");
    const key = await physical(root);
    const shared = groups.get(key);
    if (shared) shared.account = `${shared.account}+${account.id}`;
    else groups.set(key, { account: account.id, provider, root });
  }
  return [...groups.values()];
}

function labelOf(id: string, known: Account[]) {
  return id
    .split("+")
    .map((part) => known.find((item) => item.id === part)?.label ?? part)
    .join(" + ");
}

const scanner = new UsageScanner(usageSources);
const pricesKey = "usage.prices";
const pricesUrl = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

let limitsCache: { at: number; value: LimitAccount[] } | null = null;
let limitsPending: Promise<LimitAccount[]> | null = null;

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

type LimitBase = Omit<LimitAccount, "failover" | "ok" | "error" | "windows">;

function limitBase(account: Account): LimitBase {
  return {
    id: account.id,
    provider: account.provider as UsageProvider,
    label: account.label,
    email: account.email,
    plan: account.plan,
    isDefault: account.isDefault,
  };
}

function limitFailure(base: LimitBase, error: string): Omit<LimitAccount, "failover"> {
  return { ...base, ok: false, error: error.slice(0, 200), windows: [] };
}

async function claudeLimits(account: Account): Promise<Omit<LimitAccount, "failover">> {
  const base = limitBase(account);
  const dir = accountPath(account.id);
  try {
    if (!dir) return limitFailure(base, `${account.label} não tem diretório de configuração.`);
    const credentials = JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string };
    };
    const oauth = credentials.claudeAiOauth;
    if (oauth?.subscriptionType) base.plan = oauth.subscriptionType;
    if (!oauth?.accessToken) return limitFailure(base, `${account.label} não está logado.`);
    if (oauth.expiresAt && oauth.expiresAt < Date.now())
      return limitFailure(base, `O login do ${account.label} expirou. Ele renova no próximo turno.`);
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-code/2.1.328",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return limitFailure(base, `A Anthropic respondeu ${response.status} ao ler os limites.`);
    return { ...base, ok: true, error: null, windows: claudeWindows((await response.json()) as RawClaudeUsage) };
  } catch (error) {
    return limitFailure(
      base,
      `Não deu para ler os limites do Claude: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function readCodexRateLimits(binary = "codex", timeoutMs = 20_000, codexHome: string | null = null) {
  return new Promise<RawCodexLimits>((resolve, reject) => {
    const { CODEX_HOME: _inherited, ...inherited } = process.env;
    const env = Object.fromEntries(
      Object.entries({
        ...inherited,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "runelay_bots",
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
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
      params: { clientInfo: { name: "runelay_bots", title: "r/bots", version: "1.0.0" } },
    });
  });
}

async function codexLimits(account: Account): Promise<Omit<LimitAccount, "failover">> {
  const base = limitBase(account);
  try {
    const raw = await readCodexRateLimits("codex", 20_000, accountDir(account.id));
    return { ...base, plan: raw.planType ?? base.plan, ok: true, error: null, windows: codexWindows(raw) };
  } catch (error) {
    return limitFailure(
      base,
      `Não deu para ler os limites do Codex: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function failoversFor(accountId: string, accounts: Account[]) {
  const result: LimitAccount["failover"] = [];
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return result;
  const sibling = siblingAccounts(accounts, account).find((item) => item.status === "ready");
  for (const bot of listBots()) {
    const engine = engineOf(bot);
    if (engine.account !== accountId) continue;
    const target = sibling ?? accounts.find((item) => item.id === engine.fallback?.account);
    if (!target) continue;
    result.push({ botId: bot.id, botName: bot.name, to: target.id, toLabel: target.label });
  }
  return result;
}

async function computeLimits() {
  const all = await listAccounts();
  const accounts = all.filter((account) => usageProviders.includes(account.provider) && account.status !== "missing");
  const limits = await Promise.all(
    accounts.map((account) => (account.provider === "claude" ? claudeLimits(account) : codexLimits(account))),
  );
  return limits.map((limit) => ({ ...limit, failover: failoversFor(limit.id, all) }));
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

export async function usageSummary(rangeKey: string, provider: string | null, account: string | null) {
  const span = ranges[rangeKey] ?? ranges["30d"];
  const now = Math.floor(Date.now() / 1000);
  const since = Math.floor((now - span) / 3600) * 3600;
  const hourly = rangeKey === "24h";
  const [snapshot, table, known] = await Promise.all([scanner.snapshot(), priceTable(), usageAccounts()]);
  const keep = (row: { p: string; h: number; a: string }) =>
    row.h >= since && (!provider || provider === row.p) && (!account || account === row.a);
  const perAccount = new Map<
    string,
    {
      id: string;
      provider: UsageProvider;
      label: string;
      processed: number;
      requests: number;
      sessions: number;
      costUsd: number;
    }
  >();
  const accountEntry = (id: string, p: UsageProvider) => {
    let entry = perAccount.get(id);
    if (!entry) {
      entry = { id, provider: p, label: labelOf(id, known), processed: 0, requests: 0, sessions: 0, costUsd: 0 };
      perAccount.set(id, entry);
    }
    return entry;
  };
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
      account: string;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
      processed: number;
      requests: number;
      costUsd: number | null;
    }
  >();
  for (const row of snapshot.rows as UsageRow[]) {
    if (!keep(row)) continue;
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
    const owner = accountEntry(row.a, row.p);
    owner.processed += processed;
    owner.requests += c[6];
    owner.costUsd += cost?.total ?? 0;
    const detailKey = `${day}|${row.p}|${row.m}|${row.a}`;
    const entry = detail.get(detailKey) ?? {
      day,
      provider: row.p,
      model: row.m,
      account: row.a,
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
  for (const session of snapshot.sessions as SessionRow[]) {
    if (!keep(session)) continue;
    totals.sessions += 1;
    accountEntry(session.a, session.p).sessions += 1;
  }
  if (!provider && !account) for (const item of known) accountEntry(item.id, item.provider as UsageProvider);
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
    accounts: [...perAccount.values()].sort(
      (a, b) =>
        Number(known.findIndex((item) => item.id === a.id) < 0) -
          Number(known.findIndex((item) => item.id === b.id) < 0) ||
        known.findIndex((item) => item.id === a.id) - known.findIndex((item) => item.id === b.id),
    ),
    scannedAt: snapshot.scannedAt,
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
