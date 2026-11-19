import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const vaultSecrets = sqliteTable("vault_secrets", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  kind: text("kind").notNull(),
  storage: text("storage").notNull(),
  touchId: text("touch_id").notNull(),
  domains: text("domains", { mode: "json" }).$type<string[]>().notNull(),
  bots: text("bots", { mode: "json" }).$type<string[]>().notNull(),
  iv: blob("iv", { mode: "buffer" }),
  tag: blob("tag", { mode: "buffer" }),
  ciphertext: blob("ciphertext", { mode: "buffer" }),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  rotatedAt: text("rotated_at"),
  lastUsedAt: text("last_used_at"),
  lastUsedBy: text("last_used_by"),
  lastTool: text("last_tool"),
});

export const vaultAudit = sqliteTable(
  "vault_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    name: text("name").notNull(),
    outcome: text("outcome").notNull(),
    by: text("by"),
    extra: text("extra", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [index("vault_audit_name_idx").on(table.name, table.at)],
);
