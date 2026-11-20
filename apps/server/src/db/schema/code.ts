import { boolean, index, pgTable, text } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "./types";

export const codeWorkspaces = pgTable(
  "code_workspaces",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    sessionId: text("session_id"),
    repo: text("repo").notNull(),
    repoName: text("repo_name").notNull(),
    branch: text("branch").notNull(),
    base: text("base"),
    baseCommit: text("base_commit"),
    path: text("path").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    status: text("status").notNull(),
    prUrl: text("pr_url"),
    extra: jsonb<Record<string, unknown>>("extra"),
    createdAt: timestamptz("created_at").notNull(),
    lastAccessedAt: timestamptz("last_accessed_at"),
  },
  (table) => [
    index("code_workspaces_bot_idx").on(table.botId),
    index("code_workspaces_session_idx").on(table.sessionId),
  ],
);

export const codeRepos = pgTable("code_repos", {
  path: text("path").primaryKey(),
  name: text("name").notNull(),
  reason: text("reason"),
  addedBy: text("added_by"),
  addedAt: timestamptz("added_at").notNull(),
});
