import { and, eq } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { codeWorkspaces } from "../../../db/tables";

export async function liveWorkspaceIds(botId: string, db: Db = getDb()) {
  const rows = await db
    .select({ id: codeWorkspaces.id })
    .from(codeWorkspaces)
    .where(and(eq(codeWorkspaces.botId, botId), eq(codeWorkspaces.status, "alive")));
  return rows.map((row) => row.id);
}
