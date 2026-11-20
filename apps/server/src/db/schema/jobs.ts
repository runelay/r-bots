import { sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "./types";

export const jobOutbox = pgTable(
  "job_outbox",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payload: jsonb<unknown>("payload").notNull(),
    createdAt: timestamptz("created_at").notNull().default(sql`now()`),
    dispatchedAt: timestamptz("dispatched_at"),
  },
  (table) => [index("job_outbox_pending_idx").on(table.createdAt).where(sql`${table.dispatchedAt} is null`)],
);
