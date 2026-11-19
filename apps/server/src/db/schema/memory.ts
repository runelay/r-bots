import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const teamMemory = sqliteTable(
  "team_memory",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    botId: text("bot_id").notNull(),
    botName: text("bot_name").notNull().default(""),
    summary: text("summary").notNull(),
    extra: text("extra", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [index("team_memory_at_idx").on(table.at), index("team_memory_bot_idx").on(table.botId, table.at)],
);
