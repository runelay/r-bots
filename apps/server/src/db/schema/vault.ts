import { bigint, customType, index, pgTable, text } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "./types";

const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => Buffer.from(value),
});

export const vaultSecrets = pgTable("vault_secrets", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  kind: text("kind").notNull(),
  storage: text("storage").notNull(),
  touchId: text("touch_id").notNull(),
  domains: jsonb<string[]>("domains").notNull(),
  bots: jsonb<string[]>("bots").notNull(),
  iv: bytea("iv"),
  tag: bytea("tag"),
  ciphertext: bytea("ciphertext"),
  expiresAt: timestamptz("expires_at"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull(),
  rotatedAt: timestamptz("rotated_at"),
  lastUsedAt: timestamptz("last_used_at"),
  lastUsedBy: text("last_used_by"),
  lastTool: text("last_tool"),
});

export const vaultAudit = pgTable(
  "vault_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    at: timestamptz("at").notNull(),
    name: text("name").notNull(),
    outcome: text("outcome").notNull(),
    by: text("by"),
    extra: jsonb<Record<string, unknown>>("extra"),
  },
  (table) => [index("vault_audit_name_idx").on(table.name, table.at)],
);
