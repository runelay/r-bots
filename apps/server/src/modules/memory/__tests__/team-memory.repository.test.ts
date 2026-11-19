import { beforeEach, describe, expect, test } from "bun:test";
import { type Db, openDatabase } from "../../../db";
import { addTeamEntry, recentTeamEntries, type TeamEntry, teamEntryExists } from "../repositories/team-memory.repository";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

function entry(overrides: Partial<TeamEntry> = {}): TeamEntry {
  return { at: "2026-11-19T10:00:00.000Z", botId: "bot-a", botName: "Ana", summary: "fez a planilha", ...overrides };
}

describe("team memory repository", () => {
  test("recent entries skip the asking bot and older days, oldest first, within the limit", () => {
    addTeamEntry(entry({ at: "2026-11-18T23:00:00.000Z", summary: "ontem" }), db);
    addTeamEntry(entry({ summary: "primeiro" }), db);
    addTeamEntry(entry({ botId: "bot-me", botName: "Eu", summary: "eu mesmo" }), db);
    addTeamEntry(entry({ at: "2026-11-19T11:00:00.000Z", botId: "bot-b", botName: "Bia", summary: "segundo" }), db);
    addTeamEntry(entry({ at: "2026-11-19T12:00:00.000Z", summary: "terceiro" }), db);
    expect(recentTeamEntries("bot-me", "2026-11-19", 5, db).map((item) => item.summary)).toEqual([
      "primeiro",
      "segundo",
      "terceiro",
    ]);
    expect(recentTeamEntries("bot-me", "2026-11-19", 2, db)).toEqual([
      { at: "2026-11-19T11:00:00.000Z", botId: "bot-b", botName: "Bia", summary: "segundo" },
      { at: "2026-11-19T12:00:00.000Z", botId: "bot-a", botName: "Ana", summary: "terceiro" },
    ]);
    expect(recentTeamEntries("bot-me", "2026-11-20", 5, db)).toEqual([]);
  });

  test("an entry exists only when time, bot and summary all match", () => {
    addTeamEntry(entry(), db);
    expect(teamEntryExists(entry(), db)).toBe(true);
    expect(teamEntryExists(entry({ at: "2026-11-19T10:00:01.000Z" }), db)).toBe(false);
    expect(teamEntryExists(entry({ botId: "bot-b" }), db)).toBe(false);
    expect(teamEntryExists(entry({ summary: "outra coisa" }), db)).toBe(false);
    expect(teamEntryExists(entry({ botName: "Outro nome" }), db)).toBe(true);
  });
});
