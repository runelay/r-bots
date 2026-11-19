import type { StoredSession } from "../../conversations/services/sessions.service";
import { recordWorktree, touchWorktree } from "../repositories/code.repository";
import { stopDevServers } from "./dev-server.service";
import {
  activeWorkspace,
  CodeError,
  changedFiles,
  closeWorkspace,
  git,
  invalidateStatus,
  listRepos,
  openWorkspace,
  type WorkspaceState,
} from "./workspace.service";

export async function openTaskWorkspace(session: StoredSession, botId: string, repo: string, task: string) {
  const result = await openWorkspace(session, botId, repo, task);
  await recordWorktree(result.workspace, botId, session.meta.sessionId, "alive");
  return result;
}

export async function closeTaskWorkspace(session: StoredSession) {
  const workspace = activeWorkspace(session);
  if (!workspace) return null;
  await stopDevServers(workspace);
  await closeWorkspace(session);
  session.meta.providerSessions = {};
  await session.save();
  await touchWorktree(workspace.id, { status: "closed" });
  return workspace;
}

export async function mentionedRepo(text: string, botNames: string[]) {
  const mentions = [...text.matchAll(/(?:^|\s)@([\w.-]+)/g)].map((match) => match[1]);
  if (mentions.length === 0) return null;
  const taken = new Set(botNames.map((name) => name.toLowerCase()));
  const repos = await listRepos();
  for (const mention of mentions) {
    if (taken.has(mention.toLowerCase())) continue;
    const repo =
      repos.find((item) => item.name === mention) ??
      repos.find((item) => item.name.toLowerCase() === mention.toLowerCase());
    if (repo) return repo;
  }
  return null;
}

export interface DeliverInput {
  action: "commit" | "push" | "pr";
  message: string;
  title?: string;
  body?: string;
  base?: string;
}

function baseBranch(workspace: WorkspaceState) {
  return workspace.base.replace(/^origin\//, "");
}

export async function resolvePrBase(workspace: WorkspaceState, requested?: string) {
  const asked = requested?.trim().replace(/^origin\//, "");
  if (asked) return asked;
  let best: { name: string; ahead: number; behind: number } | null = null;
  for (const name of ["main", "develop", "master"]) {
    const counts = await git(workspace.path, ["rev-list", "--left-right", "--count", `HEAD...origin/${name}`]);
    if (counts.code !== 0) continue;
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) continue;
    if (!best || ahead < best.ahead || (ahead === best.ahead && behind < best.behind)) best = { name, ahead, behind };
  }
  return best?.name ?? baseBranch(workspace);
}

export function deliverPrompt(workspace: WorkspaceState, input: DeliverInput, files: number) {
  if (input.action === "push")
    return files > 0
      ? `Fazer commit de ${files} arquivo${files === 1 ? "" : "s"} e push da branch ${workspace.branch}? Mensagem: “${input.message}”`
      : `Fazer push da branch ${workspace.branch}?`;
  if (input.action === "pr")
    return `Fazer commit de ${files} arquivo${files === 1 ? "" : "s"}, push da branch ${workspace.branch} e abrir PR para ${input.base?.trim() || baseBranch(workspace)}? Mensagem: “${input.message}”`;
  return `Fazer commit de ${files} arquivo${files === 1 ? "" : "s"} na branch ${workspace.branch}? Mensagem: “${input.message}”`;
}

export function deliverProblem(input: DeliverInput, pending = true) {
  const message = input.message.trim();
  if (!message && !pending && input.action !== "commit") return null;
  if (!message) return "Escreva a mensagem do commit.";
  if (!/^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)(\([\w./-]+\))?!?: .+/.test(message))
    return "Use conventional commits, por exemplo: feat(lp): change hero copy.";
  if (/co-authored-by|generated with/i.test(`${message}\n${input.body ?? ""}\n${input.title ?? ""}`))
    return "Sem assinatura de IA no commit nem no PR (Co-Authored-By, Generated with). Refaça sem ela.";
  if (message.split("\n").filter((line) => line.trim()).length > 2 || message.split("\n")[0].length > 100)
    return "Mensagem do commit curta: assunto de até 100 caracteres e no máximo 2 linhas.";
  if (/[áàâãéêíóôõúç]/i.test(message.split("\n")[0]))
    return "Assunto do commit em inglês, por exemplo: fix(flags): split invoice module.";
  return null;
}

export async function deliverWorkspace(workspace: WorkspaceState, input: DeliverInput) {
  const message = input.message.trim();
  const pending = (await git(workspace.path, ["status", "--porcelain"])).stdout.trim();
  const problem = deliverProblem(input, Boolean(pending));
  if (problem) throw new CodeError(problem);
  const files = await changedFiles(workspace, true);
  let commit: string | null = null;
  if (pending) {
    const added = await git(workspace.path, ["add", "-A"]);
    if (added.code !== 0) throw new CodeError(`git add falhou: ${added.stderr.trim().slice(0, 300)}`, 500);
    const committed = await git(workspace.path, ["commit", "-m", message], 300_000);
    if (committed.code !== 0)
      throw new CodeError(`O commit falhou: ${(committed.stderr || committed.stdout).trim().slice(-600)}`, 500);
    commit = (await git(workspace.path, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  }
  invalidateStatus(workspace);
  let prUrl: string | null = null;
  let prExisted = false;
  let previousPr: PullRequestRef | null = null;
  const base = await resolvePrBase(workspace, input.base);
  if (input.action === "pr" || input.action === "push") {
    if (protectedBranches.has(workspace.branch))
      throw new CodeError(`A branch ${workspace.branch} é protegida: push direto só pela pessoa.`);
    const pushed = await git(workspace.path, ["push", "-u", "origin", workspace.branch], 300_000);
    if (pushed.code !== 0)
      throw new CodeError(`O push falhou: ${(pushed.stderr || pushed.stdout).trim().slice(-600)}`, 500);
    const pulls = await branchPullRequests(workspace);
    const open = pulls.find((pull) => pull.state === "OPEN");
    if (open) {
      prUrl = open.url;
      prExisted = true;
    } else previousPr = pulls[0] ?? null;
  }
  if (input.action === "pr" && !prExisted && !previousPr) {
    const { execFile } = await import("node:child_process");
    prUrl = await new Promise<string>((done, fail) => {
      execFile(
        "gh",
        [
          "pr",
          "create",
          "--base",
          base,
          "--head",
          workspace.branch,
          "--title",
          input.title?.trim() || message,
          "--body",
          input.body?.trim() || message,
        ],
        { cwd: workspace.path, timeout: 120_000 },
        (error, stdout, stderr) =>
          error
            ? fail(
                new CodeError(
                  `Não consegui abrir o PR: ${String(stderr || error.message)
                    .trim()
                    .slice(-600)}`,
                  500,
                ),
              )
            : done(String(stdout).trim().split("\n").pop() ?? ""),
      );
    });
  }
  await touchWorktree(workspace.id, { status: "delivered", ...(prUrl ? { prUrl } : {}) });
  return {
    action: input.action,
    commit,
    prUrl,
    prExisted,
    previousPr,
    files: files.length,
    branch: workspace.branch,
    base,
  };
}

const protectedBranches = new Set(["main", "master", "develop"]);

export interface PullRequestRef {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  baseRefName: string;
}

async function branchPullRequests(workspace: WorkspaceState) {
  const { execFile } = await import("node:child_process");
  return new Promise<PullRequestRef[]>((done) => {
    execFile(
      "gh",
      [
        "pr",
        "list",
        "--head",
        workspace.branch,
        "--state",
        "all",
        "--json",
        "number,url,state,baseRefName,updatedAt",
        "--limit",
        "10",
      ],
      { cwd: workspace.path, timeout: 60_000 },
      (error, stdout) => {
        if (error) return done([]);
        try {
          const list = JSON.parse(String(stdout)) as Array<PullRequestRef & { updatedAt?: string }>;
          done(
            [...list]
              .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
              .map(({ number, url, state, baseRefName }) => ({ number, url, state, baseRefName })),
          );
        } catch {
          done([]);
        }
      },
    );
  });
}
