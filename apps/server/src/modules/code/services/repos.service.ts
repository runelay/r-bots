import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { dataDir, rootDir } from "../../../config/env";
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

let cache: AllowedRepo[] = [];

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function expandHome(path: string) {
  return path.replace(/^~(?=$|\/)/, hostHome);
}

export function allowedRepos(): AllowedRepo[] {
  return cache;
}

export async function loadAllowedRepos() {
  try {
    cache = await getDb().select().from(codeRepos).orderBy(asc(codeRepos.addedAt), asc(codeRepos.path));
  } catch {
    cache = [];
  }
  return cache;
}

export async function seedAllowedRepos() {
  const db = getDb();
  const rows = await db
    .selectDistinct({ path: codeWorkspaces.repo, name: codeWorkspaces.repoName, at: codeWorkspaces.createdAt })
    .from(codeWorkspaces);
  const now = new Date().toISOString();
  const values = rows
    .filter((row) => row.path)
    .map((row) => ({
      path: resolve(row.path),
      name: row.name || basename(row.path),
      reason: "Já tinha worktree antes da lista de repositórios liberados.",
      addedBy: null,
      addedAt: row.at || now,
    }));
  if (values.length) await db.insert(codeRepos).values(values).onConflictDoNothing();
  return (await loadAllowedRepos()).length;
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

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function repoRootProblem(path: string) {
  const target = real(resolve(expandHome(path)));
  const homes = [hostHome, homedir()].map(real);
  if (target === "/" || homes.includes(target))
    return `${target} é a raiz ou a pasta pessoal inteira, não um repositório.`;
  const serverRoots = [
    dataDir,
    "/data",
    "/backups",
    "/run",
    "/proc",
    "/sys",
    "/etc",
    rootDir,
    worktreesRoot,
    join(hostHome, ".local", "share", "runelay-bots"),
    join(hostHome, ".local", "share", "runelay-bots-backups"),
  ].map((root) => real(resolve(root)));
  const clash = serverRoots.find((root) => within(target, root) || within(root, target));
  return clash ? `${target} contém ou fica dentro de uma pasta do servidor (${clash}) e não pode ser liberado.` : null;
}

export async function gitRepoAt(path: string) {
  const absolute = resolve(expandHome(path.trim()));
  try {
    if ((await stat(join(absolute, ".git"))).isDirectory()) return absolute;
  } catch {}
  return null;
}

export async function addAllowedRepo(path: string, reason: string, addedBy: string | null) {
  const absolute = resolve(path);
  const row = { path: absolute, name: basename(absolute), reason, addedBy, addedAt: new Date().toISOString() };
  await getDb().insert(codeRepos).values(row).onConflictDoNothing();
  await loadAllowedRepos();
  return allowedRepos().find((repo) => repo.path === absolute) ?? row;
}

export async function removeAllowedRepo(path: string) {
  const absolute = resolve(path);
  const found = allowedRepos().find((repo) => repo.path === absolute);
  if (!found) return null;
  await getDb().delete(codeRepos).where(eq(codeRepos.path, absolute));
  await loadAllowedRepos();
  return found;
}

export async function fileRoots() {
  let worktrees: string[] = [];
  try {
    const rows = await getDb()
      .select({ path: codeWorkspaces.path, status: codeWorkspaces.status })
      .from(codeWorkspaces);
    worktrees = rows.filter((row) => row.status !== "removed").map((row) => row.path);
  } catch {}
  return [worktreesRoot, ...allowedRepos().map((repo) => repo.path), ...worktrees];
}
