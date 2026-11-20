import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeProcesses, gitArgs, gitSync, makeRepo, newSession } from "../../../../test/code-helpers";
import { resetData } from "../../../../test/helpers";
import * as settings from "../../../db/settings";
import { readSetting, writeSetting } from "../../../db/settings";
import {
  addGrant,
  collectWorktrees,
  hasGrant,
  listGrants,
  listWorktrees,
  recordWorktree,
  removeGrant,
  startWorktreeCollector,
  touchWorktree,
  type WorktreeRecord,
} from "../repositories/code.repository";
import * as worktreeRows from "../repositories/worktrees.repository";
import { listRepos, openWorkspace, type WorkspaceState, waitForInstall } from "../services/workspace.service";

const grantsSpecifier = "../repositories/code.repository.ts?grants";
const ttlSpecifier = "../repositories/code.repository.ts?ttl";
const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();

beforeEach(async () => {
  await resetData();
});

afterEach(async () => {
  jest.useRealTimers();
});

async function settle() {
  await addGrant("__flush__", "flush");
  await removeGrant("__flush__", "flush");
}

describe("grants", () => {
  test("adds, finds, counts uses, lists and removes grants per repo", async () => {
    expect(await hasGrant("/repo/grants", "git push")).toBe(false);
    await addGrant("/repo/grants", "git push");
    await addGrant("/repo/grants", "git push");
    await addGrant("/repo/grants", "npm publish");
    expect(await hasGrant("/repo/grants", "git push")).toBe(true);
    const listed = (await listGrants()).filter((grant) => grant.repo === "/repo/grants");
    expect(listed.map((grant) => grant.key)).toEqual(["git push", "npm publish"]);
    expect(listed[0]).toMatchObject({ uses: 1 });
    expect(listed[0].lastUsedAt).not.toBeNull();
    await settle();
    const stored = await readSetting<Record<string, Array<{ key: string }>>>("code.grants", {});
    expect(stored["/repo/grants"].map((grant) => grant.key)).toEqual(["git push", "npm publish"]);

    expect(await removeGrant("/repo/grants", "git push")).toBe(true);
    expect(await removeGrant("/repo/grants", "git push")).toBe(false);
    expect(await removeGrant("/repo/grants", "npm publish")).toBe(true);
    expect(await removeGrant("/repo/none", "x")).toBe(false);
    expect((await listGrants()).some((grant) => grant.repo === "/repo/grants")).toBe(false);
  });

  test("loads stored grants and logs write failures", async () => {
    await writeSetting("code.grants", { "/repo/stored": [{ key: "k", createdAt: "", uses: 2, lastUsedAt: null }] });
    const fresh = (await import(grantsSpecifier)) as typeof import("../repositories/code.repository");
    expect(await fresh.listGrants()).toEqual([
      { repo: "/repo/stored", key: "k", createdAt: "", uses: 2, lastUsedAt: null },
    ]);
    const write = spyOn(settings, "writeSetting").mockImplementation(() => {
      throw new Error("disk full");
    });
    const save = spyOn(worktreeRows, "saveWorktreeRows").mockImplementation(() => {
      throw new Error("db locked");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fresh.addGrant("/repo/stored", "other");
      expect(warn).toHaveBeenCalledWith("code store write failed", expect.objectContaining({ message: "disk full" }));
      await fresh.recordWorktree(workspaceOf("reg-fail"), "bot", "s1");
      expect(warn).toHaveBeenCalledWith("code store write failed", expect.objectContaining({ message: "db locked" }));
    } finally {
      write.mockRestore();
      save.mockRestore();
      warn.mockRestore();
    }
    expect((await fresh.listGrants()).map((grant) => grant.key)).toEqual(["k", "other"]);
    expect((await readSetting<Record<string, unknown[]>>("code.grants", {}))["/repo/stored"]).toHaveLength(1);
    expect((await worktreeRows.loadWorktreeRows()).some((row) => row.id === "reg-fail")).toBe(false);
  });
});

function workspaceOf(id: string, path = `/tmp/${id}`): WorkspaceState {
  return {
    id,
    repo: "/repo/x",
    repoName: "x",
    path,
    branch: `feat/${id}`,
    base: "main",
    baseCommit: "abc",
    task: "t",
    openedAt: "",
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null },
  };
}

describe("worktree registry", () => {
  test("records, touches and lists worktrees by last access", async () => {
    await recordWorktree(workspaceOf("reg-a"), "bot", "s1");
    await recordWorktree(workspaceOf("reg-b"), "bot", "s2", "closed");
    const first = (await listWorktrees()).find((item) => item.id === "reg-a") as WorktreeRecord;
    expect(first).toMatchObject({
      status: "alive",
      pinned: false,
      botId: "bot",
      sessionId: "s1",
      branch: "feat/reg-a",
    });
    first.lastAccessedAt = "2000-01-01T00:00:00.000Z";
    await recordWorktree(workspaceOf("reg-a"), "bot", "s1", "delivered");
    expect(first.status).toBe("delivered");
    expect(first.lastAccessedAt).not.toBe("2000-01-01T00:00:00.000Z");
    first.lastAccessedAt = "2001-01-01T00:00:00.000Z";
    expect(await touchWorktree("reg-missing")).toBeNull();
    const touched = await touchWorktree("reg-b", { prUrl: "https://example.test/pull/1" });
    expect(touched?.prUrl).toBe("https://example.test/pull/1");
    const ids = (await listWorktrees()).map((item) => item.id);
    expect(ids.indexOf("reg-b")).toBeLessThan(ids.indexOf("reg-a"));
    await settle();
    const stored = (await worktreeRows.loadWorktreeRows()).find((item) => item.id === "reg-b");
    expect(stored).toMatchObject({
      status: "closed",
      prUrl: "https://example.test/pull/1",
      sessionId: "s2",
      base: "main",
    });
  });
});

async function realWorktree(name: string) {
  await makeRepo(name);
  await listRepos(true);
  const session = await newSession(`bot-${name}`);
  const { workspace } = await openWorkspace(session, `bot-${name}`, name, "gc task");
  await waitForInstall(workspace);
  await recordWorktree(workspace, `bot-${name}`, session.meta.sessionId);
  const record = (await listWorktrees()).find((item) => item.id === workspace.id) as WorktreeRecord;
  record.lastAccessedAt = old;
  return { workspace, record };
}

describe("worktree collector", () => {
  test("removes old clean worktrees and keeps pinned, active, recent, dirty and unpushed ones", async () => {
    const clean = await realWorktree("gc-clean");
    const dirty = await realWorktree("gc-dirty");
    writeFileSync(join(dirty.workspace.path, "wip.txt"), "x");
    const ahead = await realWorktree("gc-ahead");
    writeFileSync(join(ahead.workspace.path, "c.txt"), "x");
    gitSync(ahead.workspace.path, ["add", "-A"]);
    gitSync(ahead.workspace.path, ["commit", "-q", "-m", "local"]);
    const pinned = await realWorktree("gc-pinned");
    pinned.record.pinned = true;
    const active = await realWorktree("gc-active");
    const recent = await realWorktree("gc-recent");
    recent.record.lastAccessedAt = new Date().toISOString();
    const gone = await realWorktree("gc-gone");
    rmSync(gone.workspace.path, { recursive: true, force: true });
    const done = await realWorktree("gc-done");
    done.record.status = "removed";

    const removed = await collectWorktrees((record) => record.id === active.record.id);
    expect(removed).toContain(clean.record.id);
    expect(clean.record.status).toBe("removed");
    expect(dirty.record.status).toBe("stale");
    expect(ahead.record.status).toBe("stale");
    expect(pinned.record.status).toBe("alive");
    expect(active.record.status).toBe("alive");
    expect(recent.record.status).toBe("alive");
    expect(gone.record.status).toBe("removed");
    expect(removed).not.toContain(gone.record.id);
  });

  test("marks a worktree stale when git cannot remove it", async () => {
    const stuck = await realWorktree("gc-stuck");
    codeProcesses((call) => (gitArgs(call, "worktree", "remove") ? { code: 1, stderr: "locked" } : undefined));
    expect(await collectWorktrees(() => false)).not.toContain(stuck.record.id);
    expect(stuck.record.status).toBe("stale");
  });

  test("runs on a timer and logs what it removed or why it failed", async () => {
    const victim = await realWorktree("gc-timer");
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      jest.useFakeTimers();
      startWorktreeCollector(() => false);
      jest.advanceTimersByTime(60_000);
      jest.useRealTimers();
      for (let attempt = 0; attempt < 200 && victim.record.status !== "removed"; attempt++) await Bun.sleep(5);
      expect(victim.record.status).toBe("removed");
      for (let attempt = 0; attempt < 200 && log.mock.calls.length === 0; attempt++) await Bun.sleep(5);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(victim.record.id));

      jest.useFakeTimers();
      startWorktreeCollector(() => {
        throw new Error("boom");
      });
      jest.advanceTimersByTime(6 * 3600_000);
      jest.useRealTimers();
      for (let attempt = 0; attempt < 200 && warn.mock.calls.length === 0; attempt++) await Bun.sleep(5);
      expect(warn).toHaveBeenCalledWith("worktree gc failed", expect.any(Error));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("uses the configured time to live", async () => {
    process.env.CODE_WORKTREE_TTL_DAYS = "0";
    try {
      const fresh = (await import(ttlSpecifier)) as typeof import("../repositories/code.repository");
      const { workspace } = await realWorktree("gc-ttl");
      await fresh.recordWorktree(workspace, "bot", "s");
      const record = (await fresh.listWorktrees()).find(
        (item: WorktreeRecord) => item.id === workspace.id,
      ) as WorktreeRecord;
      record.lastAccessedAt = new Date(Date.now() - 1000).toISOString();
      expect(await fresh.collectWorktrees(() => false)).toContain(workspace.id);
    } finally {
      delete process.env.CODE_WORKTREE_TTL_DAYS;
    }
  });
});
