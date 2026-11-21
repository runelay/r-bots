import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeProcesses, factsOf, gitSync, makeRepo, newSession, worktreesDir } from "../../../../test/code-helpers";
import { waitFor } from "../../../../test/engine-helpers";
import { resetData } from "../../../../test/helpers";
import { resetSandboxProbe, sandboxMissingMessage } from "../services/sandbox.service";
import {
  changedFiles,
  gitArgs,
  gitSafeEnv,
  installLimits,
  installLogPath,
  listRepos,
  openWorkspace,
  pinnedGitEnv,
  shareWithSandbox,
  waitForInstall,
} from "../services/workspace.service";

const saved = { mode: process.env.BOTS_TOOL_SANDBOX, sudo: process.env.BOTS_SANDBOX_SUDO };

beforeEach(async () => {
  await resetData();
  resetSandboxProbe();
});

afterEach(() => {
  if (saved.mode === undefined) delete process.env.BOTS_TOOL_SANDBOX;
  else process.env.BOTS_TOOL_SANDBOX = saved.mode;
  if (saved.sudo === undefined) delete process.env.BOTS_SANDBOX_SUDO;
  else process.env.BOTS_SANDBOX_SUDO = saved.sudo;
  resetSandboxProbe();
});

async function opened(name: string, files: Record<string, string> = { "README.md": "hi\n" }) {
  await makeRepo(name, { files });
  await listRepos(true);
  const session = await newSession(`bot-${name}`);
  const result = await openWorkspace(session, `bot-${name}`, name, "Task");
  await waitForInstall(result.workspace);
  return { session, ...result };
}

describe("server git ignores repo-controlled config", () => {
  test("adds no-ext-diff and no-textconv to diff-like commands and neutralizes dangerous keys", () => {
    expect(gitArgs(["diff", "--stat"])).toEqual(["diff", "--no-ext-diff", "--no-textconv", "--stat"]);
    expect(gitArgs(["show", "x"])).toEqual(["show", "--no-ext-diff", "--no-textconv", "x"]);
    expect(gitArgs(["status"])).toEqual(["status"]);
    expect(gitArgs([])).toEqual([]);
    const env = gitSafeEnv("/elsewhere");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
      env[`GIT_CONFIG_KEY_${index}`],
      env[`GIT_CONFIG_VALUE_${index}`],
    ]);
    expect(pairs).toContainEqual(["core.hooksPath", "/dev/null"]);
    expect(pairs).toContainEqual(["core.fsmonitor", "false"]);
    expect(pairs).toContainEqual(["diff.external", ""]);
    expect(env.GIT_DIR).toBeUndefined();
  });

  test("a tampered .git file in the worktree does not move the server's git dir", async () => {
    const { workspace } = await opened("ws-pin-tamper");
    const pinned = pinnedGitEnv(workspace.path);
    expect(pinned?.GIT_COMMON_DIR).toBe(join(workspace.repo, ".git"));
    expect(pinned?.GIT_WORK_TREE).toBe(workspace.path);
    expect(pinnedGitEnv(join(workspace.path, "src"))?.GIT_DIR).toBe(pinned?.GIT_DIR);
    writeFileSync(join(workspace.path, ".git"), "gitdir: /nonexistent/evil\n");
    writeFileSync(join(workspace.path, "new.txt"), "x\n");
    const files = await changedFiles(workspace, true);
    expect(files.map((file) => file.path)).toContain("new.txt");
  });

  test("finds a renamed admin dir by its gitdir file and gives up on unknown paths", async () => {
    await makeRepo("ws-pin-scan");
    await listRepos(true);
    const repo = join(process.env.HOST_HOME as string, "repos", "ws-pin-scan");
    const admin = join(repo, ".git", "worktrees");
    mkdirSync(join(admin, "renamed"), { recursive: true });
    mkdirSync(join(admin, "broken"), { recursive: true });
    const root = join(worktreesDir, "ws-pin-scan", "task-1");
    writeFileSync(join(admin, "renamed", "gitdir"), `${join(root, ".git")}\n`);
    expect(pinnedGitEnv(root)?.GIT_DIR).toBe(join(admin, "renamed"));
    expect(pinnedGitEnv(join(worktreesDir, "ws-pin-scan", "other"))).toBeNull();
    expect(pinnedGitEnv(join(worktreesDir, "ws-pin-scan"))).toBeNull();
    expect(pinnedGitEnv(worktreesDir)).toBeNull();
    expect(pinnedGitEnv(join(worktreesDir, "not-a-repo", "x"))).toBeNull();
    expect(pinnedGitEnv("/srv/elsewhere")).toBeNull();
    await makeRepo("ws-pin-empty");
    await listRepos(true);
    expect(pinnedGitEnv(join(worktreesDir, "ws-pin-empty", "x"))).toBeNull();
  });
});

describe("sharing a workspace with the sandbox user", () => {
  test("does nothing with the sandbox off", async () => {
    const { workspace } = await opened("ws-share-off");
    const fake = codeProcesses();
    await shareWithSandbox(workspace);
    expect(fake.calls).toHaveLength(0);
    fake.restore();
  });

  test("opens the worktree and the git object store to rbwork and sets a group repository", async () => {
    const { workspace } = await opened("ws-share-on");
    process.env.BOTS_TOOL_SANDBOX = "uid";
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = codeProcesses((call) => {
      if (call.command === "chgrp" || call.command === "chmod") return { code: 0 };
      if (call.command === "find") return { code: 1, stderr: "find: denied" };
      return undefined;
    });
    try {
      await shareWithSandbox(workspace);
      const chgrp = fake.calls.find((call) => call.command === "chgrp");
      expect(chgrp?.args.slice(0, 2)).toEqual(["-R", "rbwork"]);
      expect(chgrp?.args).toContain(workspace.path);
      expect(chgrp?.args).toContain(join(workspace.repo, ".git", "objects"));
      expect(chgrp?.args).not.toContain(join(workspace.repo, ".git", "config"));
      expect(chgrp?.args).not.toContain(join(workspace.repo, ".git", "hooks"));
      expect(fake.calls.find((call) => call.command === "chmod")?.args.slice(0, 2)).toEqual(["-R", "g+rwX"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("sandbox find falhou"));
      expect(gitSync(workspace.repo, ["config", "--get", "core.sharedRepository"]).stdout.trim()).toBe("group");
      const tampered = { ...workspace, path: join(worktreesDir, "ws-share-on", "missing") };
      await shareWithSandbox(tampered);
    } finally {
      warn.mockRestore();
      fake.restore();
    }
  });
});

describe("dependency install in the sandbox", () => {
  test("runs the package manager as the sandbox user without lifecycle scripts and caps the log", async () => {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    process.env.BOTS_SANDBOX_SUDO = "/fake/sudo";
    const limit = installLimits.logBytes;
    installLimits.logBytes = 64;
    const fake = codeProcesses((call) => {
      if (["chgrp", "chmod", "find"].includes(call.command)) return { code: 0 };
      if (call.command !== "/fake/sudo") return undefined;
      if (call.args.includes("--probe")) return { stdout: "ok 1502 bwrap=0\n" };
      if (call.args.includes("--sweep")) return { stdout: "0\n" };
      return { code: 0, stdout: "x".repeat(50), stderr: "y".repeat(50) };
    });
    try {
      const { workspace, session } = await opened("ws-install-sandbox", { "bun.lock": "x" });
      expect(workspace.install.status).toBe("done");
      const install = fake.calls.find((call) => call.command === "/fake/sudo" && call.args.includes("--cwd"));
      expect(install?.args.at(-1)).toBe("bun install --frozen-lockfile --ignore-scripts");
      expect(install?.args).toContain("CI=1");
      const log = await waitFor(() => {
        const text = readFileSync(installLogPath(workspace), "utf8");
        return text.includes("[log cortado]") ? text : null;
      });
      expect(log.replace("\n[log cortado]\n", "")).toHaveLength(64);
      expect((await factsOf(session, "code.install")).at(-1)?.data.status).toBe("done");
    } finally {
      installLimits.logBytes = limit;
      fake.restore();
    }
  });

  test("fails closed when the sandbox is configured but not usable", async () => {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    process.env.BOTS_SANDBOX_SUDO = "/fake/sudo";
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = codeProcesses((call) => {
      if (["chgrp", "chmod", "find"].includes(call.command)) return { code: 0 };
      if (call.command === "/fake/sudo") return { code: 1, stderr: "sudo: a password is required" };
      return undefined;
    });
    try {
      const { workspace } = await opened("ws-install-nosandbox", { "bun.lock": "x" });
      expect(workspace.install.status).toBe("failed");
      expect(workspace.install.error).toBe(sandboxMissingMessage);
      expect(fake.calls.some((call) => call.args.includes("--cwd"))).toBe(false);
    } finally {
      warn.mockRestore();
      fake.restore();
    }
  });
});
