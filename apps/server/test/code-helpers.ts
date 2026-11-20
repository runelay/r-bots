import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { addAllowedRepo } from "../src/modules/code/services/repos.service";
import { createStoredSession, type StoredSession } from "../src/modules/conversations/services/sessions.service";
import { fakeProcesses, type ProcessCall, type ProcessReply, restoreProcessFakes } from "./fake-process";

export const repoRoot = join(process.env.HOST_HOME as string, "repos");
export const worktreesDir = join(process.env.HOST_HOME as string, ".local", "share", "runelay-bots-worktrees");

export function gitSync(cwd: string, args: string[], env?: Record<string, string>) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const out = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (env === undefined && out.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  return out;
}

export interface RepoOptions {
  branch?: string;
  origin?: boolean;
  files?: Record<string, string | Uint8Array>;
}

export function writeFiles(dir: string, files: Record<string, string | Uint8Array>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export async function makeRepo(name: string, options: RepoOptions = {}) {
  const path = join(repoRoot, name);
  mkdirSync(path, { recursive: true });
  const branch = options.branch ?? "main";
  gitSync(path, ["init", "-q", "-b", branch]);
  gitSync(path, ["config", "user.name", "Test"]);
  gitSync(path, ["config", "user.email", "test@example.com"]);
  gitSync(path, ["config", "commit.gpgsign", "false"]);
  writeFiles(path, options.files ?? { "README.md": "hello\n" });
  gitSync(path, ["add", "-A"]);
  gitSync(path, ["commit", "-q", "-m", "init"]);
  let origin: string | null = null;
  if (options.origin) {
    origin = join(mkdtempSync(join(tmpdir(), "rb-origin-")), `${name}.git`);
    gitSync(dirname(origin), ["init", "-q", "--bare", "-b", branch, origin]);
    gitSync(path, ["remote", "add", "origin", origin]);
    gitSync(path, ["push", "-q", "-u", "origin", branch]);
  }
  await addAllowedRepo(path, "test", null);
  return { path, name, branch, origin };
}

export type CommandHandler = (call: ProcessCall) => ProcessReply | undefined;

function realGit(call: ProcessCall): ProcessReply {
  const options = call.options as { cwd?: string; env?: Record<string, string> };
  const result = Bun.spawnSync(["git", ...call.args], {
    cwd: options.cwd,
    env: options.env ?? (process.env as Record<string, string>),
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function isGh(call: ProcessCall) {
  return basename(call.command) === "gh";
}

export function codeProcesses(handler: CommandHandler = () => undefined) {
  restoreProcessFakes();
  return fakeProcesses((call) => {
    const reply = handler(call);
    if (reply) return reply;
    if (call.command === "git") return realGit(call);
    if (isGh(call)) return { code: 1, stderr: `no fake gh reply for ${call.args.join(" ")}` };
    return undefined;
  });
}

export function gitArgs(call: ProcessCall, ...prefix: string[]) {
  return call.command === "git" && prefix.every((item, index) => call.args[index] === item);
}

export function ghArgs(call: ProcessCall, ...prefix: string[]) {
  return isGh(call) && prefix.every((item, index) => call.args[index] === item);
}

export function newSession(botId = "coder", kind: "thread" | "conversation" | "session" = "thread") {
  return createStoredSession({ botId, kind, source: "chat", title: "Code task" });
}

export async function factsOf(session: StoredSession, type?: string) {
  return (await session.log.lines())
    .flatMap((line) => (JSON.parse(line) as { facts: Array<{ type: string; data: Record<string, unknown> }> }).facts)
    .filter((fact) => !type || fact.type === type);
}
