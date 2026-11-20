import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeToolHooks } from "@runelay-bots/protocol";
import { factsOfType, makeBot, newSession } from "../../../../test/engine-helpers";
import {
  aborted,
  contextOf,
  lastRequest,
  quietEngine,
  repliesOf,
  restoreTracked,
  run,
  sequence,
  settledOf,
  track,
} from "../../../../test/engine-turn-helpers";
import { fakeProviders, replyWith } from "../../../../test/helpers";
import { clearLimit } from "../../accounts/services/limits.service";
import * as decisions from "../../approvals/services/decisions.service";
import * as actions from "../../code/services/actions.service";
import * as devServers from "../../code/services/dev-server.service";
import * as hooks from "../../code/services/hooks.service";
import { CodeLive } from "../../code/services/live-diff.service";
import * as sandbox from "../../code/services/sandbox.service";
import type { InstallState, WorkspaceState } from "../../code/services/workspace.service";
import * as workspaces from "../../code/services/workspace.service";
import * as handoff from "../../conversations/services/handoff.service";
import * as uploads from "../../uploads/services/uploads.service";

const root = mkdtempSync(join(tmpdir(), "rb-engine-code-"));
let counter = 0;

beforeEach(() => {
  quietEngine();
  track(spyOn(console, "warn").mockImplementation(() => undefined));
});

afterEach(() => {
  restoreTracked();
  clearLimit("vps:claude");
  clearLimit("vps:codex");
});

function workspace(install: Partial<InstallState> = {}, name = `repo-${++counter}`): WorkspaceState {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return {
    id: `ws_${name}`,
    repo: join(root, "src", name),
    repoName: name,
    path,
    branch: `feat/${name}`,
    base: "origin/main",
    baseCommit: "abc",
    task: "tarefa",
    openedAt: new Date().toISOString(),
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null, ...install },
  };
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("an open workspace", () => {
  test("runs the provider in the worktree with native hooks and the code prompt", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const open = workspace({ status: "running", command: "bun install" });
    session.meta.workspace = open;
    session.meta.permission = "readonly";
    const nativeHooks = { before: async () => ({ allow: true }), after: async () => undefined } as NativeToolHooks;
    const made = track(spyOn(hooks, "nativeHooks").mockReturnValue(nativeHooks));
    track(
      spyOn(devServers, "devServersOf").mockReturnValue([
        { url: "http://127.0.0.1:5173", command: "bun dev" } as ReturnType<typeof devServers.devServersOf>[number],
      ]),
    );
    const checkpoint = track(spyOn(workspaces, "createCheckpoint").mockResolvedValue(undefined as never));
    const scan = track(spyOn(CodeLive.prototype, "scan").mockResolvedValue(undefined));
    fakeProviders.next(({ emit }) => {
      emit({ type: "session", id: "prov-code" });
      emit({ type: "tool", id: "e1", name: "Edit", phase: "start", input: { files: [join(open.path, "a.ts")] } });
      emit({ type: "tool", id: "e1", name: "Edit", phase: "end", ok: true });
      emit({ type: "text", part: "a", text: "Mudei o a.ts." });
      emit({ type: "done", ok: true });
    });
    await run(session, { text: "muda o botão" });
    const request = lastRequest();
    expect(request.code).toEqual({ cwd: open.path, readOnly: true });
    expect(request.nativeShell).toBe(false);
    expect(fakeProviders.turns[0].hooks).toBe(nativeHooks);
    expect(made).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledWith(session, open, "turn_0");
    expect(scan.mock.calls.map((call) => call[1])).toEqual(["tool", "sweep"]);
    expect(request.systemPrompt).toContain(`Repositório ${open.repoName}. Worktree ${open.path}`);
    expect(request.systemPrompt).toContain("instalando em segundo plano (bun install)");
    expect(request.systemPrompt).toContain("Servidores no ar: http://127.0.0.1:5173 (bun dev).");
    expect(request.systemPrompt).not.toContain("## Terminal na VPS");
    expect(await repliesOf(session)).toEqual(["Mudei o a.ts."]);
    expect(session.meta.providerSessions).toEqual({ [`vps:claude@${open.id}`]: "prov-code" });
  });

  test("describes each install state", async () => {
    const bot = await makeBot();
    const cases: Array<[Partial<InstallState>, string]> = [
      [{ status: "failed", error: "ERR! não achei o pacote" }, "a instalação falhou (ERR! não achei o pacote)"],
      [{ status: "failed" }, "a instalação falhou ()"],
      [{ status: "done" }, "Dependências: instaladas."],
      [{ status: "skipped" }, "sem lockfile ou já presentes"],
    ];
    for (const [install, text] of cases) {
      const session = await newSession(bot.id);
      session.meta.workspace = workspace(install);
      await run(session);
      expect(lastRequest().systemPrompt).toContain(text);
      expect(lastRequest().systemPrompt).not.toContain("Servidores no ar");
    }
  });

  test("asks for another model when the provider cannot edit code here", async () => {
    const bot = await makeBot();
    bot.engine = { account: "vps:grok", model: "grok", effort: null, fallback: null };
    const session = await newSession(bot.id);
    const open = workspace();
    session.meta.workspace = open;
    await run(session);
    const request = lastRequest();
    expect(request.code).toBeNull();
    expect(fakeProviders.turns[0].hooks).toBeUndefined();
    expect(request.systemPrompt).toContain(
      `o repositório ${open.repoName} aberto (branch ${open.branch}), mas o modelo atual não edita código`,
    );
    expect(request.systemPrompt).toContain("Neste modelo você não tem terminal");
    expect(request.systemPrompt).not.toContain("## Terminal na VPS");
    expect(Object.keys(session.meta.providerSessions ?? {})).toEqual(["vps:grok"]);
  });

  test("survives a failing checkpoint and snapshot", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    session.meta.workspace = workspace();
    track(spyOn(workspaces, "createCheckpoint").mockRejectedValue(new Error("sem git")));
    track(spyOn(workspaces, "snapshotChanges").mockRejectedValue(new Error("sem status")));
    await run(session);
    expect((await settledOf(session))?.outcome).toBe("completed");
    expect(console.warn).toHaveBeenCalledWith("checkpoint failed", expect.any(Error));
  });
});

describe("tool sandbox around a coding turn", () => {
  const saved = process.env.BOTS_TOOL_SANDBOX;

  afterEach(() => {
    if (saved === undefined) delete process.env.BOTS_TOOL_SANDBOX;
    else process.env.BOTS_TOOL_SANDBOX = saved;
  });

  test("native shells stay on in full and default access, with or without the sandbox", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    session.meta.permission = "full";
    await run(session);
    expect(lastRequest().nativeShell).toBe(true);
    process.env.BOTS_TOOL_SANDBOX = "uid";
    const kill = track(spyOn(sandbox, "killSandboxed").mockResolvedValue(0));
    await run(session);
    expect(lastRequest().nativeShell).toBe(true);
    session.meta.permission = "default";
    await run(session);
    expect(lastRequest().nativeShell).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  test("kills what the turn left running as the sandbox user", async () => {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    const kill = track(spyOn(sandbox, "killSandboxed").mockResolvedValue(1));
    track(spyOn(workspaces, "createCheckpoint").mockResolvedValue(undefined as never));
    const bot = await makeBot();
    const session = await newSession(bot.id);
    session.meta.workspace = workspace();
    await run(session);
    expect(kill).toHaveBeenCalledWith(sandbox.sandboxMarker("sbx", "turn_0"));
  });
});

describe("a mentioned repository", () => {
  test("opens a workspace for an @repo mention and reports a failed open", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const mentioned = track(
      spyOn(actions, "mentionedRepo").mockResolvedValue({ name: "conty-api", path: "/repos/conty-api" } as never),
    );
    const opening = track(spyOn(actions, "openTaskWorkspace").mockRejectedValue(new Error("repo sujo")));
    await run(session, { text: "@conty-api arruma o login" });
    expect(mentioned.mock.calls[0][0]).toBe("@conty-api arruma o login");
    expect(mentioned.mock.calls[0][1]).toContain(bot.id);
    expect(opening).toHaveBeenCalledWith(session, bot.id, "/repos/conty-api", "@conty-api arruma o login");
    expect((await factsOfType(session, "code.workspace"))[0].data).toEqual({
      action: "failed",
      repo: "conty-api",
      error: "repo sujo",
    });
    opening.mockRejectedValue("cru");
    await run(session, { text: "@conty-api de novo" });
    expect((await factsOfType(session, "code.workspace"))[1].data.error).toBe("cru");
  });

  test("keeps the open workspace of the same repository and ignores lookup failures", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const open = workspace();
    session.meta.workspace = open;
    track(spyOn(actions, "mentionedRepo").mockResolvedValue({ name: open.repoName, path: open.repo } as never));
    const opening = track(spyOn(actions, "openTaskWorkspace"));
    await run(session, { text: `@${open.repoName} segue` });
    expect(opening).not.toHaveBeenCalled();
    track(spyOn(actions, "mentionedRepo").mockRejectedValue(new Error("sem repos")));
    await run(session, { text: "@qualquer coisa" });
    expect(opening).not.toHaveBeenCalled();
    expect((await settledOf(session))?.outcome).toBe("completed");
  });
});

describe("switching workspaces mid-turn", () => {
  test("continues the request in the workspace opened during the run", async () => {
    const bot = await makeBot();
    bot.capabilities = { ...bot.capabilities, browser: false };
    const session = await newSession(bot.id);
    const first = workspace();
    const second = workspace();
    session.meta.workspace = first;
    const scan = track(spyOn(CodeLive.prototype, "scan").mockResolvedValue(undefined));
    track(
      spyOn(handoff, "handoffBlock").mockImplementation(async (_, options) =>
        options.full ? "Até aqui: li o código." : "",
      ),
    );
    fakeProviders.next(
      sequence(async (turn) => {
        turn.emit({ type: "text", part: "n", text: "Vou abrir o outro repositório." });
        session.meta.workspace = second;
        contextOf(turn).endRun?.();
        await aborted(turn.signal);
        turn.emit({ type: "done", ok: false, message: "aborted" });
      }, replyWith("Feito no segundo repositório.")),
    );
    await run(session, { text: "corrige nos dois" });
    expect(fakeProviders.turns).toHaveLength(2);
    const next = fakeProviders.turns[1].request;
    expect(next.code).toEqual({ cwd: second.path });
    expect(next.resume).toBeNull();
    expect(next.prompt).toBe(
      `Até aqui: li o código.\n\n---\n\nO repositório ${second.repoName} está aberto na worktree ${second.path} (branch ${second.branch}), que é o seu diretório de trabalho. Continue agora o pedido da pessoa com as ferramentas de código:\ncorrige nos dois`,
    );
    expect(await repliesOf(session, "narration")).toEqual(["Vou abrir o outro repositório."]);
    expect(await repliesOf(session)).toEqual(["Feito no segundo repositório."]);
    expect(scan.mock.calls.filter((call) => call[1] === "sweep")).toHaveLength(2);
    expect(Object.keys(session.meta.providerSessions ?? {})).toEqual([`vps:claude@${second.id}`]);
  });

  test("opens the first workspace without carry when the turn started without one", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const opened = workspace();
    track(spyOn(handoff, "handoffBlock").mockResolvedValue(""));
    track(spyOn(workspaces, "snapshotChanges").mockRejectedValue(new Error("x")));
    fakeProviders.next(
      sequence(async (turn) => {
        session.meta.workspace = opened;
        contextOf(turn).endRun?.();
        await aborted(turn.signal);
      }, replyWith("Pronto.")),
    );
    await run(session, { text: "abre e muda" });
    expect(fakeProviders.turns[1].request.prompt.startsWith(`O repositório ${opened.repoName} está aberto`)).toBe(true);
    expect(fakeProviders.turns[1].request.systemPrompt).toContain("## Repositório aberto");
  });

  test("stops switching after two workspaces", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    track(spyOn(CodeLive.prototype, "scan").mockResolvedValue(undefined));
    const switcher = async (turn: Parameters<Parameters<typeof fakeProviders.next>[0]>[0]) => {
      session.meta.workspace = workspace();
      contextOf(turn).endRun?.();
      await aborted(turn.signal);
    };
    fakeProviders.next(switcher);
    await run(session);
    expect(fakeProviders.turns).toHaveLength(3);
  });

  test("does not switch when the turn failed", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    fakeProviders.next(({ emit }) => {
      session.meta.workspace = workspace();
      emit({ type: "done", ok: false, message: "falhou" });
    });
    await run(session);
    expect(fakeProviders.turns).toHaveLength(1);
    expect((await settledOf(session))?.outcome).toBe("failed");
  });
});

describe("limits during a schedule", () => {
  test("retries a scheduled run on the fallback without a handoff", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id, "thread");
    track(
      spyOn(decisions, "decideTriage").mockResolvedValue({ kind: "triage", outcome: "notify", answer: null } as never),
    );
    const carry = track(spyOn(handoff, "handoffBlock"));
    fakeProviders.next(
      sequence(({ emit }) => emit({ type: "done", ok: false, message: "rate limit" }), replyWith("Rotina feita.")),
    );
    await run(session, { source: "schedule", scheduleId: "diaria", text: "Rodar rotina." });
    expect(fakeProviders.turns.map((turn) => [turn.request.provider, turn.request.resume])).toEqual([
      ["claude", null],
      ["codex", null],
    ]);
    expect(fakeProviders.turns[1].request.prompt).toBe("Rodar rotina.");
    expect(carry).not.toHaveBeenCalled();
    expect(await repliesOf(session)).toEqual(["Rotina feita."]);
  });

  test("keeps attachment images for the VPS Claude fallback on retry", async () => {
    const bot = await makeBot();
    bot.engine = {
      account: "vps:codex",
      model: "gpt",
      effort: null,
      fallback: { account: "vps:claude", model: "sonnet" },
    };
    const session = await newSession(bot.id);
    const image = { path: "/tmp/print.png", mime: "image/png", label: "print.png" };
    const prepare = track(
      spyOn(uploads, "prepareAttachments").mockResolvedValue({ text: "Imagem: print.png", images: [image] }),
    );
    fakeProviders.next(
      sequence(({ emit }) => emit({ type: "done", ok: false, message: "quota exceeded" }), replyWith("Vi a imagem.")),
    );
    await run(session, {
      text: "olha",
      attachments: [
        {
          uploadId: "up_9",
          name: "print.png",
          mime: "image/png",
          size: 1,
          kind: "image",
          file: "print.png",
          createdAt: new Date().toISOString(),
          source: "user",
        },
      ],
    });
    expect(prepare.mock.calls[0][2]).toBe(false);
    expect(fakeProviders.turns.map((turn) => turn.request.provider)).toEqual(["codex", "claude"]);
    expect(fakeProviders.turns[0].request.images).toEqual([image]);
    expect(fakeProviders.turns[1].request.images).toEqual([image]);
    expect(await repliesOf(session)).toEqual(["Vi a imagem."]);
  });
});
