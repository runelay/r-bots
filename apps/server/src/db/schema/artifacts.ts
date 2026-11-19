import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { blobs } from "./files";

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    canvas: text("canvas", { mode: "json" }).$type<{ seen: number; notified: number }>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("artifacts_bot_idx").on(table.botId, table.updatedAt)],
);

export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    author: text("author"),
    size: integer("size").notNull(),
    blobKey: text("blob_key")
      .notNull()
      .references(() => blobs.key),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.n] })],
);
