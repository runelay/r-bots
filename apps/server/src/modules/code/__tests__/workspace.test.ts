import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as proc from "@runelay-bots/providers/proc";
import {
  codeProcesses,
  factsOf,
  gitArgs,
  gitSync,
  makeRepo,
  newSession,
  repoRoot,
  worktreesDir,
  writeFiles,
} from "../../../../test/code-helpers";
import { waitFor } from "../../../../test/engine-helpers";
import { resetData } from "../../../../test/helpers";
import { addAllowedRepo } from "../services/repos.service";
import {
  activeWorkspace,
  allDiffs,
  baseContent,
  CodeError,
  cachedRepoNames,
  changedFiles,
  checkpointRef,
  clipText,
  closeWorkspace,
  codeSummary,
  createCheckpoint,
  diffTexts,
  fileDiff,
  hunkStats,
  insideWorkspace,
  installLogPath,
  invalidateStatus,
  listRepos,
  openWorkspace,
  parsePatch,
  publicWorkspace,
  readMaybe,
  relativePath,
  resolveRepo,
  restoreCheckpoint,
  revertFile,
  slugify,
  snapshotChanges,
  type WorkspaceState,
  waitForInstall,
} from "../services/workspace.service";

beforeEach(async () => {
  await resetData();
});

describe("repository discovery", () => {
  test("lists only allowed repos that still have a .git folder", async () => {
    await makeRepo("ws-alpha");
    await makeRepo("ws-beta", { branch: "develop" });
    mkdirSync(join(repoRoot, "ws-unlisted", ".git"), { recursive: true });
    await addAllowedRepo(join(repoRoot, "ws-gone"), "test", null);
    const repos = await listRepos(true);
    const names = repos.map((repo) => repo.name);
    expect(names).toContain("ws-alpha");
    expect(names).toContain("ws-beta");
    expect(names).not.toContain("ws-unlisted");
    expect(names).not.toContain("ws-gone");
    expect(repos.find((repo) => repo.name === "ws-beta")?.branch).toBe("develop");
    expect(cachedRepoNames()).toEqual(names);
  });

  test("resolves allowed repos by path, home path, exact, case, loose and partial names", async () => {
    await makeRepo("ws-resolve-one");
    await makeRepo("ws-Resolve-Two");
    await makeRepo("wsmulti-a");
    await makeRepo("wsmulti-b");
    mkdirSync(join(repoRoot, "ws-unlisted", ".git"), { recursive: true });
    await listRepos(true);
    await expect(resolveRepo("  ")).rejects.toThrow("Diga qual repositório.");
    expect((await resolveRepo(join(repoRoot, "ws-resolve-one"))).path).toBe(join(repoRoot, "ws-resolve-one"));
    expect((await resolveRepo("~/repos/ws-resolve-one")).path).toBe(join(repoRoot, "ws-resolve-one"));
    await expect(resolveRepo(join(repoRoot, "ws-unlisted"))).rejects.toThrow("workspace_add");
    expect((await resolveRepo("@ws-resolve-one")).name).toBe("ws-resolve-one");
    expect((await resolveRepo("ws-resolve-two")).name).toBe("ws-Resolve-Two");
    expect((await resolveRepo("WS RESOLVE ONE")).name).toBe("ws-resolve-one");
    expect((await resolveRepo("resolveone")).name).toBe("ws-resolve-one");
    await expect(resolveRepo("wsmulti")).rejects.toThrow('Achei mais de um repositório para "wsmulti"');
    await expect(resolveRepo("zzz-nothing")).rejects.toThrow('Não achei "zzz-nothing"');
    const error = await resolveRepo("zzz-nothing").catch((caught) => caught);
    expect(error).toBeInstanceOf(CodeError);
    expect(error.status).toBe(400);
  });

  test("slugify keeps short slugs, falls back and cuts on a dash", async () => {
    expect(slugify("Olá, Mundo!")).toBe("ola-mundo");
    expect(slugify("!!!")).toBe("tarefa");
    expect(slugify("fix the login screen when the token expires early", 40)).toBe(
      "fix-the-login-screen-when-the-token",
    );
    expect(slugify("a".repeat(50), 10)).toBe("aaaaaaaaaa");
    expect(slugify("abc-defghijklmnopqrstuvwxyz", 10)).toBe("abc-defghi");
  });
});

async function opened(name: string, options: Parameters<typeof makeRepo>[1] = {}, task = "Add feature") {
  await makeRepo(name, options);
  await listRepos(true);
  const session = await newSession(`bot-${name}`);
  const result = await openWorkspace(session, `bot-${name}`, name, task);
  await waitForInstall(result.workspace);
  return { session, ...result };
}

describe("opening and closing workspaces", () => {
  test("creates a worktree from the best base and reuses or reopens it", async () => {
    const { session, workspace, created } = await opened("ws-open", { origin: true });
    expect(created).toBe(true);
    expect(workspace.base).toBe("origin/main");
    expect(workspace.branch).toBe("feat/add-feature");
    expect(workspace.path).toBe(join(worktreesDir, "ws-open", "ws-open-bot-ws-open-add-feature"));
    expect(existsSync(join(workspace.path, "README.md"))).toBe(true);
    expect(workspace.install.status).toBe("skipped");
    expect(activeWorkspace(session)).toBe(workspace);
    expect((await factsOf(session, "code.workspace"))[0].data.action).toBe("opened");

    const again = await openWorkspace(session, "bot-ws-open", "ws-open", "Add feature");
    expect(again).toEqual({ workspace, created: false });

    expect(await closeWorkspace(session)).toBe(workspace);
    expect(activeWorkspace(session)).toBeNull();
    expect(await closeWorkspace(session)).toBeNull();
    expect((await factsOf(session, "code.workspace")).map((fact) => fact.data.action)).toEqual(["opened", "closed"]);

    const reopened = await openWorkspace(session, "bot-ws-open", "ws-open", "Add feature");
    expect(reopened.created).toBe(false);
    expect(reopened.workspace.active).toBe(true);
    expect(reopened.workspace.closedAt).toBeNull();
    expect((await factsOf(session, "code.workspace")).at(-1)?.data.action).toBe("reopened");

    await closeWorkspace(session, true);
    expect(await factsOf(session, "code.workspace")).toHaveLength(3);
    expect(activeWorkspace(undefined)).toBeNull();
    expect(publicWorkspace({ ...workspace, pr: undefined }).pr).toBeNull();
  });

  test("picks a local base, falls back to HEAD and uses the session title", async () => {
    const develop = await opened("ws-develop", { branch: "develop" });
    expect(develop.workspace.base).toBe("develop");
    await makeRepo("ws-headbase", { branch: "trunk" });
    await listRepos(true);
    const session = await newSession("bot-head");
    session.meta.title = "Título da sessão";
    const { workspace } = await openWorkspace(session, "bot-head", "ws-headbase", "");
    await waitForInstall(workspace);
    expect(workspace.base).toBe("HEAD");
    expect(workspace.branch).toBe("feat/titulo-da-sessao");
    const untitled = await newSession("bot-head");
    untitled.meta.title = "";
    const fallback = await openWorkspace(untitled, "bot-head", "ws-headbase", "");
    await waitForInstall(fallback.workspace);
    expect(fallback.workspace.branch).toBe("feat/tarefa");
  });

  test("adds a suffix when the folder or branch is taken", async () => {
    const first = await opened("ws-clash");
    const second = await openWorkspace(await newSession("bot-ws-clash"), "bot-ws-clash", "ws-clash", "Add feature");
    await waitForInstall(second.workspace);
    expect(second.workspace.branch).toBe("feat/add-feature-2");
    for (const suffix of ["3", "4", "5"]) gitSync(first.workspace.repo, ["branch", `feat/add-feature-${suffix}`]);
    const sixth = await openWorkspace(await newSession("bot-ws-clash"), "bot-ws-clash", "ws-clash", "Add feature");
    await waitForInstall(sixth.workspace);
    expect(sixth.workspace.branch).toMatch(/^feat\/add-feature-[0-9a-f]{4}$/);
  });

  test("reports a worktree that git refuses to create", async () => {
    await makeRepo("ws-refuse");
    await listRepos(true);
    codeProcesses((call) =>
      gitArgs(call, "worktree", "add") ? { code: 128, stderr: "fatal: refused", stdout: "" } : undefined,
    );
    const error = await openWorkspace(await newSession("bot-refuse"), "bot-refuse", "ws-refuse", "Task").catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(CodeError);
    expect(error.status).toBe(500);
    expect(error.message).toContain("fatal: refused");
  });
});

describe("dependency install", () => {
  test("skips when there is no lockfile or node_modules is already there", async () => {
    const managers: Record<string, string> = {
      "bun.lock": "bun",
      "pnpm-lock.yaml": "pnpm",
      "yarn.lock": "yarn",
      "package-lock.json": "npm",
    };
    for (const [name, lock] of [
      ["ws-lock-bun", "bun.lock"],
      ["ws-lock-pnpm", "pnpm-lock.yaml"],
      ["ws-lock-yarn", "yarn.lock"],
      ["ws-lock-npm", "package-lock.json"],
    ]) {
      const { workspace } = await opened(name, { files: { [lock]: "x", "node_modules/.keep": "" } });
      expect(workspace.install.status).toBe("skipped");
      expect(workspace.install.manager).toBe(managers[lock]);
    }
  });

  test("runs the package manager and records success", async () => {
    const calls = codeProcesses((call) =>
      call.command.endsWith("bun") ? { code: 0, stdout: "installed\n", stderr: "warn\n" } : undefined,
    );
    const { session, workspace } = await opened("ws-install-ok", { files: { "bun.lockb": "x" } });
    expect(workspace.install.status).toBe("done");
    expect(workspace.install.command).toBe("bun install --frozen-lockfile --ignore-scripts");
    const install = calls.calls.find((call) => call.command.endsWith("bun"));
    expect(install?.args).toEqual(["install", "--frozen-lockfile", "--ignore-scripts"]);
    const log = await waitFor(() => {
      const text = readFileSync(installLogPath(workspace), "utf8");
      return text.includes("installed") && text.includes("warn") ? text : null;
    });
    expect(log).toContain("installed");
    const facts = await factsOf(session, "code.install");
    expect(facts.map((fact) => fact.data.status)).toEqual(["running", "done"]);
    expect(typeof facts[1].data.durationMs).toBe("number");
  });

  test("records failures with the log tail or the exit code", async () => {
    codeProcesses((call) => (call.command.endsWith("bun") ? { code: 1, stderr: "ERR boom\n" } : undefined));
    const failed = await opened("ws-install-fail", { files: { "bun.lock": "x" } });
    expect(failed.workspace.install.status).toBe("failed");
    expect(["ERR boom", "bun install --frozen-lockfile --ignore-scripts saiu com código 1."]).toContain(
      failed.workspace.install.error as string,
    );
    codeProcesses((call) => (call.command.endsWith("npm") ? { code: 2 } : undefined));
    const silent = await opened("ws-install-silent", { files: { "package-lock.json": "{}" } });
    expect(silent.workspace.install.error).toBe("npm ci --no-audit --no-fund --ignore-scripts saiu com código 2.");
  });

  test("fails when the binary is missing or cannot spawn", async () => {
    const find = spyOn(proc, "findBinary").mockReturnValue(null);
    const missing = await opened("ws-install-missing", { files: { "yarn.lock": "x" } });
    find.mockRestore();
    expect(missing.workspace.install.status).toBe("failed");
    expect(missing.workspace.install.error).toBe("yarn não está instalado na VPS.");
    expect((await factsOf(missing.session, "code.install")).map((fact) => fact.data.status)).toEqual(["failed"]);

    codeProcesses((call) => {
      if (call.command.endsWith("pnpm")) throw new Error("spawn failed");
      return undefined;
    });
    const broken = await opened("ws-install-throw", { files: { "pnpm-lock.yaml": "x" } });
    expect(broken.workspace.install.status).toBe("failed");
    expect(broken.workspace.install.error).toBe("pnpm install --frozen-lockfile --ignore-scripts saiu com código 1.");
  });

  test("treats unreadable folders and logs as empty", async () => {
    const fs = await import("node:fs/promises");
    const realReaddir = fs.readdir;
    const readdirSpy = spyOn(fs, "readdir").mockImplementation(((path: string, ...rest: unknown[]) =>
      String(path).startsWith(worktreesDir)
        ? Promise.reject(new Error("EACCES"))
        : (realReaddir as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.readdir);
    const unreadable = await opened("ws-install-unreadable", { files: { "bun.lock": "x" } });
    readdirSpy.mockRestore();
    expect(unreadable.workspace.install).toMatchObject({ status: "skipped", manager: null });

    const realReadFile = fs.readFile;
    const readFileSpy = spyOn(fs, "readFile").mockImplementation(((path: string, ...rest: unknown[]) =>
      String(path).endsWith("install.log")
        ? Promise.reject(new Error("EIO"))
        : (realReadFile as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.readFile);
    codeProcesses((call) => (call.command.endsWith("bun") ? { code: 3, stderr: "nope\n" } : undefined));
    const lost = await opened("ws-install-lostlog", { files: { "bun.lock": "x" } });
    readFileSpy.mockRestore();
    expect(lost.workspace.install.error).toBe("bun install --frozen-lockfile --ignore-scripts saiu com código 3.");
  });

  test("logs instead of crashing when saving the session fails", async () => {
    await makeRepo("ws-install-crash");
    await listRepos(true);
    const session = await newSession("bot-crash");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const realSave = session.save.bind(session);
    let saves = 0;
    session.save = () => (++saves === 2 ? Promise.reject(new Error("disk full")) : realSave());
    const { workspace } = await openWorkspace(session, "bot-crash", "ws-install-crash", "Task");
    await waitForInstall(workspace);
    expect(warn).toHaveBeenCalledWith("install failed", expect.any(Error));
    warn.mockRestore();
  });
});

describe("paths", () => {
  const workspace = { path: "/work/tree" } as WorkspaceState;

  test("checks containment and relative paths", async () => {
    expect(insideWorkspace(workspace, "src/a.ts")).toBe(true);
    expect(insideWorkspace(workspace, "/work/tree")).toBe(true);
    expect(insideWorkspace(workspace, "../other")).toBe(false);
    expect(relativePath(workspace, "/work/tree/src/a.ts")).toBe("src/a.ts");
    expect(relativePath(workspace, "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("changes and diffs", () => {
  test("lists modified, added, deleted, renamed, binary and untracked files", async () => {
    const { workspace } = await opened("ws-changes", {
      files: {
        "keep.txt": "one\ntwo\n",
        "gone.txt": "bye\n",
        "old-name.txt": "rename me please, this content is long enough\n",
        "src/old.ts": "export const value = 'rename me too, long enough content';\n",
      },
    });
    writeFiles(workspace.path, {
      "keep.txt": "one\nthree\nfour\n",
      "staged.txt": "new\n",
      "untracked.txt": "a\nb\nc",
      "empty.txt": "",
      "image.bin": new Uint8Array([0, 1, 2, 3]),
      "big.bin": new Uint8Array(2 * 1024 * 1024 + 10).fill(65),
      "bin-tracked.dat": new Uint8Array([0, 9, 9]),
      'quo"te.txt': "q\n",
    });
    rmSync(join(workspace.path, "gone.txt"));
    symlinkSync(join(workspace.path, "nowhere"), join(workspace.path, "dangling.txt"));
    gitSync(workspace.path, ["add", "staged.txt", "bin-tracked.dat"]);
    gitSync(workspace.path, ["mv", "old-name.txt", "new-name.txt"]);
    gitSync(workspace.path, ["mv", "src/old.ts", "src/new.ts"]);
    const files = await changedFiles(workspace, true);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
    expect(byPath["keep.txt"]).toEqual({ path: "keep.txt", status: "modified", added: 2, removed: 1, binary: false });
    expect(byPath["staged.txt"].status).toBe("added");
    expect(byPath["gone.txt"].status).toBe("deleted");
    expect(byPath["new-name.txt"].status).toBe("renamed");
    expect(byPath["src/new.ts"].status).toBe("renamed");
    expect(byPath["bin-tracked.dat"]).toMatchObject({ binary: true, added: 0, removed: 0 });
    expect(byPath["untracked.txt"]).toMatchObject({ status: "untracked", added: 3 });
    expect(byPath["empty.txt"]).toMatchObject({ added: 0, binary: false });
    expect(byPath["image.bin"].binary).toBe(true);
    expect(byPath["big.bin"].binary).toBe(true);
    expect(byPath["dangling.txt"]).toMatchObject({ added: 0, binary: false });
    expect(byPath['quo"te.txt'].status).toBe("untracked");
    expect(files.map((file) => file.path)).toEqual(
      [...files.map((file) => file.path)].sort((a, b) => a.localeCompare(b)),
    );

    writeFileSync(join(workspace.path, "later.txt"), "x\n");
    expect(await changedFiles(workspace)).toBe(files);
    invalidateStatus(workspace);
    expect((await changedFiles(workspace)).map((file) => file.path)).toContain("later.txt");

    const summary = await codeSummary(workspace);
    expect(summary.files).toBe(files.length + 1);
    expect(summary.added).toBeGreaterThan(0);
    expect(summary.removed).toBeGreaterThan(0);

    const snapshot = await snapshotChanges(workspace);
    expect(snapshot.get("keep.txt")).toBe("one\nthree\nfour\n");
    expect(snapshot.has("image.bin")).toBe(false);
    expect(snapshot.get("gone.txt")).toBeNull();
  });

  test("keeps unparseable quoted paths as written", async () => {
    const { workspace } = await opened("ws-quoted");
    writeFileSync(join(workspace.path, "café.txt"), "x\n");
    const files = await changedFiles(workspace, true);
    expect(files[0].path).toBe("caf\\303\\251.txt");
  });

  test("summaries and snapshots tolerate git failures", async () => {
    const { workspace } = await opened("ws-git-broken");
    const spy = spyOn(proc, "run").mockRejectedValue(new Error("git exploded"));
    try {
      expect((await codeSummary(workspace)).files).toBe(0);
      expect((await snapshotChanges(workspace)).size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("diffs one file, every file, and reverts tracked and new files", async () => {
    const { workspace } = await opened("ws-diff", { files: { "a.txt": "1\n2\n3\n", "big.txt": "x\n" } });
    writeFiles(workspace.path, {
      "a.txt": "1\ntwo\n3\n",
      "new.txt": "fresh\n",
      "pic.bin": new Uint8Array([0, 1]),
      "big.txt": "y".repeat(200_001),
    });
    const tracked = await fileDiff(workspace, "a.txt");
    expect(tracked).toMatchObject({ path: "a.txt", status: "modified", added: 1, removed: 1, binary: false });
    expect(tracked.before).toBe("1\n2\n3\n");
    expect(tracked.after).toBe("1\ntwo\n3\n");
    expect(tracked.hunks[0].lines).toEqual([" 1", "-2", "+two", " 3"]);
    const fresh = await fileDiff(workspace, "new.txt");
    expect(fresh).toMatchObject({ status: "untracked", before: null, after: "fresh\n" });
    expect(fresh.hunks[0].lines).toEqual(["+fresh"]);
    const big = await fileDiff(workspace, "big.txt");
    expect(big.after).toBeNull();
    const ghost = await fileDiff(workspace, "ghost.txt");
    expect(ghost).toMatchObject({ status: "modified", added: 0, removed: 0, binary: false, hunks: [], after: null });
    await expect(fileDiff(workspace, "../escape")).rejects.toThrow("Caminho fora da tarefa.");
    await expect(fileDiff(workspace, ".git/config")).rejects.toThrow("Caminho fora da tarefa.");
    await expect(fileDiff(workspace, ".")).rejects.toThrow("Caminho fora da tarefa.");

    const all = await allDiffs(workspace);
    const byPath = Object.fromEntries(all.files.map((file) => [file.path, file]));
    expect(byPath["a.txt"].hunks).toHaveLength(1);
    expect(byPath["new.txt"].hunks[0].lines).toEqual(["+fresh"]);
    expect(byPath["pic.bin"].hunks).toEqual([]);
    expect(all.patch).toContain("diff --git a/a.txt b/a.txt");

    expect(await baseContent(workspace, "a.txt")).toBe("1\n2\n3\n");
    expect(await baseContent(workspace, "new.txt")).toBeNull();

    expect(await revertFile(workspace, "a.txt")).toBe("a.txt");
    expect(readFileSync(join(workspace.path, "a.txt"), "utf8")).toBe("1\n2\n3\n");
    gitSync(workspace.path, ["add", "new.txt"]);
    expect(await revertFile(workspace, "new.txt")).toBe("new.txt");
    expect(existsSync(join(workspace.path, "new.txt"))).toBe(false);
  });

  test("reports a revert that git cannot apply", async () => {
    const { workspace } = await opened("ws-revert-fail", { files: { "a.txt": "1\n" } });
    codeProcesses((call) => (gitArgs(call, "checkout") ? { code: 1, stderr: "locked" } : undefined));
    await expect(revertFile(workspace, "a.txt")).rejects.toThrow("Não consegui desfazer: locked");
  });

  test("diffs two texts", async () => {
    const result = await diffTexts("a\nb\n", "a\nc\n");
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(result.hunks[0].lines).toEqual([" a", "-b", "+c"]);
    const created = await diffTexts(null, "x\n");
    expect(created.added).toBe(1);
    expect(await diffTexts("same\n", "same\n")).toEqual({ hunks: [], added: 0, removed: 0 });
  });

  test("reads small text files only", async () => {
    const dir = join(repoRoot, "ws-read");
    writeFiles(dir, {
      "text.txt": "hi",
      "bin.dat": new Uint8Array([1, 0, 2]),
      "huge.txt": "z".repeat(1024 * 1024 + 1),
    });
    expect(await readMaybe(join(dir, "text.txt"))).toBe("hi");
    expect(await readMaybe(join(dir, "bin.dat"))).toBeNull();
    expect(await readMaybe(join(dir, "huge.txt"))).toBeNull();
    expect(await readMaybe(dir)).toBeNull();
    expect(await readMaybe(join(dir, "missing"))).toBeNull();
    expect(clipText("ok")).toBe("ok");
    expect(clipText(null)).toBeNull();
    expect(clipText("x".repeat(200_001))).toBeNull();
  });
});

describe("patch parsing", () => {
  test("parses files, hunks, sections, renames, deletions and binaries", async () => {
    const patch = [
      "noise before any file",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@ function main() {",
      " keep",
      "-old",
      "+new",
      "+more",
      "\\ No newline at end of file",
      "diff --git a/gone.txt b/gone.txt",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      'diff --git "a/sp ace.txt" "b/sp ace.txt"',
      '+++ "b/sp ace.txt"',
      "@@ -2 +2 @@",
      "+x",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "gone.txt", "img.png", "sp ace.txt"]);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      section: "function main() {",
      lines: [" keep", "-old", "+new", "+more"],
    });
    expect(files[1].hunks[0]).toMatchObject({ oldLines: 1, newStart: 0, newLines: 0, lines: ["-bye"] });
    expect(files[1].hunks[0].section).toBeUndefined();
    expect(files[2].binary).toBe(true);
    expect(files[3].hunks[0]).toMatchObject({ oldStart: 2, oldLines: 1, newLines: 1 });
    expect(parsePatch("diff --git weird")[0]).toEqual({ path: "", oldPath: null, hunks: [], binary: false });
    expect(hunkStats(files.flatMap((file) => file.hunks))).toEqual({ added: 3, removed: 2 });
  });
});

describe("checkpoints", () => {
  test("creates once per turn and restores files, removing new ones", async () => {
    const { session, workspace } = await opened("ws-check", { files: { "a.txt": "base\n" } });
    writeFiles(workspace.path, { "a.txt": "turn one\n", "keep-new.txt": "k\n" });
    const checkpoint = await createCheckpoint(session, workspace, "turn_1");
    expect(checkpoint.ref).toBe(checkpointRef(session.meta.sessionId, "turn_1"));
    expect(gitSync(workspace.path, ["rev-parse", checkpoint.ref]).stdout.trim()).toBe(checkpoint.commit);
    expect(await createCheckpoint(session, workspace, "turn_1")).toBe(checkpoint);
    expect(session.meta.checkpoints).toHaveLength(1);
    expect(await factsOf(session, "code.checkpoint")).toHaveLength(1);

    writeFiles(workspace.path, { "a.txt": "turn two\n", "later.txt": "l\n" });
    const restored = await restoreCheckpoint(workspace, checkpoint);
    expect(restored).toEqual({ restored: 2, removed: 1 });
    expect(readFileSync(join(workspace.path, "a.txt"), "utf8")).toBe("turn one\n");
    expect(existsSync(join(workspace.path, "later.txt"))).toBe(false);
    expect(existsSync(join(workspace.path, "keep-new.txt"))).toBe(true);
  });

  test("reports missing checkpoints and git failures", async () => {
    const { session, workspace } = await opened("ws-check-fail", { files: { "a.txt": "base\n" } });
    const missing = { turnId: "turn_9", ref: "x", commit: "f".repeat(40), workspaceId: workspace.id, at: "" };
    const error = await restoreCheckpoint(workspace, missing).catch((caught) => caught);
    expect(error.status).toBe(404);
    expect(error.message).toContain("Esse ponto de volta não existe mais");

    const good = await createCheckpoint(session, workspace, "turn_2");
    codeProcesses((call) => (gitArgs(call, "checkout-index") ? { code: 1, stderr: "disk" } : undefined));
    await expect(restoreCheckpoint(workspace, good)).rejects.toThrow("Não consegui voltar os arquivos: disk");

    codeProcesses((call) => (gitArgs(call, "add", "-A") ? { code: 1, stderr: "index locked" } : undefined));
    await expect(createCheckpoint(session, workspace, "turn_3")).rejects.toThrow(
      "Não consegui guardar o ponto de volta: index locked",
    );
    codeProcesses((call) => (gitArgs(call, "commit-tree") ? { code: 1, stderr: "bad tree" } : undefined));
    await expect(createCheckpoint(session, workspace, "turn_4")).rejects.toThrow(
      "Não consegui guardar o ponto de volta: bad tree",
    );
  });

  test("keeps only the last 200 checkpoints", async () => {
    const { session, workspace } = await opened("ws-check-cap");
    session.meta.checkpoints = Array.from({ length: 200 }, (_, index) => ({
      turnId: `old_${index}`,
      ref: "r",
      commit: "c",
      workspaceId: workspace.id,
      at: "",
    }));
    await createCheckpoint(session, workspace, "turn_new");
    expect(session.meta.checkpoints).toHaveLength(200);
    expect(session.meta.checkpoints?.[0].turnId).toBe("old_1");
  });
});
