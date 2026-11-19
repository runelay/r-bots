import { childEnv, run } from "@runelay-bots/providers/proc";
import { env } from "../../../config/env";
import { allStoredSessions, type StoredSession } from "../../conversations/services/sessions.service";
import { isBusy } from "../../engine/services/engine.service";
import { appWatching } from "../../status/services/viewers.service";
import { touchWorktree } from "../repositories/code.repository";
import { stopDevServers } from "./dev-server.service";
import {
  activeWorkspace,
  CodeError,
  closeWorkspace,
  git,
  publicWorkspace,
  type WorkspaceState,
} from "./workspace.service";

export type PrStatus = "open" | "draft" | "merged" | "closed";
export type CheckStatus = "pending" | "success" | "failure" | "skipped" | "neutral";
export type CiStatus = "none" | "pending" | "success" | "failure";
export type ReviewStatus = "approved" | "changes_requested" | "review_required" | null;
export type FileCategory = "code" | "tests" | "generated" | "docs";

export interface PrCheck {
  name: string;
  workflow: string | null;
  status: CheckStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  url: string | null;
}

export interface PrCategoryCount {
  files: number;
  added: number;
  removed: number;
}

export interface PrSnapshot {
  number: number;
  title: string;
  url: string;
  status: PrStatus;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  files: number;
  categories: Record<FileCategory, PrCategoryCount>;
  checks: PrCheck[];
  ci: CiStatus;
  review: ReviewStatus;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string | null;
  fetchedAt: string;
}

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

const viewFields =
  "number,title,state,isDraft,mergedAt,closedAt,baseRefName,headRefName,additions,deletions,files,statusCheckRollup,reviewDecision,url,updatedAt";
const tickMs = 10_000;
const pendingDelayMs = 30_000;
const openDelayMs = 2 * 60_000;
const closedDelayMs = 10 * 60_000;
const discoverDelayMs = 2 * 60_000;
const autoCloseMs = env.CODE_PR_AUTOCLOSE_HOURS * 3600_000;
const nextCheck = new Map<string, number>();
const inFlight = new Set<string>();
const ghBin = env.CODE_GH_BIN ?? "gh";

function gh(cwd: string, args: string[], timeoutMs = 30_000): Promise<GhResult> {
  return run(ghBin, args, { cwd, timeoutMs, env: childEnv({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }) });
}

const generatedPatterns = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Package\.resolved|Podfile\.lock|uv\.lock)$/,
  /(^|\/)(dist|build|out|\.next|generated|__generated__)\//,
  /\.(gen|generated)\.[\w]+$/,
  /\.min\.(js|css)$/,
  /\.snap$/,
  /(^|\/)migrations\/meta\//,
  /_snapshot\.json$/,
  /(^|\/)_journal\.json$/,
  /\.d\.ts\.map$|\.js\.map$/,
];
const docPatterns = [/\.(md|mdx|markdown|rst|txt)$/i, /(^|\/)docs?\//i, /(^|\/)(LICENSE|CHANGELOG|README)(\.\w+)?$/i];
const testPatterns = [
  /\.(test|spec)\.[\w]+$/,
  /(^|\/)(__tests__|_tests_|tests?|e2e|__mocks__|fixtures)\//,
  /(^|\/)Tests\//,
  /_test\.(go|py)$/,
  /(^|\/)test_[\w]+\.py$/,
];

export function classifyFile(path: string): FileCategory {
  if (generatedPatterns.some((pattern) => pattern.test(path))) return "generated";
  if (testPatterns.some((pattern) => pattern.test(path))) return "tests";
  if (docPatterns.some((pattern) => pattern.test(path))) return "docs";
  return "code";
}

function emptyCategories(): Record<FileCategory, PrCategoryCount> {
  return {
    code: { files: 0, added: 0, removed: 0 },
    tests: { files: 0, added: 0, removed: 0 },
    generated: { files: 0, added: 0, removed: 0 },
    docs: { files: 0, added: 0, removed: 0 },
  };
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !value || value.startsWith("0001-")) return null;
  return value;
}

function checkOf(item: Record<string, unknown>): PrCheck {
  if (item.__typename === "StatusContext") {
    const state = String(item.state ?? "").toUpperCase();
    const status: CheckStatus =
      state === "SUCCESS" ? "success" : state === "FAILURE" || state === "ERROR" ? "failure" : "pending";
    return {
      name: String(item.context ?? "status"),
      workflow: null,
      status,
      startedAt: validDate(item.startedAt),
      completedAt: null,
      durationMs: null,
      url: typeof item.targetUrl === "string" && item.targetUrl ? item.targetUrl : null,
    };
  }
  const conclusion = String(item.conclusion ?? "").toUpperCase();
  const running = String(item.status ?? "").toUpperCase() !== "COMPLETED";
  const status: CheckStatus = running
    ? "pending"
    : conclusion === "SUCCESS"
      ? "success"
      : conclusion === "SKIPPED"
        ? "skipped"
        : conclusion === "NEUTRAL"
          ? "neutral"
          : "failure";
  const startedAt = validDate(item.startedAt);
  const completedAt = running ? null : validDate(item.completedAt);
  const durationMs = startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null;
  return {
    name: String(item.name ?? "check"),
    workflow: typeof item.workflowName === "string" && item.workflowName ? item.workflowName : null,
    status,
    startedAt,
    completedAt,
    durationMs,
    url: typeof item.detailsUrl === "string" && item.detailsUrl ? item.detailsUrl : null,
  };
}

function ciOf(checks: PrCheck[]): CiStatus {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.status === "failure")) return "failure";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "success";
}

export function snapshotFromView(view: Record<string, unknown>): PrSnapshot {
  const categories = emptyCategories();
  const files = (view.files as Array<{ path?: string; additions?: number; deletions?: number }> | undefined) ?? [];
  for (const file of files) {
    const bucket = categories[classifyFile(String(file.path ?? ""))];
    bucket.files++;
    bucket.added += Number(file.additions ?? 0);
    bucket.removed += Number(file.deletions ?? 0);
  }
  const latest = new Map<string, PrCheck>();
  for (const raw of (view.statusCheckRollup as Array<Record<string, unknown>> | undefined) ?? []) {
    const check = checkOf(raw);
    const key = `${check.workflow ?? ""}/${check.name}`;
    const current = latest.get(key);
    if (!current || (check.startedAt ?? "") >= (current.startedAt ?? "")) latest.set(key, check);
  }
  const checks = [...latest.values()];
  const state = String(view.state ?? "").toUpperCase();
  const status: PrStatus =
    state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : view.isDraft ? "draft" : "open";
  const decision = String(view.reviewDecision ?? "").toUpperCase();
  const review: ReviewStatus =
    decision === "APPROVED"
      ? "approved"
      : decision === "CHANGES_REQUESTED"
        ? "changes_requested"
        : decision === "REVIEW_REQUIRED"
          ? "review_required"
          : null;
  return {
    number: Number(view.number),
    title: String(view.title ?? ""),
    url: String(view.url ?? ""),
    status,
    base: String(view.baseRefName ?? ""),
    head: String(view.headRefName ?? ""),
    additions: Number(view.additions ?? 0),
    deletions: Number(view.deletions ?? 0),
    files: files.length,
    categories,
    checks,
    ci: ciOf(checks),
    review,
    mergedAt: validDate(view.mergedAt),
    closedAt: validDate(view.closedAt),
    updatedAt: validDate(view.updatedAt),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchPr(cwd: string, ref: string | number) {
  const result = await gh(cwd, ["pr", "view", String(ref), "--json", viewFields]);
  if (result.code !== 0) return null;
  try {
    return snapshotFromView(JSON.parse(result.stdout) as Record<string, unknown>);
  } catch {
    return null;
  }
}

async function hasUpstream(workspace: WorkspaceState) {
  return (await git(workspace.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).code === 0;
}

async function wasPushed(workspace: WorkspaceState) {
  if (await hasUpstream(workspace)) return true;
  return (
    (await git(workspace.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${workspace.branch}`]))
      .code === 0
  );
}

export async function discoverPr(workspace: WorkspaceState) {
  const result = await gh(workspace.path, [
    "pr",
    "list",
    "--head",
    workspace.branch,
    "--state",
    "all",
    "--json",
    "number,url,updatedAt",
    "--limit",
    "5",
  ]);
  if (result.code !== 0) return null;
  try {
    const list = JSON.parse(result.stdout) as Array<{ number: number; updatedAt?: string }>;
    const newest = [...list].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
    return newest ? newest.number : null;
  } catch {
    return null;
  }
}

function cleanLogLine(line: string) {
  return line
    .replace(/(\u001b|\^\[)\[[0-9;]*m/g, "")
    .replace(/^[^\t]*\t[^\t]*\t/, "")
    .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "")
    .trimEnd();
}

export function summarizeLog(raw: string) {
  const lines = raw.split("\n").map(cleanLogLine);
  const end = lines.findIndex((line) => /^(Post job cleanup|Cleaning up orphan processes)/.test(line));
  const body = (end >= 0 ? lines.slice(0, end) : lines).filter(
    (line) => !/^##\[(group|endgroup)\]|Process completed with exit code|^\s*✓ /.test(line),
  );
  while (body.length > 0 && !body[body.length - 1].trim()) body.pop();
  const marker = body.findIndex((line) => /Failed Tests \d|^\s*FAIL\s|^error(\[|:)|^ERR!|npm ERR!/.test(line));
  const tail = marker >= 0 ? body.slice(marker, marker + 45) : body.slice(-45);
  const compact: string[] = [];
  for (const line of tail) {
    if (!line.trim() && !compact[compact.length - 1]?.trim()) continue;
    compact.push(line.replace(/^##\[error\]/, "Erro: "));
  }
  const text = compact.join("\n").trim();
  return text.length > 4000 ? text.slice(-4000) : text;
}

export async function failedLog(workspace: WorkspaceState, check: PrCheck) {
  const match = check.url?.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  if (!match) return null;
  const args = match[2]
    ? ["run", "view", "--job", match[2], "--log-failed"]
    : ["run", "view", match[1], "--log-failed"];
  const result = await gh(workspace.path, args, 60_000);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return summarizeLog(result.stdout) || null;
}

export async function reviewSummary(workspace: WorkspaceState, number: number) {
  const reviews = await gh(workspace.path, ["pr", "view", String(number), "--json", "reviews"]);
  let review: { id?: string; body?: string; author?: string } | null = null;
  try {
    const list =
      (
        JSON.parse(reviews.stdout) as {
          reviews?: Array<{
            id?: string;
            state?: string;
            body?: string;
            author?: { login?: string };
            submittedAt?: string;
          }>;
        }
      ).reviews ?? [];
    const latest = list
      .filter((item) => item.state === "CHANGES_REQUESTED")
      .sort((a, b) => String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")))[0];
    if (latest) review = { id: latest.id, body: latest.body?.trim(), author: latest.author?.login };
  } catch {}
  const comments: Array<{ path: string; line: number | null; body: string }> = [];
  const inline = await gh(workspace.path, ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate"]);
  try {
    const list = JSON.parse(inline.stdout) as Array<{
      path?: string;
      line?: number | null;
      original_line?: number | null;
      body?: string;
      in_reply_to_id?: number;
      created_at?: string;
    }>;
    for (const item of list.filter((entry) => !entry.in_reply_to_id).slice(-8)) {
      comments.push({
        path: String(item.path ?? ""),
        line: item.line ?? item.original_line ?? null,
        body: String(item.body ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
      });
    }
  } catch {}
  return {
    author: review?.author ?? null,
    body: review?.body ? review.body.replace(/\s+/g, " ").slice(0, 400) : null,
    comments,
  };
}

function sameState(a: PrSnapshot | null | undefined, b: PrSnapshot) {
  if (!a) return false;
  const strip = (value: PrSnapshot) => JSON.stringify({ ...value, fetchedAt: null });
  return strip(a) === strip(b);
}

function delayFor(pr: PrSnapshot | null) {
  const away = appWatching() ? 1 : 4;
  if (!pr) return discoverDelayMs * away;
  if (pr.status === "merged") return closedDelayMs * away;
  if (pr.status === "closed") return closedDelayMs * away;
  return (pr.ci === "pending" ? pendingDelayMs : openDelayMs) * away;
}

function publicPr(workspace: WorkspaceState, pr: PrSnapshot) {
  return { workspaceId: workspace.id, repoName: workspace.repoName, ...pr };
}

async function applySnapshot(session: StoredSession, workspace: WorkspaceState, next: PrSnapshot) {
  const previous = workspace.pr ?? null;
  workspace.pr = next;
  if (sameState(previous, next)) return;
  await session.save();
  session.log.emit({ type: "code.pr", data: publicPr(workspace, next) });
  if (previous && previous.number !== next.number) return;
  const failedBefore = new Set(
    (previous?.checks ?? []).filter((check) => check.status === "failure").map((check) => `${check.name}|${check.url}`),
  );
  const failedNow = next.checks.filter(
    (check) => check.status === "failure" && !failedBefore.has(`${check.name}|${check.url}`),
  );
  if (next.ci === "failure" && failedNow.length > 0 && next.status !== "merged") {
    const first = failedNow[0];
    const log = await failedLog(workspace, first).catch(() => null);
    session.log.emit({
      type: "code.ci",
      data: {
        workspaceId: workspace.id,
        number: next.number,
        prUrl: next.url,
        outcome: "failure",
        check: first,
        failed: failedNow.map((check) => ({ name: check.name, url: check.url })),
        log,
      },
    });
  } else if (previous && (previous.ci === "pending" || previous.ci === "failure") && next.ci === "success") {
    session.log.emit({
      type: "code.ci",
      data: {
        workspaceId: workspace.id,
        number: next.number,
        prUrl: next.url,
        outcome: "success",
        checks: next.checks.length,
      },
    });
  }
  if (next.review === "changes_requested" && previous?.review !== "changes_requested") {
    const summary = await reviewSummary(workspace, next.number).catch(() => ({
      author: null,
      body: null,
      comments: [],
    }));
    session.log.emit({
      type: "code.review",
      data: { workspaceId: workspace.id, number: next.number, prUrl: next.url, state: "changes_requested", ...summary },
    });
  } else if (next.review === "approved" && previous && previous.review !== "approved") {
    session.log.emit({
      type: "code.review",
      data: { workspaceId: workspace.id, number: next.number, prUrl: next.url, state: "approved" },
    });
  }
  if (next.status !== previous?.status && (next.status === "merged" || next.status === "closed")) {
    await touchWorktree(workspace.id, { prUrl: next.url });
  }
}

export async function refreshPr(session: StoredSession, discover = true) {
  const workspace = activeWorkspace(session);
  if (!workspace) return null;
  const key = session.meta.sessionId;
  if (inFlight.has(key)) return workspace.pr ?? null;
  inFlight.add(key);
  try {
    let number = workspace.pr?.number ?? null;
    if (!number && discover && (await wasPushed(workspace))) number = await discoverPr(workspace);
    if (!number) return null;
    const next = await fetchPr(workspace.path, number);
    if (!next) return workspace.pr ?? null;
    await applySnapshot(session, workspace, next);
    nextCheck.set(key, Date.now() + delayFor(next));
    return next;
  } finally {
    inFlight.delete(key);
  }
}

export function kickPr(session: StoredSession, url?: string | null) {
  const workspace = activeWorkspace(session);
  if (!workspace) return;
  const number = url?.match(/\/pull\/(\d+)/)?.[1];
  if (number && !workspace.pr) {
    void fetchPr(workspace.path, number)
      .then((pr) => pr && applySnapshot(session, workspace, pr))
      .catch((error) => console.warn("pr fetch failed", error));
    nextCheck.set(session.meta.sessionId, Date.now() + pendingDelayMs);
    return;
  }
  nextCheck.set(session.meta.sessionId, Date.now());
}

async function isClean(workspace: WorkspaceState) {
  const dirty = (await git(workspace.path, ["status", "--porcelain"])).stdout.trim();
  if (dirty)
    return { clean: false, reason: "Tem mudança não commitada na worktree. Commite ou descarte antes de fechar." };
  const upstream = await hasUpstream(workspace);
  if (upstream) {
    const ahead = (await git(workspace.path, ["rev-list", "--count", "@{u}..HEAD"])).stdout.trim();
    if (ahead && ahead !== "0")
      return {
        clean: false,
        reason: `Tem ${ahead} commit${ahead === "1" ? "" : "s"} que não ${ahead === "1" ? "foi" : "foram"} para o GitHub.`,
      };
  }
  return { clean: true, reason: "" };
}

export async function finishWorkspace(session: StoredSession, by: "user" | "auto") {
  const workspace = activeWorkspace(session);
  if (!workspace) throw new CodeError("Esta conversa não tem repositório aberto.", 404);
  if (isBusy(session.meta.sessionId)) throw new CodeError("O bot ainda está trabalhando.", 409);
  const check = await isClean(workspace);
  if (!check.clean) throw new CodeError(check.reason, 409);
  await stopDevServers(workspace);
  const removed = await git(workspace.repo, ["worktree", "remove", workspace.path], 120_000);
  if (removed.code !== 0)
    throw new CodeError(
      `Não consegui remover a worktree: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`,
      500,
    );
  await closeWorkspace(session, true);
  session.meta.providerSessions = {};
  await session.save();
  await touchWorktree(workspace.id, { status: "removed" });
  nextCheck.delete(session.meta.sessionId);
  const pr = workspace.pr ? { number: workspace.pr.number, status: workspace.pr.status, url: workspace.pr.url } : null;
  session.log.emit({ type: "code.workspace", data: { action: "removed", by, ...publicWorkspace(workspace), pr } });
  return { ok: true, path: workspace.path, branch: workspace.branch, pr };
}

export async function reopenPr(session: StoredSession) {
  const workspace = activeWorkspace(session);
  if (!workspace?.pr) throw new CodeError("Esta conversa não tem PR.", 404);
  if (workspace.pr.status !== "closed") throw new CodeError("O PR não está fechado.", 409);
  const result = await gh(workspace.path, ["pr", "reopen", String(workspace.pr.number)], 60_000);
  if (result.code !== 0)
    throw new CodeError(`Não consegui reabrir o PR: ${(result.stderr || result.stdout).trim().slice(0, 300)}`, 500);
  nextCheck.set(session.meta.sessionId, Date.now());
  return refreshPr(session);
}

async function autoClose(session: StoredSession, workspace: WorkspaceState) {
  const pr = workspace.pr;
  if (!pr || pr.status !== "merged" || !pr.mergedAt) return;
  if (Date.now() - Date.parse(pr.mergedAt) < autoCloseMs) return;
  if (isBusy(session.meta.sessionId)) return;
  if (!(await isClean(workspace)).clean) return;
  await finishWorkspace(session, "auto");
}

async function tick() {
  const now = Date.now();
  for (const session of allStoredSessions()) {
    const workspace = activeWorkspace(session);
    if (!workspace) continue;
    const key = session.meta.sessionId;
    const due = nextCheck.get(key) ?? 0;
    if (due > now) continue;
    nextCheck.set(key, now + delayFor(workspace.pr ?? null));
    try {
      if (workspace.pr?.status !== "merged") await refreshPr(session);
      await autoClose(session, workspace);
    } catch (error) {
      console.warn("pr watch failed", key, error instanceof Error ? error.message : error);
    }
  }
}

export function startPrWatcher() {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void tick().finally(() => {
      running = false;
    });
  };
  setTimeout(run, 5_000).unref();
  setInterval(run, tickMs).unref();
}
