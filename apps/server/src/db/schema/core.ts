import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "./types";

type Json = Record<string, unknown>;

export const bots = pgTable(
  "bots",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    accent: text("accent").notNull().default(""),
    glyph: text("glyph").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    permission: text("permission"),
    builtIn: boolean("built_in").notNull().default(false),
    capabilities: jsonb<Json>("capabilities").notNull().default(sql`'{}'`),
    schedules: jsonb<Json[]>("schedules").notNull().default(sql`'[]'`),
    engine: jsonb<Json>("engine"),
    decisions: jsonb<Json>("decisions"),
    connectors: jsonb<Json>("connectors"),
    memory: jsonb<Json>("memory"),
    computer: jsonb<Json>("computer"),
    voice: jsonb<Json>("voice"),
    sidebar: jsonb<Json>("sidebar"),
    extra: jsonb<Json>("extra"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [index("bots_archived_idx").on(table.archivedAt)],
);

export const groups = pgTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  extra: jsonb<Json>("extra"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull(),
  archivedAt: timestamptz("archived_at"),
});

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.botId] }), index("group_members_bot_idx").on(table.botId)],
);

export const sections = pgTable("sections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  extra: jsonb<Json>("extra"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at"),
  archivedAt: timestamptz("archived_at"),
});

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    lastMessage: jsonb<Json>("last_message"),
    unread: integer("unread").notNull().default(0),
    readAt: timestamptz("read_at"),
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    uniqueIndex("threads_live_owner_idx").on(table.ownerId).where(sql`archived_at is null`),
    index("threads_owner_idx").on(table.ownerId, table.archivedAt),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb<unknown>("value").notNull(),
  updatedAt: timestamptz("updated_at").notNull(),
});
