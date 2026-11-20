import { type Db, getDb, writeTransaction } from "../../../db";
import { extraOf, type Json, present } from "../../../db/rows";
import { codeWorkspaces } from "../../../db/tables";
import type { WorktreeRecord } from "./code.repository";

const known = [
  "id",
  "botId",
  "sessionId",
  "repo",
  "repoName",
  "branch",
  "base",
  "baseCommit",
  "path",
  "pinned",
  "status",
  "prUrl",
  "createdAt",
  "lastAccessedAt",
] as const;

export function worktreeColumns(source: WorktreeRecord | Json) {
  const row = source as Json;
  return {
    id: String(row.id),
    botId: String(row.botId),
    sessionId: (row.sessionId as string | null | undefined) ?? null,
    repo: String(row.repo),
    repoName: String(row.repoName ?? ""),
    branch: String(row.branch ?? ""),
    base: (row.base as string | null | undefined) ?? null,
    baseCommit: (row.baseCommit as string | null | undefined) ?? null,
    path: String(row.path),
    pinned: row.pinned === true,
    status: String(row.status ?? "alive"),
    prUrl: (row.prUrl as string | null | undefined) ?? null,
    extra: extraOf(row, known),
    createdAt: String(row.createdAt),
    lastAccessedAt: (row.lastAccessedAt as string | null | undefined) ?? null,
  };
}

export async function loadWorktreeRows(db: Db = getDb()): Promise<WorktreeRecord[]> {
  return (await db.select().from(codeWorkspaces).orderBy(codeWorkspaces.createdAt, codeWorkspaces.id)).map(
    (row) =>
      ({
        id: row.id,
        path: row.path,
        repo: row.repo,
        repoName: row.repoName,
        branch: row.branch,
        base: row.base ?? "",
        baseCommit: row.baseCommit ?? "",
        botId: row.botId,
        sessionId: row.sessionId ?? "",
        createdAt: row.createdAt,
        lastAccessedAt: row.lastAccessedAt ?? row.createdAt,
        status: row.status,
        pinned: row.pinned,
        ...present({ prUrl: row.prUrl }),
        ...(row.extra ?? {}),
      }) as WorktreeRecord,
  );
}

export async function saveWorktreeRows(list: WorktreeRecord[], db: Db = getDb()) {
  await writeTransaction(async (tx) => {
    for (const record of list) {
      const columns = worktreeColumns(record);
      await tx.insert(codeWorkspaces).values(columns).onConflictDoUpdate({ target: codeWorkspaces.id, set: columns });
    }
  }, db);
}
