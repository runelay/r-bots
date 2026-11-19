import { and, desc, eq, gte, ne } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { teamMemory } from "../../../db/tables";

export interface TeamEntry {
  at: string;
  botId: string;
  botName: string;
  summary: string;
}

export function addTeamEntry(entry: TeamEntry, db: Db = getDb()) {
  db.insert(teamMemory).values(entry).run();
}

export function recentTeamEntries(excludeBotId: string, since: string, limit: number, db: Db = getDb()): TeamEntry[] {
  return db
    .select({ at: teamMemory.at, botId: teamMemory.botId, botName: teamMemory.botName, summary: teamMemory.summary })
    .from(teamMemory)
    .where(and(gte(teamMemory.at, since), ne(teamMemory.botId, excludeBotId)))
    .orderBy(desc(teamMemory.id))
    .limit(limit)
    .all()
    .reverse();
}

export function teamEntryExists(entry: TeamEntry, db: Db = getDb()) {
  return Boolean(
    db
      .select({ id: teamMemory.id })
      .from(teamMemory)
      .where(and(eq(teamMemory.at, entry.at), eq(teamMemory.botId, entry.botId), eq(teamMemory.summary, entry.summary)))
      .get(),
  );
}
