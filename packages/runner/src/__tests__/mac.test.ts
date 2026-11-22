import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceSync } from "@runelay-bots/protocol";
import { claudeLoggedOutMessage, claudeLoginTtlMs, claudeMissingMessage } from "../constants";
import {
  captureProcess,
  checkoutSync,
  claudeGate,
  cloneDirOf,
  findClaude,
  gitRunner,
  homeDirOf,
  loggedIn,
  macPath,
  macRequest,
  mapStrings,
  pushSync,
  worktreeDirOf,
} from "../mac";
import type { GitResult, GitRun } from "../types";
import { tempDir, turnRequest } from "./helpers";

const ok: GitResult = { code: 0, stdout: "", stderr: "" };

describe("Mac helpers", () => {
  test("captures a process output and exit code", async () => {
    expect(
      await captureProcess(["sh", "-c", "echo out; echo err >&2; exit 3"], { PATH: process.env.PATH ?? "" }),
    ).toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  test("puts the usual Mac tool folders on the PATH once", () => {
    expect(macPath("/usr/bin:/opt/homebrew/bin", "/Users/dono")).toBe(
      "/Users/dono/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/dono/.bun/bin:/usr/bin",
    );
    expect(macPath(undefined, "/h")).toBe("/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/h/.bun/bin");
  });

  test("finds the Claude CLI from the setting, the PATH or the installer folders", () => {
    const only =
      (...paths: string[]) =>
      (path: string) =>
        paths.includes(path);
    expect(findClaude("/opt/claude", "/bin", "/h", only("/opt/claude"))).toBe("/opt/claude");
    expect(findClaude("/opt/claude", "/bin", "/h", only("/bin/claude"))).toBeNull();
    expect(findClaude(null, "/a:/bin", "/h", only("/bin/claude", "/h/.local/bin/claude"))).toBe("/bin/claude");
    expect(findClaude(null, "/bin", "/h", only("/h/.claude/local/claude"))).toBe("/h/.claude/local/claude");
    expect(findClaude(null, "/bin", "/h", only())).toBeNull();
  });

  test("reads the login state from claude auth status", () => {
    expect(loggedIn('{"loggedIn":true}')).toBe(true);
    expect(loggedIn('{"loggedIn":false}')).toBe(false);
    expect(loggedIn("nope")).toBe(false);
  });

  test("blocks a turn without the CLI or a login and remembers a good login for a while", async () => {
    await expect(claudeGate(null, {}, async () => ok)()).rejects.toThrow(claudeMissingMessage);
    await expect(claudeGate("/c", {}, async () => ({ ...ok, stdout: '{"loggedIn":false}' }))()).rejects.toThrow(
      claudeLoggedOutMessage,
    );
    await expect(
      claudeGate("/c", {}, async () => {
        throw new Error("spawn");
      })(),
    ).rejects.toThrow(claudeLoggedOutMessage);
    const calls: string[][] = [];
    let now = 1000;
    const gate = claudeGate(
      "/c",
      { HOME: "/h" },
      async (argv, env) => {
        calls.push([...argv, env.HOME ?? ""]);
        return { ...ok, stdout: '{"loggedIn":true}' };
      },
      () => now,
    );
    await gate();
    await gate();
    expect(calls).toEqual([["/c", "auth", "status", "/h"]]);
    now += claudeLoginTtlMs;
    await gate();
    expect(calls).toHaveLength(2);
  });

  test("runs git without prompts and with gh as the GitHub credential when there is one", async () => {
    const seen: Array<{ argv: string[]; env: Record<string, string>; cwd: string | undefined }> = [];
    const capture = async (argv: string[], env: Record<string, string>, cwd?: string) => {
      seen.push({ argv, env, cwd });
      return ok;
    };
    await gitRunner("/bin/gh", { PATH: "/bin" }, capture)(["status"], "/w", { X: "1" });
    await gitRunner(null, {}, capture)(["status"], "/w");
    expect(seen).toEqual([
      {
        argv: ["git", "-c", "credential.https://github.com.helper=!'/bin/gh' auth git-credential", "status"],
        env: { PATH: "/bin", GIT_TERMINAL_PROMPT: "0", X: "1" },
        cwd: "/w",
      },
      { argv: ["git", "status"], env: { GIT_TERMINAL_PROMPT: "0" }, cwd: "/w" },
    ]);
  });

  test("names the clone, the task worktree and the bot home under the workspaces folder", () => {
    const sync = { name: "app", branch: "feat/a b" } as WorkspaceSync;
    expect(cloneDirOf("/w", sync)).toBe("/w/app");
    expect(worktreeDirOf("/w", sync)).toBe("/w/.worktrees/app/feat-a-b");
    expect(homeDirOf("/w", "/srv/worktrees/.bots/bot 1")).toBe("/w/.homes/bot-1");
  });

  test("maps paths inside any value", () => {
    expect(mapStrings({ a: ["/vps/x/f", 3, null], b: { c: "/vps/x" } }, "/vps/x", "/mac/y")).toEqual({
      a: ["/mac/y/f", 3, null],
      b: { c: "/mac/y" },
    });
    const same = { a: "/x" };
    expect(mapStrings(same, "/x", "/x")).toBe(same);
  });

  test("points the request at the Mac folder, drops VPS-only images and the VPS account", () => {
    const request = turnRequest({
      systemPrompt: "repo em /vps/wt",
      prompt: "veja /vps/wt/a.ts",
      images: [
        { path: "/mac/img.png", mime: "image/png", label: "a" },
        { path: "/vps/data/img.png", mime: "image/png", label: "b" },
      ],
      code: { cwd: "/vps/wt", readOnly: true },
      configDir: "/home/vps/.claude-2",
    });
    const exists = (path: string) => path === "/mac/img.png";
    expect(macRequest(request, { local: "/mac/wt", remote: "/vps/wt" }, exists)).toEqual({
      ...request,
      systemPrompt: "repo em /mac/wt",
      prompt: "veja /mac/wt/a.ts",
      images: [{ path: "/mac/img.png", mime: "image/png", label: "a" }],
      code: { cwd: "/mac/wt", readOnly: true },
      configDir: null,
    });
    const plain = turnRequest();
    expect(macRequest(plain, null, exists)).toEqual({ ...plain, configDir: null });
  });
});

describe("workspace sync with git", () => {
  let temp: ReturnType<typeof tempDir>;
  let git: GitRun;

  const sh = async (cwd: string, ...args: string[]) => {
    const result = await git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], cwd);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };

  beforeEach(async () => {
    temp = tempDir("rb-mac-sync-");
    git = gitRunner(null, { PATH: process.env.PATH ?? "", HOME: temp.dir, GIT_CONFIG_NOSYSTEM: "1" });
    await sh(temp.dir, "init", "--quiet", "--bare", "-b", "main", "origin.git");
    await sh(temp.dir, "init", "--quiet", "-b", "main", "vps");
    const vps = join(temp.dir, "vps");
    writeFileSync(join(vps, "a.txt"), "1\n");
    writeFileSync(join(vps, "b.txt"), "keep\n");
    writeFileSync(join(vps, ".gitignore"), "node_modules\n");
    await sh(vps, "add", "-A");
    await sh(vps, "commit", "--quiet", "-m", "base");
    await sh(vps, "remote", "add", "origin", join(temp.dir, "origin.git"));
    await sh(vps, "push", "--quiet", "origin", "main");
    await sh(vps, "checkout", "--quiet", "-b", "feat/x");
  });

  afterEach(() => temp.remove());

  function syncOf(commit: string): WorkspaceSync {
    return {
      repo: "acme/app",
      cloneUrl: join(temp.dir, "origin.git"),
      name: "app",
      branch: "feat/x",
      ref: "refs/rbots/sync/feat/x",
      commit,
      cwd: join(temp.dir, "vps"),
    };
  }

  test("moves uncommitted work from the VPS to the Mac and back through a hidden ref", async () => {
    const vps = join(temp.dir, "vps");
    writeFileSync(join(vps, "a.txt"), "2\n");
    await sh(vps, "rm", "--quiet", "b.txt");
    writeFileSync(join(vps, "c.txt"), "novo\n");
    const sent = await pushSync(git, vps, syncOf("pending"));
    expect(sent.ref).toBe("refs/rbots/sync/feat/x");
    expect(await sh(vps, "log", "--oneline", "-1", "--format=%s")).toBe("base");
    expect(await sh(vps, "branch", "--list", "--format=%(refname)")).not.toContain("rbots");
    const root = join(temp.dir, "mac");
    const path = await checkoutSync(git, root, syncOf(sent.commit), existsSync);
    expect(path).toBe(join(root, ".worktrees", "app", "feat-x"));
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("2\n");
    expect(existsSync(join(path, "b.txt"))).toBe(false);
    expect(readFileSync(join(path, "c.txt"), "utf8")).toBe("novo\n");
    expect(await sh(path, "status", "--porcelain")).toBe("M a.txt\n D b.txt\n?? c.txt");
    expect(await sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x");
    expect(await sh(path, "rev-parse", "HEAD")).toBe(await sh(vps, "rev-parse", "HEAD"));
    writeFileSync(join(path, "junk.txt"), "x\n");
    mkdirInto(path, "node_modules", "dep.js");
    await checkoutSync(git, root, syncOf(sent.commit), existsSync);
    expect(existsSync(join(path, "junk.txt"))).toBe(false);
    expect(existsSync(join(path, "node_modules", "dep.js"))).toBe(true);
    writeFileSync(join(path, "c.txt"), "do mac\n");
    const back = await pushSync(git, path, syncOf(sent.commit));
    expect(await sh(join(temp.dir, "origin.git"), "rev-parse", "refs/rbots/sync/feat/x")).toBe(back.commit);
    expect(await sh(path, "show", `${back.commit}:c.txt`)).toBe("do mac");
    expect(await sh(path, "rev-parse", `${back.commit}^`)).toBe(await sh(vps, "rev-parse", "HEAD"));
  });

  test("explains what failed", async () => {
    const root = join(temp.dir, "mac");
    await expect(
      checkoutSync(git, root, { ...syncOf("x"), cloneUrl: join(temp.dir, "none.git") }, existsSync),
    ).rejects.toThrow("Não consegui clonar no Mac");
    await expect(checkoutSync(git, root, syncOf("0".repeat(40)), existsSync)).rejects.toThrow(
      "Não consegui baixar o código da VPS",
    );
    await expect(pushSync(git, temp.dir, syncOf("x"))).rejects.toThrow("Não consegui ler a worktree do Mac");
  });
});

function mkdirInto(root: string, dir: string, file: string) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, file), "x\n");
}
