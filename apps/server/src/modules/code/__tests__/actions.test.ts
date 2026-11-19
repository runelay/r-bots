import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeProcesses, gitArgs, gitSync, makeRepo, newSession } from "../../../../test/code-helpers";
import type { ProcessCall, ProcessReply } from "../../../../test/helpers";
import { resetData } from "../../../../test/helpers";
import { listWorktrees } from "../repositories/code.repository";
import {
  closeTaskWorkspace,
  type DeliverInput,
  deliverProblem,
  deliverPrompt,
  deliverWorkspace,
  mentionedRepo,
  openTaskWorkspace,
  resolvePrBase,
} from "../services/actions.service";
import { activeWorkspace, listRepos, waitForInstall, type WorkspaceState } from "../services/workspace.service";

beforeEach(async () => {
  await resetData();
});

async function task(name: string, origin = true) {
  makeRepo(name, { origin });
  await listRepos(true);
  const session = await newSession(`bot-${name}`);
  const { workspace } = await openTaskWorkspace(session, `bot-${name}`, name, "deliver task");
  await waitForInstall(workspace);
  return { session, workspace };
}

function change(workspace: WorkspaceState, file = "feature.txt") {
  writeFileSync(join(workspace.path, file), `${file}\n`);
}

function withGh(gh: (args: string) => ProcessReply | undefined, git?: (call: ProcessCall) => ProcessReply | undefined) {
  return codeProcesses((call) => {
    if (call.command === "gh") return gh(call.args.join(" ")) ?? { code: 1, stderr: "unexpected" };
    return git?.(call);
  });
}

const commit: DeliverInput = { action: "commit", message: "feat(core): add feature" };

describe("task workspaces", () => {
  test("opens, records, closes and finds mentioned repos", async () => {
    const { session, workspace } = await task("act-open", false);
    const record = (await listWorktrees()).find((item) => item.id === workspace.id);
    expect(record).toMatchObject({ status: "alive", botId: "bot-act-open", sessionId: session.meta.sessionId });
    session.meta.providerSessions = { "vps:claude": "x" };
    expect(await closeTaskWorkspace(session)).toBe(workspace);
    expect(activeWorkspace(session)).toBeNull();
    expect(session.meta.providerSessions).toEqual({});
    expect((await listWorktrees()).find((item) => item.id === workspace.id)?.status).toBe("closed");
    expect(await closeTaskWorkspace(session)).toBeNull();

    expect(await mentionedRepo("no mentions here", [])).toBeNull();
    expect((await mentionedRepo("please check @act-open now", []))?.name).toBe("act-open");
    expect((await mentionedRepo("email@act-open @ACT-OPEN", []))?.name).toBe("act-open");
    expect(await mentionedRepo("@act-open", ["Act-Open"])).toBeNull();
    expect(await mentionedRepo("@nothing-here", [])).toBeNull();
  });
});

describe("delivery rules", () => {
  test("validates commit messages", () => {
    expect(deliverProblem({ action: "commit", message: " " })).toBe("Escreva a mensagem do commit.");
    expect(deliverProblem({ action: "push", message: "" }, false)).toBeNull();
    expect(deliverProblem({ action: "commit", message: "" }, false)).toBe("Escreva a mensagem do commit.");
    expect(deliverProblem({ action: "commit", message: "added stuff" })).toContain("conventional commits");
    expect(deliverProblem({ action: "pr", message: "feat: x", body: "Generated with bots" })).toContain(
      "Sem assinatura de IA",
    );
    expect(deliverProblem({ action: "pr", message: "feat: x", title: "Co-Authored-By: a" })).toContain("Sem assinatura");
    expect(deliverProblem({ action: "commit", message: "feat: a\nb\nc" })).toContain("Mensagem do commit curta");
    expect(deliverProblem({ action: "commit", message: `feat: ${"x".repeat(100)}` })).toContain("curta");
    expect(deliverProblem({ action: "commit", message: "fix(flags)!: ajuste de módulo" })).toContain("em inglês");
    expect(deliverProblem({ action: "commit", message: "fix(flags)!: split module\nbody" })).toBeNull();
  });

  test("describes what will happen", () => {
    const workspace = { branch: "feat/x", base: "origin/develop" } as WorkspaceState;
    expect(deliverPrompt(workspace, { action: "push", message: "feat: x" }, 2)).toBe(
      "Fazer commit de 2 arquivos e push da branch feat/x? Mensagem: “feat: x”",
    );
    expect(deliverPrompt(workspace, { action: "push", message: "feat: x" }, 1)).toContain("1 arquivo e push");
    expect(deliverPrompt(workspace, { action: "push", message: "" }, 0)).toBe("Fazer push da branch feat/x?");
    expect(deliverPrompt(workspace, { action: "pr", message: "feat: x" }, 1)).toContain("abrir PR para develop?");
    expect(deliverPrompt(workspace, { action: "pr", message: "feat: x", base: " main " }, 3)).toContain(
      "3 arquivos, push da branch feat/x e abrir PR para main?",
    );
    expect(deliverPrompt(workspace, commit, 1)).toBe(
      "Fazer commit de 1 arquivo na branch feat/x? Mensagem: “feat(core): add feature”",
    );
    expect(deliverPrompt(workspace, commit, 4)).toContain("4 arquivos na branch");
  });

  test("picks the PR base closest to HEAD", async () => {
    const workspace = { path: "/tmp", base: "origin/develop" } as WorkspaceState;
    expect(await resolvePrBase(workspace, " origin/release ")).toBe("release");
    const counts: Record<string, ProcessReply> = {
      "HEAD...origin/main": { stdout: "3\t5\n" },
      "HEAD...origin/develop": { stdout: "3\t1\n" },
      "HEAD...origin/master": { stdout: "x y\n" },
    };
    codeProcesses((call) => (gitArgs(call, "rev-list") ? counts[call.args[3]] : undefined));
    expect(await resolvePrBase(workspace)).toBe("develop");
    counts["HEAD...origin/main"] = { stdout: "1\t9\n" };
    expect(await resolvePrBase(workspace)).toBe("main");
    codeProcesses((call) => (gitArgs(call, "rev-list") ? { code: 128 } : undefined));
    expect(await resolvePrBase(workspace, "  ")).toBe("develop");
  });
});

describe("delivering", () => {
  test("commits pending work without pushing", async () => {
    const { workspace } = await task("act-commit", false);
    await expect(deliverWorkspace(workspace, { action: "commit", message: "wip" })).rejects.toThrow(
      "conventional commits",
    );
    change(workspace);
    const result = await deliverWorkspace(workspace, commit);
    expect(result).toMatchObject({ action: "commit", prUrl: null, prExisted: false, previousPr: null, files: 1 });
    expect(result.commit).toBe(gitSync(workspace.path, ["rev-parse", "--short", "HEAD"]).stdout.trim());
    expect(result.base).toBe("main");
    expect(gitSync(workspace.path, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("feat(core): add feature");
    expect((await listWorktrees()).find((item) => item.id === workspace.id)?.status).toBe("delivered");
    const nothing = await deliverWorkspace(workspace, commit);
    expect(nothing.commit).toBeNull();
  });

  test("reports git add and commit failures", async () => {
    const { workspace } = await task("act-commit-fail", false);
    change(workspace);
    codeProcesses((call) => (gitArgs(call, "add", "-A") ? { code: 1, stderr: "index.lock exists" } : undefined));
    await expect(deliverWorkspace(workspace, commit)).rejects.toThrow("git add falhou: index.lock exists");
    codeProcesses((call) => (gitArgs(call, "commit") ? { code: 1, stdout: "hook rejected" } : undefined));
    await expect(deliverWorkspace(workspace, commit)).rejects.toThrow("O commit falhou: hook rejected");
  });

  test("pushes and opens a PR, or reuses the open one", async () => {
    const { workspace } = await task("act-pr");
    change(workspace);
    const created = withGh((args) => {
      if (args.startsWith("pr list")) return { stdout: "[]" };
      if (args.startsWith("pr create")) return { stdout: "Creating pull request\nhttps://github.com/o/r/pull/9\n" };
      return undefined;
    });
    const result = await deliverWorkspace(workspace, {
      action: "pr",
      message: "feat: open pr",
      title: " Title ",
      body: " Body ",
    });
    expect(result).toMatchObject({ action: "pr", prUrl: "https://github.com/o/r/pull/9", prExisted: false, base: "main" });
    expect(gitSync(workspace.path, ["rev-parse", "--abbrev-ref", "@{u}"]).stdout.trim()).toBe(`origin/${workspace.branch}`);
    const create = created.calls.find((call) => call.args[1] === "create");
    expect(create?.args).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      workspace.branch,
      "--title",
      "Title",
      "--body",
      "Body",
    ]);
    expect((await listWorktrees()).find((item) => item.id === workspace.id)?.prUrl).toBe(
      "https://github.com/o/r/pull/9",
    );

    change(workspace, "second.txt");
    withGh((args) =>
      args.startsWith("pr list")
        ? {
            stdout: JSON.stringify([
              { number: 8, url: "u8", state: "CLOSED", baseRefName: "main", updatedAt: "2026-01-01" },
              { number: 9, url: "u9", state: "OPEN", baseRefName: "main", updatedAt: "2026-02-01" },
            ]),
          }
        : undefined,
    );
    const reused = await deliverWorkspace(workspace, { action: "pr", message: "feat: more" });
    expect(reused).toMatchObject({ prUrl: "u9", prExisted: true, previousPr: null });
  });

  test("keeps a closed PR as previous instead of opening a new one", async () => {
    const { workspace } = await task("act-pr-prev");
    withGh((args) =>
      args.startsWith("pr list")
        ? {
            stdout: JSON.stringify([
              { number: 1, url: "u1", state: "MERGED", baseRefName: "main" },
              { number: 2, url: "u2", state: "CLOSED", baseRefName: "dev", updatedAt: "2026-05-01" },
            ]),
          }
        : undefined,
    );
    const result = await deliverWorkspace(workspace, { action: "pr", message: "feat: again" });
    expect(result).toMatchObject({
      commit: null,
      prUrl: null,
      previousPr: { number: 2, url: "u2", state: "CLOSED", baseRefName: "dev" },
    });
    withGh((args) => (args.startsWith("pr list") ? { code: 1 } : undefined));
    expect((await deliverWorkspace(workspace, { action: "push", message: "" })).previousPr).toBeNull();
    withGh((args) => (args.startsWith("pr list") ? { stdout: "nope" } : undefined));
    expect((await deliverWorkspace(workspace, { action: "push", message: "" })).previousPr).toBeNull();
  });

  test("refuses protected branches and reports push and PR failures", async () => {
    const { workspace } = await task("act-pr-fail");
    await expect(
      deliverWorkspace({ ...workspace, branch: "develop" }, { action: "push", message: "" }),
    ).rejects.toThrow("A branch develop é protegida");
    withGh(
      () => undefined,
      (call) => (gitArgs(call, "push") ? { code: 1, stderr: "rejected" } : undefined),
    );
    await expect(deliverWorkspace(workspace, { action: "push", message: "" })).rejects.toThrow(
      "O push falhou: rejected",
    );
    withGh((args) => {
      if (args.startsWith("pr list")) return { stdout: "[]" };
      if (args.startsWith("pr create")) return { code: 1, stderr: "no commits between" };
      return undefined;
    });
    await expect(deliverWorkspace(workspace, { action: "pr", message: "feat: x" })).rejects.toThrow(
      "Não consegui abrir o PR: no commits between",
    );
    withGh((args) => {
      if (args.startsWith("pr list")) return { stdout: "[]" };
      if (args.startsWith("pr create")) return { code: 4 };
      return undefined;
    });
    await expect(deliverWorkspace(workspace, { action: "pr", message: "feat: x" })).rejects.toThrow(
      "Não consegui abrir o PR: gh saiu com código 4",
    );
  });
});
