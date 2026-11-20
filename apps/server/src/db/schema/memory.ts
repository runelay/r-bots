import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "./types";

export const teamMemory = pgTable(
  "team_memory",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    at: timestamptz("at").notNull(),
    botId: text("bot_id").notNull(),
    botName: text("bot_name").notNull().default(""),
    summary: text("summary").notNull(),
    extra: jsonb<Record<string, unknown>>("extra"),
  },
  (table) => [index("team_memory_at_idx").on(table.at), index("team_memory_bot_idx").on(table.botId, table.at)],
);
