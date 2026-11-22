import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeProcesses, gitArgs, gitSync, makeRepo } from "../../../../test/code-helpers";
import { resetData } from "../../../../test/helpers";
import { dropAllRunners, fakeRunner, hostHello, runnerDevice } from "../../../../test/runner-helpers";
import {
  applyPendingSync,
  applySync,
  beginMacTurn,
  cleanSyncAfterDeliver,
  detachedMessage,
  dropSyncRef,
  finishMacTurn,
  githubRepoOf,
  noGithubMessage,
  prepareMacSync,
  resetMacSync,
  snapshotCommit,
  syncBeforeDeliver,
  syncRefOf,
} from "../services/mac-sync.service";

const github = "https://github.com/acme/app.git";
const ref = "refs/rbots/sync/feat/x";
let failing: string | null = null;

beforeEach(async () => {
  await resetData();
  failing = null;
  codeProcesses((call) => (failing && gitArgs(call, failing) ? { code: 1, stderr: `falhou ${failing}` } : undefined));
});

afterEach(() => {
  resetMacSync();
  dropAllRunners();
});

async function githubRepo(name: string) {
  const repo = await makeRepo(name, { origin: true, files: { "a.txt": "1\n", "b.txt": "keep\n" } });
  gitSync(repo.path, ["remote", "set-url", "origin", github]);
  gitSync(repo.path, ["config", `url.${repo.origin}.insteadOf`, github]);
  gitSync(repo.path, ["checkout", "-q", "-b", "feat/x"]);
  return { ...repo, origin: repo.origin as string };
}

function macClone(origin: string, commit: string) {
  const mac = join(mkdtempSync(join(tmpdir(), "rb-mac-")), "app");
  gitSync(tmpdir(), ["clone", "-q", origin, mac]);
  gitSync(mac, ["config", "user.name", "Mac"]);
  gitSync(mac, ["config", "user.email", "mac@example.com"]);
  gitSync(mac, ["fetch", "-q", "origin", `+${ref}:${ref}`]);
  gitSync(mac, ["checkout", "-q", "-B", "feat/x", `${commit}^`]);
  gitSync(mac, ["checkout", commit, "--", "."]);
  gitSync(mac, ["reset", "-q"]);
  return mac;
}

function macSnapshot(mac: string) {
  const index = join(mac, ".git", "rbots-index");
  const env = { ...process.env, GIT_INDEX_FILE: index } as Record<string, string>;
  gitSync(mac, ["read-tree", "HEAD"], env);
  gitSync(mac, ["add", "-A"], env);
  const tree = gitSync(mac, ["write-tree"], env).stdout.trim();
  rmSync(index, { force: true });
  const commit = gitSync(mac, ["commit-tree", tree, "-p", "HEAD", "-m", "r/bots sync"]).stdout.trim();
  gitSync(mac, ["push", "-q", "--force", "origin", `${commit}:${ref}`]);
  return commit;
}

describe("githubRepoOf", () => {
  test("reads the GitHub repository from any origin form", () => {
    expect(githubRepoOf("https://github.com/acme/app.git\n")).toBe("acme/app");
    expect(githubRepoOf("https://x-access-token:t@github.com/acme/app")).toBe("acme/app");
    expect(githubRepoOf("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubRepoOf("ssh://git@github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepoOf("https://gitlab.com/acme/app.git")).toBeNull();
    expect(githubRepoOf("/srv/app.git")).toBeNull();
    expect(syncRefOf("feat/x")).toBe(ref);
  });
});

describe("Mac workspace sync", () => {
  test("refuses what the Mac cannot receive and skips folders without git", async () => {
    const plain = mkdtempSync(join(tmpdir(), "rb-plain-"));
    expect(await prepareMacSync(plain)).toEqual({ kind: "plain" });
    const local = await makeRepo("local-only", { origin: true });
    expect(await prepareMacSync(local.path)).toEqual({ kind: "refused", message: noGithubMessage });
    const repo = await githubRepo("detached");
    gitSync(repo.path, ["checkout", "-q", "--detach"]);
    expect(await prepareMacSync(repo.path)).toEqual({ kind: "refused", message: detachedMessage });
    gitSync(repo.path, ["checkout", "-q", "feat/x"]);
    failing = "push";
    expect(await prepareMacSync(repo.path)).toEqual({
      kind: "refused",
      message: "Não consegui mandar o código para o GitHub: falhou push",
    });
    failing = "add";
    await expect(snapshotCommit(repo.path)).rejects.toThrow("Não consegui guardar o estado da worktree: falhou add");
    failing = "commit-tree";
    await expect(snapshotCommit(repo.path)).rejects.toThrow(
      "Não consegui guardar o estado da worktree: falhou commit-tree",
    );
  });

  test("sends the VPS work through a hidden ref and brings the Mac work back without new commits", async () => {
    const repo = await githubRepo("roundtrip");
    const head = gitSync(repo.path, ["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(join(repo.path, "a.txt"), "2\n");
    writeFileSync(join(repo.path, "c.txt"), "novo\n");
    const plan = await prepareMacSync(repo.path);
    expect(plan.kind).toBe("sync");
    if (plan.kind !== "sync") return;
    expect(plan.sync).toMatchObject({
      repo: "acme/app",
      cloneUrl: github,
      name: "app",
      branch: "feat/x",
      ref,
      cwd: repo.path,
    });
    expect(gitSync(repo.origin, ["rev-parse", ref]).stdout.trim()).toBe(plan.sync.commit);
    expect(gitSync(repo.path, ["rev-parse", "HEAD"]).stdout.trim()).toBe(head);
    expect(gitSync(repo.path, ["status", "--porcelain"]).stdout).toBe(" M a.txt\n?? c.txt\n");
    const mac = macClone(repo.origin, plan.sync.commit);
    writeFileSync(join(mac, "c.txt"), "do mac\n");
    gitSync(mac, ["rm", "-q", "b.txt"]);
    gitSync(mac, ["commit", "-q", "-m", "feat: mac"]);
    writeFileSync(join(mac, "d.txt"), "d\n");
    const commit = macSnapshot(mac);
    beginMacTurn(repo.path, "mac-1:runner", "t1");
    await finishMacTurn(repo.path, { ref, commit });
    expect(gitSync(repo.path, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("feat: mac");
    expect(existsSync(join(repo.path, "b.txt"))).toBe(false);
    expect(readFileSync(join(repo.path, "d.txt"), "utf8")).toBe("d\n");
    expect(readFileSync(join(repo.path, "c.txt"), "utf8")).toBe("do mac\n");
    expect(gitSync(repo.path, ["status", "--porcelain"]).stdout).toBe(" M a.txt\n?? c.txt\n?? d.txt\n");
    gitSync(repo.path, ["add", "-A"]);
    gitSync(repo.path, ["commit", "-q", "-m", "feat: delivered"]);
    writeFileSync(join(mac, "e.txt"), "e\n");
    const later = macSnapshot(mac);
    await applySync(repo.path, { ref, commit: later });
    expect(gitSync(repo.path, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("feat: delivered");
    expect(gitSync(repo.path, ["status", "--porcelain"]).stdout).toBe("?? e.txt\n");
    await applyPendingSync(repo.path);
    await expect(applySync(repo.path, { ref, commit: "f".repeat(40) })).rejects.toThrow(
      "O código do Mac chegou incompleto.",
    );
    await expect(applySync(repo.path, { ref: "refs/rbots/sync/none", commit: later })).rejects.toThrow(
      "Não consegui baixar o código do Mac",
    );
    await cleanSyncAfterDeliver(repo.path);
    expect(gitSync(repo.origin, ["show-ref"], { ...process.env } as Record<string, string>).stdout).not.toContain(
      "refs/rbots",
    );
    await cleanSyncAfterDeliver(repo.path);
  });

  test("pulls the running Mac turn before a delivery and cleans the ref when that turn ends", async () => {
    const repo = await githubRepo("deliver");
    const plan = await prepareMacSync(repo.path);
    if (plan.kind !== "sync") throw new Error("sem sync");
    const mac = macClone(repo.origin, plan.sync.commit);
    writeFileSync(join(mac, "f.txt"), "f\n");
    const commit = macSnapshot(mac);
    const runner = fakeRunner(runnerDevice("mac-1:runner", 5, { deviceId: "mac-1" }));
    runner.say(hostHello({ environment: "mac" }));
    beginMacTurn(repo.path, "mac-1:runner", "t1");
    const pulled = syncBeforeDeliver(repo.path);
    const asked = await runner.next("request");
    expect(asked).toMatchObject({ op: "workspace.sync", turnId: "t1" });
    runner.say({ type: "response", id: asked.id, ok: true, result: { ref, commit } });
    await pulled;
    expect(readFileSync(join(repo.path, "f.txt"), "utf8")).toBe("f\n");
    await cleanSyncAfterDeliver(repo.path);
    expect(gitSync(repo.origin, ["rev-parse", "--verify", "-q", ref], {} as Record<string, string>).code).toBe(0);
    await finishMacTurn(repo.path, null);
    expect(gitSync(repo.origin, ["rev-parse", "--verify", "-q", ref], {} as Record<string, string>).code).not.toBe(0);
    await syncBeforeDeliver(repo.path);
    gitSync(repo.path, ["checkout", "-q", "--detach"]);
    await dropSyncRef(repo.path);
  });
});
