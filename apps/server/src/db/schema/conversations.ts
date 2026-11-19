import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

type Json = Record<string, unknown>;

export const conversations = sqliteTable(
  "conversations",
  {
    sessionId: text("session_id").primaryKey(),
    botId: text("bot_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull().default(""),
    source: text("source").notNull(),
    scheduleId: text("schedule_id"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    unread: integer("unread").notNull().default(0),
    readAt: text("read_at"),
    lastMessage: text("last_message", { mode: "json" }).$type<Json>(),
    turnCount: integer("turn_count").notNull().default(0),
    runCount: integer("run_count").notNull().default(0),
    lastSeq: integer("last_seq").notNull().default(0),
    meta: text("meta", { mode: "json" }).$type<Json>().notNull(),
  },
  (table) => [
    index("conversations_bot_idx").on(table.botId, table.updatedAt),
    index("conversations_kind_idx").on(table.kind, table.archivedAt),
  ],
);

export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => conversations.sessionId, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    types: text("types").notNull().default(""),
    role: text("role"),
    text: text("text"),
    facts: text("facts", { mode: "json" }).$type<unknown[]>().notNull(),
  },
  (table) => [uniqueIndex("conversation_events_session_seq_idx").on(table.sessionId, table.seq)],
);
