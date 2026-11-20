import { and, desc, eq, gte, ne } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { teamMemory } from "../../../db/tables";

export interface TeamEntry {
  at: string;
  botId: string;
  botName: string;
  summary: string;
}

export async function addTeamEntry(entry: TeamEntry, db: Db = getDb()) {
  await db.insert(teamMemory).values(entry);
}

export async function recentTeamEntries(
  excludeBotId: string,
  since: string,
  limit: number,
  db: Db = getDb(),
): Promise<TeamEntry[]> {
  const rows = await db
    .select({ at: teamMemory.at, botId: teamMemory.botId, botName: teamMemory.botName, summary: teamMemory.summary })
    .from(teamMemory)
    .where(and(gte(teamMemory.at, since), ne(teamMemory.botId, excludeBotId)))
    .orderBy(desc(teamMemory.id))
    .limit(limit);
  return rows.reverse();
}

export async function teamEntryExists(entry: TeamEntry, db: Db = getDb()) {
  const [row] = await db
    .select({ id: teamMemory.id })
    .from(teamMemory)
    .where(and(eq(teamMemory.at, entry.at), eq(teamMemory.botId, entry.botId), eq(teamMemory.summary, entry.summary)))
    .limit(1);
  return Boolean(row);
}
