import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventLog } from "../../conversations/services/sessions.service";
import { type CodeSignal, CodeLive, onCodeSignal } from "../services/live-diff.service";
import type { WorkspaceState } from "../services/workspace.service";
import * as workspaceService from "../services/workspace.service";

interface Emitted {
  type: string;
  data: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

const roots: string[] = [];

function gitSync(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function makeRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rb-live-diff-"));
  roots.push(root);
  gitSync(root, ["init", "-q", "-b", "main"]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  gitSync(root, ["add", "-A"]);
  gitSync(root, ["commit", "-q", "-m", "base"]);
  const workspace: WorkspaceState = {
    id: `ws_${roots.length}`,
    repo: root,
    repoName: "repo",
    path: root,
    branch: "feat/x",
    base: "main",
    baseCommit: gitSync(root, ["rev-parse", "HEAD"]),
    task: "x",
    openedAt: new Date().toISOString(),
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null },
  };
  return workspace;
}

function fakeLog() {
  const events: Emitted[] = [];
  const log = { sessionId: "s1", emit: (event: Emitted) => events.push(event) } as unknown as EventLog;
  return { log, events };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("CodeLive", () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  test("emits one cumulative edit per changed file and a status only when it changes", async () => {
    const workspace = await makeRepo({ "a.txt": "one\ntwo\n", "b.txt": "keep\n" });
    const { log, events } = fakeLog();
    const live = new CodeLive(log, "turn1", workspace, new Map());
    expect(live.workspace).toBe(workspace);

    writeFileSync(join(workspace.path, "a.txt"), "one\nTWO\n");
    writeFileSync(join(workspace.path, "new.txt"), "fresh\n");
    await live.scan("call1", "tool");

    const edits = events.filter((event) => event.type === "code.edit");
    expect(edits.map((event) => event.data.path).sort()).toEqual(["a.txt", "new.txt"]);
    const edit = edits.find((event) => event.data.path === "a.txt") as Emitted;
    expect(edit.data).toMatchObject({
      callId: "call1",
      workspaceId: workspace.id,
      absPath: join(workspace.path, "a.txt"),
      outside: false,
      before: "one\ntwo\n",
      after: "one\nTWO\n",
      added: 1,
      removed: 1,
      created: false,
      deleted: false,
      source: "tool",
      cumulative: true,
      key: "turn1:a.txt",
    });
    expect((events.find((event) => event.data.path === "new.txt") as Emitted).data.created).toBe(true);
    const status = events.filter((event) => event.type === "code.status");
    expect(status).toHaveLength(1);
    expect(status[0].data).toEqual({ workspaceId: workspace.id, files: 2, added: 2, removed: 1 });
    expect(status[0].scope).toEqual({ turnId: "turn1" });

    events.length = 0;
    await live.scan(null, "sweep");
    expect(events).toHaveLength(0);

    writeFileSync(join(workspace.path, "a.txt"), "one\ntwo\n");
    await live.scan(null, "sweep");
    const reverted = events.find((event) => event.type === "code.edit") as Emitted;
    expect(reverted.data).toMatchObject({ path: "a.txt", before: "one\ntwo\n", after: "one\ntwo\n", added: 0 });
    expect(events.at(-1)?.data).toEqual({ workspaceId: workspace.id, files: 1, added: 1, removed: 0 });
  });

  test("uses the snapshot taken before the turn as the baseline and reports deletions", async () => {
    const workspace = await makeRepo({ "a.txt": "base\n" });
    writeFileSync(join(workspace.path, "a.txt"), "before turn\n");
    const { log, events } = fakeLog();
    const live = new CodeLive(log, "turn2", workspace, new Map([["a.txt", "before turn\n"]]));
    rmSync(join(workspace.path, "a.txt"));
    await live.scan("c", "tool");
    const edit = events.find((event) => event.type === "code.edit") as Emitted;
    expect(edit.data).toMatchObject({ before: "before turn\n", after: null, deleted: true, created: false });
  });

  test("collapses many changed files into a single bulk event", async () => {
    const workspace = await makeRepo({ "seed.txt": "x\n" });
    const { log, events } = fakeLog();
    const live = new CodeLive(log, "turn3", workspace, new Map());
    for (let index = 0; index < 30; index++) writeFileSync(join(workspace.path, `f${index}.txt`), "a\nb\n");
    await live.scan(null, "sweep");
    expect(events.some((event) => event.type === "code.edit")).toBe(false);
    const bulk = events.find((event) => event.type === "code.bulk") as Emitted;
    expect(bulk.data).toMatchObject({
      callId: null,
      workspaceId: workspace.id,
      files: 30,
      added: 60,
      removed: 0,
      source: "sweep",
      key: "turn3:bulk:sweep",
    });
    expect(bulk.data.paths).toHaveLength(12);
  });

  test("a failed scan is logged and does not break the next one", async () => {
    const workspace = await makeRepo({ "a.txt": "a\n" });
    const { log, events } = fakeLog();
    const live = new CodeLive(log, "turn4", workspace, new Map());
    const diff = spyOn(workspaceService, "diffTexts").mockRejectedValueOnce(new Error("boom"));
    writeFileSync(join(workspace.path, "a.txt"), "b\n");
    await live.scan("c1", "tool");
    expect(warn).toHaveBeenCalledWith("code scan failed", expect.any(Error));
    diff.mockRestore();
    writeFileSync(join(workspace.path, "a.txt"), "c\n");
    await live.scan("c2", "tool");
    expect(events.find((event) => event.type === "code.edit")?.data.after).toBe("c\n");
  });

  test("a workspace whose git status fails scans nothing", async () => {
    const workspace = await makeRepo({ "a.txt": "a\n" });
    const { log, events } = fakeLog();
    const changed = spyOn(workspaceService, "changedFiles").mockRejectedValueOnce(new Error("no git"));
    const live = new CodeLive(log, "turn5", workspace, new Map());
    await live.scan(null, "sweep");
    changed.mockRestore();
    expect(events).toEqual([
      {
        type: "code.status",
        data: { workspaceId: workspace.id, files: 0, added: 0, removed: 0 },
        scope: { turnId: "turn5" },
      },
    ]);
  });

  test("a branch switch is a neutral line, not a wall of edits", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`f${index}.txt`, "a\n"]));
    const workspace = await makeRepo(files);
    workspace.branch = "main";
    gitSync(workspace.path, ["checkout", "-q", "-b", "hotfix/x"]);
    for (let index = 0; index < 30; index++) writeFileSync(join(workspace.path, `f${index}.txt`), "b\n");
    gitSync(workspace.path, ["commit", "-q", "-am", "other"]);
    gitSync(workspace.path, ["checkout", "-q", "main"]);
    const signals: CodeSignal[] = [];
    onCodeSignal((value) => signals.push(value));
    const { log, events } = fakeLog();
    const live = new CodeLive(log, "turn6", workspace, new Map());
    gitSync(workspace.path, ["checkout", "-q", "hotfix/x"]);
    await live.scan("c1", "tool");
    expect(events.some((event) => event.type === "code.edit" || event.type === "code.bulk")).toBe(false);
    expect(events.find((event) => event.type === "code.branch")).toEqual({
      type: "code.branch",
      data: { workspaceId: workspace.id, from: "main", to: "hotfix/x" },
      scope: { turnId: "turn6" },
    });
    expect(workspace.branch).toBe("hotfix/x");
    expect(workspace.baseCommit).toBe(gitSync(workspace.path, ["rev-parse", "main"]));
    expect(signals).toEqual([{ sessionId: "s1", kind: "head" }]);

    writeFileSync(join(workspace.path, "f1.txt"), "c\n");
    gitSync(workspace.path, ["commit", "-q", "-am", "mine"]);
    await live.scan("c2", "tool");
    expect(events.find((event) => event.type === "code.edit")?.data).toMatchObject({ path: "f1.txt", before: "b\n" });

    gitSync(workspace.path, ["reset", "-q", "--hard", "HEAD~1"]);
    await live.scan("c3", "tool");
    expect(events.filter((event) => event.type === "code.edit")).toHaveLength(1);
    expect(events.filter((event) => event.type === "code.branch")).toHaveLength(1);
    onCodeSignal(null);
  });

  test("PR URLs from tool output are signaled with whether the tool created them", async () => {
    const workspace = await makeRepo({ "a.txt": "a\n" });
    const signals: CodeSignal[] = [];
    onCodeSignal((value) => signals.push(value));
    const { log } = fakeLog();
    const live = new CodeLive(log, "turn7", workspace, new Map());
    const url = "https://github.com/o/r/pull/12";
    await live.scan("c1", "tool", { input: { command: "gh pr create --fill" }, output: { stdout: `${url}\n` } });
    await live.scan("c2", "tool", { input: null, output: `see ${url} and ${url}` });
    await live.scan("c3", "tool", { output: null });
    await live.scan("c4", "tool", { input: { command: "ls" }, output: "nothing" });
    expect(signals).toEqual([
      { sessionId: "s1", kind: "pr", urls: [url], created: true },
      { sessionId: "s1", kind: "pr", urls: [url], created: false },
    ]);
    onCodeSignal(() => {
      throw new Error("handler broke");
    });
    await live.scan("c5", "tool", { output: url });
    expect(warn).toHaveBeenCalledWith("code signal failed", expect.any(Error));
    onCodeSignal(null);
  });

  test("an unreadable HEAD never counts as a branch switch", async () => {
    const workspace = await makeRepo({ "a.txt": "a\n" });
    const head = spyOn(workspaceService, "readHead").mockRejectedValue(new Error("no head"));
    const { log, events } = fakeLog();
    const live = new CodeLive(log, "turn8", workspace, new Map());
    writeFileSync(join(workspace.path, "a.txt"), "b\n");
    await live.scan("c1", "tool");
    head.mockRestore();
    expect(events.some((event) => event.type === "code.branch")).toBe(false);
    expect(events.find((event) => event.type === "code.edit")?.data.after).toBe("b\n");
  });
});
