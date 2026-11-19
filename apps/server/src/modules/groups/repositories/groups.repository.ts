import { asc, eq } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { extraOf, type Json } from "../../../db/rows";
import { groupMembers, groups } from "../../../db/tables";
import type { Group } from "../services/groups.service";

const known = ["id", "name", "members", "createdAt", "updatedAt", "archivedAt"] as const;

export function loadGroupRows(db: Db = getDb()): Group[] {
  const members = new Map<string, string[]>();
  for (const row of db.select().from(groupMembers).orderBy(asc(groupMembers.position)).all()) {
    const list = members.get(row.groupId) ?? [];
    list.push(row.botId);
    members.set(row.groupId, list);
  }
  return db
    .select()
    .from(groups)
    .orderBy(asc(groups.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      members: members.get(row.id) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      ...(row.extra ?? {}),
    }));
}

export function saveGroupRow(source: Group | Json, db: Db = getDb()) {
  const group = source as Json;
  const row = {
    id: String(group.id),
    name: String(group.name ?? ""),
    extra: extraOf(group, known),
    createdAt: String(group.createdAt),
    updatedAt: String(group.updatedAt ?? group.createdAt),
    archivedAt: (group.archivedAt as string | null | undefined) ?? null,
  };
  db.$client
    .transaction(() => {
      db.insert(groups).values(row).onConflictDoUpdate({ target: groups.id, set: row }).run();
      db.delete(groupMembers).where(eq(groupMembers.groupId, row.id)).run();
      const members = [...new Set((group.members as string[] | undefined) ?? [])];
      members.forEach((botId, position) => {
        db.insert(groupMembers).values({ groupId: row.id, botId, position }).run();
      });
    })
    .immediate();
}
