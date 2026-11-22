import { join } from "node:path";
import { childEnv, run } from "@runelay-bots/providers/proc";
import { getStoredSession, type StoredSession } from "../../conversations/services/sessions.service";
import { recordWorktree, touchWorktree, worktreeById } from "../repositories/code.repository";
import { stopDevServers } from "./dev-server.service";
import { applyPendingSync, cleanSyncAfterDeliver } from "./mac-sync.service";
import {
  activeWorkspace,
  activeWorkspaces,
  addWorkspace,
  baseContent,
  CodeError,
  changedFiles,
  closeWorkspace,
  git,
  gitSafeEnv,
  invalidateStatus,
  listRepos,
  openWorkspace,
  publicWorkspace,
  readHead,
  readMaybe,
  resolveRepo,
  shareWithSandbox,
  taskSlug,
  taskWorktreeId,
  type WorkspaceState,
  workspaceAt,
  workspaceById,
  workspaceFromRecord,
  workspacesOf,
  worktreeIdAt,
} from "./workspace.service";

async function pendingWork(path: string) {
  if ((await git(path, ["status", "--porcelain"])).stdout.trim()) return true;
  const upstream = await git(path, ["rev-list", "--count", "@{u}..HEAD"]);
  return upstream.code === 0 && upstream.stdout.trim() !== "0";
}

async function claimPrevious(session: StoredSession, botId: string, repoInput: string, task: string) {
  const repo = await resolveRepo(repoInput);
  if (workspacesOf(session).some((item) => item.repo === repo.path)) return null;
  const record = await worktreeById(taskWorktreeId(repo.name, botId, taskSlug(session, task)));
  if (!record || record.botId !== botId || record.repo !== repo.path || record.status === "removed") return null;
  if (record.sessionId !== session.meta.sessionId) {
    const owner = getStoredSession(record.sessionId);
    if (activeWorkspaces(owner).some((item) => item.id === record.id)) return null;
  }
  const head = await readHead(record.path);
  if (!head) return null;
  if (record.status !== "alive" && !(await pendingWork(record.path))) return null;
  const workspace = workspaceFromRecord(record);
  if (head.branch) workspace.branch = head.branch;
  workspace.task = task.slice(0, 300);
  addWorkspace(session, workspace, true);
  await session.save();
  await shareWithSandbox(workspace);
  session.log.emit({ type: "code.workspace", data: { action: "adopted", ...publicWorkspace(workspace) } });
  await touchWorktree(record.id, { status: "alive", sessionId: session.meta.sessionId });
  return workspace;
}

export async function openTaskWorkspace(session: StoredSession, botId: string, repo: string, task: string) {
  const previous = await claimPrevious(session, botId, repo, task);
  if (previous) return { workspace: previous, created: false };
  const result = await openWorkspace(session, botId, repo, task);
  await recordWorktree(result.workspace, botId, session.meta.sessionId, "alive");
  return result;
}

const adoptable = new Set(["alive", "delivered"]);

export async function adoptWorkspaceAt(session: StoredSession, path: string) {
  if (workspaceAt(session, path)) return null;
  const spot = worktreeIdAt(path);
  if (!spot) return null;
  const known = workspaceById(session, spot.id);
  if (known?.active) return null;
  const record = await worktreeById(spot.id);
  if (
    !record ||
    record.sessionId !== session.meta.sessionId ||
    record.botId !== session.meta.botId ||
    record.path !== spot.path ||
    !adoptable.has(record.status)
  )
    return null;
  const head = await readHead(record.path).catch(() => null);
  if (!head) return null;
  const workspace = known ?? workspaceFromRecord(record);
  workspace.active = true;
  workspace.closedAt = null;
  if (head.branch) workspace.branch = head.branch;
  addWorkspace(session, workspace, false);
  await session.save();
  await shareWithSandbox(workspace);
  session.log.emit({ type: "code.workspace", data: { action: "adopted", ...publicWorkspace(workspace) } });
  await touchWorktree(workspace.id, { status: "alive" });
  return workspace;
}

export async function closeTaskWorkspace(session: StoredSession, target?: WorkspaceState | null) {
  const workspace = target ?? activeWorkspace(session);
  if (!workspace?.active) return null;
  const primary = activeWorkspace(session) === workspace;
  await stopDevServers(workspace);
  await closeWorkspace(session, false, workspace);
  if (primary) session.meta.providerSessions = {};
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

const hookPaths =
  /^(\.husky|\.githooks|\.git-hooks|\.lefthook|\.github\/workflows)\/|(^|\/)(lefthook\.ya?ml|\.pre-commit-config\.ya?ml|\.huskyrc(\.\w+)?|\.npmrc|\.yarnrc(\.yml)?|bunfig\.toml)$/;
function scriptsOf(text: string | null) {
  if (text === null) return "";
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown; husky?: unknown; "simple-git-hooks"?: unknown };
    return JSON.stringify([parsed.scripts ?? null, parsed.husky ?? null, parsed["simple-git-hooks"] ?? null]);
  } catch {
    return null;
  }
}

export async function deliverRisk(workspace: WorkspaceState) {
  const files = await changedFiles(workspace, true);
  const risky: string[] = [];
  for (const file of files) {
    if (hookPaths.test(file.path)) risky.push(file.path);
    else if (/(^|\/)package\.json$/.test(file.path)) {
      const before = scriptsOf(await baseContent(workspace, file.path));
      const after = scriptsOf(await readMaybe(join(workspace.path, file.path)));
      if (before === null || after === null || before !== after) risky.push(file.path);
    }
  }
  return risky;
}

export async function deliverWorkspace(workspace: WorkspaceState, input: DeliverInput) {
  await applyPendingSync(workspace.path);
  const message = input.message.trim();
  const pending = (await git(workspace.path, ["status", "--porcelain"])).stdout.trim();
  const problem = deliverProblem(input, Boolean(pending));
  if (problem) throw new CodeError(problem);
  const files = await changedFiles(workspace, true);
  let commit: string | null = null;
  if (pending) {
    const added = await git(workspace.path, ["add", "-A"]);
    if (added.code !== 0) throw new CodeError(`git add falhou: ${added.stderr.trim().slice(0, 300)}`, 500);
    const committed = await git(workspace.path, ["commit", "--no-verify", "-m", message], 300_000);
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
    const pushed = await git(workspace.path, ["push", "--no-verify", "-u", "origin", workspace.branch], 300_000);
    if (pushed.code !== 0)
      throw new CodeError(`O push falhou: ${(pushed.stderr || pushed.stdout).trim().slice(-600)}`, 500);
    await cleanSyncAfterDeliver(workspace.path).catch((error) =>
      console.warn(`mac sync: ref não apagada: ${error instanceof Error ? error.message : error}`),
    );
    const pulls = await branchPullRequests(workspace);
    const open = pulls.find((pull) => pull.state === "OPEN");
    if (open) {
      prUrl = open.url;
      prExisted = true;
    } else previousPr = pulls[0] ?? null;
  }
  if (input.action === "pr" && !prExisted && !previousPr) {
    const created = await run(
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
      {
        cwd: workspace.path,
        timeoutMs: 120_000,
        env: childEnv({ GH_PROMPT_DISABLED: "1", ...gitSafeEnv(workspace.path) }),
      },
    );
    if (created.code !== 0)
      throw new CodeError(
        `Não consegui abrir o PR: ${String(created.stderr || `gh saiu com código ${created.code}`)
          .trim()
          .slice(-600)}`,
        500,
      );
    prUrl = created.stdout.trim().split("\n").pop() ?? "";
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
  const { code, stdout } = await run(
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
    {
      cwd: workspace.path,
      timeoutMs: 60_000,
      env: childEnv({ GH_PROMPT_DISABLED: "1", ...gitSafeEnv(workspace.path) }),
    },
  );
  if (code !== 0) return [];
  try {
    const list = JSON.parse(stdout) as Array<PullRequestRef & { updatedAt?: string }>;
    return [...list]
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
      .map(({ number, url, state, baseRefName }) => ({ number, url, state, baseRefName }));
  } catch {
    return [];
  }
}
