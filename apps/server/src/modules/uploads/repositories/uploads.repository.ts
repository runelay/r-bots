import { and, desc, eq, sql } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import { present } from "../../../db/rows";
import { codeWorkspaces, uploads } from "../../../db/tables";
import type { UploadKind, UploadMeta } from "../services/uploads.service";

type UploadRow = typeof uploads.$inferSelect;

export interface UploadRefs {
  blobKey: string;
  sha256: string;
  thumbKey: string | null;
  derived?: Record<string, string> | null;
  sessionId?: string | null;
}

export function uploadFromRow(row: UploadRow): UploadMeta {
  return {
    uploadId: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    kind: row.kind as UploadKind,
    file: `${row.id}-${row.name}`,
    createdAt: row.createdAt,
    source: row.source === "bot" ? "bot" : "user",
    ...present({
      width: row.width,
      height: row.height,
      duration: row.duration,
      waveform: row.waveform,
      transcript: row.transcript,
      transcriptSource: row.transcriptSource as UploadMeta["transcriptSource"] | null,
    }),
    ...(row.thumbKey ? { thumb: true } : {}),
  };
}

function metaColumns(meta: UploadMeta) {
  return {
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    kind: meta.kind,
    source: meta.source,
    width: meta.width ?? null,
    height: meta.height ?? null,
    duration: meta.duration ?? null,
    waveform: meta.waveform ?? null,
    transcript: meta.transcript ?? null,
    transcriptSource: meta.transcriptSource ?? null,
    createdAt: meta.createdAt,
  };
}

export async function saveUploadRow(botId: string, meta: UploadMeta, refs: UploadRefs, db: Db = getDb()) {
  const row = {
    id: meta.uploadId,
    botId,
    sessionId: refs.sessionId ?? null,
    blobKey: refs.blobKey,
    sha256: refs.sha256,
    thumbKey: refs.thumbKey,
    derived: refs.derived ?? null,
    ...metaColumns(meta),
  };
  await db.insert(uploads).values(row).onConflictDoUpdate({ target: uploads.id, set: row });
}

export async function updateUploadMeta(botId: string, meta: UploadMeta, db: Db = getDb()) {
  await db
    .update(uploads)
    .set(metaColumns(meta))
    .where(and(eq(uploads.id, meta.uploadId), eq(uploads.botId, botId)));
}

export async function readUploadRow(botId: string, uploadId: string, db: Db = getDb()) {
  const [row] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.botId, botId)))
    .limit(1);
  return row ?? null;
}

export async function listUploadRows(botId: string, db: Db = getDb()) {
  return db.select().from(uploads).where(eq(uploads.botId, botId)).orderBy(desc(uploads.createdAt), desc(uploads.id));
}

export async function uploadBytesOf(botId: string, db: Db = getDb()) {
  const [row] = await db
    .select({ total: sql<string | number | null>`coalesce(sum(${uploads.size}), 0)` })
    .from(uploads)
    .where(eq(uploads.botId, botId));
  return Number(row?.total ?? 0);
}

export async function botWorktreePaths(botId: string, db: Db = getDb()) {
  const rows = await db
    .select({ path: codeWorkspaces.path })
    .from(codeWorkspaces)
    .where(and(eq(codeWorkspaces.botId, botId), eq(codeWorkspaces.status, "alive")));
  return rows.map((row) => row.path);
}
