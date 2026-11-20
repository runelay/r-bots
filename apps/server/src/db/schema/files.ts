import { bigint, doublePrecision, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "./types";

export const blobs = pgTable(
  "blobs",
  {
    key: text("key").primaryKey(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    botId: text("bot_id"),
    sessionId: text("session_id"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [index("blobs_bot_idx").on(table.botId), index("blobs_session_idx").on(table.sessionId)],
);

export const uploads = pgTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    sessionId: text("session_id"),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    blobKey: text("blob_key")
      .notNull()
      .references(() => blobs.key),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    duration: doublePrecision("duration"),
    waveform: jsonb<number[]>("waveform"),
    thumbKey: text("thumb_key"),
    derived: jsonb<Record<string, string>>("derived"),
    transcript: text("transcript"),
    transcriptSource: text("transcript_source"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    index("uploads_bot_idx").on(table.botId, table.createdAt),
    index("uploads_session_idx").on(table.sessionId),
  ],
);

export const exports = pgTable(
  "exports",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    format: text("format").notNull(),
    status: text("status").notNull(),
    blobKey: text("blob_key").references(() => blobs.key),
    error: text("error"),
    botId: text("bot_id"),
    tabId: text("tab_id"),
    fileName: text("file_name"),
    size: bigint("size", { mode: "number" }),
    createdAt: timestamptz("created_at").notNull(),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [index("exports_source_idx").on(table.sourceType, table.sourceId)],
);
