import { afterEach, describe, expect, test } from "bun:test";
import {
  backgroundLanguage,
  currentLanguage,
  defineMessages,
  format,
  isLanguagePreference,
  noteDeviceLanguage,
  parseLanguage,
  preferredLanguage,
  requestLanguage,
  resetLanguageState,
  setLanguagePreference,
  t,
  withLanguage,
} from "../i18n";

const table = {
  "pt-BR": { hello: "Olá, {name}.", plain: "Sem variáveis." },
  en: { hello: "Hi, {name}.", plain: "No variables." },
};

afterEach(() => resetLanguageState());

describe("i18n", () => {
  test("parses Accept-Language into pt-BR or en", () => {
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("en-US,en;q=0.9,pt;q=0.8")).toBe("en");
    expect(parseLanguage("pt-BR")).toBe("pt-BR");
    expect(parseLanguage("fr-FR")).toBe("pt-BR");
    expect(parseLanguage(" EN-gb ")).toBe("en");
    expect(parseLanguage("*")).toBeNull();
    expect(parseLanguage("")).toBeNull();
    expect(parseLanguage(null)).toBeNull();
    expect(parseLanguage(undefined)).toBeNull();
  });

  test("validates preferences", () => {
    expect(isLanguagePreference("system")).toBe(true);
    expect(isLanguagePreference("pt-BR")).toBe(true);
    expect(isLanguagePreference("en")).toBe(true);
    expect(isLanguagePreference("es")).toBe(false);
    expect(isLanguagePreference(1)).toBe(false);
  });

  test("background language follows the preference, then the last device, then pt-BR", () => {
    expect(preferredLanguage()).toBeNull();
    expect(backgroundLanguage()).toBe("pt-BR");
    noteDeviceLanguage(null);
    expect(preferredLanguage()).toBeNull();
    noteDeviceLanguage("en");
    expect(preferredLanguage()).toBe("en");
    expect(backgroundLanguage()).toBe("en");
    setLanguagePreference("pt-BR");
    expect(backgroundLanguage()).toBe("pt-BR");
    setLanguagePreference("system");
    expect(backgroundLanguage()).toBe("en");
    resetLanguageState();
    expect(backgroundLanguage()).toBe("pt-BR");
  });

  test("request language prefers the override, then the header, then the background", () => {
    const headers = new Headers({ "accept-language": "en-US" });
    expect(requestLanguage(headers)).toBe("en");
    expect(requestLanguage(headers, "pt-BR")).toBe("pt-BR");
    expect(requestLanguage(new Headers(), "en")).toBe("en");
    expect(requestLanguage(new Headers())).toBe("pt-BR");
    setLanguagePreference("en");
    expect(requestLanguage(new Headers({ "accept-language": "*" }))).toBe("en");
  });

  test("withLanguage scopes the current language across awaits", async () => {
    expect(currentLanguage()).toBe("pt-BR");
    const seen = await withLanguage("en", async () => {
      await Promise.resolve();
      return currentLanguage();
    });
    expect(seen).toBe("en");
    expect(currentLanguage()).toBe("pt-BR");
  });

  test("formats and translates messages in both languages", () => {
    expect(format("{a} e {b} e {c}", { a: 1, b: "dois" })).toBe("1 e dois e {c}");
    expect(format("sem nada")).toBe("sem nada");
    expect(t("en", table, "hello", { name: "Ana" })).toBe("Hi, Ana.");
    expect(t("pt-BR", table, "hello", { name: "Ana" })).toBe("Olá, Ana.");
    const text = defineMessages(table);
    expect(text("plain")).toBe("Sem variáveis.");
    expect(text("plain", undefined, "en")).toBe("No variables.");
    expect(withLanguage("en", () => text("hello", { name: "{x}" }))).toBe("Hi, {x}.");
  });
});
