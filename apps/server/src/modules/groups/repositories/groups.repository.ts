import { asc, eq } from "drizzle-orm";
import { type Db, getDb, writeTransaction } from "../../../db";
import { extraOf, type Json } from "../../../db/rows";
import { groupMembers, groups } from "../../../db/tables";
import type { Group } from "../services/groups.service";

const known = ["id", "name", "members", "createdAt", "updatedAt", "archivedAt"] as const;

export async function loadGroupRows(db: Db = getDb()): Promise<Group[]> {
  const members = new Map<string, string[]>();
  for (const row of await db.select().from(groupMembers).orderBy(asc(groupMembers.position))) {
    const list = members.get(row.groupId) ?? [];
    list.push(row.botId);
    members.set(row.groupId, list);
  }
  const rows = await db.select().from(groups).orderBy(asc(groups.createdAt), asc(groups.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    members: members.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    ...(row.extra ?? {}),
  }));
}

export async function saveGroupRow(source: Group | Json, db: Db = getDb()) {
  const group = source as Json;
  const row = {
    id: String(group.id),
    name: String(group.name ?? ""),
    extra: extraOf(group, known),
    createdAt: String(group.createdAt),
    updatedAt: String(group.updatedAt ?? group.createdAt),
    archivedAt: (group.archivedAt as string | null | undefined) ?? null,
  };
  const members = [...new Set((group.members as string[] | undefined) ?? [])];
  await writeTransaction(async (tx) => {
    await tx.insert(groups).values(row).onConflictDoUpdate({ target: groups.id, set: row });
    await tx.delete(groupMembers).where(eq(groupMembers.groupId, row.id));
    if (members.length)
      await tx.insert(groupMembers).values(members.map((botId, position) => ({ groupId: row.id, botId, position })));
  }, db);
}
