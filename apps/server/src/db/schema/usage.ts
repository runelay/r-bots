import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { jsonb } from "./types";

export const usageBuckets = pgTable(
  "usage_buckets",
  {
    hour: bigint("hour", { mode: "number" }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    tier: text("tier").notNull(),
    counters: jsonb<number[]>("counters").notNull(),
  },
  (table) => [primaryKey({ columns: [table.hour, table.provider, table.model, table.tier] })],
);

export const usageSessions = pgTable(
  "usage_sessions",
  {
    key: text("key").primaryKey(),
    hour: bigint("hour", { mode: "number" }).notNull(),
    model: text("model").notNull(),
  },
  (table) => [index("usage_sessions_hour_idx").on(table.hour)],
);

export const usageCursors = pgTable("usage_cursors", {
  path: text("path").primaryKey(),
  state: jsonb<Record<string, unknown>>("state").notNull(),
});

export const usageSeen = pgTable(
  "usage_seen",
  {
    key: text("key").primaryKey(),
    hour: bigint("hour", { mode: "number" }).notNull(),
  },
  (table) => [index("usage_seen_hour_idx").on(table.hour)],
);
