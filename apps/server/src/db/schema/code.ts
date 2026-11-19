import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const codeWorkspaces = sqliteTable(
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
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull(),
    prUrl: text("pr_url"),
    extra: text("extra", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    lastAccessedAt: text("last_accessed_at"),
  },
  (table) => [
    index("code_workspaces_bot_idx").on(table.botId),
    index("code_workspaces_session_idx").on(table.sessionId),
  ],
);

export const codeRepos = sqliteTable("code_repos", {
  path: text("path").primaryKey(),
  name: text("name").notNull(),
  reason: text("reason"),
  addedBy: text("added_by"),
  addedAt: text("added_at").notNull(),
});
