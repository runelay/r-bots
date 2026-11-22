import { readSetting, writeSetting } from "../../../db/settings";
import { ValidationError } from "../../../shared/errors";
import {
  defineMessages,
  isLanguagePreference,
  type Language,
  type LanguagePreference,
  languagePreferences,
  setLanguagePreference,
} from "../../../shared/i18n";

export const notificationKinds = ["replies", "approvals", "routines", "failures"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

const text = defineMessages({
  "pt-BR": {
    replies: "Respostas dos bots",
    approvals: "Aprovações pendentes",
    routines: "Resultados de rotinas",
    failures: "Turnos com erro",
    microphoneInvalid: "microphone precisa ser o nome do microfone ou null.",
    bodyInvalid: "Corpo inválido.",
    unknownField: "Campo desconhecido: {key}.",
    notificationsInvalid: "notifications inválido.",
    unknownNotification: "Notificação desconhecida: {key}.",
    notificationBoolean: "notifications.{key} precisa ser verdadeiro ou falso.",
    microphonesInvalid: "microphones precisa ser uma lista de nomes.",
    languageInvalid: "language precisa ser {options}.",
  },
  en: {
    replies: "Bot replies",
    approvals: "Pending approvals",
    routines: "Routine results",
    failures: "Turns with errors",
    microphoneInvalid: "microphone must be the microphone name or null.",
    bodyInvalid: "Invalid body.",
    unknownField: "Unknown field: {key}.",
    notificationsInvalid: "Invalid notifications.",
    unknownNotification: "Unknown notification: {key}.",
    notificationBoolean: "notifications.{key} must be true or false.",
    microphonesInvalid: "microphones must be a list of names.",
    languageInvalid: "language must be {options}.",
  },
});

export function notificationLabel(kind: NotificationKind, language?: Language) {
  return text(kind, undefined, language);
}

export interface AppPreferences {
  notifications: Record<NotificationKind, boolean>;
  microphone: string | null;
  microphones: string[];
  language: LanguagePreference;
  updatedAt: string | null;
}

const preferencesKey = "app.preferences";
const listeners = new Set<(preferences: AppPreferences) => void>();

export function defaultPreferences(): AppPreferences {
  return {
    notifications: { replies: true, approvals: true, routines: true, failures: true },
    microphone: null,
    microphones: [],
    language: "system",
    updatedAt: null,
  };
}

export async function readPreferences(): Promise<AppPreferences> {
  const stored = await readSetting<Partial<AppPreferences>>(preferencesKey, {});
  const base = defaultPreferences();
  const language = isLanguagePreference(stored.language) ? stored.language : base.language;
  setLanguagePreference(language);
  return {
    notifications: { ...base.notifications, ...stored.notifications },
    microphone: stored.microphone ?? null,
    microphones: stored.microphones ?? [],
    language,
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
    throw new ValidationError(text("microphoneInvalid"), "microphone");
  return value.trim();
}

export async function updatePreferences(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError(text("bodyInvalid"), "body");
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!["notifications", "microphone", "microphones", "language"].includes(key))
      throw new ValidationError(text("unknownField", { key }), key);
  const next = await readPreferences();
  if (raw.notifications !== undefined) {
    if (!raw.notifications || typeof raw.notifications !== "object" || Array.isArray(raw.notifications))
      throw new ValidationError(text("notificationsInvalid"), "notifications");
    for (const [key, value] of Object.entries(raw.notifications)) {
      if (!(notificationKinds as readonly string[]).includes(key))
        throw new ValidationError(text("unknownNotification", { key }), `notifications.${key}`);
      if (typeof value !== "boolean")
        throw new ValidationError(text("notificationBoolean", { key }), `notifications.${key}`);
      next.notifications[key as NotificationKind] = value;
    }
  }
  if (raw.microphones !== undefined) {
    if (!Array.isArray(raw.microphones) || raw.microphones.length > 40)
      throw new ValidationError(text("microphonesInvalid"), "microphones");
    next.microphones = [
      ...new Set(raw.microphones.map(microphoneName).filter((item): item is string => item !== null)),
    ];
  }
  if (raw.microphone !== undefined) next.microphone = microphoneName(raw.microphone);
  if (raw.language !== undefined) {
    if (!isLanguagePreference(raw.language))
      throw new ValidationError(text("languageInvalid", { options: languagePreferences.join(", ") }), "language");
    next.language = raw.language;
  }
  next.updatedAt = new Date().toISOString();
  await writeSetting(preferencesKey, next);
  setLanguagePreference(next.language);
  for (const listener of listeners) listener(next);
  return next;
}
