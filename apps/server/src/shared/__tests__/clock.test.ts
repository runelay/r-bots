import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as settings from "../../db/settings";
import {
  defaultTimezone,
  isTimezone,
  noteClientTimezone,
  nowNote,
  resetClock,
  userTimezone,
  zonedDay,
} from "../clock";

const lateNight = new Date("2026-11-20T02:47:00Z");

afterEach(async () => {
  resetClock();
  await settings.writeSetting("user.timezone", defaultTimezone);
  resetClock();
});

describe("user clock", () => {
  test("validates IANA zones", () => {
    expect(isTimezone("America/Sao_Paulo")).toBe(true);
    expect(isTimezone("Mars/Olympus")).toBe(false);
    expect(isTimezone("")).toBe(false);
    expect(isTimezone(42)).toBe(false);
    expect(isTimezone("x".repeat(65))).toBe(false);
  });

  test("defaults to São Paulo and keeps the zone the Mac reports", async () => {
    expect(await userTimezone()).toBe(defaultTimezone);
    expect(noteClientTimezone(null)).toBe(false);
    expect(noteClientTimezone("Nowhere/City")).toBe(false);
    expect(noteClientTimezone("Europe/Lisbon")).toBe(true);
    expect(noteClientTimezone("Europe/Lisbon")).toBe(false);
    expect(await userTimezone()).toBe("Europe/Lisbon");
    await Bun.sleep(20);
    resetClock();
    const [first, second] = await Promise.all([userTimezone(), userTimezone()]);
    expect([first, second]).toEqual(["Europe/Lisbon", "Europe/Lisbon"]);
  });

  test("falls back to the default on a bad stored value or a database failure", async () => {
    await settings.writeSetting("user.timezone", "Bad/Zone");
    resetClock();
    expect(await userTimezone()).toBe(defaultTimezone);
    resetClock();
    const failing = spyOn(settings, "readSetting").mockRejectedValue(new Error("down"));
    try {
      expect(await userTimezone()).toBe(defaultTimezone);
    } finally {
      failing.mockRestore();
    }
    const unsaved = spyOn(settings, "writeSetting").mockRejectedValue(new Error("down"));
    try {
      expect(noteClientTimezone("Asia/Tokyo")).toBe(true);
      await Bun.sleep(5);
      expect(await userTimezone()).toBe("Asia/Tokyo");
    } finally {
      unsaved.mockRestore();
    }
  });

  test("the note uses the person's day, not the server's UTC day", () => {
    expect(zonedDay(lateNight, "UTC")).toBe("2026-11-20");
    expect(zonedDay(lateNight, defaultTimezone)).toBe("2026-11-19");
    const note = nowNote(defaultTimezone, lateNight);
    expect(note).toContain("quinta-feira, 19 de novembro de 2026");
    expect(note).toContain("23:47");
    expect(note).toContain("Hoje é 2026-11-19 e amanhã é sexta-feira, 20/11");
    expect(note).toContain("America/Sao_Paulo, UTC-03:00");
    expect(note).toContain("ISO com -03:00");
    expect(nowNote("UTC", lateNight)).toContain("UTC, UTC+00:00");
  });
});
