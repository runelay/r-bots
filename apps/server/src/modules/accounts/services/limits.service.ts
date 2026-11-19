import { readFileSync } from "node:fs";
import type { ProviderEvent } from "@runelay-bots/protocol";
import { type Provider, providerLabels } from "@runelay-bots/protocol";

const limitPattern =
  /spend(?:ing)? limit|usage limit|rate[ _-]?limit|limit reached|limit exceeded|hit your (?:[\w']+ ){0,3}limit|quota|too many requests|\b429\b|credit balance is too low|out of credits|resets? (?:at |in )?\d/i;

const unknownResetMs = 15 * 60_000;
const displayZone = "America/Sao_Paulo";

export interface LimitState {
  until: Date;
  known: boolean;
  message: string;
}

const limited = new Map<string, LimitState>();

const limitReplyPattern =
  /you'?ve hit your|usage limit reached|spend(?:ing)? limit|limit reached\||limit · resets|out of (?:extra )?usage/i;

export function isLimitReply(text: string) {
  return text.length < 400 && limitReplyPattern.test(text);
}

export function isLimitError(text: string | null | undefined) {
  return Boolean(text && limitPattern.test(text));
}

function zoneOffset(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at;
}

function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function nextWallTime(hour: number, minute: number, zone: string, now: Date) {
  const local = new Date(now.getTime() + zoneOffset(now.getTime(), zone));
  for (let days = 0; days < 2; days++) {
    const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour, minute);
    const at = guess - zoneOffset(guess, zone);
    if (at > now.getTime()) return new Date(at);
  }
  return null;
}

export function parseResetAt(text: string, now = new Date(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/);
  if (iso) {
    const at = Date.parse(iso[1]);
    if (Number.isFinite(at)) return new Date(at);
  }
  const relative = text.match(
    /(?:try again|retry|resets?|available again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,and]*)+)/i,
  );
  if (relative) {
    let ms = 0;
    for (const [, amount, unit] of relative[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
      const value = Number(amount);
      const key = unit.toLowerCase();
      ms += key.startsWith("d") ? value * 86_400_000 : key.startsWith("h") ? value * 3_600_000 : value * 60_000;
    }
    if (ms > 0) return new Date(now.getTime() + ms);
  }
  const clock = text.match(
    /(?:resets?|try again|available again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i,
  );
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const half = clock[3]?.toLowerCase();
    if (half === "pm" && hour < 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const named = clock[4]?.trim();
    return nextWallTime(hour, minute, named && validZone(named) ? named : zone, now);
  }
  return null;
}

export function markLimited(accountId: string, message: string, zone?: string) {
  const resetAt = parseResetAt(message, new Date(), zone);
  const state: LimitState = resetAt
    ? { until: resetAt, known: true, message }
    : { until: new Date(Date.now() + unknownResetMs), known: false, message };
  limited.set(accountId, state);
  return state;
}

export function limitOf(accountId: string) {
  const state = limited.get(accountId);
  if (!state) return null;
  if (state.until.getTime() <= Date.now()) {
    limited.delete(accountId);
    return null;
  }
  return state;
}

export function clearLimit(accountId: string) {
  limited.delete(accountId);
}

export function formatReset(at: Date, now = new Date()) {
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: displayZone, hour: "2-digit", minute: "2-digit" }).format(
    at,
  );
  const day = (value: Date) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: displayZone, day: "2-digit", month: "2-digit" }).format(value);
  if (day(at) === day(now)) return `às ${time}`;
  if (day(at) === day(new Date(now.getTime() + 86_400_000))) return `amanhã às ${time}`;
  return `dia ${day(at)} às ${time}`;
}

export function providerName(provider: Provider) {
  return providerLabels[provider].split(" · ")[0] === "ChatGPT" ? "Codex" : providerLabels[provider].split(" · ")[0];
}

export function injectedFault(accountId: string): string | null {
  const file = process.env.BOTS_FAULTS_FILE;
  if (!file) return null;
  try {
    const faults = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    return faults[accountId] ?? null;
  } catch {
    return null;
  }
}

export function emitFault(message: string, emit: (event: ProviderEvent) => void) {
  emit({ type: "text", part: "fault", text: message });
  emit({ type: "done", ok: false, message });
}
