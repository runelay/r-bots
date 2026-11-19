import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const usageBuckets = sqliteTable(
  "usage_buckets",
  {
    hour: integer("hour").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    tier: text("tier").notNull(),
    counters: text("counters", { mode: "json" }).$type<number[]>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.hour, table.provider, table.model, table.tier] })],
);

export const usageSessions = sqliteTable(
  "usage_sessions",
  {
    key: text("key").primaryKey(),
    hour: integer("hour").notNull(),
    model: text("model").notNull(),
  },
  (table) => [index("usage_sessions_hour_idx").on(table.hour)],
);

export const usageCursors = sqliteTable("usage_cursors", {
  path: text("path").primaryKey(),
  state: text("state", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

export const usageSeen = sqliteTable(
  "usage_seen",
  {
    key: text("key").primaryKey(),
    hour: integer("hour").notNull(),
  },
  (table) => [index("usage_seen_hour_idx").on(table.hour)],
);
