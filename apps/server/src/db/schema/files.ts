import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const blobs = sqliteTable(
  "blobs",
  {
    key: text("key").primaryKey(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    botId: text("bot_id"),
    sessionId: text("session_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("blobs_bot_idx").on(table.botId), index("blobs_session_idx").on(table.sessionId)],
);

export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    sessionId: text("session_id"),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    blobKey: text("blob_key")
      .notNull()
      .references(() => blobs.key),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    duration: real("duration"),
    waveform: text("waveform", { mode: "json" }).$type<number[]>(),
    thumbKey: text("thumb_key"),
    derived: text("derived", { mode: "json" }).$type<Record<string, string>>(),
    transcript: text("transcript"),
    transcriptSource: text("transcript_source"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("uploads_bot_idx").on(table.botId, table.createdAt),
    index("uploads_session_idx").on(table.sessionId),
  ],
);

export const exports = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    format: text("format").notNull(),
    status: text("status").notNull(),
    blobKey: text("blob_key").references(() => blobs.key),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [index("exports_source_idx").on(table.sourceType, table.sourceId)],
);
