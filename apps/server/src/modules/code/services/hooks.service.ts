import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { NativeToolHooks } from "@runelay-bots/protocol";
import { decideApproval } from "../../approvals/services/decisions.service";
import { type ActionClass, applyCodePermission, permissionLabels } from "../../approvals/services/permissions.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { secretBashCommand } from "../../vault/services/vault-tools.service";
import { addGrant, hasGrant } from "../repositories/code.repository";
import { wrapHeavyCommand } from "./heavy-commands.service";
import type { CodeLive } from "./live-diff.service";
import { commandIsReadOnly, fixedRuleViolation, type Gate, gateNative } from "./policy.service";
import {
  clipText,
  diffTexts,
  insideWorkspace,
  readMaybe,
  relativePath,
  type WorkspaceState,
} from "./workspace.service";

const editTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string, max = 80) {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

export function codeLabel(tool: string, input: Record<string, unknown>) {
  const file = String(input.file_path ?? input.notebook_path ?? "");
  const name = file ? basename(file) : "";
  if (tool === "Read") return `Ler ${name}`;
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return `Editar ${name}`;
  if (tool === "Write") return existsSync(file) ? `Reescrever ${name}` : `Criar ${name}`;
  if (tool === "Glob") return `Procurar arquivos ${oneLine(String(input.pattern ?? ""), 60)}`;
  if (tool === "Grep") return `Procurar “${oneLine(String(input.pattern ?? ""), 60)}”`;
  if (tool === "TodoWrite") return "Atualizar a lista de passos";
  if (tool === "Bash")
    return String(input.description ?? "").trim()
      ? oneLine(String(input.description), 80)
      : `Rodar ${oneLine(String(input.command ?? ""), 70)}`;
  return tool;
}

function shownInput(tool: string, input: Record<string, unknown>, workspace: WorkspaceState | null) {
  const path = (value: unknown) => (typeof value === "string" && workspace ? relativePath(workspace, value) : value);
  if (tool === "Write")
    return { file_path: path(input.file_path), lines: String(input.content ?? "").split("\n").length };
  if (tool === "Edit")
    return {
      file_path: path(input.file_path),
      old_string: clip(String(input.old_string ?? ""), 2000),
      new_string: clip(String(input.new_string ?? ""), 2000),
      ...(input.replace_all ? { replace_all: true } : {}),
    };
  if (tool === "MultiEdit")
    return { file_path: path(input.file_path), edits: Array.isArray(input.edits) ? input.edits.length : 0 };
  if (tool === "Read")
    return {
      file_path: path(input.file_path),
      ...(input.offset ? { offset: input.offset } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    };
  if (tool === "Bash")
    return {
      command: clip(String(input.command ?? ""), 4000),
      ...(input.description ? { description: input.description } : {}),
    };
  return input;
}

function shownOutput(tool: string, response: unknown) {
  if (typeof response === "string") return clip(response, 4000);
  const value = (response ?? {}) as Record<string, unknown>;
  if (tool === "Bash") {
    return {
      stdout: String(value.stdout ?? "").slice(-4000),
      stderr: String(value.stderr ?? "").slice(-2000),
      ...(value.interrupted ? { interrupted: true } : {}),
    };
  }
  if (tool === "Read") {
    const file = (value.file ?? {}) as Record<string, unknown>;
    return { lines: Number(file.numLines ?? file.totalLines ?? 0) || undefined, type: value.type ?? "text" };
  }
  if (tool === "Glob") {
    const names = Array.isArray(value.filenames) ? (value.filenames as string[]) : [];
    return { count: Number(value.numFiles ?? names.length), files: names.slice(0, 40) };
  }
  if (tool === "Grep")
    return {
      files: Number(value.numFiles ?? 0),
      matches: Number(value.numMatches ?? value.numLines ?? 0),
      content: clip(
        String(value.content ?? (Array.isArray(value.filenames) ? (value.filenames as string[]).join("\n") : "")),
        3000,
      ),
    };
  if (editTools.has(tool)) return { ok: true };
  if (tool === "TodoWrite") return { todos: value.newTodos ?? value.todos ?? null };
  const text = JSON.stringify(value);
  return text.length > 4000 ? clip(text, 4000) : value;
}

function scope(context: ToolContext) {
  return { runId: context.runId(), turnId: context.turnId };
}

function owner(context: ToolContext) {
  return context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() };
}

function humanRecord(context: ToolContext, tool: string, callId: string, reason: string, outcome = "human") {
  context.emitDecision({
    kind: "approval",
    question: "Esta ação do bot é segura para rodar sem uma pessoa confirmar?",
    answer: null,
    confidence: null,
    threshold: context.decisions.threshold,
    outcome,
    latencyMs: 0,
    model: null,
    reason,
    tool,
    callId,
  });
}

export interface CallStart {
  allowed: boolean;
  callId: string;
  message?: string;
}

export async function beginCall(
  context: ToolContext,
  spec: {
    callId?: string;
    name: string;
    label: string;
    input: Record<string, unknown>;
    gate: Gate;
    target?: { label: string; role: string };
    workspace?: WorkspaceState | null;
    alwaysHuman?: boolean;
  },
): Promise<CallStart> {
  const callId = spec.callId || `call_${randomBytes(9).toString("base64url")}`;
  const log = context.log;
  context.onCallStart();
  log.emit({
    type: "call.requested",
    data: {
      callId,
      capability: { kind: "tool", name: spec.name, label: spec.label, surface: "code" },
      input: spec.input,
      owner: owner(context),
      ...(context.origin ? { origin: { agent: context.origin } } : {}),
    },
    scope: scope(context),
  });
  const reject = (interactionId: string | null, message: string, code = "TOOL_EXECUTION_DENIED") => {
    log.emit({
      type: "call.settled",
      data: {
        callId,
        ...(interactionId ? { cause: { interactionId } } : {}),
        error: { code, message },
        outcome: "rejected",
      },
      scope: scope(context),
    });
    context.onCallSettled(`${spec.name}(${oneLine(JSON.stringify(spec.input), 120)}) → negado`);
    context.onCallEnd();
    return { allowed: false, callId, message };
  };
  const mode = context.permission ?? "default";
  let gate = spec.gate;
  if (mode !== "default" && !spec.alwaysHuman) {
    const command =
      spec.name === "Bash"
        ? String(spec.input.command ?? "")
        : spec.name === "dev_server_start"
          ? String(spec.input.cmd ?? "")
          : "";
    const action: ActionClass = editTools.has(spec.name)
      ? "edit"
      : spec.name === "workspace_deliver"
        ? "deliver"
        : spec.name === "dev_server_start"
          ? "command"
          : spec.name === "Bash"
            ? spec.workspace && commandIsReadOnly(command, spec.workspace)
              ? "read"
              : "command"
            : "read";
    const fixed = mode === "full" && command && spec.workspace ? fixedRuleViolation(command, spec.workspace) : null;
    const before = gate.kind;
    gate = applyCodePermission(mode, action, gate, fixed, spec.label);
    if (gate.kind === "allow" && before !== "allow") {
      humanRecord(context, spec.name, callId, `Modo ${permissionLabels[mode]}: liberado sem card.`, "granted");
      log.emit({ type: "call.started", data: { callId, clearedBy: { permission: mode } }, scope: scope(context) });
      return { allowed: true, callId };
    }
  }
  if (gate.kind === "asked") {
    humanRecord(context, spec.name, callId, gate.reason, "requested");
    log.emit({
      type: "call.started",
      data: { callId, clearedBy: { request: true, reason: gate.reason } },
      scope: scope(context),
    });
    return { allowed: true, callId };
  }
  if (gate.kind === "deny") {
    humanRecord(context, spec.name, callId, gate.message, "blocked");
    return reject(null, gate.message, "TOOL_POLICY");
  }
  const grantKey = gate.kind === "jev" || (gate.kind === "human" && !gate.hard) ? gate.grantKey : undefined;
  const repo = spec.workspace?.repo;
  if (grantKey && repo && (await hasGrant(repo, grantKey))) {
    humanRecord(context, spec.name, callId, `Sempre permitido neste repositório: ${grantKey}`, "granted");
    log.emit({ type: "call.started", data: { callId, clearedBy: { grant: grantKey } }, scope: scope(context) });
    return { allowed: true, callId };
  }
  if (gate.kind === "jev") {
    const decision = await decideApproval(
      {
        botName: context.bot.name,
        botRole: context.bot.role,
        request: context.request,
        tool: spec.name,
        input: spec.input,
        page: null,
        element: "",
      },
      context.decisions,
      callId,
    );
    context.emitDecision(decision);
    if (decision.outcome === "auto_approved") {
      log.emit({
        type: "call.started",
        data: { callId, clearedBy: { decision: "jev", model: decision.model } },
        scope: scope(context),
      });
      return { allowed: true, callId };
    }
    gate = {
      kind: "human",
      prompt: gate.prompt,
      reason: "",
      hard: false,
      ...(gate.grantKey ? { grantKey: gate.grantKey } : {}),
    };
  } else if (gate.kind === "human") {
    humanRecord(context, spec.name, callId, gate.reason, "human");
  }
  if (gate.kind === "human") {
    if (context.isSchedule)
      return reject(null, "Ninguém está aqui para aprovar isso agora. Não tente de novo nesta rotina.");
    const offerGrant =
      !gate.hard && gate.grantKey && repo ? `${gate.grantKey} em ${spec.workspace?.repoName}` : undefined;
    const { choice, interactionId, always } = await context.requestApproval(gate.prompt, callId, context.origin, {
      ...(spec.target ? { target: spec.target } : {}),
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(offerGrant ? { grant: offerGrant } : {}),
    });
    if (choice !== "approve") return reject(interactionId, "A pessoa negou essa ação. Não tente de novo sem pedir.");
    if (always && gate.grantKey && repo) await addGrant(repo, gate.grantKey);
    log.emit({
      type: "call.started",
      data: { callId, clearedBy: { interactionId, ...(always ? { remembered: true } : {}) } },
      scope: scope(context),
    });
    return { allowed: true, callId };
  }
  log.emit({ type: "call.started", data: { callId }, scope: scope(context) });
  return { allowed: true, callId };
}

export function endCall(
  context: ToolContext,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  result: { ok: boolean; output?: unknown; error?: string },
) {
  if (result.ok) {
    context.log.emit({
      type: "call.settled",
      data: { callId, outcome: "completed", output: result.output ?? null },
      scope: scope(context),
    });
    context.onCallSettled(
      `${name}(${oneLine(JSON.stringify(input), 120)}) → ${oneLine(JSON.stringify(result.output ?? "ok"), 160)}`,
    );
  } else {
    context.log.emit({
      type: "call.settled",
      data: {
        callId,
        outcome: "failed",
        error: { code: "TOOL_EXECUTION_FAILED", message: clip(result.error ?? "Falhou.", 2000) },
      },
      scope: scope(context),
    });
    context.onCallSettled(
      `${name}(${oneLine(JSON.stringify(input), 120)}) → erro: ${oneLine(result.error ?? "", 160)}`,
    );
  }
  context.onCallEnd();
}

export async function emitEdit(
  context: { log: EventLog; turnId: string },
  workspace: WorkspaceState,
  data: {
    callId: string | null;
    absPath: string;
    before: string | null;
    after: string | null;
    source: "tool" | "sweep";
  },
) {
  const diff = await diffTexts(data.before, data.after);
  if (diff.hunks.length === 0) return;
  context.log.emit({
    type: "code.edit",
    data: {
      callId: data.callId,
      workspaceId: workspace.id,
      path: relativePath(workspace, data.absPath),
      absPath: data.absPath,
      outside: !insideWorkspace(workspace, data.absPath),
      before: clipText(data.before),
      after: clipText(data.after),
      hunks: diff.hunks,
      added: diff.added,
      removed: diff.removed,
      created: data.before === null,
      deleted: data.after === null,
      source: data.source,
    },
    scope: { turnId: context.turnId },
  });
}

export function nativeHooks(context: ToolContext, workspace: WorkspaceState, live: CodeLive): NativeToolHooks {
  const calls = new Map<
    string,
    { callId: string; absPath: string | null; before: string | null; input: Record<string, unknown> }
  >();
  return {
    before: async (tool, input, toolUseId) => {
      const gate = gateNative(tool, input, workspace, context.asked);
      const command = tool === "Bash" ? String(input.command ?? "") : "";
      const file = String(input.file_path ?? input.notebook_path ?? "");
      const target = command
        ? { label: oneLine(command, 160), role: "command" }
        : file
          ? { label: relativePath(workspace, file), role: "file" }
          : undefined;
      const start = await beginCall(context, {
        callId: toolUseId,
        name: tool,
        label: codeLabel(tool, input),
        input: shownInput(tool, input, workspace) as Record<string, unknown>,
        gate,
        workspace,
        ...(target ? { target } : {}),
      });
      if (!start.allowed) return { allow: false, message: start.message };
      let rewritten: string | null = null;
      if (command) {
        try {
          rewritten = await secretBashCommand(context, command);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          endCall(context, start.callId, tool, shownInput(tool, input, workspace) as Record<string, unknown>, {
            ok: false,
            error: message,
          });
          return { allow: false, message };
        }
      }
      if (command) rewritten = wrapHeavyCommand(command, rewritten ?? command) ?? rewritten;
      const absPath = editTools.has(tool) && file ? resolve(workspace.path, file) : null;
      calls.set(toolUseId, { callId: start.callId, absPath, before: absPath ? await readMaybe(absPath) : null, input });
      return rewritten ? { allow: true, input: { ...input, command: rewritten } } : { allow: true };
    },
    after: async (tool, input, response, toolUseId, failed) => {
      const call = calls.get(toolUseId);
      if (!call) return;
      calls.delete(toolUseId);
      const shown = shownInput(tool, call.input, workspace) as Record<string, unknown>;
      if (failed) {
        endCall(context, call.callId, tool, shown, {
          ok: false,
          error: typeof response === "string" ? response : JSON.stringify(response),
        });
        return;
      }
      endCall(context, call.callId, tool, shown, { ok: true, output: shownOutput(tool, response) });
      if (call.absPath && !insideWorkspace(workspace, call.absPath)) {
        const after = await readMaybe(call.absPath);
        await emitEdit(context, workspace, {
          callId: call.callId,
          absPath: call.absPath,
          before: call.before,
          after,
          source: "tool",
        }).catch((error) => console.warn("code.edit failed", error));
      } else if (call.absPath || tool === "Bash") {
        await live.scan(call.callId, "tool");
      }
    },
  };
}
