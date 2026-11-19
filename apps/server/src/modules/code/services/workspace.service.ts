import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { childEnv, findBinary, run } from "@runelay-bots/providers/proc";
import { dataDir } from "../../../config/env";
import type { StoredSession } from "../../conversations/services/sessions.service";
import type { PrSnapshot } from "./pull-request.service";

export const repoRoots = (process.env.CODE_REPO_ROOTS ?? "/home/anderson/projects/conty-dev,/home/anderson/projects")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
export const worktreesRoot = process.env.CODE_WORKTREES_DIR ?? "/home/anderson/projects/worktrees";
export const codeDataDir = join(dataDir, "code");

export interface InstallState {
  status: "running" | "done" | "failed" | "skipped";
  manager: string | null;
  command: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error?: string;
}

export interface WorkspaceState {
  id: string;
  repo: string;
  repoName: string;
  path: string;
  branch: string;
  base: string;
  baseCommit: string;
  task: string;
  openedAt: string;
  active: boolean;
  closedAt: string | null;
  install: InstallState;
  pr?: PrSnapshot | null;
}

export interface RepoInfo {
  name: string;
  path: string;
  location: string;
  branch: string | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: string[];
}

export interface FileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  added: number;
  removed: number;
  binary: boolean;
}

export class CodeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function git(cwd: string, args: string[], timeoutMs = 60_000, extraEnv: Record<string, string> = {}) {
  return run("git", args, {
    cwd,
    timeoutMs,
    env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extraEnv }),
  });
}

async function isDir(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

let repoCache: { at: number; repos: RepoInfo[] } | null = null;

async function headBranch(repo: string) {
  try {
    const head = (await readFile(join(repo, ".git", "HEAD"), "utf8")).trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : null;
  } catch {
    return null;
  }
}

export function cachedRepoNames() {
  return repoCache?.repos.map((repo) => repo.name) ?? [];
}

export async function listRepos(refresh = false): Promise<RepoInfo[]> {
  if (!refresh && repoCache && Date.now() - repoCache.at < 30_000) return repoCache.repos;
  const seen = new Set<string>();
  const repos: RepoInfo[] = [];
  for (const root of repoRoots) {
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".") || entry === "worktrees") continue;
      const path = join(root, entry);
      if (resolve(path) === resolve(worktreesRoot)) continue;
      if (!(await isDir(join(path, ".git")))) continue;
      try {
        const info = await stat(path);
        const key = `${info.dev}:${info.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
      } catch {
        continue;
      }
      repos.push({ name: entry, path, location: basename(root), branch: await headBranch(path) });
    }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  repoCache = { at: Date.now(), repos };
  return repos;
}

function loose(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export async function resolveRepo(input: string) {
  const value = input.trim().replace(/^@/, "");
  if (!value) throw new CodeError("Diga qual repositório.");
  if (isAbsolute(value) || value.startsWith("~/")) {
    const path = resolve(value.replace(/^~\//, `${process.env.HOME ?? "/home/anderson"}/`));
    if (!(await isDir(join(path, ".git")))) throw new CodeError(`${path} não é um repositório git.`);
    return { name: basename(path), path };
  }
  const repos = await listRepos();
  const exact = repos.filter((repo) => repo.name === value);
  if (exact.length >= 1) return exact[0];
  const folded = repos.filter((repo) => repo.name.toLowerCase() === value.toLowerCase());
  if (folded.length === 1) return folded[0];
  const target = loose(value);
  const same = repos.filter((repo) => loose(repo.name) === target);
  if (same.length === 1) return same[0];
  const partial = repos.filter((repo) => loose(repo.name).includes(target) || target.includes(loose(repo.name)));
  if (partial.length === 1) return partial[0];
  const options = (partial.length > 1 ? partial : repos)
    .map((repo) => repo.name)
    .slice(0, 30)
    .join(", ");
  if (partial.length > 1) throw new CodeError(`Achei mais de um repositório para "${value}": ${options}. Qual deles?`);
  throw new CodeError(`Não achei o repositório "${value}". Os que existem: ${options}.`);
}

export function slugify(text: string, max = 40) {
  const base = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return "tarefa";
  if (base.length <= max) return base;
  const cut = base.slice(0, max);
  const dash = cut.lastIndexOf("-");
  return (dash > 12 ? cut.slice(0, dash) : cut).replace(/-+$/g, "");
}

async function pickBase(repo: string) {
  for (const ref of ["origin/develop", "origin/main", "origin/master", "develop", "main", "master"]) {
    const result = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result.code === 0) return { base: ref, commit: result.stdout.trim() };
  }
  const head = await git(repo, ["rev-parse", "HEAD"]);
  return { base: "HEAD", commit: head.stdout.trim() };
}

async function branchExists(repo: string, branch: string) {
  return (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const installs = new Map<string, Promise<void>>();

export function waitForInstall(workspace: WorkspaceState) {
  return installs.get(workspace.path) ?? Promise.resolve();
}

function installPlan(files: Set<string>) {
  if (files.has("bun.lock") || files.has("bun.lockb"))
    return { manager: "bun", bin: "bun", args: ["install", "--frozen-lockfile"] };
  if (files.has("pnpm-lock.yaml")) return { manager: "pnpm", bin: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (files.has("yarn.lock")) return { manager: "yarn", bin: "yarn", args: ["install", "--frozen-lockfile"] };
  if (files.has("package-lock.json")) return { manager: "npm", bin: "npm", args: ["ci", "--no-audit", "--no-fund"] };
  return null;
}

export function installLogPath(workspace: WorkspaceState) {
  return join(codeDataDir, workspace.id, "install.log");
}

function startInstall(session: StoredSession, workspace: WorkspaceState) {
  const work = (async () => {
    const files = new Set(await readdir(workspace.path).catch(() => [] as string[]));
    const plan = installPlan(files);
    const emit = () =>
      session.log.emit({ type: "code.install", data: { workspaceId: workspace.id, ...workspace.install } });
    if (!plan || files.has("node_modules")) {
      workspace.install = {
        status: "skipped",
        manager: plan?.manager ?? null,
        command: null,
        startedAt: null,
        finishedAt: new Date().toISOString(),
      };
      await session.save();
      return;
    }
    const bin = findBinary([plan.bin]);
    const command = `${plan.bin} ${plan.args.join(" ")}`;
    if (!bin) {
      workspace.install = {
        status: "failed",
        manager: plan.manager,
        command,
        startedAt: null,
        finishedAt: new Date().toISOString(),
        error: `${plan.bin} não está instalado na VPS.`,
      };
      emit();
      await session.save();
      return;
    }
    const started = Date.now();
    workspace.install = {
      status: "running",
      manager: plan.manager,
      command,
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
    };
    emit();
    await session.save();
    await mkdir(join(codeDataDir, workspace.id), { recursive: true });
    const out = createWriteStream(installLogPath(workspace));
    const code = await (async () => {
      let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        child = Bun.spawn([bin, ...plan.args], {
          cwd: workspace.path,
          env: childEnv({ CI: "1" }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20 * 60_000,
          killSignal: "SIGTERM",
        });
      } catch {
        return 1;
      }
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) out.write(chunk);
      };
      await Promise.all([pump(child.stdout), pump(child.stderr)]);
      const exit = await child.exited;
      return child.signalCode ? 1 : exit;
    })();
    out.end();
    let tail = "";
    if (code !== 0)
      tail = (await readFile(installLogPath(workspace), "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .slice(-6)
        .join("\n");
    workspace.install = {
      status: code === 0 ? "done" : "failed",
      manager: plan.manager,
      command,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      ...(code === 0 ? {} : { error: tail.slice(-1500) || `${command} saiu com código ${code}.` }),
    };
    session.log.emit({
      type: "code.install",
      data: { workspaceId: workspace.id, ...workspace.install, durationMs: Date.now() - started },
    });
    await session.save();
  })().catch((error) => console.warn("install failed", error));
  installs.set(workspace.path, work);
  void work.finally(() => installs.delete(workspace.path));
}

export function activeWorkspace(session: StoredSession | undefined | null) {
  const workspace = session?.meta.workspace;
  return workspace?.active ? workspace : null;
}

export function publicWorkspace(workspace: WorkspaceState) {
  return {
    id: workspace.id,
    repo: workspace.repo,
    repoName: workspace.repoName,
    path: workspace.path,
    branch: workspace.branch,
    base: workspace.base,
    task: workspace.task,
    openedAt: workspace.openedAt,
    active: workspace.active,
    closedAt: workspace.closedAt,
    install: workspace.install,
    pr: workspace.pr ?? null,
  };
}

export async function openWorkspace(session: StoredSession, botId: string, repoInput: string, task: string) {
  const repo = await resolveRepo(repoInput);
  const current = session.meta.workspace;
  if (current && current.repo === repo.path && (await exists(current.path))) {
    if (current.active) return { workspace: current, created: false };
    current.active = true;
    current.closedAt = null;
    await session.save();
    session.log.emit({ type: "code.workspace", data: { action: "reopened", ...publicWorkspace(current) } });
    return { workspace: current, created: false };
  }
  const hasOrigin = (await git(repo.path, ["remote", "get-url", "origin"])).code === 0;
  if (hasOrigin) await git(repo.path, ["fetch", "--quiet", "origin"], 45_000);
  const { base, commit } = await pickBase(repo.path);
  const slug = slugify(task || session.meta.title || "tarefa");
  const botSlug = slugify(botId, 20);
  let id = `${repo.name}-${botSlug}-${slug}`.replace(/[^\w.-]/g, "-");
  let branch = `feat/${slug}`;
  for (let attempt = 2; (await exists(join(worktreesRoot, id))) || (await branchExists(repo.path, branch)); attempt++) {
    const suffix = attempt < 6 ? String(attempt) : randomBytes(2).toString("hex");
    id = `${repo.name}-${botSlug}-${slug}-${suffix}`.replace(/[^\w.-]/g, "-");
    branch = `feat/${slug}-${suffix}`;
  }
  const path = join(worktreesRoot, id);
  await mkdir(worktreesRoot, { recursive: true });
  const added = await git(repo.path, ["worktree", "add", "-b", branch, path, commit], 180_000);
  if (added.code !== 0)
    throw new CodeError(`Não consegui criar a worktree: ${(added.stderr || added.stdout).trim().slice(0, 400)}`, 500);
  const workspace: WorkspaceState = {
    id,
    repo: repo.path,
    repoName: repo.name,
    path,
    branch,
    base,
    baseCommit: commit,
    task: task.slice(0, 300),
    openedAt: new Date().toISOString(),
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null },
  };
  session.meta.workspace = workspace;
  await session.save();
  session.log.emit({ type: "code.workspace", data: { action: "opened", ...publicWorkspace(workspace) } });
  startInstall(session, workspace);
  statusCache.delete(path);
  return { workspace, created: true };
}

export async function closeWorkspace(session: StoredSession, quiet = false) {
  const workspace = session.meta.workspace;
  if (!workspace?.active) return null;
  workspace.active = false;
  workspace.closedAt = new Date().toISOString();
  await session.save();
  if (!quiet) session.log.emit({ type: "code.workspace", data: { action: "closed", ...publicWorkspace(workspace) } });
  return workspace;
}

export function insideWorkspace(workspace: WorkspaceState, path: string) {
  const absolute = resolve(workspace.path, path);
  const rel = relative(workspace.path, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function relativePath(workspace: WorkspaceState, path: string) {
  const absolute = resolve(workspace.path, path);
  return insideWorkspace(workspace, absolute) ? relative(workspace.path, absolute) : absolute;
}

function cleanPath(workspace: WorkspaceState, path: string) {
  const rel = relativePath(workspace, path);
  if (isAbsolute(rel) || rel === "" || rel.split("/").includes(".git")) throw new CodeError("Caminho fora da tarefa.");
  return rel;
}

const statusCache = new Map<string, { at: number; files: FileChange[] }>();

function unquote(path: string) {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

async function countLines(path: string) {
  try {
    const info = await stat(path);
    if (info.size > 2 * 1024 * 1024) return { lines: 0, binary: true };
    const buffer = await readFile(path);
    if (buffer.includes(0)) return { lines: 0, binary: true };
    const text = buffer.toString("utf8");
    if (!text) return { lines: 0, binary: false };
    return { lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), binary: false };
  } catch {
    return { lines: 0, binary: false };
  }
}

export async function changedFiles(workspace: WorkspaceState, fresh = false): Promise<FileChange[]> {
  const cached = statusCache.get(workspace.path);
  if (!fresh && cached && Date.now() - cached.at < 3_000) return cached.files;
  const [numstat, names, untracked] = await Promise.all([
    git(workspace.path, ["diff", "--numstat", "-M", workspace.baseCommit]),
    git(workspace.path, ["diff", "--name-status", "-M", workspace.baseCommit]),
    git(workspace.path, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const statusByPath = new Map<string, FileChange["status"]>();
  for (const line of names.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...paths] = line.split("\t");
    const path = unquote(paths[paths.length - 1] ?? "");
    const letter = code[0];
    statusByPath.set(
      path,
      letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : "modified",
    );
  }
  const files: FileChange[] = [];
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [addedRaw, removedRaw, ...rest] = line.split("\t");
    let path = unquote(rest.join("\t"));
    const arrow = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (arrow) path = `${arrow[1]}${arrow[3]}${arrow[4]}`.replace(/\/\//g, "/");
    else if (path.includes(" => ")) path = path.split(" => ")[1];
    const binary = addedRaw === "-";
    files.push({
      path,
      status: statusByPath.get(path) ?? "modified",
      added: binary ? 0 : Number(addedRaw),
      removed: binary ? 0 : Number(removedRaw),
      binary,
    });
  }
  for (const line of untracked.stdout.split("\n")) {
    const path = unquote(line.trim());
    if (!path || files.some((file) => file.path === path)) continue;
    const { lines, binary } = await countLines(join(workspace.path, path));
    files.push({ path, status: "untracked", added: lines, removed: 0, binary });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  statusCache.set(workspace.path, { at: Date.now(), files });
  return files;
}

export function invalidateStatus(workspace: WorkspaceState) {
  statusCache.delete(workspace.path);
}

export function parsePatch(text: string) {
  const files: { path: string; oldPath: string | null; hunks: DiffHunk[]; binary: boolean }[] = [];
  let file: (typeof files)[number] | null = null;
  let hunk: DiffHunk | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/);
      file = { path: match?.[2] ?? "", oldPath: match?.[1] ?? null, hunks: [], binary: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target !== "/dev/null") file.path = unquote(target).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("Binary files")) {
      file.binary = true;
      continue;
    }
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (header) {
      const section = (header[5] ?? "").trim().slice(0, 120);
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        ...(section ? { section } : {}),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) hunk.lines.push(line);
    else if (hunk && line === "\\ No newline at end of file") continue;
  }
  return files;
}

export function hunkStats(hunks: DiffHunk[]) {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

export async function diffTexts(before: string | null, after: string | null) {
  const dir = join(codeDataDir, "tmp", randomBytes(6).toString("hex"));
  await mkdir(dir, { recursive: true });
  try {
    const left = join(dir, "a");
    const right = join(dir, "b");
    await writeFile(left, before ?? "");
    await writeFile(right, after ?? "");
    const result = await git(dir, ["diff", "--no-index", "--no-color", "-U3", "a", "b"]);
    const hunks = parsePatch(result.stdout)[0]?.hunks ?? [];
    return { hunks, ...hunkStats(hunks) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const maxInlineBytes = 200_000;

export async function readMaybe(path: string) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    const buffer = await readFile(path);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export async function baseContent(workspace: WorkspaceState, rel: string) {
  const result = await git(workspace.path, ["show", `${workspace.baseCommit}:${rel}`]);
  return result.code === 0 ? result.stdout : null;
}

export async function fileDiff(workspace: WorkspaceState, path: string) {
  const rel = cleanPath(workspace, path);
  const files = await changedFiles(workspace, true);
  const change = files.find((file) => file.path === rel);
  const result =
    change?.status === "untracked"
      ? await git(workspace.path, ["diff", "--no-color", "--no-index", "--", "/dev/null", rel])
      : await git(workspace.path, ["diff", "--no-color", "-M", workspace.baseCommit, "--", rel]);
  const parsed = parsePatch(result.stdout)[0];
  const before = change?.status === "untracked" ? null : await baseContent(workspace, rel);
  const after = await readMaybe(join(workspace.path, rel));
  return {
    path: rel,
    status: change?.status ?? "modified",
    added: change?.added ?? 0,
    removed: change?.removed ?? 0,
    binary: parsed?.binary ?? change?.binary ?? false,
    hunks: parsed?.hunks ?? [],
    patch: result.stdout,
    before: before !== null && before.length <= maxInlineBytes ? before : null,
    after: after !== null && after.length <= maxInlineBytes ? after : null,
  };
}

export async function allDiffs(workspace: WorkspaceState) {
  const files = await changedFiles(workspace, true);
  const tracked = await git(workspace.path, ["diff", "--no-color", "-M", workspace.baseCommit]);
  const parsed = parsePatch(tracked.stdout);
  const result = files.map((file) => {
    const match = parsed.find((item) => item.path === file.path);
    return { ...file, hunks: match?.hunks ?? [], patch: "" };
  });
  for (const item of result) {
    if (item.status !== "untracked" || item.binary) continue;
    const diff = await git(workspace.path, ["diff", "--no-color", "--no-index", "--", "/dev/null", item.path]);
    item.hunks = parsePatch(diff.stdout)[0]?.hunks ?? [];
  }
  return { files: result, patch: tracked.stdout };
}

export async function revertFile(workspace: WorkspaceState, path: string) {
  const rel = cleanPath(workspace, path);
  const inBase = (await git(workspace.path, ["cat-file", "-e", `${workspace.baseCommit}:${rel}`])).code === 0;
  if (inBase) {
    const restored = await git(workspace.path, ["checkout", workspace.baseCommit, "--", rel]);
    if (restored.code !== 0) throw new CodeError(`Não consegui desfazer: ${restored.stderr.trim().slice(0, 300)}`, 500);
    await git(workspace.path, ["reset", "--quiet", "--", rel]);
  } else {
    await git(workspace.path, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", rel]);
    await rm(join(workspace.path, rel), { force: true });
  }
  invalidateStatus(workspace);
  return rel;
}

export async function codeSummary(workspace: WorkspaceState) {
  const files = await changedFiles(workspace).catch(() => [] as FileChange[]);
  return {
    ...publicWorkspace(workspace),
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

export async function snapshotChanges(workspace: WorkspaceState) {
  const files = await changedFiles(workspace, true).catch(() => [] as FileChange[]);
  const contents = new Map<string, string | null>();
  for (const file of files) {
    if (file.binary) continue;
    contents.set(file.path, await readMaybe(join(workspace.path, file.path)));
  }
  return contents;
}

export function clipText(text: string | null) {
  return text !== null && text.length <= maxInlineBytes ? text : null;
}

export interface Checkpoint {
  turnId: string;
  ref: string;
  commit: string;
  workspaceId: string;
  at: string;
}

async function withIndex<T>(work: (env: Record<string, string>) => Promise<T>) {
  const dir = join(codeDataDir, "tmp");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `index-${randomBytes(6).toString("hex")}`);
  try {
    return await work({ GIT_INDEX_FILE: file });
  } finally {
    await rm(file, { force: true });
  }
}

async function snapshotTree(workspace: WorkspaceState) {
  return withIndex(async (env) => {
    await git(workspace.path, ["read-tree", "HEAD"], 60_000, env);
    const added = await git(workspace.path, ["add", "-A", "--", "."], 120_000, env);
    if (added.code !== 0)
      throw new CodeError(`Não consegui guardar o ponto de volta: ${added.stderr.trim().slice(0, 300)}`, 500);
    const tree = await git(workspace.path, ["write-tree"], 60_000, env);
    return tree.stdout.trim();
  });
}

export function checkpointRef(sessionId: string, turnId: string) {
  return `refs/runelay/checkpoints/${sessionId}/${turnId}`;
}

export async function createCheckpoint(session: StoredSession, workspace: WorkspaceState, turnId: string) {
  const existing = session.meta.checkpoints?.find(
    (item) => item.turnId === turnId && item.workspaceId === workspace.id,
  );
  if (existing) return existing;
  const tree = await snapshotTree(workspace);
  const head = (await git(workspace.path, ["rev-parse", "HEAD"])).stdout.trim();
  const commit = await git(
    workspace.path,
    ["commit-tree", tree, "-p", head, "-m", `runelay checkpoint ${session.meta.sessionId} ${turnId}`],
    60_000,
    {
      GIT_AUTHOR_NAME: "runelay bots",
      GIT_AUTHOR_EMAIL: "bots@runelay.local",
      GIT_COMMITTER_NAME: "runelay bots",
      GIT_COMMITTER_EMAIL: "bots@runelay.local",
    },
  );
  if (commit.code !== 0)
    throw new CodeError(`Não consegui guardar o ponto de volta: ${commit.stderr.trim().slice(0, 300)}`, 500);
  const ref = checkpointRef(session.meta.sessionId, turnId);
  await git(workspace.path, ["update-ref", ref, commit.stdout.trim()]);
  const checkpoint: Checkpoint = {
    turnId,
    ref,
    commit: commit.stdout.trim(),
    workspaceId: workspace.id,
    at: new Date().toISOString(),
  };
  session.meta.checkpoints = [...(session.meta.checkpoints ?? []), checkpoint].slice(-200);
  session.log.emit({ type: "code.checkpoint", data: { ...checkpoint }, scope: { turnId } });
  await session.save();
  return checkpoint;
}

export async function restoreCheckpoint(workspace: WorkspaceState, checkpoint: Checkpoint) {
  const now = await withIndex(async (env) => {
    await git(workspace.path, ["read-tree", "HEAD"], 60_000, env);
    await git(workspace.path, ["add", "-A", "--", "."], 120_000, env);
    return (await git(workspace.path, ["ls-files", "-z"], 60_000, env)).stdout.split("\0").filter(Boolean);
  });
  const then = new Set(
    (await git(workspace.path, ["ls-tree", "-r", "-z", "--name-only", checkpoint.commit])).stdout
      .split("\0")
      .filter(Boolean),
  );
  const restored = await withIndex(async (env) => {
    const read = await git(workspace.path, ["read-tree", checkpoint.commit], 60_000, env);
    if (read.code !== 0)
      throw new CodeError(`Esse ponto de volta não existe mais: ${read.stderr.trim().slice(0, 200)}`, 404);
    const out = await git(workspace.path, ["checkout-index", "-a", "-f"], 120_000, env);
    if (out.code !== 0) throw new CodeError(`Não consegui voltar os arquivos: ${out.stderr.trim().slice(0, 300)}`, 500);
    return then.size;
  });
  let removed = 0;
  for (const path of now) {
    if (then.has(path)) continue;
    await rm(join(workspace.path, path), { force: true });
    removed++;
  }
  await git(workspace.path, ["reset", "--quiet"]);
  invalidateStatus(workspace);
  return { restored, removed };
}
