import { beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { makeRepo, newSession } from "../../../../test/code-helpers";
import { resetData } from "../../../../test/helpers";
import { listWorktrees, recordWorktree } from "../repositories/code.repository";
import { startCodeHousekeeping } from "../services/housekeeping.service";
import * as workspaces from "../services/workspace.service";

beforeEach(async () => {
  await resetData();
});

describe("code housekeeping", () => {
  test("warms the repo list and keeps active worktrees out of the collector", async () => {
    await makeRepo("hk-repo");
    await workspaces.listRepos(true);
    const session = await newSession("hk-bot");
    const { workspace } = await workspaces.openWorkspace(session, "hk-bot", "hk-repo", "housekeeping");
    await workspaces.waitForInstall(workspace);
    await recordWorktree(workspace, "hk-bot", session.meta.sessionId);
    const record = (await listWorktrees()).find((item) => item.id === workspace.id);
    if (!record) throw new Error("missing record");
    record.lastAccessedAt = "2000-01-01T00:00:00.000Z";

    const list = spyOn(workspaces, "listRepos").mockRejectedValue(new Error("no roots"));
    jest.useFakeTimers();
    try {
      startCodeHousekeeping();
      expect(list).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(60_000);
    } finally {
      jest.useRealTimers();
      list.mockRestore();
    }
    for (let attempt = 0; attempt < 200 && record.lastAccessedAt.startsWith("2000"); attempt++) await Bun.sleep(5);
    expect(record.status).toBe("alive");
    expect(record.lastAccessedAt.startsWith("2000")).toBe(true);
  });
});
