import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, newSession } from "../../../../test/code-helpers";
import { resetData } from "../../../../test/helpers";
import type { BotDefinition } from "../../bots/services/bots.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import * as engine from "../../engine/services/engine.service";
import { botCodeSummary, botIsCoding } from "../services/bot-code.service";
import { snapshotFromView } from "../services/pull-request.service";
import { closeWorkspace, listRepos, openWorkspace, waitForInstall } from "../services/workspace.service";

beforeEach(async () => {
  await resetData();
});

const bot = (id: string) => ({ id }) as BotDefinition;

describe("bot code summary", () => {
  test("is null without a thread or an open workspace", async () => {
    expect(await botCodeSummary(bot("bc-none"))).toBeNull();
    await ensureThread("bc-idle");
    expect(await botCodeSummary(bot("bc-idle"))).toBeNull();
  });

  test("summarizes the thread workspace and caches it briefly", async () => {
    await makeRepo("bc-repo");
    await listRepos(true);
    const thread = await ensureThread("bc-coder");
    const session = getStoredSession(thread.sessionId);
    if (!session) throw new Error("missing session");
    const { workspace } = await openWorkspace(session, "bc-coder", "bc-repo", "summary task");
    await waitForInstall(workspace);
    writeFileSync(join(workspace.path, "new.txt"), "a\nb\n");
    workspace.pr = snapshotFromView({ number: 4, state: "OPEN" });
    const first = await botCodeSummary(bot("bc-coder"));
    expect(first).toEqual({
      repoName: "bc-repo",
      branch: workspace.branch,
      path: workspace.path,
      files: 1,
      added: 2,
      removed: 0,
      pr: { number: 4, status: "open", ci: "none" },
      running: false,
    });
    writeFileSync(join(workspace.path, "other.txt"), "c\n");
    const running = spyOn(engine, "isRunning").mockReturnValue(true);
    const cached = await botCodeSummary(bot("bc-coder"));
    running.mockRestore();
    expect(cached).toEqual({ ...first, running: true } as typeof cached);

    workspace.pr = null;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 10_000);
    const fresh = await botCodeSummary(bot("bc-coder"));
    clock.mockRestore();
    expect(fresh).toMatchObject({ files: 2, pr: null });
  });
});

describe("bot is coding", () => {
  test("only counts thread and conversation sessions with an active workspace", async () => {
    await makeRepo("bc-coding");
    await listRepos(true);
    expect(await botIsCoding("bc-coding-bot")).toBe(false);
    const side = await newSession("bc-coding-bot", "session");
    const sideOpen = await openWorkspace(side, "bc-coding-bot", "bc-coding", "side");
    await waitForInstall(sideOpen.workspace);
    expect(await botIsCoding("bc-coding-bot")).toBe(false);
    const main = await newSession("bc-coding-bot", "conversation");
    const mainOpen = await openWorkspace(main, "bc-coding-bot", "bc-coding", "main");
    await waitForInstall(mainOpen.workspace);
    expect(await botIsCoding("bc-coding-bot")).toBe(true);
    await closeWorkspace(main, true);
    expect(await botIsCoding("bc-coding-bot")).toBe(false);
  });
});
