import { bigint, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { json, jsonb, timestamptz } from "./types";

type Json = Record<string, unknown>;

export const conversations = pgTable(
  "conversations",
  {
    sessionId: text("session_id").primaryKey(),
    botId: text("bot_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull().default(""),
    source: text("source").notNull(),
    scheduleId: text("schedule_id"),
    startedAt: timestamptz("started_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
    unread: integer("unread").notNull().default(0),
    readAt: timestamptz("read_at"),
    lastMessage: jsonb<Json>("last_message"),
    turnCount: integer("turn_count").notNull().default(0),
    runCount: integer("run_count").notNull().default(0),
    lastSeq: integer("last_seq").notNull().default(0),
    meta: jsonb<Json>("meta").notNull(),
  },
  (table) => [
    index("conversations_bot_idx").on(table.botId, table.updatedAt),
    index("conversations_kind_idx").on(table.kind, table.archivedAt),
  ],
);

export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    sessionId: text("session_id")
      .notNull()
      .references(() => conversations.sessionId, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamptz("at"),
    types: text("types").notNull().default(""),
    role: text("role"),
    text: text("text"),
    facts: json<unknown[]>("facts").notNull(),
  },
  (table) => [uniqueIndex("conversation_events_session_seq_idx").on(table.sessionId, table.seq)],
);
