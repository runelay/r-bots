import { readSetting, writeSetting } from "../db/settings";

export const defaultTimezone = "America/Sao_Paulo";
const settingKey = "user.timezone";

let current: string | null = null;
let loading: Promise<string> | null = null;

export function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function userTimezone() {
  if (current) return current;
  loading ??= readSetting<unknown>(settingKey, defaultTimezone)
    .catch(() => defaultTimezone)
    .then((stored) => {
      current ??= isTimezone(stored) ? stored : defaultTimezone;
      return current;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function noteClientTimezone(value: string | null | undefined) {
  if (!isTimezone(value) || value === current) return false;
  current = value;
  void writeSetting(settingKey, value).catch(() => undefined);
  return true;
}

export function resetClock() {
  current = null;
  loading = null;
}

export function offsetOf(date: Date, zone: string) {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "+00:00" : name.replace("GMT", "");
}

export function zonedDay(date: Date, zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    date,
  );
}

export function nowNote(zone: string, now = new Date()) {
  const spoken = new Intl.DateTimeFormat("pt-BR", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const tomorrow = new Intl.DateTimeFormat("pt-BR", {
    timeZone: zone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(now.getTime() + 24 * 3_600_000));
  const offset = offsetOf(now, zone);
  return [
    "## Data e hora",
    `Agora é ${spoken} no fuso da pessoa (${zone}, UTC${offset}). Hoje é ${zonedDay(now, zone)} e amanhã é ${tomorrow}.`,
    `Use esse fuso para hoje, amanhã, dias da semana e qualquer horário, inclusive na agenda (ISO com ${offset}). O relógio do servidor está em UTC e a data do ambiente pode já ter virado: ignore e use esta.`,
  ].join("\n");
}
