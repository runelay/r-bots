import { type EnvironmentId, environmentIds } from "@runelay-bots/protocol";
import { readSetting, writeSetting } from "../../../db/settings";
import { ValidationError } from "../../../shared/errors";

export const notificationKinds = ["replies", "approvals", "routines", "failures"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const notificationLabels: Record<NotificationKind, string> = {
  replies: "Respostas dos bots",
  approvals: "Aprovações pendentes",
  routines: "Resultados de rotinas",
  failures: "Turnos com erro",
};

export interface AppPreferences {
  notifications: Record<NotificationKind, boolean>;
  microphone: string | null;
  microphones: string[];
  environment: EnvironmentId;
  updatedAt: string | null;
}

const preferencesKey = "app.preferences";
const listeners = new Set<(preferences: AppPreferences) => void>();

export function defaultPreferences(): AppPreferences {
  return {
    notifications: { replies: true, approvals: true, routines: true, failures: true },
    microphone: null,
    microphones: [],
    environment: "vps",
    updatedAt: null,
  };
}

function isEnvironment(value: unknown): value is EnvironmentId {
  return environmentIds.some((id) => id === value);
}

export async function readPreferences(): Promise<AppPreferences> {
  const stored = await readSetting<Partial<AppPreferences>>(preferencesKey, {});
  const base = defaultPreferences();
  return {
    notifications: { ...base.notifications, ...stored.notifications },
    microphone: stored.microphone ?? null,
    microphones: stored.microphones ?? [],
    environment: isEnvironment(stored.environment) ? stored.environment : base.environment,
    updatedAt: stored.updatedAt ?? null,
  };
}

export function onPreferences(listener: (preferences: AppPreferences) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function microphoneName(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 120)
    throw new ValidationError("microphone precisa ser o nome do microfone ou null.", "microphone");
  return value.trim();
}

export async function updatePreferences(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Corpo inválido.", "body");
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!["notifications", "microphone", "microphones", "environment"].includes(key))
      throw new ValidationError(`Campo desconhecido: ${key}.`, key);
  const next = await readPreferences();
  if (raw.notifications !== undefined) {
    if (!raw.notifications || typeof raw.notifications !== "object" || Array.isArray(raw.notifications))
      throw new ValidationError("notifications inválido.", "notifications");
    for (const [key, value] of Object.entries(raw.notifications)) {
      if (!(notificationKinds as readonly string[]).includes(key))
        throw new ValidationError(`Notificação desconhecida: ${key}.`, `notifications.${key}`);
      if (typeof value !== "boolean")
        throw new ValidationError(`notifications.${key} precisa ser verdadeiro ou falso.`, `notifications.${key}`);
      next.notifications[key as NotificationKind] = value;
    }
  }
  if (raw.microphones !== undefined) {
    if (!Array.isArray(raw.microphones) || raw.microphones.length > 40)
      throw new ValidationError("microphones precisa ser uma lista de nomes.", "microphones");
    next.microphones = [
      ...new Set(raw.microphones.map(microphoneName).filter((item): item is string => item !== null)),
    ];
  }
  if (raw.microphone !== undefined) next.microphone = microphoneName(raw.microphone);
  if (raw.environment !== undefined) {
    if (!isEnvironment(raw.environment))
      throw new ValidationError(`environment precisa ser ${environmentIds.join(" ou ")}.`, "environment");
    next.environment = raw.environment;
  }
  next.updatedAt = new Date().toISOString();
  await writeSetting(preferencesKey, next);
  for (const listener of listeners) listener(next);
  return next;
}
