import type { SyncResult, WorkspaceSync } from "@runelay-bots/protocol";
import { runnerSync } from "../../accounts/services/mac-runner.service";
import { CodeError, git, isAncestor, restoreTree, withIndex } from "./workspace.service";

export const syncRefPrefix = "refs/rbots/sync/";
export const noGithubMessage =
  "Este repositório não tem remoto no GitHub, então o Mac não tem como receber o código. Troque para VPS para trabalhar nele.";
export const detachedMessage =
  "A worktree desta tarefa não está numa branch, então o Mac não tem como recebê-la. Troque para VPS ou volte para a branch da tarefa.";

const syncAuthor = {
  GIT_AUTHOR_NAME: "r/bots",
  GIT_AUTHOR_EMAIL: "bots@runelay.local",
  GIT_COMMITTER_NAME: "r/bots",
  GIT_COMMITTER_EMAIL: "bots@runelay.local",
};

export type MacSyncPlan =
  | { kind: "plain" }
  | { kind: "sync"; sync: WorkspaceSync }
  | { kind: "refused"; message: string };

const pending = new Map<string, SyncResult>();
const running = new Map<string, { key: string; turnId: string }>();
const cleanupAfterTurn = new Set<string>();

function clip(text: string) {
  return text.trim().slice(0, 300);
}

export function githubRepoOf(url: string) {
  const match = url
    .trim()
    .match(
      /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    );
  return match?.[1] ?? null;
}

export function syncRefOf(branch: string) {
  return `${syncRefPrefix}${branch}`;
}

async function output(cwd: string, args: string[]) {
  const result = await git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function snapshotCommit(cwd: string) {
  const tree = await withIndex(async (env) => {
    await git(cwd, ["read-tree", "HEAD"], 60_000, env);
    const added = await git(cwd, ["add", "-A", "--", "."], 120_000, env);
    if (added.code !== 0) throw new CodeError(`Não consegui guardar o estado da worktree: ${clip(added.stderr)}`, 500);
    return (await git(cwd, ["write-tree"], 60_000, env)).stdout.trim();
  });
  const head = await output(cwd, ["rev-parse", "HEAD"]);
  const commit = await git(cwd, ["commit-tree", tree, "-p", head, "-m", "r/bots sync"], 60_000, syncAuthor);
  if (commit.code !== 0) throw new CodeError(`Não consegui guardar o estado da worktree: ${clip(commit.stderr)}`, 500);
  return commit.stdout.trim();
}

export async function prepareMacSync(cwd: string): Promise<MacSyncPlan> {
  if ((await output(cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return { kind: "plain" };
  await applyPendingSync(cwd);
  const repo = githubRepoOf(await output(cwd, ["config", "--get", "remote.origin.url"]));
  if (!repo) return { kind: "refused", message: noGithubMessage };
  const branch = await output(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch) return { kind: "refused", message: detachedMessage };
  const commit = await snapshotCommit(cwd);
  const ref = syncRefOf(branch);
  const pushed = await git(cwd, ["push", "--no-verify", "--quiet", "--force", "origin", `${commit}:${ref}`], 180_000);
  if (pushed.code !== 0)
    return { kind: "refused", message: `Não consegui mandar o código para o GitHub: ${clip(pushed.stderr)}` };
  await git(cwd, ["update-ref", ref, commit]);
  const [, name = repo] = repo.split("/");
  return {
    kind: "sync",
    sync: { repo, cloneUrl: `https://github.com/${repo}.git`, name, branch, ref, commit, cwd },
  };
}

export async function applySync(cwd: string, { ref, commit }: SyncResult) {
  const fetched = await git(cwd, ["fetch", "--quiet", "--no-tags", "origin", `+${ref}:${ref}`], 180_000);
  if (fetched.code !== 0) throw new CodeError(`Não consegui baixar o código do Mac: ${clip(fetched.stderr)}`, 502);
  const parent = await output(cwd, ["rev-parse", `${commit}^`]);
  if (!parent) throw new CodeError("O código do Mac chegou incompleto.", 502);
  const head = await output(cwd, ["rev-parse", "HEAD"]);
  if (parent !== head && (await isAncestor(cwd, head, parent))) await git(cwd, ["reset", "--quiet", parent]);
  await restoreTree(cwd, commit);
  pending.delete(cwd);
}

export async function applyPendingSync(cwd: string) {
  const waiting = pending.get(cwd);
  if (waiting) await applySync(cwd, waiting);
}

export function beginMacTurn(cwd: string, key: string, turnId: string) {
  running.set(cwd, { key, turnId });
}

export async function finishMacTurn(cwd: string, result: SyncResult | null) {
  running.delete(cwd);
  if (result) pending.set(cwd, result);
  await applyPendingSync(cwd);
  if (cleanupAfterTurn.delete(cwd)) await dropSyncRef(cwd);
}

export async function syncBeforeDeliver(cwd: string) {
  const turn = running.get(cwd);
  if (turn) pending.set(cwd, await runnerSync(turn.key, turn.turnId));
  await applyPendingSync(cwd);
}

export async function dropSyncRef(cwd: string) {
  const branch = await output(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch) return;
  const ref = syncRefOf(branch);
  await git(cwd, ["push", "--no-verify", "--quiet", "origin", "--delete", ref], 120_000);
  await git(cwd, ["update-ref", "-d", ref]);
}

export async function cleanSyncAfterDeliver(cwd: string) {
  const branch = await output(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch || !(await output(cwd, ["rev-parse", "--verify", "-q", syncRefOf(branch)]))) return;
  if (running.has(cwd)) {
    cleanupAfterTurn.add(cwd);
    return;
  }
  await dropSyncRef(cwd);
}

export function resetMacSync() {
  pending.clear();
  running.clear();
  cleanupAfterTurn.clear();
}
