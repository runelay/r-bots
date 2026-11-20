import { createHash } from "node:crypto";
import { access, readFile, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ValidationError } from "../../../shared/errors";
import { allowedRepoFor, allowedRepos, expandHome, insideAllowedArea } from "../../code/services/repos.service";
import { git } from "../../code/services/workspace.service";

export interface ProjectWorktree {
  path: string;
  branch: string | null;
  main: boolean;
}

export interface ProjectInfo {
  name: string;
  path: string;
  worktrees: ProjectWorktree[];
}

export interface ProjectScript {
  name: string;
  command: string;
  tool: string | null;
}

export interface ProjectEnv {
  values: Record<string, string>;
  keys: string[];
  secrets: string[];
  files: string[];
}

const envFiles = [".env.local", ".env.development.local"];
const linkedFiles = [".env", ".env.local", ".env.development.local", ".dev.vars"];
const secretKey = /KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|CREDENTIAL|DATABASE_URL|DSN|AUTH|COOKIE|SESSION/i;

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function projectKey(path: string) {
  return `prj_${createHash("sha1").update(path).digest("hex").slice(0, 10)}`;
}

export function parseWorktrees(text: string): ProjectWorktree[] {
  const items: ProjectWorktree[] = [];
  let current: ProjectWorktree | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9).trim(), branch: null, main: items.length === 0 };
      items.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (current && line.trim() === "detached") {
      current.branch = null;
    }
  }
  return items;
}

export async function worktreesOf(repoPath: string) {
  const result = await git(repoPath, ["worktree", "list", "--porcelain"], 15_000);
  if (result.code !== 0) return [{ path: repoPath, branch: null, main: true }];
  return parseWorktrees(result.stdout).filter((item) => item.path === repoPath || insideAllowedArea(item.path));
}

export async function listProjects(): Promise<ProjectInfo[]> {
  return Promise.all(
    allowedRepos().map(async (repo) => ({ name: repo.name, path: repo.path, worktrees: await worktreesOf(repo.path) })),
  );
}

export interface ResolvedProject {
  name: string;
  repoPath: string;
  path: string;
  branch: string | null;
  cwd: string;
}

async function isDir(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function resolveProject(input: { path?: string; project?: string; branch?: string; cwd?: string }) {
  let path: string | null = null;
  if (input.path) path = resolve(expandHome(input.path));
  if (!path && input.project) {
    const wanted = input.project.trim().toLowerCase();
    const repo =
      allowedRepos().find((item) => item.name.toLowerCase() === wanted) ??
      allowedRepos().find((item) => item.path === resolve(expandHome(input.project ?? ""))) ??
      allowedRepos().find((item) => item.name.toLowerCase().includes(wanted));
    if (!repo)
      throw new ValidationError(`O projeto ${input.project} não está liberado. Use workspace_add antes.`, "project");
    path = repo.path;
    if (input.branch) {
      const worktree = (await worktreesOf(repo.path)).find((item) => item.branch === input.branch);
      if (!worktree)
        throw new ValidationError(`Não achei worktree da branch ${input.branch} em ${repo.name}.`, "project");
      path = worktree.path;
    }
  }
  if (!path) throw new ValidationError("Diga o projeto (path ou project).", "project");
  if (!insideAllowedArea(path)) throw new ValidationError("Esse caminho não está num repositório liberado.", "project");
  if (!(await isDir(path))) throw new ValidationError("Essa pasta não existe.", "project");
  const top = await git(path, ["rev-parse", "--show-toplevel"], 10_000);
  const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : path;
  const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000);
  const repoPath = common.code === 0 && common.stdout.trim() ? dirname(common.stdout.trim()) : root;
  const branchResult = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], 10_000);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null;
  const cwd = resolve(root, input.cwd ?? relative(root, path));
  if (!within(root, cwd)) throw new ValidationError("A pasta precisa ficar dentro do projeto.", "project");
  const repo = allowedRepoFor(repoPath);
  return {
    name: repo?.name ?? basename(repoPath),
    repoPath,
    path: root,
    branch: branch === "HEAD" ? null : branch,
    cwd: relative(root, cwd),
  } satisfies ResolvedProject;
}

export function managerOf(files: string[]) {
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  return "npm";
}

export function scriptCommand(manager: string, script: string) {
  if (manager === "yarn") return `yarn ${script}`;
  return `${manager} run ${script}`;
}

async function lockFiles(dirs: string[]) {
  const found: string[] = [];
  for (const dir of dirs)
    for (const file of ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"])
      if (await exists(join(dir, file))) found.push(file);
  return found;
}

export async function readScripts(project: ResolvedProject) {
  const dir = join(project.path, project.cwd);
  let scripts: ProjectScript[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    scripts = Object.entries(pkg.scripts ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, command]) => ({ name, command, tool: null }));
  } catch {}
  const manager = managerOf(await lockFiles([dir, project.path]));
  return { manager, scripts };
}

export function parseEnv(text: string) {
  const values: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

function envDirs(project: ResolvedProject) {
  const dirs = [join(project.path, project.cwd)];
  if (project.repoPath !== project.path) dirs.push(join(project.repoPath, project.cwd));
  return dirs;
}

export async function loadEnv(project: ResolvedProject): Promise<ProjectEnv> {
  const values: Record<string, string> = {};
  const files: string[] = [];
  for (const dir of envDirs(project).reverse()) {
    for (const file of envFiles) {
      const text = await readFile(join(dir, file), "utf8").catch(() => null);
      if (text === null) continue;
      Object.assign(values, parseEnv(text));
      if (!files.includes(file)) files.push(file);
    }
  }
  const keys = Object.keys(values).sort();
  const secrets = [
    ...new Set(
      Object.entries(values)
        .filter(([key, value]) => value.length >= 6 && secretKey.test(key))
        .map(([, value]) => value),
    ),
  ];
  return { values, keys, secrets, files };
}

export async function linkEnvFiles(project: ResolvedProject) {
  if (project.repoPath === project.path) return [];
  const linked: string[] = [];
  const target = join(project.path, project.cwd);
  const source = join(project.repoPath, project.cwd);
  for (const file of linkedFiles) {
    if (await exists(join(target, file))) continue;
    if (!(await exists(join(source, file)))) continue;
    const ignored = await git(project.path, ["check-ignore", "-q", join(project.cwd, file)], 10_000);
    if (ignored.code !== 0) continue;
    try {
      await symlink(join(source, file), join(target, file));
      linked.push(file);
    } catch {}
  }
  return linked;
}
