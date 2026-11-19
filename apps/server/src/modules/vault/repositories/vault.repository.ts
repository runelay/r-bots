import { and, desc, eq, notInArray } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { extraOf, type Json } from "../../../db/rows";
import { vaultAudit, vaultSecrets } from "../../../db/tables";
import type { SecretMeta } from "../services/vault.service";

export interface Sealed {
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

type SecretRow = typeof vaultSecrets.$inferSelect;

export function secretColumns(source: SecretMeta | Json) {
  const meta = source as Json;
  return {
    name: String(meta.name),
    description: String(meta.description ?? ""),
    kind: String(meta.kind ?? "password"),
    storage: String(meta.storage ?? "mac"),
    touchId: String(meta.touchId ?? "always"),
    domains: (meta.domains as string[] | undefined) ?? [],
    bots: (meta.bots as string[] | undefined) ?? [],
    expiresAt: (meta.expiresAt as string | null | undefined) ?? null,
    createdAt: String(meta.createdAt),
    updatedAt: String(meta.updatedAt ?? meta.createdAt),
    rotatedAt: (meta.rotatedAt as string | null | undefined) ?? null,
    lastUsedAt: (meta.lastUsedAt as string | null | undefined) ?? null,
    lastUsedBy: (meta.lastUsedBy as string | null | undefined) ?? null,
    lastTool: (meta.lastTool as string | null | undefined) ?? null,
  };
}

function metaOf(row: SecretRow): SecretMeta {
  return {
    name: row.name,
    description: row.description,
    domains: row.domains,
    bots: row.bots,
    touchId: row.touchId as SecretMeta["touchId"],
    expiresAt: row.expiresAt,
    storage: row.storage as SecretMeta["storage"],
    kind: row.kind as SecretMeta["kind"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rotatedAt: row.rotatedAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedBy: row.lastUsedBy,
    lastTool: row.lastTool,
  };
}

export function loadSecretMetas(db: Db = getDb()) {
  const index: Record<string, SecretMeta> = {};
  for (const row of db.select().from(vaultSecrets).all()) index[row.name] = metaOf(row);
  return index;
}

export function saveSecretMetas(index: Record<string, SecretMeta>, db: Db = getDb()) {
  const names = Object.keys(index);
  db.$client
    .transaction(() => {
      for (const meta of Object.values(index)) {
        const columns = secretColumns(meta);
        db.insert(vaultSecrets).values(columns).onConflictDoUpdate({ target: vaultSecrets.name, set: columns }).run();
      }
      if (names.length) db.delete(vaultSecrets).where(notInArray(vaultSecrets.name, names)).run();
      else db.delete(vaultSecrets).run();
    })
    .immediate();
}

export function writeSealed(name: string, sealed: Sealed | null, db: Db = getDb()) {
  db.update(vaultSecrets)
    .set({ iv: sealed?.iv ?? null, tag: sealed?.tag ?? null, ciphertext: sealed?.ct ?? null })
    .where(eq(vaultSecrets.name, name))
    .run();
}

export function readSealed(name: string, db: Db = getDb()): Sealed | null {
  const row = db
    .select({ iv: vaultSecrets.iv, tag: vaultSecrets.tag, ct: vaultSecrets.ciphertext })
    .from(vaultSecrets)
    .where(eq(vaultSecrets.name, name))
    .get();
  if (!row?.iv || !row.tag || !row.ct) return null;
  return { iv: Buffer.from(row.iv), tag: Buffer.from(row.tag), ct: Buffer.from(row.ct) };
}

export function auditColumns(entry: Json) {
  return {
    at: String(entry.at),
    name: String(entry.name ?? ""),
    outcome: String(entry.outcome ?? ""),
    by: (entry.by as string | undefined) ?? null,
    extra: extraOf(entry, ["at", "name", "outcome", "by"]),
  };
}

export function addAudit(entry: Json, db: Db = getDb()) {
  db.insert(vaultAudit).values(auditColumns(entry)).run();
}

export function readAuditRows(name: string | null, limit: number, db: Db = getDb()) {
  return db
    .select()
    .from(vaultAudit)
    .where(name ? and(eq(vaultAudit.name, name)) : undefined)
    .orderBy(desc(vaultAudit.id))
    .limit(limit)
    .all()
    .map((row) => ({
      at: row.at,
      name: row.name,
      outcome: row.outcome,
      ...(row.by === null ? {} : { by: row.by }),
      ...(row.extra ?? {}),
    }));
}
