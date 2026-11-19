import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { makeRepo } from "../../../../test/code-helpers";
import { getDb } from "../../../db";
import { codeRepos } from "../../../db/tables";
import type { BotDefinition } from "../../bots/services/bots.service";
import type { EventLog, StoredSession } from "../../conversations/services/sessions.service";
import * as sessions from "../../conversations/services/sessions.service";
import type { ApprovalResult, ToolContext } from "../../engine/services/mcp-gateway.service";
import * as actions from "../services/actions.service";
import { codeModeSupported, registerCodeTools } from "../services/code-tools.service";
import type { PublicDevServer } from "../services/dev-server.service";
import * as devServers from "../services/dev-server.service";
import * as pullRequests from "../services/pull-request.service";
import { allowedRepoFor, seedAllowedRepos } from "../services/repos.service";
import * as workspaces from "../services/workspace.service";
import { CodeError, type InstallState, type WorkspaceState } from "../services/workspace.service";

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function workspace(install: Partial<InstallState> = {}): WorkspaceState {
  return {
    id: "ws_tools",
    repo: "/srv/rb-tools/origin",
    repoName: "conty-lp",
    path: "/srv/rb-tools/worktree",
    branch: "feat/task",
    base: "develop",
    baseCommit: "abc",
    task: "task",
    openedAt: "2026-01-01T00:00:00.000Z",
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null, ...install },
  };
}

function session(state: WorkspaceState | null) {
  const events: Emitted[] = [];
  const stored = {
    meta: { sessionId: "s1", botId: "bot1", workspace: state },
    log: { emit: (event: Emitted) => events.push(event) },
  } as unknown as StoredSession;
  return { stored, events };
}

function harness(
  options: {
    current?: StoredSession | null;
    provider?: string;
    runner?: string;
    approval?: ApprovalResult;
    endRun?: () => void;
    permission?: ToolContext["permission"];
  } = {},
) {
  const events: Emitted[] = [];
  const context = {
    token: "t",
    botId: "bot1",
    sessionId: "s1",
    log: { emit: (event: Emitted) => events.push(event) } as unknown as EventLog,
    turnId: "turn1",
    runId: () => "run1",
    tools: [],
    delegates: [],
    origin: null,
    ownerCallId: null,
    isSchedule: false,
    signal: new AbortController().signal,
    onCallStart: () => undefined,
    onCallEnd: () => undefined,
    requestApproval: async () => options.approval ?? { choice: "approve", interactionId: "i1" },
    delegate: async () => "",
    bot: { id: "bot1", name: "Bot", role: "dev" } as BotDefinition,
    request: "",
    asked: { commit: false, push: false, pr: false },
    decisions: { autoApprove: true, threshold: 0.7 },
    emitDecision: () => undefined,
    onCallSettled: () => undefined,
    groupMembers: [],
    onHandoff: () => undefined,
    provider: options.provider ?? "claude",
    cancelTurn: () => undefined,
    ...(options.endRun ? { endRun: options.endRun } : {}),
    ...(options.permission ? { permission: options.permission } : {}),
  } as ToolContext;
  const current = options.current === undefined ? null : options.current;
  spies.push(spyOn(sessions, "getStoredSession").mockImplementation(() => current ?? undefined));
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerCodeTools(server, context, () => options.runner ?? "vps");
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`tool ${name} not registered`);
    return handler(args);
  };
  const settled = () => events.filter((event) => event.type === "call.settled").map((event) => event.data);
  return { tools, call, events, settled, context };
}

const spies: { mockRestore(): void }[] = [];

function stub<T extends object, K extends keyof T>(target: T, key: K) {
  const spy = spyOn(target, key as never) as unknown as ReturnType<typeof mock>;
  spies.push(spy as unknown as { mockRestore(): void });
  return spy;
}

function devServer(overrides: Partial<PublicDevServer> = {}): PublicDevServer & { logs: string } {
  return {
    id: "dev_1",
    workspaceId: "ws_tools",
    command: "npm run dev",
    port: 4100,
    url: "http://localhost:4100",
    previewPath: "/preview/ws_tools/4100/?t=x",
    status: "running",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    logs: "ready",
    ...overrides,
  };
}

beforeEach(() => {
  spies.length = 0;
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function rmAllowed(path: string) {
  getDb().delete(codeRepos).where(eq(codeRepos.path, path)).run();
  seedAllowedRepos();
}

function textOf(result: ToolResult) {
  return result.content[0].text;
}

describe("codeModeSupported", () => {
  test("only claude and codex on the vps edit code", () => {
    expect(codeModeSupported("claude", "vps")).toBe(true);
    expect(codeModeSupported("codex", "vps")).toBe(true);
    expect(codeModeSupported("grok", "vps")).toBe(false);
    expect(codeModeSupported("claude", "mac")).toBe(false);
  });
});

describe("without an open workspace", () => {
  test("only workspace_add, workspace_open and workspace_close are registered", () => {
    const { tools } = harness({ current: session(null).stored });
    expect([...tools.keys()]).toEqual(["workspace_add", "workspace_open", "workspace_close"]);
  });

  test("workspace_add always asks a person, even with full access, and records the repo", async () => {
    const { path } = makeRepo("tools-add-full");
    rmAllowed(path);
    const asked = mock(async () => ({ choice: "approve" as const, interactionId: "i1" }));
    const { call, context } = harness({ permission: "full" });
    context.requestApproval = asked as unknown as ToolContext["requestApproval"];
    const result = await call("workspace_add", { path, reason: "a pessoa pediu" });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain("Liberado: tools-add-full");
    expect(allowedRepoFor(path)?.path).toBe(path);
  });

  test("workspace_add does not record a repo the person denied, nor a folder without git", async () => {
    const { path } = makeRepo("tools-add-deny");
    rmAllowed(path);
    const { call } = harness({ approval: { choice: "deny", interactionId: "i2" } });
    const denied = await call("workspace_add", { path, reason: "x" });
    expect(denied.isError).toBe(true);
    expect(allowedRepoFor(path)).toBeNull();
    const plain = await call("workspace_add", { path: "/tmp", reason: "x" });
    expect(textOf(plain)).toContain("não é um repositório git");
  });

  test("workspace_open needs the conversation", async () => {
    const { call, settled } = harness();
    const result = await call("workspace_open", { repo: "a/conty-lp", task: "x" });
    expect(result).toEqual({ content: [{ type: "text", text: "Conversa não encontrada." }], isError: true });
    expect(settled().at(-1)).toMatchObject({ outcome: "failed" });
  });

  test("workspace_open opens the worktree and hands the run over to the code tools", async () => {
    const opened = workspace({ status: "running", command: "pnpm i" });
    const { stored } = session(null);
    const open = stub(actions, "openTaskWorkspace").mockResolvedValue({ workspace: opened } as never);
    const endRun = mock(() => undefined);
    const { call, events } = harness({ current: stored, endRun });
    const result = await call("workspace_open", { repo: "conty-lp", task: "hero" });
    expect(open).toHaveBeenCalledWith(stored, "bot1", "conty-lp", "hero");
    expect(textOf(result)).toBe(
      [
        `Workspace aberto: conty-lp em ${opened.path}, branch feat/task (a partir de develop).`,
        "Dependências instalando em segundo plano (pnpm i). dev_server_start espera a instalação terminar.",
        "Continuando já dentro da worktree, com as ferramentas de código.",
      ].join("\n"),
    );
    expect(endRun).toHaveBeenCalledTimes(1);
    expect(events[0].data.capability).toMatchObject({ label: "Abrir conty-lp" });
  });

  test("workspace_open tells unsupported models to switch and reports install states", async () => {
    const cases: [Partial<InstallState>, string][] = [
      [{ status: "failed", error: "ENOSPC" }, "A instalação das dependências falhou: ENOSPC"],
      [{ status: "failed" }, "A instalação das dependências falhou: "],
      [{ status: "done" }, "Dependências instaladas."],
    ];
    for (const [install, line] of cases) {
      stub(actions, "openTaskWorkspace").mockResolvedValue({ workspace: workspace(install) } as never);
      const { call } = harness({ current: session(null).stored, provider: "grok" });
      const text = textOf(await call("workspace_open", { repo: "conty-lp", task: "x" }));
      expect(text).toContain(line);
      expect(text).toContain("Diga à pessoa para escolher um modelo Claude ou Codex");
      for (const spy of spies.splice(0)) spy.mockRestore();
    }
  });

  test("workspace_open on the same workspace or without endRun does not restart the run", async () => {
    const current = workspace();
    stub(actions, "openTaskWorkspace").mockResolvedValue({ workspace: current } as never);
    const endRun = mock(() => undefined);
    const { call } = harness({ current: session(current).stored, endRun });
    expect(textOf(await call("workspace_open", { repo: "conty-lp", task: "x" }))).not.toContain("Continuando");
    expect(endRun).not.toHaveBeenCalled();
    for (const spy of spies.splice(0)) spy.mockRestore();
    stub(actions, "openTaskWorkspace").mockResolvedValue({ workspace: { ...current, id: "other" } } as never);
    const second = harness({ current: session(current).stored });
    expect(textOf(await second.call("workspace_open", { repo: "conty-lp", task: "x" }))).not.toContain("Continuando");
  });

  test("workspace_open reports failures", async () => {
    stub(actions, "openTaskWorkspace").mockRejectedValueOnce(new CodeError("Repo não existe", 404));
    const { call, settled } = harness({ current: session(null).stored });
    expect(await call("workspace_open", { repo: "x", task: "y" })).toEqual({
      content: [{ type: "text", text: "Repo não existe" }],
      isError: true,
    });
    expect(settled().at(-1)).toMatchObject({ error: { message: "Repo não existe" } });
    stub(actions, "openTaskWorkspace").mockRejectedValueOnce("raw");
    expect(textOf(await call("workspace_open", { repo: "x", task: "y" }))).toBe("raw");
  });

  test("read-only mode still lets workspace_close run", async () => {
    const { call } = harness({ current: session(null).stored, permission: "readonly" });
    expect(textOf(await call("workspace_close"))).toBe("Nenhum repositório aberto nesta conversa.");
  });

  test("workspace_close without a workspace is a no-op", async () => {
    const { call, settled } = harness();
    expect(textOf(await call("workspace_close"))).toBe("Nenhum repositório aberto nesta conversa.");
    expect(settled().at(-1)).toMatchObject({ outcome: "completed", output: { closed: false } });
  });
});

describe("with an open workspace", () => {
  function open(options: Parameters<typeof harness>[0] = {}) {
    const current = workspace();
    const owner = session(current);
    const tools = harness({ current: owner.stored, ...options });
    return { ...tools, current, owner };
  }

  test("registers every code tool", () => {
    const { tools } = open();
    expect([...tools.keys()]).toEqual([
      "workspace_add",
      "workspace_open",
      "workspace_close",
      "dev_server_start",
      "dev_server_stop",
      "dev_server_logs",
      "workspace_deliver",
    ]);
  });

  test("workspace_close closes the task and keeps the worktree", async () => {
    const close = stub(actions, "closeTaskWorkspace").mockResolvedValue(null);
    const { call, current, settled, owner } = open();
    expect(textOf(await call("workspace_close"))).toBe(
      `Fechado. A worktree continua em ${current.path} (branch ${current.branch}).`,
    );
    expect(close).toHaveBeenCalledWith(owner.stored);
    expect(settled().at(-1)).toMatchObject({ output: { closed: true, path: current.path, branch: current.branch } });
  });

  test("dev_server_start reports the url and forwards lifecycle events to the conversation", async () => {
    const start = stub(devServers, "startDevServer").mockImplementation((async (
      _workspace: WorkspaceState,
      _input: unknown,
      onExit: (server: PublicDevServer) => void,
    ) => {
      onExit(devServer({ status: "stopped" }));
      onExit(devServer({ status: "exited", exitCode: 1 }));
      return devServer();
    }) as never);
    const { call, current, owner } = open();
    const result = await call("dev_server_start", { cmd: "npm run dev", port: 4100, cwd: "apps/web" });
    expect(start).toHaveBeenCalledWith(
      current,
      { cmd: "npm run dev", port: 4100, cwd: "apps/web" },
      expect.any(Function),
    );
    expect(textOf(result)).toBe(
      'Servidor no ar em http://localhost:4100 (porta 4100). Teste com browser_open("http://localhost:4100"). Últimas linhas:\nready',
    );
    expect(owner.events.map((event) => event.data.action)).toEqual(["stopped", "exited", "started"]);
  });

  test("dev_server_start reports a server that exited early and errors", async () => {
    const start = stub(devServers, "startDevServer").mockResolvedValueOnce(
      devServer({ status: "exited", exitCode: 2, logs: "crash" } as Partial<PublicDevServer>) as never,
    );
    const { call, settled } = open();
    const exited = await call("dev_server_start", { cmd: "npm run dev" });
    expect(start).toHaveBeenLastCalledWith(expect.anything(), { cmd: "npm run dev" }, expect.any(Function));
    expect(exited).toEqual({
      content: [{ type: "text", text: "O servidor saiu antes de responder (código 2). Últimas linhas:\ncrash" }],
      isError: true,
    });
    expect(settled().at(-1)).toMatchObject({ outcome: "failed" });
    start.mockRejectedValueOnce(new Error("porta ocupada"));
    expect(textOf(await call("dev_server_start", { cmd: "npm run dev" }))).toBe("porta ocupada");
    start.mockRejectedValueOnce("raw");
    expect(textOf(await call("dev_server_start", { cmd: "npm run dev" }))).toBe("raw");
  });

  test("dev_server_start is gated like a bash command", async () => {
    const start = stub(devServers, "startDevServer");
    const { call } = open({ approval: { choice: "deny", interactionId: "i2" } });
    const denied = await call("dev_server_start", { cmd: "sudo npm run dev" });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("A pessoa negou");
    expect(start).not.toHaveBeenCalled();
  });

  test("dev_server_stop stops all or one port", async () => {
    const stop = stub(devServers, "stopDevServers").mockResolvedValueOnce([{ port: 4100 }, { port: 4101 }] as never);
    const { call, current, events } = open();
    expect(textOf(await call("dev_server_stop"))).toBe("Parado: porta 4100, 4101.");
    expect(stop).toHaveBeenLastCalledWith(current, undefined);
    stop.mockResolvedValueOnce([] as never);
    expect(textOf(await call("dev_server_stop", { port: 4100 }))).toBe("Nenhum servidor rodando.");
    expect(stop).toHaveBeenLastCalledWith(current, 4100);
    expect(
      events
        .filter((event) => event.type === "call.requested")
        .map((event) => (event.data.capability as { label: string }).label),
    ).toEqual(["Parar o servidor", "Parar o servidor da porta 4100"]);
  });

  test("dev_server_logs shows the tail or the error", async () => {
    const logs = stub(devServers, "devServerLogs").mockResolvedValueOnce(
      devServer({ logs: "a\nb" } as Partial<PublicDevServer>) as never,
    );
    const { call, current, settled } = open();
    expect(textOf(await call("dev_server_logs"))).toBe("Servidor running na porta 4100:\na\nb");
    expect(logs).toHaveBeenLastCalledWith(current, undefined, 80);
    expect(settled().at(-1)).toMatchObject({ output: { port: 4100, status: "running", lines: 2 } });
    logs.mockRejectedValueOnce(new Error("Nenhum servidor desta tarefa ainda."));
    const failed = await call("dev_server_logs", { port: 4100, lines: 5 });
    expect(logs).toHaveBeenLastCalledWith(current, 4100, 5);
    expect(failed.isError).toBe(true);
    logs.mockRejectedValueOnce("raw");
    expect(textOf(await call("dev_server_logs"))).toBe("raw");
  });

  describe("workspace_deliver", () => {
    function delivered(overrides: Partial<Awaited<ReturnType<typeof actions.deliverWorkspace>>> = {}) {
      return {
        action: "commit" as const,
        commit: "abc1234",
        prUrl: "",
        prExisted: false,
        previousPr: null,
        files: 2,
        branch: "feat/task",
        base: "develop",
        ...overrides,
      };
    }

    function setup(result: ReturnType<typeof delivered> | Error) {
      stub(workspaces, "changedFiles").mockResolvedValue([]);
      const deliver = stub(actions, "deliverWorkspace");
      if (result instanceof Error) deliver.mockRejectedValue(result);
      else deliver.mockResolvedValue(result as never);
      const kick = stub(pullRequests, "kickPr").mockImplementation(() => undefined);
      return { deliver, kick, ...open() };
    }

    test("a bad commit message is denied before anything runs", async () => {
      const { call, deliver } = setup(delivered());
      const result = await call("workspace_deliver", { action: "commit", message: "arrumei" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("conventional commits");
      expect(deliver).not.toHaveBeenCalled();
    });

    test("commit", async () => {
      const { call, deliver, current, owner, kick } = setup(delivered());
      const text = textOf(await call("workspace_deliver", { action: "commit", message: "fix: typo" }));
      expect(text).toBe("Commit abc1234 na branch feat/task.");
      expect(deliver).toHaveBeenCalledWith(current, { action: "commit", message: "fix: typo" });
      expect(owner.events[0]).toMatchObject({ type: "code.delivered", data: { workspaceId: current.id } });
      expect(kick).not.toHaveBeenCalled();
    });

    test("commit with nothing pending", async () => {
      const { call } = setup(delivered({ commit: null as unknown as string }));
      expect(textOf(await call("workspace_deliver", { message: "fix: typo" }))).toBe(
        "Nada novo para commitar na branch feat/task.",
      );
    });

    test("push with and without an open PR, and after an old one", async () => {
      const first = setup(delivered({ action: "push", prUrl: "https://gh/pr/1" }));
      expect(textOf(await first.call("workspace_deliver", { action: "push" }))).toBe(
        "Commit abc1234; push da branch feat/task feito. O PR https://gh/pr/1 foi atualizado.",
      );
      expect(first.kick).toHaveBeenCalledWith(first.owner.stored, "https://gh/pr/1");
      for (const spy of spies.splice(0)) spy.mockRestore();

      const second = setup(delivered({ action: "push" }));
      expect(textOf(await second.call("workspace_deliver", { action: "push", message: "" }))).toBe(
        "Commit abc1234; push da branch feat/task feito. A branch ainda não tem PR.",
      );
      for (const spy of spies.splice(0)) spy.mockRestore();

      const third = setup(
        delivered({
          action: "push",
          previousPr: { number: 7, url: "https://gh/pr/7", state: "MERGED", baseRefName: "main" },
        }),
      );
      expect(textOf(await third.call("workspace_deliver", { action: "push" }))).toBe(
        "Commit abc1234; push da branch feat/task feito. A branch já teve o PR #7 (mergeado, base main): https://gh/pr/7.",
      );
    });

    test("pr opens a new PR, updates an existing one or refuses after a closed one", async () => {
      const opened = setup(delivered({ action: "pr", prUrl: "https://gh/pr/2" }));
      expect(
        textOf(
          await opened.call("workspace_deliver", {
            action: "pr",
            message: "feat: hero",
            title: "Hero",
            body: "Body",
            base: "main",
          }),
        ),
      ).toBe("PR aberto para develop: https://gh/pr/2");
      expect(opened.deliver).toHaveBeenCalledWith(opened.current, {
        action: "pr",
        message: "feat: hero",
        title: "Hero",
        body: "Body",
        base: "main",
      });
      for (const spy of spies.splice(0)) spy.mockRestore();

      const existing = setup(delivered({ action: "pr", prUrl: "https://gh/pr/3", prExisted: true }));
      expect(textOf(await existing.call("workspace_deliver", { action: "pr", message: "feat: hero" }))).toBe(
        "Commit abc1234; push feito. O PR já existia e foi atualizado: https://gh/pr/3",
      );
      for (const spy of spies.splice(0)) spy.mockRestore();

      const closed = setup(
        delivered({
          action: "pr",
          previousPr: { number: 4, url: "https://gh/pr/4", state: "CLOSED", baseRefName: "develop" },
        }),
      );
      const text = textOf(await closed.call("workspace_deliver", { action: "pr", message: "feat: hero" }));
      expect(text).toContain("A branch já teve o PR #4 (fechado sem merge, base develop)");
      expect(text).toContain("gh pr create --base develop --head feat/task");
    });

    test("delivery failures are reported", async () => {
      const failed = setup(new Error("push rejeitado"));
      const result = await failed.call("workspace_deliver", { action: "commit", message: "fix: x" });
      expect(result).toEqual({ content: [{ type: "text", text: "push rejeitado" }], isError: true });
      for (const spy of spies.splice(0)) spy.mockRestore();
      const raw = setup(new Error("x"));
      (raw.deliver as ReturnType<typeof mock>).mockRejectedValue("raw");
      expect(textOf(await raw.call("workspace_deliver", { action: "commit", message: "fix: x" }))).toBe("raw");
    });

    test("without the conversation the delivery still runs", async () => {
      const result = setup(delivered({ prUrl: "https://gh/pr/9", action: "pr" }));
      (sessions.getStoredSession as unknown as ReturnType<typeof mock>).mockImplementation(() => undefined);
      expect(textOf(await result.call("workspace_deliver", { action: "pr", message: "feat: x" }))).toBe(
        "PR aberto para develop: https://gh/pr/9",
      );
      expect(result.kick).not.toHaveBeenCalled();
    });
  });

  test("read-only permission refuses tools that change things", async () => {
    stub(workspaces, "changedFiles").mockResolvedValue([]);
    const { call } = open({ permission: "readonly" });
    expect((await call("workspace_deliver", { action: "commit", message: "fix: x" })).isError).toBe(true);
    expect((await call("dev_server_start", { cmd: "npm run dev" })).isError).toBe(true);
  });

  test("every tool reports a refused gate", async () => {
    const { call } = open({ permission: "readonly" });
    const refusing = spyOn(await import("../services/hooks.service"), "beginCall").mockResolvedValue({
      allowed: false,
      callId: "c",
    });
    spies.push(refusing);
    for (const name of ["workspace_open", "workspace_close", "dev_server_stop", "dev_server_logs"])
      expect(await call(name, { repo: "r", task: "t" })).toEqual({
        content: [{ type: "text", text: "Negado." }],
        isError: true,
      });
  });
});
