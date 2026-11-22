import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProcesses } from "../../../../test/helpers";
import { withLanguage } from "../../../shared/i18n";
import type { DecisionRecord } from "../../approvals/services/decisions.service";
import * as decisions from "../../approvals/services/decisions.service";
import type { PermissionMode } from "../../approvals/services/permissions.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import type { ApprovalResult, ToolContext } from "../../engine/services/mcp-gateway.service";
import * as vaultTools from "../../vault/services/vault-tools.service";
import { listGrants } from "../repositories/code.repository";
import { ensureBotHome } from "../services/bot-home.service";
import {
  approvalTimeoutMs,
  beginCall,
  codeLabel,
  emitEdit,
  endCall,
  homeHooks,
  nativeHooks,
  sandboxedBash,
  worktreePathsIn,
} from "../services/hooks.service";
import type { CodeLive } from "../services/live-diff.service";
import type { Gate } from "../services/policy.service";
import { worktreesRoot } from "../services/repos.service";
import { resetSandboxProbe, sandboxMarker, sandboxMissingMessage } from "../services/sandbox.service";
import type { WorkspaceState } from "../services/workspace.service";

interface Emitted {
  type: string;
  data: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

const root = mkdtempSync(join(tmpdir(), "rb-hooks-"));
let repoCount = 0;

function workspace(): WorkspaceState {
  repoCount++;
  return {
    id: `ws_hooks_${repoCount}`,
    repo: `/srv/rb-hooks/repo-${repoCount}-${Date.now()}`,
    repoName: `repo-${repoCount}`,
    path: root,
    branch: "feat/task",
    base: "main",
    baseCommit: "abc",
    task: "task",
    openedAt: "2026-01-01T00:00:00.000Z",
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null },
  };
}

function makeContext(
  overrides: Partial<ToolContext> = {},
  approval: ApprovalResult = { choice: "approve", interactionId: "int_1" },
) {
  const events: Emitted[] = [];
  const decisionsSeen: DecisionRecord[] = [];
  const settled: string[] = [];
  const counters = { start: 0, end: 0 };
  const requestApproval = mock(async () => approval);
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
    onCallStart: () => counters.start++,
    onCallEnd: () => counters.end++,
    requestApproval,
    delegate: async () => "",
    bot: { id: "bot1", name: "Bot", role: "dev" } as BotDefinition,
    request: "do it",
    asked: { commit: false, push: false, pr: false },
    decisions: { autoApprove: true, threshold: 0.7 },
    emitDecision: (record: DecisionRecord) => decisionsSeen.push(record),
    onCallSettled: (summary: string) => settled.push(summary),
    groupMembers: [],
    onHandoff: () => undefined,
    provider: "claude",
    cancelTurn: () => undefined,
    ...overrides,
  } as ToolContext;
  return { context, events, decisionsSeen, settled, counters, requestApproval };
}

function types(events: Emitted[]) {
  return events.map((event) => event.type);
}

function decision(outcome: string): DecisionRecord {
  return {
    kind: "approval",
    question: "q",
    answer: null,
    confidence: 0.9,
    threshold: 0.7,
    outcome,
    latencyMs: 1,
    model: "jev-1",
    reason: "r",
    tool: "Bash",
    callId: "c",
  } as DecisionRecord;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("codeLabel", () => {
  test("describes each native tool in plain words", () => {
    const existing = join(root, "exists.txt");
    writeFileSync(existing, "x");
    expect(codeLabel("Read", { file_path: "/a/b/file.ts" })).toBe("Ler file.ts");
    expect(codeLabel("Edit", { file_path: "a.ts" })).toBe("Editar a.ts");
    expect(codeLabel("NotebookEdit", { notebook_path: "n.ipynb" })).toBe("Editar n.ipynb");
    expect(withLanguage("en", () => codeLabel("Read", { file_path: "/a/b/file.ts" }))).toBe("Read file.ts");
    expect(withLanguage("en", () => codeLabel("Bash", { command: "bun test" }))).toBe("Run bun test");
    expect(withLanguage("en", () => codeLabel("TodoWrite", {}))).toBe("Update the step list");
    expect(codeLabel("Write", { file_path: existing })).toBe("Reescrever exists.txt");
    expect(codeLabel("Write", { file_path: join(root, "missing.txt") })).toBe("Criar missing.txt");
    expect(codeLabel("Write", {})).toBe("Criar ");
    expect(codeLabel("Glob", { pattern: "**/*.ts" })).toBe("Procurar arquivos **/*.ts");
    expect(codeLabel("Glob", {})).toBe("Procurar arquivos ");
    expect(codeLabel("Grep", { pattern: "foo\n bar" })).toBe("Procurar “foo bar”");
    expect(codeLabel("Grep", {})).toBe("Procurar “”");
    expect(codeLabel("TodoWrite", {})).toBe("Atualizar a lista de passos");
    expect(codeLabel("Bash", { description: "  Run tests  ", command: "x" })).toBe("Run tests");
    expect(codeLabel("Bash", { command: "a".repeat(100) })).toBe(`Rodar ${"a".repeat(69)}…`);
    expect(codeLabel("Bash", {})).toBe("Rodar ");
    expect(codeLabel("WebFetch", {})).toBe("WebFetch");
  });
});

describe("beginCall", () => {
  test("an allowed gate starts the call right away", async () => {
    const { context, events, counters } = makeContext({ origin: "other-bot", ownerCallId: "parent" });
    const start = await beginCall(context, { name: "Read", label: "Ler a", input: { a: 1 }, gate: { kind: "allow" } });
    expect(start.allowed).toBe(true);
    expect(start.callId).toMatch(/^call_/);
    expect(counters.start).toBe(1);
    expect(types(events)).toEqual(["call.requested", "call.started"]);
    expect(events[0].data).toMatchObject({
      capability: { kind: "tool", name: "Read", label: "Ler a", surface: "code" },
      owner: { callId: "parent" },
      origin: { agent: "other-bot" },
    });
    expect(events[0].scope).toEqual({ runId: "run1", turnId: "turn1" });
  });

  test("a deny gate settles as rejected with a policy error", async () => {
    const { context, events, decisionsSeen, settled, counters } = makeContext();
    const start = await beginCall(context, {
      callId: "c1",
      name: "Bash",
      label: "x",
      input: { command: "nohup x" },
      gate: { kind: "deny", message: "não pode" },
    });
    expect(start).toEqual({ allowed: false, callId: "c1", message: "não pode" });
    expect(events[0].data.owner).toEqual({ runId: "run1" });
    expect(events.at(-1)?.data).toEqual({
      callId: "c1",
      error: { code: "TOOL_POLICY", message: "não pode" },
      outcome: "rejected",
    });
    expect(decisionsSeen[0]).toMatchObject({ outcome: "blocked", reason: "não pode", threshold: 0.7 });
    expect(settled[0]).toContain("→ negado");
    expect(counters.end).toBe(1);
  });

  test("an asked gate runs without a card and records why", async () => {
    const { context, events, decisionsSeen } = makeContext();
    const start = await beginCall(context, {
      name: "workspace_deliver",
      label: "x",
      input: {},
      gate: { kind: "asked", reason: "Você pediu o push." },
    });
    expect(start.allowed).toBe(true);
    expect(events.at(-1)?.data.clearedBy).toEqual({ request: true, reason: "Você pediu o push." });
    expect(decisionsSeen[0].outcome).toBe("requested");
  });

  test("a hard human gate asks for approval and honors a denial", async () => {
    const { context, events, requestApproval, decisionsSeen } = makeContext(
      {},
      { choice: "deny", interactionId: "int_9" },
    );
    const ws = workspace();
    const start = await beginCall(context, {
      name: "Bash",
      label: "x",
      input: { command: "sudo ls" },
      gate: { kind: "human", prompt: "Rodar sudo?", reason: "sudo", hard: true, grantKey: "sudo" },
      workspace: ws,
      target: { label: "sudo ls", role: "command" },
    });
    expect(start.allowed).toBe(false);
    expect(requestApproval).toHaveBeenCalledWith("Rodar sudo?", start.callId, null, {
      target: { label: "sudo ls", role: "command" },
      reason: "sudo",
      timeoutMs: approvalTimeoutMs,
    });
    expect(decisionsSeen[0].outcome).toBe("human");
    expect(events.at(-1)?.data).toMatchObject({ cause: { interactionId: "int_9" }, outcome: "rejected" });
  });

  test("an approved soft gate can be remembered for the repository and reused", async () => {
    const ws = workspace();
    const gate: Gate = { kind: "human", prompt: "Rodar x?", reason: "", hard: false, grantKey: "make x" };
    const first = makeContext({}, { choice: "approve", interactionId: "int_2", always: true });
    const start = await beginCall(first.context, { name: "Bash", label: "x", input: {}, gate, workspace: ws });
    expect(start.allowed).toBe(true);
    expect(first.requestApproval).toHaveBeenCalledWith("Rodar x?", start.callId, null, {
      grant: `make x em ${ws.repoName}`,
      timeoutMs: approvalTimeoutMs,
    });
    expect(first.events.at(-1)?.data.clearedBy).toEqual({ interactionId: "int_2", remembered: true });
    expect((await listGrants()).some((grant) => grant.repo === ws.repo && grant.key === "make x")).toBe(true);

    const second = makeContext();
    const again = await beginCall(second.context, { name: "Bash", label: "x", input: {}, gate, workspace: ws });
    expect(again.allowed).toBe(true);
    expect(second.requestApproval).not.toHaveBeenCalled();
    expect(second.events.at(-1)?.data.clearedBy).toEqual({ grant: "make x" });
    expect(second.decisionsSeen[0]).toMatchObject({ outcome: "granted" });
  });

  test("an approval without always does not create a grant", async () => {
    const ws = workspace();
    const { context, events } = makeContext({}, { choice: "approve", interactionId: "int_3" });
    await beginCall(context, {
      name: "Bash",
      label: "x",
      input: {},
      gate: { kind: "human", prompt: "p", reason: "r", hard: false, grantKey: "k" },
      workspace: ws,
    });
    expect(events.at(-1)?.data.clearedBy).toEqual({ interactionId: "int_3" });
    expect((await listGrants()).some((grant) => grant.repo === ws.repo)).toBe(false);
  });

  test("scheduled runs cannot wait for a person", async () => {
    const { context, requestApproval } = makeContext({ isSchedule: true });
    const start = await beginCall(context, {
      name: "Bash",
      label: "x",
      input: {},
      gate: { kind: "human", prompt: "p", reason: "r", hard: true },
    });
    expect(start.allowed).toBe(false);
    expect(start.message).toContain("Ninguém está aqui");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  describe("jev gate", () => {
    let spy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => {
      spy?.mockRestore();
      spy = null;
    });

    test("an auto approval from jev runs the call", async () => {
      spy = spyOn(decisions, "decideApproval").mockResolvedValue(decision("auto_approved"));
      const { context, events, decisionsSeen, requestApproval } = makeContext();
      const start = await beginCall(context, {
        name: "Bash",
        label: "x",
        input: { command: "./run.sh" },
        gate: { kind: "jev", prompt: "Rodar ./run.sh?" },
        workspace: workspace(),
      });
      expect(start.allowed).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ botName: "Bot", botRole: "dev", request: "do it", tool: "Bash", page: null }),
        context.decisions,
        start.callId,
      );
      expect(decisionsSeen[0].outcome).toBe("auto_approved");
      expect(events.at(-1)?.data.clearedBy).toEqual({ decision: "jev", model: "jev-1" });
      expect(requestApproval).not.toHaveBeenCalled();
    });

    test("when jev does not approve, the person decides with a grant offer", async () => {
      spy = spyOn(decisions, "decideApproval").mockResolvedValue(decision("human"));
      const ws = workspace();
      const { context, requestApproval } = makeContext();
      const start = await beginCall(context, {
        name: "Bash",
        label: "x",
        input: {},
        gate: { kind: "jev", prompt: "Rodar?", grantKey: "./run.sh" },
        workspace: ws,
      });
      expect(start.allowed).toBe(true);
      expect(requestApproval).toHaveBeenCalledWith("Rodar?", start.callId, null, {
        grant: `./run.sh em ${ws.repoName}`,
        timeoutMs: approvalTimeoutMs,
      });
    });

    test("without a grant key the person still decides", async () => {
      spy = spyOn(decisions, "decideApproval").mockResolvedValue(decision("human"));
      const { context, requestApproval } = makeContext();
      await beginCall(context, { name: "Bash", label: "x", input: {}, gate: { kind: "jev", prompt: "Rodar?" } });
      expect(requestApproval).toHaveBeenCalledWith("Rodar?", expect.any(String), null, {
        timeoutMs: approvalTimeoutMs,
      });
    });
  });

  describe("permission modes", () => {
    async function start(
      mode: PermissionMode,
      name: string,
      input: Record<string, unknown>,
      gate: Gate,
      ws = workspace(),
    ) {
      const harness = makeContext({ permission: mode });
      const result = await beginCall(harness.context, { name, label: "Rodar coisa", input, gate, workspace: ws });
      return { ...harness, result };
    }

    test("full access clears hard gates without a card", async () => {
      const { result, events, decisionsSeen } = await start(
        "full",
        "Bash",
        { command: "sudo ls" },
        { kind: "human", prompt: "p", reason: "r", hard: true },
      );
      expect(result.allowed).toBe(true);
      expect(events.at(-1)?.data.clearedBy).toEqual({ permission: "full" });
      expect(decisionsSeen[0]).toMatchObject({ outcome: "granted", reason: "Modo Acesso total: liberado sem card." });
    });

    test("full access still blocks fixed rules", async () => {
      const { result } = await start(
        "full",
        "Bash",
        { command: "git push --force origin main" },
        { kind: "human", prompt: "p", reason: "r", hard: true },
      );
      expect(result.allowed).toBe(false);
      expect(result.message).toContain("push --force em main");
    });

    test("full access with an already allowed gate just starts", async () => {
      const { result, events } = await start("full", "Bash", {}, { kind: "allow" });
      expect(result.allowed).toBe(true);
      expect(events.at(-1)?.data).toEqual({ callId: result.callId });
    });

    test("read-only allows reads and denies edits, commands and deliveries", async () => {
      expect((await start("readonly", "Bash", { command: "git status" }, { kind: "allow" })).result.allowed).toBe(true);
      expect((await start("readonly", "Bash", { command: "rm x" }, { kind: "allow" })).result.allowed).toBe(false);
      expect((await start("readonly", "Edit", {}, { kind: "allow" })).result.allowed).toBe(false);
      expect((await start("readonly", "workspace_deliver", {}, { kind: "allow" })).result.allowed).toBe(false);
      expect(
        (await start("readonly", "dev_server_start", { cmd: "npm run dev" }, { kind: "allow" })).result.allowed,
      ).toBe(false);
      expect((await start("readonly", "Read", {}, { kind: "allow" })).result.allowed).toBe(true);
    });

    test("edit mode asks before commands", async () => {
      const { result, requestApproval } = await start("edit", "Bash", { command: "npm i" }, { kind: "allow" });
      expect(result.allowed).toBe(true);
      expect(requestApproval).toHaveBeenCalledWith("Rodar coisa?", result.callId, null, {
        reason: "Modo Editar: comandos e entregas pedem sua confirmação.",
        timeoutMs: approvalTimeoutMs,
      });
    });

    test("full access still asks before writing in production, deploying or sending money", async () => {
      const hard: Gate = { kind: "human", prompt: "p", reason: "r", hard: true };
      const write = await start("full", "Bash", { command: `supabase db query --remote=abc "update t set a=1"` }, hard);
      expect(write.result.allowed).toBe(true);
      expect(write.requestApproval).toHaveBeenCalledWith(
        `Rodar SQL no banco remoto sem --read-only: supabase db query --remote=abc update t set a=1?`,
        write.result.callId,
        null,
        { reason: "Isso mexe em produção, então preciso do seu ok.", timeoutMs: approvalTimeoutMs },
      );
      const deploy = await start("full", "Bash", { command: "wrangler deploy" }, hard);
      expect(deploy.requestApproval).toHaveBeenCalledTimes(1);
      const denied = makeContext({ permission: "full" }, { choice: "deny", interactionId: "int_2" });
      const refused = await beginCall(denied.context, {
        name: "Bash",
        label: "x",
        input: { command: "gh pr merge 12" },
        gate: { kind: "allow" },
        workspace: workspace(),
      });
      expect(refused.allowed).toBe(false);
    });

    test("full access lets Jev clear a requested production action and denies an unclear one in a routine", async () => {
      const hardList = spyOn(decisions, "decideHardList").mockResolvedValue(decision("auto_approved"));
      try {
        const cleared = await start("full", "Bash", { command: "wrangler deploy" }, { kind: "allow" });
        expect(cleared.result.allowed).toBe(true);
        expect(cleared.requestApproval).not.toHaveBeenCalled();
        expect(cleared.events.at(-1)?.data.clearedBy).toEqual({ decision: "jev", model: "jev-1", hardList: true });
        expect(hardList.mock.calls[0]?.[0]).toMatchObject({
          tool: "Bash",
          isSchedule: false,
          reason: "Isso coloca algo no ar, então preciso do seu ok.",
        });
        hardList.mockResolvedValue(decision("denied"));
        const routine = makeContext({ permission: "full", isSchedule: true });
        const refused = await beginCall(routine.context, {
          name: "Bash",
          label: "x",
          input: { command: "wrangler deploy" },
          gate: { kind: "allow" },
          workspace: workspace(),
        });
        expect(refused.allowed).toBe(false);
        expect(refused.message).toContain("registre no resumo da rotina");
        expect(routine.requestApproval).not.toHaveBeenCalled();
        expect(routine.settled.at(-1)).toContain("negado");
      } finally {
        hardList.mockRestore();
      }
    });

    test("read-only production queries run without a card in every mode", async () => {
      const hard: Gate = { kind: "human", prompt: "p", reason: "r", hard: true };
      const command = `cd /tmp && supabase db query --remote=abc --read-only "select 1" | head -5`;
      for (const mode of ["readonly", "edit", "default", "full"] as PermissionMode[]) {
        const { result, requestApproval } = await start(mode, "Bash", { command }, hard);
        expect(result.allowed).toBe(true);
        expect(requestApproval).not.toHaveBeenCalled();
      }
      const blocked = await start("default", "Bash", { command }, { kind: "deny", message: "fora" });
      expect(blocked.result.allowed).toBe(false);
    });

    test("bash without a workspace counts as a command", async () => {
      const harness = makeContext({ permission: "readonly" });
      const result = await beginCall(harness.context, {
        name: "Bash",
        label: "x",
        input: { command: "ls" },
        gate: { kind: "allow" },
      });
      expect(result.allowed).toBe(false);
    });
  });
});

describe("endCall", () => {
  test("settles completed and failed calls with a summary", () => {
    const { context, events, settled, counters } = makeContext();
    endCall(context, "c1", "Read", { file_path: "a" }, { ok: true, output: { lines: 2 } });
    endCall(context, "c2", "Read", {}, { ok: true });
    endCall(context, "c3", "Bash", {}, { ok: false, error: "boom" });
    endCall(context, "c4", "Bash", {}, { ok: false });
    expect(events.map((event) => event.data.outcome)).toEqual(["completed", "completed", "failed", "failed"]);
    expect(events[1].data.output).toBeNull();
    expect(events[2].data.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "boom" });
    expect(events[3].data.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "Falhou." });
    expect(settled).toEqual([
      'Read({"file_path":"a"}) → {"lines":2}',
      'Read({}) → "ok"',
      "Bash({}) → erro: boom",
      "Bash({}) → erro: ",
    ]);
    expect(counters.end).toBe(4);
  });
});

describe("emitEdit", () => {
  test("emits a diff for a real change and nothing when the text is the same", async () => {
    const { context, events } = makeContext();
    const ws = workspace();
    await emitEdit(context, ws, {
      callId: "c",
      absPath: "/srv/outside/a.txt",
      before: null,
      after: "a\n",
      source: "tool",
    });
    expect(events[0].data).toMatchObject({
      path: "/srv/outside/a.txt",
      outside: true,
      created: true,
      deleted: false,
      added: 1,
      removed: 0,
    });
    await emitEdit(context, ws, {
      callId: "c",
      absPath: join(root, "a.txt"),
      before: "x",
      after: "x",
      source: "sweep",
    });
    expect(events).toHaveLength(1);
  });
});

describe("nativeHooks", () => {
  function fakeLive() {
    const scan = mock(async () => undefined);
    return { live: { scan } as unknown as CodeLive, scan };
  }

  test("a denied tool returns the reason and is never tracked", async () => {
    const { context } = makeContext();
    const { live, scan } = fakeLive();
    const hooks = nativeHooks(context, workspace(), live);
    const result = await hooks.before("Write", { file_path: ".git/config", content: "x" }, "tu1");
    expect(result).toMatchObject({ allow: false });
    await hooks.after("Write", {}, {}, "tu1", false);
    expect(scan).not.toHaveBeenCalled();
  });

  test("an edit inside the worktree is shown and triggers a live scan", async () => {
    const { context, events } = makeContext();
    const { live, scan } = fakeLive();
    const ws = workspace();
    const hooks = nativeHooks(context, ws, live);
    writeFileSync(join(root, "e.txt"), "old\n");
    const result = await hooks.before(
      "Edit",
      { file_path: join(root, "e.txt"), old_string: "old", new_string: "new", replace_all: true },
      "tu2",
    );
    expect(result).toEqual({ allow: true });
    expect(events[0].data.input).toEqual({
      file_path: "e.txt",
      old_string: "old",
      new_string: "new",
      replace_all: true,
    });
    expect(events[0].data.capability).toMatchObject({ label: "Editar e.txt" });
    await hooks.after("Edit", {}, { filePath: "x" }, "tu2", false);
    expect(scan).toHaveBeenCalledWith("tu2", "tool", expect.objectContaining({ input: expect.any(Object) }));
    expect(events.find((event) => event.type === "call.settled")?.data.output).toEqual({ ok: true });
  });

  test("finds worktree paths in commands and routes tools to the workspace that owns them", async () => {
    const other = join(worktreesRoot, "api", "api-bot-task");
    expect(worktreePathsIn(`cd ${other} && git status; ls ${other}/src`)).toEqual([other]);
    expect(worktreePathsIn("cd ~/.local/share/runelay-bots-worktrees/api/api-bot-task/src")).toEqual([other]);
    expect(worktreePathsIn("ls /tmp")).toEqual([]);
    const { context } = makeContext();
    const { live, scan } = fakeLive();
    const ws = workspace();
    const owned = { ...ws, id: "ws_other", path: other };
    const adopt = mock(async (_path: string) => null);
    const router = { workspaceFor: (path: string) => (path.startsWith(other) ? owned : null), adopt };
    const hooks = nativeHooks(context, ws, live, router);
    const result = await hooks.before("Bash", { command: `cd ${other} && git status` }, "tu-route");
    expect(result).toMatchObject({ allow: true });
    expect(adopt).toHaveBeenCalledWith(other);
    await hooks.after("Bash", {}, "ok", "tu-route", false);
    expect(scan).toHaveBeenCalledWith("tu-route", "tool", expect.any(Object));
  });

  test("a worktree that fails to be adopted does not block the command", async () => {
    const other = join(worktreesRoot, "api", "api-bot-broken");
    const { context } = makeContext();
    const { live } = fakeLive();
    const ws = workspace();
    const adopt = mock(async (_path: string): Promise<WorkspaceState | null> => {
      throw new Error("record gone");
    });
    const hooks = nativeHooks(context, ws, live, { workspaceFor: () => null, adopt });
    const result = await hooks.before("Bash", { command: `ls ${other}` }, "tu-adopt-fail");
    expect(result).toMatchObject({ allow: true });
    expect(adopt).toHaveBeenCalledWith(other);
  });

  test("an approved edit outside the worktree emits its own diff", async () => {
    const outside = mkdtempSync(join(tmpdir(), "rb-hooks-outside-"));
    try {
      const file = join(outside, "o.txt");
      writeFileSync(file, "before\n");
      const { context, events } = makeContext();
      const { live, scan } = fakeLive();
      const hooks = nativeHooks(context, workspace(), live);
      const result = await hooks.before("Write", { file_path: file, content: "after\n" }, "tu3");
      expect(result).toEqual({ allow: true });
      expect(events[0].data.input).toEqual({ file_path: file, lines: 2 });
      writeFileSync(file, "after\n");
      await hooks.after("Write", {}, {}, "tu3", false);
      expect(scan).not.toHaveBeenCalled();
      const edit = events.find((event) => event.type === "code.edit") as Emitted;
      expect(edit.data).toMatchObject({ path: file, outside: true, before: "before\n", after: "after\n" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a failing outside diff is only logged", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const workspaceModule = await import("../services/workspace.service");
    const diff = spyOn(workspaceModule, "diffTexts").mockRejectedValue(new Error("diff failed"));
    try {
      const { context } = makeContext();
      const hooks = nativeHooks(context, workspace(), fakeLive().live);
      await hooks.before("MultiEdit", { file_path: "/srv/nowhere/m.txt", edits: [{}, {}] }, "tu4");
      await hooks.after("MultiEdit", {}, {}, "tu4", false);
      expect(warn).toHaveBeenCalledWith("code.edit failed", expect.any(Error));
    } finally {
      diff.mockRestore();
      warn.mockRestore();
    }
  });

  test("bash commands get secrets and heavy limits applied and are scanned after", async () => {
    const secret = spyOn(vaultTools, "secretBashCommand").mockResolvedValue("SECRET=1 vitest run");
    try {
      const { context, events } = makeContext();
      const { live, scan } = fakeLive();
      const hooks = nativeHooks(context, workspace(), live);
      const result = await hooks.before("Bash", { command: "vitest run", description: "Testes" }, "tu5");
      expect(result.allow).toBe(true);
      const command = (result as unknown as { input: { command: string } }).input.command;
      expect(command).toContain("flock");
      expect(command).toContain("SECRET=1 vitest run");
      expect(events[0].data.input).toEqual({ command: "vitest run", description: "Testes" });
      await hooks.after("Bash", {}, { stdout: "ok", stderr: "", interrupted: true }, "tu5", false);
      expect(scan).toHaveBeenCalledWith("tu5", "tool", expect.objectContaining({ input: expect.any(Object) }));
      expect(events.find((event) => event.type === "call.settled")?.data.output).toEqual({
        stdout: "ok",
        stderr: "",
        interrupted: true,
      });
    } finally {
      secret.mockRestore();
    }
  });

  test("a secret rewrite of a light command replaces it as is", async () => {
    const secret = spyOn(vaultTools, "secretBashCommand").mockResolvedValue("TOKEN=x curl localhost");
    try {
      const { context } = makeContext();
      const hooks = nativeHooks(context, workspace(), fakeLive().live);
      const result = await hooks.before("Bash", { command: "curl localhost" }, "tu6");
      expect(result).toEqual({ allow: true, input: { command: "TOKEN=x curl localhost" } });
    } finally {
      secret.mockRestore();
    }
  });

  test("a secret that cannot be used stops the command", async () => {
    const secret = spyOn(vaultTools, "secretBashCommand").mockRejectedValue(new Error("sem segredo"));
    const plain = spyOn(vaultTools, "secretBashCommand");
    try {
      const { context, events } = makeContext();
      const hooks = nativeHooks(context, workspace(), fakeLive().live);
      expect(await hooks.before("Bash", { command: "echo $X" }, "tu7")).toEqual({
        allow: false,
        message: "sem segredo",
      });
      expect(events.at(-1)?.data).toMatchObject({ outcome: "failed", error: { message: "sem segredo" } });
      secret.mockRejectedValueOnce("plain failure");
      expect(await hooks.before("Bash", { command: "echo $Y" }, "tu8")).toEqual({
        allow: false,
        message: "plain failure",
      });
    } finally {
      plain.mockRestore();
      secret.mockRestore();
    }
  });

  test("a plain bash command runs untouched and a failure is reported", async () => {
    const { context, events } = makeContext();
    const { live, scan } = fakeLive();
    const hooks = nativeHooks(context, workspace(), live);
    expect(await hooks.before("Bash", { command: "ls" }, "tu9")).toEqual({ allow: true });
    await hooks.after("Bash", {}, { error: "exit 1" }, "tu9", true);
    expect(scan).not.toHaveBeenCalled();
    expect(events.at(-1)?.data.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: '{"error":"exit 1"}' });
    expect(await hooks.before("Bash", { command: "ls" }, "tu10")).toEqual({ allow: true });
    await hooks.after("Bash", {}, "string failure", "tu10", true);
    expect(events.at(-1)?.data.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "string failure" });
  });

  test("read-like tools show a compact output and are not scanned", async () => {
    const { context, events } = makeContext();
    const { live, scan } = fakeLive();
    const hooks = nativeHooks(context, workspace(), live);
    const outputs: unknown[] = [];
    const run = async (tool: string, input: Record<string, unknown>, response: unknown) => {
      const id = `id_${outputs.length}_${tool}`;
      await hooks.before(tool, input, id);
      const shown = events.filter((event) => event.type === "call.requested").at(-1)?.data.input;
      await hooks.after(tool, input, response, id, false);
      outputs.push({ shown, output: events.filter((event) => event.type === "call.settled").at(-1)?.data.output });
    };
    await run("Read", { file_path: "a.ts", offset: 2, limit: 5 }, { file: { numLines: 3 }, type: "text" });
    await run("Read", { file_path: "a.ts" }, {});
    await run("Glob", { pattern: "*", path: "src" }, { filenames: ["a", "b"] });
    await run("Glob", {}, { numFiles: 7 });
    await run("Grep", { pattern: "x" }, { numFiles: 1, numMatches: 2, content: "a:x" });
    await run("Grep", { pattern: "x" }, { filenames: ["a", "b"], numLines: 4 });
    await run("Grep", { pattern: "x" }, {});
    await run("TodoWrite", { todos: [] }, { newTodos: [1] });
    await run("TodoWrite", { todos: [] }, { todos: [2] });
    await run("TodoWrite", { todos: [] }, null);
    await run("WebFetch", { url: "u" }, { small: true });
    await run("WebFetch", { url: "u" }, { big: "x".repeat(5000) });
    await run("WebFetch", { url: "u" }, "plain text");
    expect(outputs).toEqual([
      { shown: { file_path: "a.ts", offset: 2, limit: 5 }, output: { lines: 3, type: "text" } },
      { shown: { file_path: "a.ts" }, output: { lines: undefined, type: "text" } },
      { shown: { pattern: "*", path: "src" }, output: { count: 2, files: ["a", "b"] } },
      { shown: {}, output: { count: 7, files: [] } },
      { shown: { pattern: "x" }, output: { files: 1, matches: 2, content: "a:x" } },
      { shown: { pattern: "x" }, output: { files: 0, matches: 4, content: "a\nb" } },
      { shown: { pattern: "x" }, output: { files: 0, matches: 0, content: "" } },
      { shown: { todos: [] }, output: { todos: [1] } },
      { shown: { todos: [] }, output: { todos: [2] } },
      { shown: { todos: [] }, output: { todos: null } },
      { shown: { url: "u" }, output: { small: true } },
      { shown: { url: "u" }, output: expect.stringMatching(/…$/) },
      { shown: { url: "u" }, output: "plain text" },
    ]);
    expect(scan).not.toHaveBeenCalled();
  });

  test("Write and Edit inputs are summarized and unknown ids are ignored", async () => {
    const { context, events } = makeContext();
    const hooks = nativeHooks(context, workspace(), fakeLive().live);
    await hooks.before("Write", { file_path: join(root, "w.txt") }, "w1");
    expect(events[0].data.input).toEqual({ file_path: "w.txt", lines: 1 });
    await hooks.before("Edit", { file_path: join(root, "w.txt") }, "w2");
    expect(events.filter((event) => event.type === "call.requested")[1].data.input).toEqual({
      file_path: "w.txt",
      old_string: "",
      new_string: "",
    });
    await hooks.before("MultiEdit", { file_path: join(root, "w.txt"), edits: "nope" }, "w3");
    expect(events.filter((event) => event.type === "call.requested")[2].data.input).toEqual({
      file_path: "w.txt",
      edits: 0,
    });
    await hooks.before("Glob", { pattern: "*" }, "w4");
    const count = events.length;
    await hooks.after("Glob", {}, {}, "missing", false);
    expect(events).toHaveLength(count);
  });
});

describe("tool sandbox", () => {
  const saved = { mode: process.env.BOTS_TOOL_SANDBOX, sudo: process.env.BOTS_SANDBOX_SUDO };

  function sandboxOn(probe: { code?: number; stdout?: string; stderr?: string }) {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    process.env.BOTS_SANDBOX_SUDO = "/fake/sudo";
    resetSandboxProbe();
    return fakeProcesses((call) => {
      if (call.command !== "/fake/sudo") return undefined;
      if (call.args.includes("--probe")) return probe;
      return { stdout: "0\n" };
    });
  }

  function commandOf(gate: unknown) {
    return (gate as { input: { command: string } }).input.command;
  }

  afterEach(() => {
    if (saved.mode === undefined) delete process.env.BOTS_TOOL_SANDBOX;
    else process.env.BOTS_TOOL_SANDBOX = saved.mode;
    if (saved.sudo === undefined) delete process.env.BOTS_SANDBOX_SUDO;
    else process.env.BOTS_SANDBOX_SUDO = saved.sudo;
    resetSandboxProbe();
  });

  test("background bash is denied and pointed to dev_server_start", async () => {
    const { context } = makeContext();
    const hooks = nativeHooks(context, workspace(), { scan: async () => undefined } as unknown as CodeLive);
    const result = await hooks.before("Bash", { command: "npm run dev", run_in_background: true }, "bg1");
    expect(result.allow).toBe(false);
    expect(result.message).toContain("dev_server_start");
  });

  test("every bash command runs as the sandbox user in the persistent shell cwd", async () => {
    const fake = sandboxOn({ stdout: "ok 1502 bwrap=0\n" });
    try {
      const { context } = makeContext();
      const hooks = nativeHooks(context, workspace(), { scan: async () => undefined } as unknown as CodeLive);
      const command = commandOf(await hooks.before("Bash", { command: "cat 'a b'", timeout: 5000 }, "sb1"));
      const expected = [
        "'/fake/sudo' '-n' '-u' 'runelaytool' '/usr/local/bin/rb-sandbox-exec'",
        `'--cwd' "$PWD" '--marker' '${sandboxMarker("sbx", "turn1")}' '--timeout' '35' '--'`,
        `'cat '\\''a b'\\'''`,
      ].join(" ");
      expect(command).toBe(expected);
      const wrapped = commandOf(await hooks.before("Bash", { command: "vitest run" }, "sb2"));
      expect(wrapped.startsWith("flock ")).toBe(true);
      expect(wrapped).toContain("'/fake/sudo' '-n' '-u' 'runelaytool'");
      expect(wrapped).toContain("'--timeout' '1230'");
      expect(fake.calls.filter((call) => call.args.includes("--probe"))).toHaveLength(1);
    } finally {
      fake.restore();
    }
  });

  test("the bot home shell runs as the sandbox user too", async () => {
    const fake = sandboxOn({ stdout: "ok 1502 bwrap=0\n" });
    try {
      const { context } = makeContext();
      const home = await ensureBotHome(`home-sandbox-${Date.now()}`);
      const hooks = homeHooks(context, home);
      const command = commandOf(await hooks.before("Bash", { command: "gh pr list", timeout: 5000 }, "hs1"));
      expect(command.startsWith("'/fake/sudo' '-n' '-u' 'runelaytool' '/usr/local/bin/rb-sandbox-exec'")).toBe(true);
      expect(command.endsWith("'gh pr list'")).toBe(true);
      fake.restore();
      const broken = sandboxOn({ code: 1, stderr: "sudo: a password is required" });
      const denied = await homeHooks(context, home).before("Bash", { command: "ls" }, "hs2");
      expect(denied).toEqual({ allow: false, message: sandboxMissingMessage });
      broken.restore();
      const background = await homeHooks(context, home).before(
        "Bash",
        { command: "npm run dev", run_in_background: true },
        "hs3",
      );
      expect(background.allow).toBe(false);
      expect(background.message).toContain("dev_server_start");
    } finally {
      fake.restore();
    }
  });

  test("a vault rewrite stays outside the sandbox", async () => {
    const fake = sandboxOn({ stdout: "ok 1502 bwrap=0\n" });
    const secret = spyOn(vaultTools, "secretBashCommand").mockResolvedValue("HELPER");
    try {
      const { context } = makeContext();
      expect(await sandboxedBash(context, "curl x", {})).toEqual({ command: "HELPER" });
    } finally {
      secret.mockRestore();
      fake.restore();
    }
  });

  test("a configured sandbox that does not work refuses the command", async () => {
    const fake = sandboxOn({ code: 1, stderr: "sudo: a password is required" });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { context, events } = makeContext();
      const hooks = nativeHooks(context, workspace(), { scan: async () => undefined } as unknown as CodeLive);
      expect(await hooks.before("Bash", { command: "ls" }, "sb3")).toEqual({
        allow: false,
        message: sandboxMissingMessage,
      });
      expect(events.at(-1)?.data).toMatchObject({ outcome: "failed" });
    } finally {
      warn.mockRestore();
      fake.restore();
    }
  });
});

describe("homeHooks", () => {
  test("runs reads and commands in the bot home and gates the hard list", async () => {
    const home = await ensureBotHome(`home-${Date.now()}`);
    const { context, events, requestApproval } = makeContext({ permission: "full" });
    const hooks = homeHooks(context, home);
    expect(await hooks.before("Bash", { command: "gh auth status" }, "h1")).toEqual({ allow: true });
    await hooks.after("Bash", {}, { stdout: "ok", stderr: "" }, "h1", false);
    expect(events.find((event) => event.type === "call.settled")?.data).toMatchObject({
      outcome: "completed",
      output: { stdout: "ok", stderr: "" },
    });
    expect(await hooks.before("Read", { file_path: join(home.path, "a.txt") }, "h2")).toEqual({ allow: true });
    await hooks.after("Read", {}, "falhou", "h2", true);
    expect(events.at(-1)?.data.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "falhou" });
    await hooks.before("Read", { file_path: "a.txt" }, "h3");
    await hooks.after("Read", {}, { error: 1 }, "h3", true);
    expect(events.at(-1)?.data.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: '{"error":1}' });
    await hooks.after("Bash", {}, {}, "nunca-visto", false);
    const deploy = await hooks.before("Bash", { command: "wrangler deploy" }, "h4");
    expect(deploy).toEqual({ allow: true });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(await hooks.before("Bash", { command: "ls &" }, "h5")).toMatchObject({ allow: false });
    expect(await hooks.before("TodoWrite", {}, "h6")).toEqual({ allow: true });
  });

  test("applies secrets and heavy limits and stops on a secret error", async () => {
    const home = await ensureBotHome(`home-secret-${Date.now()}`);
    const secret = spyOn(vaultTools, "secretBashCommand").mockResolvedValue("SECRET=1 vitest run");
    try {
      const { context, events } = makeContext();
      const hooks = homeHooks(context, home);
      const result = await hooks.before("Bash", { command: "vitest run" }, "s1");
      expect((result as unknown as { input: { command: string } }).input.command).toContain("SECRET=1 vitest run");
      secret.mockResolvedValueOnce("TOKEN=x curl localhost");
      expect(await hooks.before("Bash", { command: "curl localhost" }, "s2")).toEqual({
        allow: true,
        input: { command: "TOKEN=x curl localhost" },
      });
      secret.mockRejectedValueOnce(new Error("sem segredo"));
      expect(await hooks.before("Bash", { command: "echo $X" }, "s3")).toEqual({
        allow: false,
        message: "sem segredo",
      });
      secret.mockRejectedValueOnce("plain failure");
      expect(await hooks.before("Bash", { command: "echo $Y" }, "s4")).toEqual({
        allow: false,
        message: "plain failure",
      });
      expect(events.at(-1)?.data).toMatchObject({ outcome: "failed", error: { message: "plain failure" } });
    } finally {
      secret.mockRestore();
    }
  });
});
