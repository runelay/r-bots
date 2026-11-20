import { and, eq, isNull } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
import type { Json } from "../../../db/rows";
import { threads } from "../../../db/tables";
import type { ThreadState } from "../services/threads.service";

type ThreadRow = typeof threads.$inferSelect;

function stateOf(row: ThreadRow): ThreadState {
  return {
    sessionId: row.sessionId,
    lastMessage: (row.lastMessage as ThreadState["lastMessage"]) ?? null,
    unread: row.unread,
    readAt: row.readAt,
  };
}

function rowOf(id: string, ownerId: string, state: ThreadState | Json, archivedAt: string | null): ThreadRow {
  const value = state as Json;
  return {
    id,
    ownerId,
    sessionId: String(value.sessionId),
    lastMessage: (value.lastMessage as Json | null | undefined) ?? null,
    unread: Number(value.unread ?? 0),
    readAt: (value.readAt as string | null | undefined) ?? null,
    archivedAt,
  };
}

export async function readLiveThread(ownerId: string, db: Db = getDb()) {
  const [row] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.ownerId, ownerId), isNull(threads.archivedAt)))
    .limit(1);
  return row ? stateOf(row) : null;
}

export async function saveLiveThread(ownerId: string, state: ThreadState | Json, db: Db = getDb()) {
  const row = rowOf(ownerId, ownerId, state, null);
  await db.insert(threads).values(row).onConflictDoUpdate({ target: threads.id, set: row });
}

export async function saveArchivedThread(
  ownerId: string,
  archiveId: string,
  archivedAt: string,
  state: ThreadState | Json,
  db: Db = getDb(),
) {
  const row = rowOf(archiveId, ownerId, state, archivedAt);
  await db.insert(threads).values(row).onConflictDoUpdate({ target: threads.id, set: row });
}

export async function readArchivedThread(ownerId: string, archiveId: string, db: Db = getDb()) {
  const [row] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, archiveId), eq(threads.ownerId, ownerId)))
    .limit(1);
  if (!row?.archivedAt) return null;
  return { archiveId: row.id, archivedAt: row.archivedAt, state: stateOf(row) };
}

export async function deleteThreadRow(id: string, db: Db = getDb()) {
  await db.delete(threads).where(eq(threads.id, id));
}
