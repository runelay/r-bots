import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessCall, ProcessReply } from "../../../../test/helpers";
import { resetData } from "../../../../test/helpers";
import { codeProcesses, factsOf, ghArgs, gitArgs, gitSync, makeRepo, newSession } from "../../../../test/code-helpers";
import * as engine from "../../engine/services/engine.service";
import { watchApp } from "../../status/services/viewers.service";
import { listWorktrees, recordWorktree } from "../repositories/code.repository";
import {
  classifyFile,
  discoverPr,
  failedLog,
  fetchPr,
  finishWorkspace,
  kickPr,
  type PrCheck,
  refreshPr,
  reopenPr,
  reviewSummary,
  snapshotFromView,
  startPrWatcher,
  summarizeLog,
} from "../services/pull-request.service";
import {
  activeWorkspace,
  listRepos,
  openWorkspace,
  waitForInstall,
  type WorkspaceState,
} from "../services/workspace.service";

beforeEach(async () => {
  await resetData();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("classification and snapshots", () => {
  test("classifies files as generated, tests, docs or code", () => {
    expect(classifyFile("bun.lock")).toBe("generated");
    expect(classifyFile("apps/web/dist/main.js")).toBe("generated");
    expect(classifyFile("src/api.gen.ts")).toBe("generated");
    expect(classifyFile("src/a.test.ts")).toBe("tests");
    expect(classifyFile("src/__tests__/a.ts")).toBe("tests");
    expect(classifyFile("pkg/foo_test.go")).toBe("tests");
    expect(classifyFile("docs/guide.txt")).toBe("docs");
    expect(classifyFile("README")).toBe("docs");
    expect(classifyFile("src/index.ts")).toBe("code");
  });

  test("builds a snapshot from gh pr view output", () => {
    const snapshot = snapshotFromView({
      number: 12,
      title: "feat: x",
      url: "https://github.com/o/r/pull/12",
      state: "OPEN",
      isDraft: true,
      baseRefName: "main",
      headRefName: "feat/x",
      additions: 10,
      deletions: 2,
      reviewDecision: "REVIEW_REQUIRED",
      mergedAt: "0001-01-01T00:00:00Z",
      closedAt: "",
      updatedAt: "2026-01-01T00:00:00Z",
      files: [
        { path: "src/a.ts", additions: 5, deletions: 1 },
        { path: "src/a.test.ts", additions: 3 },
        { path: "README.md", deletions: 1 },
        { path: "bun.lock", additions: 2, deletions: 0 },
        {},
      ],
      statusCheckRollup: [
        { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci/1" },
        { __typename: "StatusContext", state: "ERROR", targetUrl: "" },
        { __typename: "StatusContext", context: "ci/fail", state: "FAILURE" },
        { __typename: "StatusContext", context: "ci/wait", state: "PENDING", startedAt: "2026-01-01T00:00:00Z" },
        {
          name: "build",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:00Z",
          detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
        },
        {
          name: "build",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          startedAt: "2026-01-01T00:01:00Z",
          completedAt: "2026-01-01T00:03:30Z",
          detailsUrl: "",
        },
        { name: "lint", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-01-01T00:02:00Z" },
        { name: "lint", status: "COMPLETED", conclusion: "NEUTRAL", startedAt: "2026-01-01T00:00:30Z" },
        { name: "e2e", status: "IN_PROGRESS", completedAt: "2026-01-01T00:00:00Z" },
        { status: "COMPLETED", conclusion: "NEUTRAL", workflowName: "" },
      ],
    });
    expect(snapshot).toMatchObject({
      number: 12,
      status: "draft",
      review: "review_required",
      files: 5,
      mergedAt: null,
      closedAt: null,
      updatedAt: "2026-01-01T00:00:00Z",
      ci: "failure",
    });
    expect(snapshot.categories).toEqual({
      code: { files: 2, added: 5, removed: 1 },
      tests: { files: 1, added: 3, removed: 0 },
      generated: { files: 1, added: 2, removed: 0 },
      docs: { files: 1, added: 0, removed: 1 },
    });
    const byName = Object.fromEntries(snapshot.checks.map((check) => [check.name, check]));
    expect(byName["ci/legacy"]).toMatchObject({ status: "success", url: "https://ci/1", workflow: null });
    expect(byName.status).toMatchObject({ status: "failure", url: null });
    expect(byName["ci/fail"].status).toBe("failure");
    expect(byName["ci/wait"]).toMatchObject({ status: "pending", startedAt: "2026-01-01T00:00:00Z" });
    expect(byName.build).toMatchObject({ status: "success", durationMs: 150_000, url: null, workflow: "CI" });
    expect(byName.lint.status).toBe("skipped");
    expect(byName.e2e).toMatchObject({ status: "pending", completedAt: null, durationMs: null });
    expect(byName.check).toMatchObject({ status: "neutral", workflow: null });

    const merged = snapshotFromView({ number: 1, state: "MERGED", reviewDecision: "APPROVED" });
    expect(merged).toMatchObject({ status: "merged", review: "approved", ci: "none", title: "", url: "", files: 0 });
    expect(snapshotFromView({ number: 1, state: "CLOSED", reviewDecision: "CHANGES_REQUESTED" })).toMatchObject({
      status: "closed",
      review: "changes_requested",
    });
    expect(snapshotFromView({ number: 1, state: "OPEN", reviewDecision: "" })).toMatchObject({
      status: "open",
      review: null,
    });
    expect(snapshotFromView({ number: 1, statusCheckRollup: [{ name: "a", status: "QUEUED" }] }).ci).toBe("pending");
    expect(
      snapshotFromView({ number: 1, statusCheckRollup: [{ name: "a", status: "COMPLETED", conclusion: "SUCCESS" }] })
        .ci,
    ).toBe("success");
  });

  test("summarizes failed CI logs", () => {
    const raw = [
      "build\tstep\t2026-01-01T00:00:00.000Z ##[group]Run tests",
      "build\tstep\t2026-01-01T00:00:00.000Z \u001b[31msetup\u001b[0m",
      "build\tstep\t2026-01-01T00:00:00.000Z  ✓ passing test",
      "build\tstep\t2026-01-01T00:00:00.000Z FAIL src/a.test.ts",
      "build\tstep\t2026-01-01T00:00:00.000Z expected 1",
      "build\tstep\t2026-01-01T00:00:00.000Z ",
      "build\tstep\t2026-01-01T00:00:00.000Z ",
      "build\tstep\t2026-01-01T00:00:00.000Z ##[error]Process failed",
      "build\tstep\t2026-01-01T00:00:00.000Z Process completed with exit code 1",
      "build\tstep\t2026-01-01T00:00:00.000Z Post job cleanup",
      "build\tstep\t2026-01-01T00:00:00.000Z after cleanup",
    ].join("\n");
    expect(summarizeLog(raw)).toBe("FAIL src/a.test.ts\nexpected 1\n\nErro: Process failed");
    const plain = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    const tail = summarizeLog(`${plain}\n\n`).split("\n");
    expect(tail).toHaveLength(45);
    expect(tail[0]).toBe("line 15");
    expect(summarizeLog(`error: ${"x".repeat(5000)}`)).toHaveLength(4000);
  });
});

type GhReply = ProcessReply | ((call: ProcessCall) => ProcessReply);

function gh(routes: Record<string, GhReply>) {
  return codeProcesses((call) => {
    if (call.command === "git") return undefined;
    if (!call.command.endsWith("gh")) return undefined;
    const key = Object.keys(routes).find((prefix) => call.args.join(" ").startsWith(prefix));
    if (!key) return { code: 1, stderr: `unexpected gh ${call.args.join(" ")}` };
    const reply = routes[key];
    return typeof reply === "function" ? reply(call) : reply;
  });
}

const workspaceStub = { path: "/tmp", branch: "feat/x" } as WorkspaceState;

describe("gh lookups", () => {
  test("fetches, discovers and reads logs and reviews", async () => {
    const fake = gh({
      "pr view 5 --json number": { stdout: JSON.stringify({ number: 5, state: "OPEN" }) },
      "pr view 6 --json number": { stdout: "not json" },
      "pr view 7 --json number": { code: 1 },
      "pr list": {
        stdout: JSON.stringify([
          { number: 1, updatedAt: "2026-01-01" },
          { number: 2, updatedAt: "2026-02-01" },
          { number: 3 },
        ]),
      },
      "run view --job 22": { stdout: "error: broke\n" },
      "run view 11": { stdout: "  \n" },
      "pr view 9 --json reviews": {
        stdout: JSON.stringify({
          reviews: [
            { id: "r1", state: "CHANGES_REQUESTED", body: "old", author: { login: "a" }, submittedAt: "2026-01-01" },
            {
              id: "r2",
              state: "CHANGES_REQUESTED",
              body: "  please\n fix  ",
              author: { login: "b" },
              submittedAt: "2026-02-01",
            },
            { id: "r3", state: "APPROVED", submittedAt: "2026-03-01" },
            { id: "r4", state: "CHANGES_REQUESTED" },
          ],
        }),
      },
      "api repos/{owner}/{repo}/pulls/9/comments": {
        stdout: JSON.stringify([
          { path: "src/a.ts", line: 3, body: "use   const" },
          { path: "src/b.ts", original_line: 8, body: "x".repeat(300) },
          { in_reply_to_id: 1, body: "reply" },
          {},
        ]),
      },
      "pr view 10 --json reviews": { stdout: JSON.stringify({}) },
      "api repos/{owner}/{repo}/pulls/10/comments": { stdout: "oops" },
      "pr view 11 --json reviews": { stdout: "oops" },
      "api repos/{owner}/{repo}/pulls/11/comments": { stdout: "[]" },
    });
    expect((await fetchPr("/tmp", 5))?.number).toBe(5);
    expect(await fetchPr("/tmp", 6)).toBeNull();
    expect(await fetchPr("/tmp", 7)).toBeNull();
    expect(await discoverPr(workspaceStub)).toBe(2);
    const list = fake.calls.find((call) => call.args[1] === "list");
    expect(list?.args).toContain("feat/x");
    expect((list?.options.env as Record<string, string>).GH_PROMPT_DISABLED).toBe("1");

    const check = (url: string | null) => ({ name: "c", url }) as PrCheck;
    expect(await failedLog(workspaceStub, check(null))).toBeNull();
    expect(await failedLog(workspaceStub, check("https://ci.example/1"))).toBeNull();
    expect(await failedLog(workspaceStub, check("https://github.com/o/r/actions/runs/11/job/22"))).toBe("error: broke");
    expect(await failedLog(workspaceStub, check("https://github.com/o/r/actions/runs/11"))).toBeNull();
    expect(await failedLog(workspaceStub, check("https://github.com/o/r/actions/runs/12"))).toBeNull();

    expect(await reviewSummary(workspaceStub, 9)).toEqual({
      author: "b",
      body: "please fix",
      comments: [
        { path: "src/a.ts", line: 3, body: "use const" },
        { path: "src/b.ts", line: 8, body: "x".repeat(200) },
        { path: "", line: null, body: "" },
      ],
    });
    expect(await reviewSummary(workspaceStub, 10)).toEqual({ author: null, body: null, comments: [] });
    expect(await reviewSummary(workspaceStub, 11)).toEqual({ author: null, body: null, comments: [] });
  });

  test("discovery returns null on failures and empty lists", async () => {
    gh({ "pr list": { code: 1 } });
    expect(await discoverPr(workspaceStub)).toBeNull();
    gh({ "pr list": { stdout: "[]" } });
    expect(await discoverPr(workspaceStub)).toBeNull();
    gh({ "pr list": { stdout: "{" } });
    expect(await discoverPr(workspaceStub)).toBeNull();
  });
});

async function openTask(name: string, options: { origin?: boolean } = { origin: true }) {
  makeRepo(name, options);
  await listRepos(true);
  const session = await newSession(`bot-${name}`);
  const { workspace } = await openWorkspace(session, `bot-${name}`, name, "pr task");
  await waitForInstall(workspace);
  await recordWorktree(workspace, `bot-${name}`, session.meta.sessionId);
  return { session, workspace };
}

function push(workspace: WorkspaceState) {
  writeFileSync(join(workspace.path, "feature.txt"), "x\n");
  gitSync(workspace.path, ["add", "-A"]);
  gitSync(workspace.path, ["commit", "-q", "-m", "feat: x"]);
  gitSync(workspace.path, ["push", "-q", "-u", "origin", workspace.branch]);
}

function view(number: number, patch: Record<string, unknown> = {}) {
  return {
    number,
    title: "feat: x",
    url: `https://github.com/o/r/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/x",
    files: [],
    statusCheckRollup: [],
    reviewDecision: "",
    ...patch,
  };
}

const failing = {
  name: "test",
  status: "COMPLETED",
  conclusion: "FAILURE",
  detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
};
const passing = { ...failing, conclusion: "SUCCESS" };

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(5);
}

describe("refreshing a workspace PR", () => {
  test("discovers the PR of a pushed branch and emits CI and review transitions", async () => {
    const { session, workspace } = await openTask("pr-flow");
    expect(await refreshPr(session)).toBeNull();
    push(workspace);
    let current: Record<string, unknown> = view(7, {
      statusCheckRollup: [failing],
      reviewDecision: "CHANGES_REQUESTED",
    });
    gh({
      "pr list": { stdout: JSON.stringify([{ number: 7, updatedAt: "x" }]) },
      "pr view 7 --json number": () => ({ stdout: JSON.stringify(current) }),
      "pr view 99 --json number": () => ({ stdout: JSON.stringify(view(100)) }),
      "run view --job 2": { stdout: "FAIL a.test.ts\n" },
      "pr view 7 --json reviews": {
        stdout: JSON.stringify({ reviews: [{ state: "CHANGES_REQUESTED", body: "fix", author: { login: "rev" } }] }),
      },
      "api repos": { stdout: "[]" },
    });
    expect(await refreshPr(session, false)).toBeNull();
    const first = await refreshPr(session);
    expect(first?.number).toBe(7);
    expect(workspace.pr?.ci).toBe("failure");
    expect(factsOf(session, "code.pr")).toHaveLength(1);
    expect(factsOf(session, "code.ci")[0].data).toMatchObject({ outcome: "failure", log: "FAIL a.test.ts", number: 7 });
    expect(factsOf(session, "code.review")[0].data).toMatchObject({
      state: "changes_requested",
      author: "rev",
      body: "fix",
    });

    await refreshPr(session);
    expect(factsOf(session, "code.pr")).toHaveLength(1);

    current = view(7, { statusCheckRollup: [passing], reviewDecision: "APPROVED" });
    await refreshPr(session);
    expect(factsOf(session, "code.ci").at(-1)?.data).toMatchObject({ outcome: "success", checks: 1 });
    expect(factsOf(session, "code.review").at(-1)?.data).toMatchObject({ state: "approved" });

    current = view(7, {
      statusCheckRollup: [passing],
      reviewDecision: "APPROVED",
      state: "MERGED",
      mergedAt: "2026-01-01T00:00:00Z",
    });
    await refreshPr(session);
    const record = (await listWorktrees()).find((item) => item.id === workspace.id);
    expect(record?.prUrl).toBe("https://github.com/o/r/pull/7");

    workspace.pr = { ...(workspace.pr as NonNullable<WorkspaceState["pr"]>), number: 99 };
    await refreshPr(session);
    expect(factsOf(session, "code.pr").at(-1)?.data).toMatchObject({ number: 100, workspaceId: workspace.id });

    gh({ "pr view": { code: 1 } });
    expect(await refreshPr(session)).toBe(workspace.pr ?? null);
  });

  test("ignores concurrent refreshes and failures in log and review lookups", async () => {
    const { session, workspace } = await openTask("pr-concurrent");
    push(workspace);
    gh({
      "pr list": { stdout: JSON.stringify([{ number: 3 }]) },
      "pr view 3 --json number": {
        stdout: JSON.stringify(view(3, { statusCheckRollup: [failing], reviewDecision: "CHANGES_REQUESTED" })),
      },
      "run view": { code: 1 },
      "pr view 3 --json reviews": { code: 1 },
      "api repos": { code: 1 },
    });
    const pending = refreshPr(session);
    expect(await refreshPr(session)).toBeNull();
    expect((await pending)?.number).toBe(3);
    expect(factsOf(session, "code.ci")[0].data.log).toBeNull();
    expect(factsOf(session, "code.review")[0].data).toMatchObject({ author: null, body: null, comments: [] });
  });

  test("tolerates log and review lookups that throw", async () => {
    const { session, workspace } = await openTask("pr-throwing");
    workspace.pr = snapshotFromView(view(4));
    gh({
      "pr view 4 --json number": {
        stdout: JSON.stringify(view(4, { statusCheckRollup: [failing], reviewDecision: "CHANGES_REQUESTED" })),
      },
    });
    const { run } = await import("@runelay-bots/providers/proc");
    const proc = await import("@runelay-bots/providers/proc");
    let calls = 0;
    const spy = spyOn(proc, "run").mockImplementation((async (...args: Parameters<typeof run>) => {
      if (args[1][4]?.startsWith("number,title")) return run(...args);
      calls++;
      throw new Error("spawn exploded");
    }) as typeof run);
    try {
      await refreshPr(session);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect(factsOf(session, "code.ci")[0].data.log).toBeNull();
    expect(factsOf(session, "code.review")[0].data).toMatchObject({ author: null, comments: [] });
  });

  test("kicks a PR from a URL or schedules the next check", async () => {
    const { session, workspace } = await openTask("pr-kick");
    kickPr(await newSession("nobody"));
    gh({ "pr view 21 --json number": { stdout: JSON.stringify(view(21)) } });
    kickPr(session, "https://github.com/o/r/pull/21");
    await until(() => Boolean(workspace.pr));
    expect(workspace.pr?.number).toBe(21);
    kickPr(session, "https://github.com/o/r/pull/21");
    kickPr(session);

    const other = await openTask("pr-kick-fail");
    gh({ "pr view 22 --json number": { code: 1 } });
    kickPr(other.session, "https://github.com/o/r/pull/22");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const proc = await import("@runelay-bots/providers/proc");
    const spy = spyOn(proc, "run").mockRejectedValue(new Error("gh crashed"));
    try {
      kickPr(other.session, "https://github.com/o/r/pull/23");
      await until(() => warn.mock.calls.length > 0);
      expect(warn).toHaveBeenCalledWith("pr fetch failed", expect.any(Error));
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect(other.workspace.pr).toBeUndefined();
  });
});

describe("finishing and reopening", () => {
  test("refuses to finish without a workspace, while busy or with local work", async () => {
    await expect(finishWorkspace(await newSession("nobody"), "user")).rejects.toThrow(
      "Esta conversa não tem repositório aberto.",
    );
    const { session, workspace } = await openTask("pr-finish-guard");
    const busy = spyOn(engine, "isBusy").mockReturnValue(true);
    await expect(finishWorkspace(session, "user")).rejects.toThrow("O bot ainda está trabalhando.");
    busy.mockRestore();
    writeFileSync(join(workspace.path, "dirty.txt"), "x");
    await expect(finishWorkspace(session, "user")).rejects.toThrow("Tem mudança não commitada");
    push(workspace);
    writeFileSync(join(workspace.path, "more.txt"), "x");
    gitSync(workspace.path, ["add", "-A"]);
    gitSync(workspace.path, ["commit", "-q", "-m", "feat: more"]);
    await expect(finishWorkspace(session, "user")).rejects.toThrow("Tem 1 commit que não foi para o GitHub.");
    writeFileSync(join(workspace.path, "again.txt"), "x");
    gitSync(workspace.path, ["add", "-A"]);
    gitSync(workspace.path, ["commit", "-q", "-m", "feat: again"]);
    await expect(finishWorkspace(session, "user")).rejects.toThrow("Tem 2 commits que não foram para o GitHub.");
  });

  test("removes the worktree and closes the workspace", async () => {
    const { session, workspace } = await openTask("pr-finish");
    push(workspace);
    workspace.pr = snapshotFromView(view(5, { state: "MERGED" }));
    codeProcesses((call) => (gitArgs(call, "worktree", "remove") ? { code: 1, stderr: "locked worktree" } : undefined));
    await expect(finishWorkspace(session, "user")).rejects.toThrow("Não consegui remover a worktree: locked worktree");
    codeProcesses();
    const result = await finishWorkspace(session, "user");
    expect(result).toEqual({
      ok: true,
      path: workspace.path,
      branch: workspace.branch,
      pr: { number: 5, status: "merged", url: "https://github.com/o/r/pull/5" },
    });
    expect(existsSync(workspace.path)).toBe(false);
    expect(activeWorkspace(session)).toBeNull();
    expect(factsOf(session, "code.workspace").at(-1)?.data).toMatchObject({ action: "removed", by: "user" });
    expect((await listWorktrees()).find((item) => item.id === workspace.id)?.status).toBe("removed");

    const local = await openTask("pr-finish-local", { origin: false });
    expect((await finishWorkspace(local.session, "auto")).pr).toBeNull();
  });

  test("reopens closed PRs only", async () => {
    await expect(reopenPr(await newSession("nobody"))).rejects.toThrow("Esta conversa não tem PR.");
    const { session, workspace } = await openTask("pr-reopen");
    workspace.pr = snapshotFromView(view(8));
    await expect(reopenPr(session)).rejects.toThrow("O PR não está fechado.");
    workspace.pr = snapshotFromView(view(8, { state: "CLOSED" }));
    gh({ "pr reopen": { code: 1, stderr: "no permission" } });
    await expect(reopenPr(session)).rejects.toThrow("Não consegui reabrir o PR: no permission");
    const fake = gh({ "pr reopen 8": { stdout: "" }, "pr view 8 --json number": { stdout: JSON.stringify(view(8)) } });
    const reopened = await reopenPr(session);
    expect(reopened?.status).toBe("open");
    expect(fake.calls.some((call) => ghArgs(call, "pr", "reopen", "8"))).toBe(true);
  });
});

describe("watcher", () => {
  async function tickOnce(advance: number) {
    jest.useFakeTimers();
    startPrWatcher();
    jest.advanceTimersByTime(advance);
    jest.useRealTimers();
  }

  test("refreshes due workspaces and auto-closes merged ones after the grace period", async () => {
    const stopWatching = watchApp();
    const merged = await openTask("pr-watch-merged");
    push(merged.workspace);
    merged.workspace.pr = snapshotFromView(view(31, { state: "MERGED", mergedAt: "2020-01-01T00:00:00Z" }));
    const fresh = await openTask("pr-watch-fresh");
    fresh.workspace.pr = snapshotFromView(view(32, { state: "MERGED", mergedAt: new Date().toISOString() }));
    const open = await openTask("pr-watch-open");
    open.workspace.pr = snapshotFromView(view(33, { statusCheckRollup: [{ name: "x", status: "QUEUED" }] }));
    const closed = await openTask("pr-watch-closed");
    closed.workspace.pr = snapshotFromView(view(34, { state: "CLOSED" }));
    const pending = await openTask("pr-watch-none");
    const fake = gh({
      "pr view 33 --json number": { stdout: JSON.stringify(view(33)) },
      "pr view 34 --json number": { stdout: JSON.stringify(view(34, { state: "CLOSED" })) },
    });
    await tickOnce(5_000);
    await until(() => !activeWorkspace(merged.session));
    expect(activeWorkspace(merged.session)).toBeNull();
    expect(factsOf(merged.session, "code.workspace").at(-1)?.data).toMatchObject({ action: "removed", by: "auto" });
    expect(activeWorkspace(fresh.session)).not.toBeNull();
    await until(() => open.workspace.pr?.ci === "none");
    expect(open.workspace.pr?.ci).toBe("none");
    expect(fake.calls.some((call) => call.args.join(" ").startsWith("pr view 34"))).toBe(true);
    expect(activeWorkspace(pending.session)).not.toBeNull();
    stopWatching();
  });

  test("skips auto-close while busy or dirty and logs failures", async () => {
    const busy = await openTask("pr-watch-busy");
    busy.workspace.pr = snapshotFromView(view(41, { state: "MERGED", mergedAt: "2020-01-01T00:00:00Z" }));
    const dirty = await openTask("pr-watch-dirty");
    dirty.workspace.pr = snapshotFromView(view(42, { state: "MERGED", mergedAt: "2020-01-01T00:00:00Z" }));
    writeFileSync(join(dirty.workspace.path, "wip.txt"), "x");
    const broken = await openTask("pr-watch-broken");
    broken.workspace.pr = snapshotFromView(view(43, { state: "MERGED", mergedAt: "2020-01-01T00:00:00Z" }));
    push(broken.workspace);
    codeProcesses((call) => (gitArgs(call, "worktree", "remove") ? { code: 1, stderr: "nope" } : undefined));
    const isBusy = spyOn(engine, "isBusy").mockImplementation((sessionId) => sessionId === busy.session.meta.sessionId);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      kickPr(busy.session);
      kickPr(dirty.session);
      kickPr(broken.session);
      await tickOnce(10_000);
      await until(() => warn.mock.calls.some((args) => args[0] === "pr watch failed"));
      expect(warn).toHaveBeenCalledWith(
        "pr watch failed",
        broken.session.meta.sessionId,
        expect.stringContaining("nope"),
      );
      expect(activeWorkspace(busy.session)).not.toBeNull();
      expect(activeWorkspace(dirty.session)).not.toBeNull();
    } finally {
      isBusy.mockRestore();
      warn.mockRestore();
    }
  });
});
