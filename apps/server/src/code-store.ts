import { stat } from "node:fs/promises";
import { join } from "node:path";
import { codeDataDir, git, type WorkspaceState } from "./code";
import { readJson, writeJson } from "./json-file";

export interface Grant {
  key: string;
  createdAt: string;
  uses: number;
  lastUsedAt: string | null;
}

export interface WorktreeRecord {
  id: string;
  path: string;
  repo: string;
  repoName: string;
  branch: string;
  base: string;
  baseCommit: string;
  botId: string;
  sessionId: string;
  createdAt: string;
  lastAccessedAt: string;
  status: "alive" | "closed" | "delivered" | "stale" | "removed";
  pinned: boolean;
  prUrl?: string | null;
}

const grantsFile = join(codeDataDir, "grants.json");
const registryFile = join(codeDataDir, "worktrees.json");
const ttlDays = Number(process.env.CODE_WORKTREE_TTL_DAYS ?? 14);

let grants: Record<string, Grant[]> | null = null;
let registry: WorktreeRecord[] | null = null;
let writes: Promise<unknown> = Promise.resolve();

async function loadGrants() {
  if (!grants) grants = await readJson<Record<string, Grant[]>>(grantsFile, {});
  return grants;
}

async function loadRegistry() {
  if (!registry) registry = await readJson<WorktreeRecord[]>(registryFile, []);
  return registry;
}

function persist(file: string, value: unknown) {
  writes = writes.then(() => writeJson(file, value)).catch((error) => console.warn("code store write failed", error));
  return writes;
}

export async function hasGrant(repo: string, key: string) {
  const list = (await loadGrants())[repo] ?? [];
  const grant = list.find((item) => item.key === key);
  if (!grant) return false;
  grant.uses++;
  grant.lastUsedAt = new Date().toISOString();
  void persist(grantsFile, grants);
  return true;
}

export async function addGrant(repo: string, key: string) {
  const all = await loadGrants();
  const list = all[repo] ?? [];
  if (!list.some((item) => item.key === key)) list.push({ key, createdAt: new Date().toISOString(), uses: 0, lastUsedAt: null });
  all[repo] = list;
  await persist(grantsFile, all);
}

export async function listGrants() {
  const all = await loadGrants();
  return Object.entries(all).flatMap(([repo, list]) => list.map((grant) => ({ repo, ...grant })));
}

export async function removeGrant(repo: string, key: string) {
  const all = await loadGrants();
  const before = all[repo]?.length ?? 0;
  all[repo] = (all[repo] ?? []).filter((item) => item.key !== key);
  if (all[repo].length === 0) delete all[repo];
  await persist(grantsFile, all);
  return before !== (all[repo]?.length ?? 0);
}

export async function recordWorktree(workspace: WorkspaceState, botId: string, sessionId: string, status: WorktreeRecord["status"] = "alive") {
  const list = await loadRegistry();
  const now = new Date().toISOString();
  const current = list.find((item) => item.id === workspace.id);
  if (current) {
    current.status = status;
    current.lastAccessedAt = now;
  } else {
    list.push({
      id: workspace.id,
      path: workspace.path,
      repo: workspace.repo,
      repoName: workspace.repoName,
      branch: workspace.branch,
      base: workspace.base,
      baseCommit: workspace.baseCommit,
      botId,
      sessionId,
      createdAt: now,
      lastAccessedAt: now,
      status,
      pinned: false,
    });
  }
  await persist(registryFile, list);
}

export async function touchWorktree(id: string, patch: Partial<WorktreeRecord> = {}) {
  const list = await loadRegistry();
  const current = list.find((item) => item.id === id);
  if (!current) return null;
  Object.assign(current, patch, { lastAccessedAt: new Date().toISOString() });
  await persist(registryFile, list);
  return current;
}

export async function listWorktrees() {
  return [...(await loadRegistry())].sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function collectWorktrees(isActive: (record: WorktreeRecord) => boolean) {
  const list = await loadRegistry();
  const cutoff = Date.now() - ttlDays * 24 * 3600_000;
  const removed: string[] = [];
  for (const record of list) {
    if (record.pinned || record.status === "removed" || isActive(record)) continue;
    if (Date.parse(record.lastAccessedAt) > cutoff) continue;
    if (!(await exists(record.path))) {
      record.status = "removed";
      continue;
    }
    const dirty = (await git(record.path, ["status", "--porcelain"])).stdout.trim();
    const ahead = (await git(record.path, ["rev-list", "--count", `${record.baseCommit}..HEAD`])).stdout.trim();
    const pushed = (await git(record.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).code === 0;
    if (dirty || (ahead !== "0" && !pushed)) {
      record.status = "stale";
      continue;
    }
    const result = await git(record.repo, ["worktree", "remove", record.path], 120_000);
    if (result.code === 0) {
      record.status = "removed";
      removed.push(record.id);
    } else record.status = "stale";
  }
  await persist(registryFile, list);
  return removed;
}

export function startWorktreeCollector(isActive: (record: WorktreeRecord) => boolean) {
  const run = () =>
    collectWorktrees(isActive)
      .then((removed) => removed.length > 0 && console.log(`worktrees removidas por idade: ${removed.join(", ")}`))
      .catch((error) => console.warn("worktree gc failed", error));
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}
