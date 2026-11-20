import { asc } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { extraOf, type Json, present } from "../../../db/rows";
import { sections } from "../../../db/tables";
import type { Section } from "../services/sections.service";

const known = ["id", "name", "order", "createdAt", "updatedAt", "archivedAt"] as const;

export async function loadSectionRows(db: Db = getDb()): Promise<Section[]> {
  const rows = await db.select().from(sections).orderBy(asc(sections.createdAt), asc(sections.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    order: row.position,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
    ...present({ updatedAt: row.updatedAt }),
    ...(row.extra ?? {}),
  }));
}

export async function saveSectionRow(source: Section | Json, db: Db = getDb()) {
  const section = source as Json;
  const row = {
    id: String(section.id),
    name: String(section.name ?? ""),
    position: Number(section.order ?? 0),
    extra: extraOf(section, known),
    createdAt: String(section.createdAt),
    updatedAt: (section.updatedAt as string | undefined) ?? null,
    archivedAt: (section.archivedAt as string | null | undefined) ?? null,
  };
  await db.insert(sections).values(row).onConflictDoUpdate({ target: sections.id, set: row });
}
