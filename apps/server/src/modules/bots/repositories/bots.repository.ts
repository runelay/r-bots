import { eq } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { extraOf, type Json, present } from "../../../db/rows";
import { bots } from "../../../db/tables";
import type { BotDefinition } from "../services/bots.service";

const known = [
  "id",
  "name",
  "role",
  "accent",
  "glyph",
  "instructions",
  "permission",
  "builtIn",
  "capabilities",
  "schedules",
  "engine",
  "decisions",
  "connectors",
  "memory",
  "computer",
  "voice",
  "sidebar",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "deletedAt",
] as const;

type BotRow = typeof bots.$inferSelect;

export function botToRow(source: Json): BotRow {
  const bot = source as Partial<BotDefinition> & Json;
  const epoch = new Date(0).toISOString();
  return {
    id: String(bot.id),
    name: String(bot.name ?? bot.id),
    role: String(bot.role ?? ""),
    accent: String(bot.accent ?? ""),
    glyph: String(bot.glyph ?? ""),
    instructions: String(bot.instructions ?? ""),
    permission: (bot.permission as string | undefined) ?? null,
    builtIn: bot.builtIn === true,
    capabilities: (bot.capabilities as Json | undefined) ?? {},
    schedules: (bot.schedules as Json[] | undefined) ?? [],
    engine: (bot.engine as Json | undefined) ?? null,
    decisions: (bot.decisions as Json | undefined) ?? null,
    connectors: (bot.connectors as Json | undefined) ?? null,
    memory: (bot.memory as Json | undefined) ?? null,
    computer: (bot.computer as Json | undefined) ?? null,
    voice: (bot.voice as Json | undefined) ?? null,
    sidebar: (bot.sidebar as Json | undefined) ?? null,
    extra: extraOf(bot, known),
    createdAt: String(bot.createdAt ?? epoch),
    updatedAt: String(bot.updatedAt ?? bot.createdAt ?? epoch),
    archivedAt: (bot.archivedAt as string | null | undefined) ?? null,
    deletedAt: (bot.deletedAt as string | null | undefined) ?? null,
  };
}

export function botFromRow(row: BotRow): BotDefinition {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    accent: row.accent,
    glyph: row.glyph,
    instructions: row.instructions,
    capabilities: row.capabilities,
    schedules: row.schedules,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    ...(row.builtIn ? { builtIn: true } : {}),
    ...present({
      deletedAt: row.deletedAt,
      engine: row.engine,
      decisions: row.decisions,
      connectors: row.connectors,
      memory: row.memory,
      computer: row.computer,
      voice: row.voice,
      sidebar: row.sidebar,
      permission: row.permission,
    }),
    ...(row.extra ?? {}),
  } as unknown as BotDefinition;
}

export function loadBotRows(db: Db = getDb()) {
  return db.select().from(bots).all().map(botFromRow);
}

export function saveBotRow(bot: BotDefinition | Json, db: Db = getDb()) {
  const row = botToRow(bot as Json);
  db.insert(bots).values(row).onConflictDoUpdate({ target: bots.id, set: row }).run();
}

export function deleteBotRow(id: string, db: Db = getDb()) {
  db.delete(bots).where(eq(bots.id, id)).run();
}
