import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { SyncResult, TurnRequest, WorkspaceSync } from "@runelay-bots/protocol";
import {
  claudeLoggedOutMessage,
  claudeLoginTtlMs,
  claudeMissingMessage,
  macClaudeCandidates,
  macExtraPath,
  syncAuthorEnv,
  syncCommitMessage,
  syncTimeoutMs,
} from "./constants";
import { findOnPath } from "./host";
import type { GitResult, GitRun, PathMap } from "./types";

export type Capture = (argv: string[], env: Record<string, string>) => Promise<GitResult>;

export async function captureProcess(
  argv: string[],
  env: Record<string, string>,
  cwd?: string,
  timeoutMs = syncTimeoutMs,
): Promise<GitResult> {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export function macPath(path: string | undefined, home: string) {
  const dirs = [
    join(home, ".local", "bin"),
    ...macExtraPath,
    join(home, ".bun", "bin"),
    ...(path ?? "").split(delimiter),
  ];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

export function findClaude(configured: string | null, path: string, home: string, exists: (path: string) => boolean) {
  if (configured) return exists(configured) ? configured : null;
  return (
    findOnPath(["claude"], path, exists) ??
    macClaudeCandidates.map((item) => join(home, item)).find((candidate) => exists(candidate)) ??
    null
  );
}

export function loggedIn(stdout: string) {
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

export function claudeGate(
  bin: string | null,
  env: Record<string, string>,
  capture: Capture,
  now: () => number = Date.now,
) {
  let okUntil = 0;
  return async () => {
    if (!bin) throw new Error(claudeMissingMessage);
    if (now() < okUntil) return;
    const status = await capture([bin, "auth", "status"], env).catch(() => null);
    if (!status || !loggedIn(status.stdout)) throw new Error(claudeLoggedOutMessage);
    okUntil = now() + claudeLoginTtlMs;
  };
}

export function gitRunner(gh: string | null, env: Record<string, string>, capture = captureProcess): GitRun {
  const auth = gh ? ["-c", `credential.https://github.com.helper=!'${gh}' auth git-credential`] : [];
  return (args, cwd, extra = {}) =>
    capture(["git", ...auth, ...args], { ...env, GIT_TERMINAL_PROMPT: "0", ...extra }, cwd);
}

function slug(text: string) {
  return text.replace(/[^\w.-]+/g, "-");
}

export function cloneDirOf(root: string, sync: WorkspaceSync) {
  return join(root, slug(sync.name));
}

export function worktreeDirOf(root: string, sync: WorkspaceSync) {
  return join(root, ".worktrees", slug(sync.name), slug(sync.branch));
}

export function homeDirOf(root: string, cwd: string) {
  return join(root, ".homes", slug(basename(cwd)));
}

async function must(git: GitRun, args: string[], cwd: string, what: string, env?: Record<string, string>) {
  const result = await git(args, cwd, env);
  if (result.code !== 0) throw new Error(`${what}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return result.stdout.trim();
}

export async function checkoutSync(git: GitRun, root: string, sync: WorkspaceSync, exists: (path: string) => boolean) {
  const clone = cloneDirOf(root, sync);
  const path = worktreeDirOf(root, sync);
  const base = `${sync.commit}^`;
  await mkdir(root, { recursive: true });
  if (!exists(join(clone, ".git")))
    await must(git, ["clone", "--quiet", "--no-checkout", sync.cloneUrl, clone], root, "Não consegui clonar no Mac");
  await must(
    git,
    ["fetch", "--quiet", "--no-tags", "origin", `+${sync.ref}:${sync.ref}`],
    clone,
    "Não consegui baixar o código da VPS",
  );
  await git(["worktree", "prune"], clone);
  if (exists(join(path, ".git"))) {
    await must(git, ["checkout", "--quiet", "-f", "-B", sync.branch, base], path, "Não consegui trocar de branch");
    await must(git, ["clean", "-fdq"], path, "Não consegui limpar a worktree");
  } else {
    await must(
      git,
      ["worktree", "add", "--quiet", "-f", "-B", sync.branch, path, base],
      clone,
      "Não consegui criar a worktree no Mac",
    );
  }
  await must(git, ["checkout", sync.commit, "--", "."], path, "Não consegui aplicar o código da VPS");
  const deleted = await must(
    git,
    ["diff", "--name-only", "-z", "--diff-filter=D", base, sync.commit],
    path,
    "Não consegui comparar o código da VPS",
  );
  for (const file of deleted.split("\0").filter(Boolean)) await rm(join(path, file), { force: true });
  await must(git, ["reset", "--quiet"], path, "Não consegui preparar a worktree");
  return path;
}

export async function pushSync(git: GitRun, path: string, sync: WorkspaceSync): Promise<SyncResult> {
  const index = join(tmpdir(), `rbots-index-${randomBytes(6).toString("hex")}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    await must(git, ["read-tree", "HEAD"], path, "Não consegui ler a worktree do Mac", env);
    await must(git, ["add", "-A", "--", "."], path, "Não consegui ler a worktree do Mac", env);
    const tree = await must(git, ["write-tree"], path, "Não consegui ler a worktree do Mac", env);
    const commit = await must(
      git,
      ["commit-tree", tree, "-p", "HEAD", "-m", syncCommitMessage],
      path,
      "Não consegui guardar o código do Mac",
      syncAuthorEnv,
    );
    await must(
      git,
      ["push", "--no-verify", "--quiet", "--force", "origin", `${commit}:${sync.ref}`],
      path,
      "Não consegui mandar o código do Mac para o GitHub",
    );
    return { ref: sync.ref, commit };
  } finally {
    await rm(index, { force: true });
  }
}

export function mapStrings<T>(value: T, from: string, to: string): T {
  if (from === to) return value;
  if (typeof value === "string") return value.split(from).join(to) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, from, to)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, mapStrings(item, from, to)]),
    ) as T;
  return value;
}

export function macRequest(request: TurnRequest, paths: PathMap | null, exists: (path: string) => boolean) {
  const { local = "", remote = "" } = paths ?? {};
  const images = request.images?.filter((image) => exists(image.path));
  return {
    ...request,
    configDir: null,
    systemPrompt: paths ? mapStrings(request.systemPrompt, remote, local) : request.systemPrompt,
    prompt: paths ? mapStrings(request.prompt, remote, local) : request.prompt,
    ...(request.images ? { images } : {}),
    ...(request.code && paths ? { code: { ...request.code, cwd: local } } : {}),
  };
}
