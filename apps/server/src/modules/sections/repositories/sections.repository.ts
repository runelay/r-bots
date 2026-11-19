import { asc } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { extraOf, type Json, present } from "../../../db/rows";
import { sections } from "../../../db/tables";
import type { Section } from "../services/sections.service";

const known = ["id", "name", "order", "createdAt", "updatedAt", "archivedAt"] as const;

export function loadSectionRows(db: Db = getDb()): Section[] {
  return db
    .select()
    .from(sections)
    .orderBy(asc(sections.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      order: row.position,
      createdAt: row.createdAt,
      archivedAt: row.archivedAt,
      ...present({ updatedAt: row.updatedAt }),
      ...(row.extra ?? {}),
    }));
}

export function saveSectionRow(source: Section | Json, db: Db = getDb()) {
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
  db.insert(sections).values(row).onConflictDoUpdate({ target: sections.id, set: row }).run();
}
