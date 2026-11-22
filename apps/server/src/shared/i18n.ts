import { AsyncLocalStorage } from "node:async_hooks";

export const languages = ["pt-BR", "en"] as const;
export type Language = (typeof languages)[number];
export const languagePreferences = ["system", ...languages] as const;
export type LanguagePreference = (typeof languagePreferences)[number];
export const defaultLanguage: Language = "pt-BR";

export type MessageVars = Record<string, string | number>;
export type MessageTable<K extends string> = Record<Language, Record<K, string>>;

const scope = new AsyncLocalStorage<Language>();
let preferred: LanguagePreference = "system";
let deviceLanguage: Language | null = null;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === "string" && (languagePreferences as readonly string[]).includes(value);
}

export function parseLanguage(header: string | null | undefined): Language | null {
  const first = header?.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!first || first === "*") return null;
  return first.startsWith("en") ? "en" : "pt-BR";
}

export function setLanguagePreference(value: LanguagePreference) {
  preferred = value;
}

export function noteDeviceLanguage(language: Language | null) {
  if (language) deviceLanguage = language;
}

export function preferredLanguage(): Language | null {
  return preferred === "system" ? deviceLanguage : preferred;
}

export function backgroundLanguage(): Language {
  return preferredLanguage() ?? defaultLanguage;
}

export function requestLanguage(headers: Headers, override?: string | null): Language {
  return parseLanguage(override) ?? parseLanguage(headers.get("accept-language")) ?? backgroundLanguage();
}

export function withLanguage<T>(language: Language, run: () => T): T {
  return scope.run(language, run);
}

export function currentLanguage(): Language {
  return scope.getStore() ?? backgroundLanguage();
}

export function resetLanguageState() {
  preferred = "system";
  deviceLanguage = null;
}

export function format(template: string, vars?: MessageVars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function t<K extends string>(language: Language, table: MessageTable<K>, key: K, vars?: MessageVars) {
  return format(table[language][key], vars);
}

export function defineMessages<K extends string>(table: MessageTable<K>) {
  return (key: K, vars?: MessageVars, language: Language = currentLanguage()) => t(language, table, key, vars);
}
