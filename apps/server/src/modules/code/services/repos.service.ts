import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { getDb } from "../../../db";
import { codeRepos, codeWorkspaces } from "../../../db/tables";

export interface AllowedRepo {
  path: string;
  name: string;
  reason: string | null;
  addedBy: string | null;
  addedAt: string;
}

export const hostHome = resolve(process.env.HOST_HOME?.trim() || homedir());
export const worktreesRoot = join(hostHome, ".local", "share", "runelay-bots-worktrees");

let cache: AllowedRepo[] | null = null;

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function expandHome(path: string) {
  return path.replace(/^~(?=$|\/)/, hostHome);
}

export function allowedRepos(): AllowedRepo[] {
  if (!cache) {
    try {
      cache = getDb().select().from(codeRepos).all();
    } catch {
      cache = [];
    }
  }
  return cache;
}

export function seedAllowedRepos() {
  const db = getDb();
  const rows = db
    .selectDistinct({ path: codeWorkspaces.repo, name: codeWorkspaces.repoName, at: codeWorkspaces.createdAt })
    .from(codeWorkspaces)
    .all();
  const now = new Date().toISOString();
  for (const row of rows) {
    if (!row.path) continue;
    db.insert(codeRepos)
      .values({
        path: resolve(row.path),
        name: row.name || basename(row.path),
        reason: "Já tinha worktree antes da lista de repositórios liberados.",
        addedBy: null,
        addedAt: row.at || now,
      })
      .onConflictDoNothing()
      .run();
  }
  cache = null;
  return allowedRepos().length;
}

export function allowedRepoFor(path: string) {
  const absolute = resolve(expandHome(path));
  return allowedRepos().find((repo) => within(repo.path, absolute)) ?? null;
}

export function insideAllowedArea(path: string, extra: string[] = []) {
  const absolute = resolve(expandHome(path));
  if (within(worktreesRoot, absolute)) return true;
  if (extra.some((root) => within(resolve(root), absolute))) return true;
  return allowedRepoFor(absolute) !== null;
}

export function insideHome(path: string) {
  const absolute = resolve(expandHome(path));
  return within(hostHome, absolute) || within(homedir(), absolute);
}

export async function gitRepoAt(path: string) {
  const absolute = resolve(expandHome(path.trim()));
  try {
    if ((await stat(join(absolute, ".git"))).isDirectory()) return absolute;
  } catch {}
  return null;
}

export function addAllowedRepo(path: string, reason: string, addedBy: string | null) {
  const absolute = resolve(path);
  const row = { path: absolute, name: basename(absolute), reason, addedBy, addedAt: new Date().toISOString() };
  getDb().insert(codeRepos).values(row).onConflictDoNothing().run();
  cache = null;
  return allowedRepos().find((repo) => repo.path === absolute) ?? row;
}

export function fileRoots() {
  let worktrees: string[] = [];
  try {
    worktrees = getDb()
      .select({ path: codeWorkspaces.path, status: codeWorkspaces.status })
      .from(codeWorkspaces)
      .all()
      .filter((row) => row.status !== "removed")
      .map((row) => row.path);
  } catch {}
  return [worktreesRoot, ...allowedRepos().map((repo) => repo.path), ...worktrees];
}
