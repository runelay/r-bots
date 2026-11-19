import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

type Json = Record<string, unknown>;

export const bots = sqliteTable(
  "bots",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    accent: text("accent").notNull().default(""),
    glyph: text("glyph").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    permission: text("permission"),
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    capabilities: text("capabilities", { mode: "json" }).$type<Json>().notNull().default(sql`'{}'`),
    schedules: text("schedules", { mode: "json" }).$type<Json[]>().notNull().default(sql`'[]'`),
    engine: text("engine", { mode: "json" }).$type<Json>(),
    decisions: text("decisions", { mode: "json" }).$type<Json>(),
    connectors: text("connectors", { mode: "json" }).$type<Json>(),
    memory: text("memory", { mode: "json" }).$type<Json>(),
    computer: text("computer", { mode: "json" }).$type<Json>(),
    voice: text("voice", { mode: "json" }).$type<Json>(),
    sidebar: text("sidebar", { mode: "json" }).$type<Json>(),
    extra: text("extra", { mode: "json" }).$type<Json>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    deletedAt: text("deleted_at"),
  },
  (table) => [index("bots_archived_idx").on(table.archivedAt)],
);

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  extra: text("extra", { mode: "json" }).$type<Json>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
});

export const groupMembers = sqliteTable(
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

export const sections = sqliteTable("sections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  extra: text("extra", { mode: "json" }).$type<Json>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
  archivedAt: text("archived_at"),
});

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    lastMessage: text("last_message", { mode: "json" }).$type<Json>(),
    unread: integer("unread").notNull().default(0),
    readAt: text("read_at"),
    archivedAt: text("archived_at"),
  },
  (table) => [
    uniqueIndex("threads_live_owner_idx").on(table.ownerId).where(sql`archived_at is null`),
    index("threads_owner_idx").on(table.ownerId, table.archivedAt),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});
