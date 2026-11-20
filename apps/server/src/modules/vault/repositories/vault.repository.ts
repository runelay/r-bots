import { createHash } from "node:crypto";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import { type Db, getDb, writeTransaction } from "../../../db";
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

export async function loadSecretMetas(db: Db = getDb()) {
  const index: Record<string, SecretMeta> = {};
  for (const row of await db.select().from(vaultSecrets).orderBy(vaultSecrets.name)) index[row.name] = metaOf(row);
  return index;
}

export async function saveSecretMetas(index: Record<string, SecretMeta>, db: Db = getDb()) {
  const names = Object.keys(index);
  await writeTransaction(async (tx) => {
    for (const meta of Object.values(index)) {
      const columns = secretColumns(meta);
      await tx.insert(vaultSecrets).values(columns).onConflictDoUpdate({ target: vaultSecrets.name, set: columns });
    }
    if (names.length) await tx.delete(vaultSecrets).where(notInArray(vaultSecrets.name, names));
    else await tx.delete(vaultSecrets);
  }, db);
}

export async function writeSealed(name: string, sealed: Sealed | null, db: Db = getDb()) {
  await db
    .update(vaultSecrets)
    .set({ iv: sealed?.iv ?? null, tag: sealed?.tag ?? null, ciphertext: sealed?.ct ?? null })
    .where(eq(vaultSecrets.name, name));
}

export async function writeSealedMany(entries: { name: string; sealed: Sealed }[], db: Db = getDb()) {
  await writeTransaction(async (tx) => {
    for (const entry of entries) await writeSealed(entry.name, entry.sealed, tx);
  }, db);
}

export async function readSealed(name: string, db: Db = getDb()): Promise<Sealed | null> {
  const [row] = await db
    .select({ iv: vaultSecrets.iv, tag: vaultSecrets.tag, ct: vaultSecrets.ciphertext })
    .from(vaultSecrets)
    .where(eq(vaultSecrets.name, name))
    .limit(1);
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

export const auditGenesis = "0".repeat(64);

function auditHash(prevHash: string, columns: ReturnType<typeof auditColumns>) {
  const { hash: _hash, prevHash: _prev, ...extra } = (columns.extra ?? {}) as Json;
  const canonical = JSON.stringify([
    new Date(columns.at).toISOString(),
    columns.name,
    columns.outcome,
    columns.by,
    extra,
  ]);
  return createHash("sha256").update(`${prevHash}\n${canonical}`).digest("hex");
}

export async function addAudit(entry: Json, db: Db = getDb()) {
  await writeTransaction(async (tx) => {
    const [last] = await tx.select({ extra: vaultAudit.extra }).from(vaultAudit).orderBy(desc(vaultAudit.id)).limit(1);
    const prevHash = typeof last?.extra?.hash === "string" ? (last.extra.hash as string) : auditGenesis;
    const columns = auditColumns(entry);
    const hash = auditHash(prevHash, columns);
    await tx.insert(vaultAudit).values({ ...columns, extra: { ...(columns.extra ?? {}), prevHash, hash } });
  }, db);
}

export async function verifyAuditChain(db: Db = getDb()) {
  const rows = await db.select().from(vaultAudit).orderBy(asc(vaultAudit.id));
  let prevHash: string | null = null;
  for (const row of rows) {
    const extra = (row.extra ?? {}) as Json;
    if (typeof extra.hash !== "string") continue;
    const expectedPrev = prevHash ?? (extra.prevHash as string);
    const columns = { at: row.at, name: row.name, outcome: row.outcome, by: row.by, extra };
    if (extra.prevHash !== expectedPrev || auditHash(expectedPrev, columns) !== extra.hash)
      return { ok: false, brokenAt: row.id };
    prevHash = extra.hash;
  }
  return { ok: true, brokenAt: null };
}

export async function readAuditRows(name: string | null, limit: number, db: Db = getDb()) {
  const rows = await db
    .select()
    .from(vaultAudit)
    .where(name ? and(eq(vaultAudit.name, name)) : undefined)
    .orderBy(desc(vaultAudit.id))
    .limit(limit);
  return rows.map((row) => ({
    at: row.at,
    name: row.name,
    outcome: row.outcome,
    ...(row.by === null ? {} : { by: row.by }),
    ...(row.extra ?? {}),
  }));
}
