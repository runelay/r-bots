import { bigint, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { blobs } from "./files";
import { jsonb, timestamptz } from "./types";

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    canvas: jsonb<{ seen: number; notified: number }>("canvas"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [index("artifacts_bot_idx").on(table.botId, table.updatedAt)],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    author: text("author"),
    size: bigint("size", { mode: "number" }).notNull(),
    blobKey: text("blob_key")
      .notNull()
      .references(() => blobs.key),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.n] })],
);
