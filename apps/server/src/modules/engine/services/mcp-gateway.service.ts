import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ValidationError } from "../../../shared/errors";
import { redactText } from "../../../shared/redact";
import { type DecisionRecord, type DecisionSettings, decideApproval } from "../../approvals/services/decisions.service";
import type { DeliveryAsk } from "../../approvals/services/delivery-intent.service";
import {
  type PermissionMode,
  readonlyRemoteMessage,
  remotePermission,
} from "../../approvals/services/permissions.service";
import { artifactEventOf } from "../../artifacts/services/artifacts.service";
import { blockEventOf, mainThreadLog } from "../../blocks/services/blocks.shared";
import {
  type BotDefinition,
  connectorsOf,
  createBot,
  getBot,
  listBots,
  updateBot,
} from "../../bots/services/bots.service";
import { type ApprovalTarget, elementText, readBrowserState } from "../../browser/services/browser.service";
import { registerCodeTools } from "../../code/services/code-tools.service";
import {
  ComputerError,
  callComputer,
  computerHumanReason,
  defaultRoots,
} from "../../computer/services/computer.service";
import {
  classifyTool,
  listConnections,
  runelayCall,
  runelayEnabled,
  searchTools,
  type ToolKind,
  touchesDatabase,
} from "../../connectors/services/runelay.service";
import { registerThreadTools } from "../../conversations/services/handoff-tools.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import { createGroup, listGroups, setGroupArchived, updateGroup } from "../../groups/services/groups.service";
import { fileEventOf } from "../../uploads/services/uploads.service";
import { onlyRefs } from "../../vault/services/vault.service";
import {
  computerTypeSecretsOnly,
  prepareSecretInput,
  registerVaultTools,
} from "../../vault/services/vault-tools.service";
import {
  type QuestionOutcome,
  type QuestionRequest,
  registerQuestionTools,
} from "../../questions/services/questions.service";
import { registerServerTools } from "../../servers/services/server-tools.service";
import type { ApprovalDetails, BotTool } from "./bot-tools.service";

export interface ApprovalResult {
  choice: "approve" | "deny";
  interactionId: string;
  always?: boolean;
}

export interface ToolContext {
  token: string;
  botId: string;
  sessionId: string;
  log: EventLog;
  turnId: string;
  runId: () => string;
  tools: BotTool[];
  delegates: BotDefinition[];
  origin: string | null;
  ownerCallId: string | null;
  isSchedule: boolean;
  signal: AbortSignal;
  onCallStart: () => void;
  onCallEnd: () => void;
  requestApproval: (
    prompt: string,
    callId: string,
    origin: string | null,
    details?: ApprovalDetails,
  ) => Promise<ApprovalResult>;
  askUser?: (request: QuestionRequest, callId: string, origin: string | null) => Promise<QuestionOutcome>;
  delegate: (targetId: string, message: string, callId: string) => Promise<string>;
  bot: BotDefinition;
  request: string;
  asked: DeliveryAsk;
  decisions: DecisionSettings;
  emitDecision: (record: DecisionRecord) => void;
  onCallSettled: (summary: string) => void;
  groupMembers: BotDefinition[];
  onHandoff: (botId: string, note: string) => void;
  provider: string;
  cancelTurn: (reason: string) => void;
  runner?: string;
  endRun?: () => void;
  permission?: PermissionMode;
}

const gatedTools = new Set(["browser_click", "browser_fill", "desktop_click", "desktop_open"]);
const alwaysHuman = new Set(["desktop_type", "desktop_key"]);

function brief(value: unknown, max = 160) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function approvalState(context: ToolContext, tool: string, input: Record<string, unknown>) {
  const page = context.bot.capabilities.browser ? await readBrowserState(context.bot.id) : null;
  const element = typeof input.ref === "string" ? elementText(context.bot.id, input.ref) : "";
  return {
    botName: context.bot.name,
    botRole: context.bot.role,
    request: context.request,
    tool,
    input,
    page: page ? { url: page.url, title: page.title } : null,
    element,
  };
}

const contexts = new Map<string, ToolContext>();

export function newToken() {
  return randomBytes(24).toString("base64url");
}

export function registerContext(context: ToolContext) {
  contexts.set(context.token, context);
  return () => contexts.delete(context.token);
}

function newCallId() {
  return `call_${randomBytes(9).toString("base64url")}`;
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: redactText(typeof value === "string" ? value : JSON.stringify(value)) }],
    ...(isError ? { isError: true } : {}),
  };
}

function scopeOf(context: ToolContext) {
  return { runId: context.runId(), turnId: context.turnId };
}

function owner(context: ToolContext) {
  return context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() };
}

async function runTool(context: ToolContext, tool: BotTool, input: Record<string, unknown>) {
  const callId = newCallId();
  const log = context.log;
  context.onCallStart();
  try {
    log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name: tool.name, label: await tool.label(input) },
        input,
        owner: owner(context),
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope: scopeOf(context),
    });
    let decision: DecisionRecord | null = null;
    const vaultOnly = tool.name === "browser_fill" && onlyRefs(input.text);
    const fullAccess = context.permission === "full";
    if (!vaultOnly && !fullAccess && (gatedTools.has(tool.name) || alwaysHuman.has(tool.name))) {
      decision = await decideApproval(await approvalState(context, tool.name, input), context.decisions, callId);
      if (alwaysHuman.has(tool.name) || (tool.name === "desktop_open" && input.app === "terminal")) {
        decision.outcome = "human";
        decision.reason = "Digitar, teclas e terminal sempre passam por uma pessoa.";
      }
      context.emitDecision(decision);
    }
    const approvalPrompt = tool.approval ? await tool.approval(input) : null;
    if (approvalPrompt && vaultOnly) {
      log.emit({ type: "call.started", data: { callId, clearedBy: { vault: true } }, scope: scopeOf(context) });
    } else if (approvalPrompt && fullAccess) {
      log.emit({ type: "call.started", data: { callId, clearedBy: { permission: "full" } }, scope: scopeOf(context) });
    } else if (approvalPrompt && decision?.outcome === "auto_approved") {
      log.emit({
        type: "call.started",
        data: { callId, clearedBy: { decision: "jev", model: decision.model } },
        scope: scopeOf(context),
      });
    } else if (approvalPrompt) {
      const deniedOutput = (interactionId: string | null) => ({
        approval: { interactionId, status: "denied" },
        code: "TOOL_EXECUTION_DENIED",
        message: "Tool execution was denied.",
        tool: { result: "not_run" },
      });
      if (context.isSchedule) {
        log.emit({
          type: "call.settled",
          data: {
            callId,
            error: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." },
            outcome: "rejected",
            output: deniedOutput(null),
          },
          scope: scopeOf(context),
        });
        return textResult("Ninguém está aqui para aprovar ações agora. Não tente de novo nesta rotina.", true);
      }
      const details = tool.details ? await tool.details(input).catch(() => undefined) : undefined;
      const { choice, interactionId } = await context.requestApproval(approvalPrompt, callId, context.origin, details);
      if (choice !== "approve") {
        log.emit({
          type: "call.settled",
          data: {
            callId,
            cause: { interactionId },
            error: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." },
            outcome: "rejected",
            output: deniedOutput(interactionId),
          },
          scope: scopeOf(context),
        });
        return textResult("A pessoa negou essa ação. Não tente de novo sem pedir.", true);
      }
      log.emit({ type: "call.started", data: { callId, clearedBy: { interactionId } }, scope: scopeOf(context) });
    } else {
      log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
    }
    try {
      const output = await tool.run(await prepareSecretInput(context, tool.name, input), context.signal);
      if (output && typeof output === "object" && "imageBase64" in output) {
        const { imageBase64, ...meta } = output as Record<string, unknown>;
        log.emit({
          type: "call.settled",
          data: {
            callId,
            outcome: "completed",
            output: { ...meta, image: `/bots/${context.bot.id}/desktop/latest.png` },
          },
          scope: scopeOf(context),
        });
        context.onCallSettled(`${tool.name}() → print ${brief(meta)}`);
        return {
          content: [
            { type: "image" as const, data: String(imageBase64), mimeType: "image/png" },
            { type: "text" as const, text: JSON.stringify(meta) },
          ],
        };
      }
      const fileEvent = fileEventOf(output);
      if (fileEvent) {
        const { fileEvent: _file, ...rest } = output as Record<string, unknown>;
        log.emit({
          type: "call.settled",
          data: { callId, outcome: "completed", output: rest },
          scope: scopeOf(context),
        });
        log.emit({
          type: fileEvent.type,
          data: { ...fileEvent.data, botId: context.botId, callId },
          scope: scopeOf(context),
        });
        context.onCallSettled(`${tool.name}(${fileEvent.data.attachment.name}) → enviado`);
        return textResult(rest);
      }
      const artifactEvent = artifactEventOf(output);
      if (artifactEvent) {
        const { artifactEvent: _event, ...rest } = output as Record<string, unknown>;
        log.emit({
          type: "call.settled",
          data: { callId, outcome: "completed", output: rest },
          scope: scopeOf(context),
        });
        log.emit({
          type: artifactEvent.type,
          data: { ...artifactEvent.data, botId: context.botId, callId },
          scope: scopeOf(context),
        });
        context.onCallSettled(`${tool.name}(${artifactEvent.data.title}) → v${artifactEvent.data.version}`);
        return textResult(rest);
      }
      const blockEvent = blockEventOf(output);
      if (blockEvent) {
        const { blockEvent: _block, ...rest } = output as Record<string, unknown>;
        log.emit({
          type: "call.settled",
          data: { callId, outcome: "completed", output: rest },
          scope: scopeOf(context),
        });
        const data = { ...blockEvent.data, botId: context.botId, callId };
        log.emit({ type: blockEvent.type, data, scope: scopeOf(context) });
        const main = await mainThreadLog(context.botId);
        if (main && main !== log) main.emit({ type: blockEvent.type, data });
        context.onCallSettled(`${tool.name}(${blockEvent.data.title}) → v${blockEvent.data.version}`);
        return textResult(rest);
      }
      log.emit({ type: "call.settled", data: { callId, outcome: "completed", output }, scope: scopeOf(context) });
      context.onCallSettled(`${tool.name}(${brief(input, 120)}) → ${brief(output)}`);
      return textResult(output);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      log.emit({
        type: "call.settled",
        data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message }, outcome: "failed" },
        scope: scopeOf(context),
      });
      context.onCallSettled(`${tool.name}(${brief(input, 120)}) → erro: ${brief(message)}`);
      return textResult(message, true);
    }
  } finally {
    context.onCallEnd();
  }
}

async function runDelegate(context: ToolContext, target: string, message: string) {
  const callId = newCallId();
  const log = context.log;
  const bot = context.delegates.find((item) => item.id === target);
  context.onCallStart();
  try {
    log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name: target, label: `Delegar para ${bot?.name ?? target}` },
        input: { bot: target, message },
        delegation: { botId: target },
        owner: owner(context),
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope: scopeOf(context),
    });
    log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
    try {
      const report = await context.delegate(target, message, callId);
      context.onCallSettled(`delegate(${target}: ${brief(message, 100)}) → ${brief(report)}`);
      log.emit({
        type: "call.settled",
        data: { callId, outcome: "completed", output: report },
        scope: scopeOf(context),
      });
      return textResult(report);
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      log.emit({
        type: "call.settled",
        data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message: text }, outcome: "failed" },
        scope: scopeOf(context),
      });
      return textResult(text, true);
    }
  } finally {
    context.onCallEnd();
  }
}

type ConfigGate = "jev" | "human" | "none";

interface ConfigChange {
  body: Record<string, unknown>;
  summary: string;
}

async function runConfigTool(
  context: ToolContext,
  name: string,
  label: string,
  input: Record<string, unknown>,
  gate: ConfigGate,
  prompt: string,
  build: (bot: BotDefinition) => ConfigChange,
) {
  const callId = newCallId();
  const log = context.log;
  context.onCallStart();
  try {
    log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name, label },
        input,
        owner: owner(context),
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope: scopeOf(context),
    });
    const current = getBot(context.bot.id);
    if (!current) return textResult("Esse bot não existe mais.", true);
    let change: ConfigChange;
    try {
      change = build(current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.emit({
        type: "call.settled",
        data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message }, outcome: "failed" },
        scope: scopeOf(context),
      });
      return textResult(message, true);
    }
    const reject = (interactionId: string | null, text: string) => {
      log.emit({
        type: "call.settled",
        data: {
          callId,
          ...(interactionId ? { cause: { interactionId } } : {}),
          error: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." },
          outcome: "rejected",
        },
        scope: scopeOf(context),
      });
      return textResult(text, true);
    };
    let cleared: Record<string, unknown> | null = null;
    if (gate !== "none" && context.permission !== "full") {
      let needsHuman = true;
      if (gate === "jev") {
        const decision = await decideApproval(await approvalState(context, name, input), context.decisions, callId);
        context.emitDecision(decision);
        if (decision.outcome === "auto_approved") {
          needsHuman = false;
          cleared = { decision: "jev", model: decision.model };
        }
      } else {
        context.emitDecision({
          kind: "approval",
          question: "Esta ação do bot é segura para rodar sem uma pessoa confirmar?",
          answer: null,
          confidence: null,
          threshold: context.decisions.threshold,
          outcome: "human",
          latencyMs: 0,
          model: null,
          reason: "Pedido de capacidade sempre passa por uma pessoa.",
          tool: name,
          callId,
        });
      }
      if (needsHuman) {
        if (context.isSchedule) return reject(null, "Ninguém está aqui para aprovar mudanças agora.");
        const { choice, interactionId } = await context.requestApproval(prompt, callId, context.origin);
        if (choice !== "approve") return reject(interactionId, "A pessoa negou essa mudança.");
        cleared = { interactionId };
      }
    }
    log.emit({
      type: "call.started",
      data: { callId, ...(cleared ? { clearedBy: cleared } : {}) },
      scope: scopeOf(context),
    });
    try {
      const updated = await updateBot(current.id, change.body);
      log.emit({
        type: "bot.updated",
        data: { botId: current.id, by: "bot", fields: Object.keys(change.body), summary: change.summary, callId },
        scope: { turnId: context.turnId },
      });
      const output = {
        ok: true,
        summary: change.summary,
        role: updated?.role,
        schedules: updated?.schedules.map((item) => item.name),
        capabilities: updated?.capabilities,
      };
      log.emit({ type: "call.settled", data: { callId, outcome: "completed", output }, scope: scopeOf(context) });
      context.onCallSettled(`${name}(${brief(input, 120)}) → ${change.summary}`);
      return textResult(`${change.summary} Vale a partir da próxima mensagem.`);
    } catch (error) {
      const message =
        error instanceof ValidationError
          ? `${error.message} (${error.field})`
          : error instanceof Error
            ? error.message
            : String(error);
      log.emit({
        type: "call.settled",
        data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message }, outcome: "failed" },
        scope: scopeOf(context),
      });
      return textResult(message, true);
    }
  } finally {
    context.onCallEnd();
  }
}

interface RemoteSpec {
  name: string;
  capability: string;
  label: string;
  input: Record<string, unknown>;
  kind: ToolKind | "free";
  prompt: string;
  connector?: string;
  alwaysHuman?: boolean;
}

function clipOutput(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= 20_000) return value;
  return `${text.slice(0, 20_000)}… (cortado)`;
}

async function runRemote(context: ToolContext, spec: RemoteSpec, work: () => Promise<unknown>) {
  const callId = newCallId();
  const log = context.log;
  context.onCallStart();
  try {
    log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: {
          kind: "tool",
          name: spec.capability,
          label: spec.label,
          ...(spec.connector ? { connector: spec.connector } : {}),
        },
        input: spec.input,
        owner: owner(context),
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope: scopeOf(context),
    });
    const reject = (interactionId: string | null, text: string) => {
      log.emit({
        type: "call.settled",
        data: {
          callId,
          ...(interactionId ? { cause: { interactionId } } : {}),
          error: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." },
          outcome: "rejected",
        },
        scope: scopeOf(context),
      });
      return textResult(text, true);
    };
    const mode = context.permission ?? "default";
    const permitted = remotePermission(mode, spec.kind);
    const verdict = spec.alwaysHuman && permitted !== "deny" ? "card" : permitted;
    if (verdict === "deny") {
      context.emitDecision({
        kind: "approval",
        question: "Esta ação do bot é segura para rodar sem uma pessoa confirmar?",
        answer: null,
        confidence: null,
        threshold: context.decisions.threshold,
        outcome: "blocked",
        latencyMs: 0,
        model: null,
        reason: "Modo Somente leitura.",
        tool: spec.capability,
        callId,
      });
      return reject(null, readonlyRemoteMessage);
    }
    const needsHuman = verdict === "card";
    if (needsHuman) {
      context.emitDecision({
        kind: "approval",
        question: "Esta ação do bot é segura para rodar sem uma pessoa confirmar?",
        answer: null,
        confidence: null,
        threshold: context.decisions.threshold,
        outcome: "human",
        latencyMs: 0,
        model: null,
        reason:
          spec.kind === "outbound" || spec.alwaysHuman
            ? "Lista dura (mensagem para fora, dinheiro, deploy, merge, apagar ou banco): sempre passa por uma pessoa."
            : "Modo Editar: escrita em conector pede sua confirmação.",
        tool: spec.capability,
        callId,
      });
    }
    let cleared: Record<string, unknown> | null = null;
    if (needsHuman) {
      if (context.isSchedule) return reject(null, "Ninguém está aqui para aprovar essa ação agora.");
      const { choice, interactionId } = await context.requestApproval(spec.prompt, callId, context.origin);
      if (choice !== "approve") return reject(interactionId, "A pessoa negou essa ação.");
      cleared = { interactionId };
    }
    if (!cleared && mode === "full" && spec.kind === "outbound" && !spec.alwaysHuman) cleared = { permission: mode };
    log.emit({
      type: "call.started",
      data: { callId, ...(cleared ? { clearedBy: cleared } : {}) },
      scope: scopeOf(context),
    });
    try {
      const output = clipOutput(await work());
      log.emit({ type: "call.settled", data: { callId, outcome: "completed", output }, scope: scopeOf(context) });
      context.onCallSettled(`${spec.capability}(${brief(spec.input, 120)}) → ${brief(output)}`);
      return textResult(output);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      log.emit({
        type: "call.settled",
        data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message }, outcome: "failed" },
        scope: scopeOf(context),
      });
      context.onCallSettled(`${spec.capability}(${brief(spec.input, 120)}) → erro: ${brief(message)}`);
      return textResult(message, true);
    }
  } finally {
    context.onCallEnd();
  }
}

interface ComputerSpec {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  act: boolean;
  label: (args: Record<string, unknown>) => string;
  prompt?: (args: Record<string, unknown>) => string;
}

const point = { x: z.number().optional(), y: z.number().optional(), elementId: z.string().optional() };
const reasonField = z
  .string()
  .max(160)
  .optional()
  .describe("Uma frase curta, em português, dizendo à pessoa por que você quer fazer isso");

interface UiTreeCache {
  app: string;
  bundleId?: string;
  nodes: Map<string, Record<string, unknown>>;
}

const uiTrees = new Map<string, UiTreeCache>();

function rememberUiTree(botId: string, tree: Record<string, unknown> | null) {
  if (!tree) return;
  const nodes = new Map<string, Record<string, unknown>>();
  const walk = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const node = item as Record<string, unknown>;
      if (typeof node.id === "string") nodes.set(node.id, node);
      walk(node.children);
    }
  };
  walk(tree.windows);
  uiTrees.set(botId, {
    app: String(tree.app ?? ""),
    ...(typeof tree.bundleId === "string" ? { bundleId: tree.bundleId } : {}),
    nodes,
  });
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function computerDetails(botId: string, args: Record<string, unknown>): ApprovalDetails {
  const reason = String(args.reason ?? "").trim();
  const base = reason ? { reason } : {};
  if (typeof args.url === "string" && args.url)
    return { ...base, target: { label: hostLabel(args.url), role: "page", url: args.url } };
  if (typeof args.app === "string" && args.app)
    return { ...base, target: { label: args.app, role: "app", app: args.app } };
  if (typeof args.elementId === "string") {
    const tree = uiTrees.get(botId);
    const node = tree?.nodes.get(args.elementId);
    if (tree && node) {
      const label = [node.title, node.description, node.placeholder, node.value].find(
        (item) => typeof item === "string" && item.trim(),
      ) as string | undefined;
      const target: ApprovalTarget = {
        label: label?.trim() ?? "",
        role: String(node.role ?? ""),
        app: tree.app,
        ...(tree.bundleId ? { bundleId: tree.bundleId } : {}),
      };
      return { ...base, target };
    }
  }
  const tree = uiTrees.get(botId);
  return tree?.app
    ? {
        ...base,
        target: { label: "", role: "app", app: tree.app, ...(tree.bundleId ? { bundleId: tree.bundleId } : {}) },
      }
    : base;
}

const computerSpecs: ComputerSpec[] = [
  {
    name: "computer_screenshot",
    description: "Print da tela do Mac (reduzido). Prefira computer_ui_tree para achar elementos.",
    shape: {
      display: z.number().int().optional(),
      region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    },
    act: false,
    label: () => "Print do Mac",
  },
  {
    name: "computer_ui_tree",
    description: "Árvore de acessibilidade do app (role, title, value, frame, id). Use os ids em computer_click.",
    shape: { app: z.string().optional() },
    act: false,
    label: (a) => `Ler a tela${a.app ? ` do ${String(a.app)}` : ""}`,
  },
  {
    name: "computer_apps",
    description: "Apps abertos e o app em primeiro plano.",
    shape: {},
    act: false,
    label: () => "Listar apps",
  },
  { name: "computer_windows", description: "Janelas abertas.", shape: {}, act: false, label: () => "Listar janelas" },
  {
    name: "computer_click",
    description: "Clica num elemento (elementId do ui_tree, preferido) ou num ponto x,y.",
    shape: {
      ...point,
      button: z.enum(["left", "right"]).optional(),
      double: z.boolean().optional(),
      reason: reasonField,
    },
    act: true,
    label: () => "Clicar num ponto da tela",
  },
  {
    name: "computer_type",
    description: "Digita texto onde estiver o foco.",
    shape: { text: z.string().min(1).max(4000), reason: reasonField },
    act: true,
    label: (a) => `Digitar "${String(a.text).slice(0, 40)}"`,
    prompt: (a) => `Posso digitar no seu Mac: "${String(a.text).slice(0, 120)}"?`,
  },
  {
    name: "computer_key",
    description: "Aperta tecla ou atalho (ex.: cmd+l, return).",
    shape: { combo: z.string().min(1).max(60), reason: reasonField },
    act: true,
    label: (a) => `Tecla ${String(a.combo)}`,
  },
  {
    name: "computer_scroll",
    description: "Rola a tela.",
    shape: { ...point, deltaX: z.number().optional(), deltaY: z.number() },
    act: true,
    label: () => "Rolar",
  },
  {
    name: "computer_drag",
    description: "Arrasta de um ponto a outro.",
    shape: { fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number() },
    act: true,
    label: () => "Arrastar",
  },
  {
    name: "computer_open",
    description: "Abre um app, uma URL ou um arquivo.",
    shape: { app: z.string().optional(), url: z.string().optional(), path: z.string().optional(), reason: reasonField },
    act: true,
    label: (a) => `Abrir ${String(a.url ?? a.app ?? a.path ?? "")}`,
  },
  {
    name: "computer_applescript",
    description: "Roda um AppleScript (Mail, Finder, Safari). Prefira isso a cliques quando der.",
    shape: { script: z.string().min(1).max(8000) },
    act: true,
    label: () => "Rodar AppleScript",
    prompt: (a) => `Posso rodar este AppleScript no seu Mac?\n${String(a.script).slice(0, 300)}`,
  },
  {
    name: "files_list",
    description: "Lista uma pasta dentro das pastas permitidas.",
    shape: { path: z.string() },
    act: false,
    label: (a) => `Listar ${String(a.path)}`,
  },
  {
    name: "files_read",
    description: "Lê um arquivo de texto pequeno dentro das pastas permitidas.",
    shape: { path: z.string() },
    act: false,
    label: (a) => `Ler ${String(a.path)}`,
  },
  {
    name: "files_move",
    description: "Move um arquivo ou pasta.",
    shape: { from: z.string(), to: z.string() },
    act: true,
    label: (a) => `Mover ${String(a.from)}`,
  },
  {
    name: "files_rename",
    description: "Renomeia um arquivo ou pasta.",
    shape: { path: z.string(), name: z.string() },
    act: true,
    label: (a) => `Renomear ${String(a.path)}`,
  },
  {
    name: "files_mkdir",
    description: "Cria uma pasta.",
    shape: { path: z.string() },
    act: true,
    label: (a) => `Criar pasta ${String(a.path)}`,
  },
  {
    name: "files_trash",
    description: "Manda itens para a Lixeira (nunca apaga de vez).",
    shape: { paths: z.array(z.string()).min(1) },
    act: true,
    label: (a) => `Lixeira (${(a.paths as unknown[]).length} itens)`,
  },
  {
    name: "files_write",
    description: "Escreve um arquivo de texto (só dentro de ~/runelay-bots-workspace).",
    shape: { path: z.string(), content: z.string().max(200_000) },
    act: true,
    label: (a) => `Escrever ${String(a.path)}`,
  },
  {
    name: "shell_run",
    description:
      "Roda um comando com cwd dentro de ~/runelay-bots-workspace (npm, pnpm, bun, node, swift, xcodebuild, git local, ls, cat, mkdir).",
    shape: { cmd: z.string().min(1).max(2000), cwd: z.string() },
    act: true,
    label: (a) => `$ ${String(a.cmd).slice(0, 60)}`,
    prompt: (a) => `Posso rodar no seu Mac: ${String(a.cmd).slice(0, 200)}?`,
  },
  {
    name: "record_start",
    description: "Começa a gravar a tela (vai para ~/Movies/runelay bots).",
    shape: {
      display: z.number().int().optional(),
      window: z.string().optional(),
      region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    },
    act: true,
    label: () => "Gravar a tela",
  },
  {
    name: "record_stop",
    description: "Para a gravação e devolve o caminho do vídeo.",
    shape: {},
    act: true,
    label: () => "Parar gravação",
  },
  {
    name: "record_status",
    description: "Diz se está gravando.",
    shape: {},
    act: false,
    label: () => "Status da gravação",
  },
];

async function runComputerTool(context: ToolContext, spec: ComputerSpec, input: Record<string, unknown>) {
  const { reason: _reason, ...args } = input;
  const details = spec.act ? computerDetails(context.bot.id, input) : undefined;
  const element = spec.name === "computer_click" ? details?.target?.label : undefined;
  const label = element ? `Clicar em “${element}”` : spec.label(args);
  const callId = newCallId();
  const log = context.log;
  context.onCallStart();
  const computerContext = {
    botId: context.bot.id,
    botName: context.bot.name,
    sessionId: context.sessionId,
    allowedRoots: context.bot.computer?.allowedRoots ?? defaultRoots,
  };
  try {
    log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name: spec.name, label, surface: "computer" },
        input: args,
        owner: owner(context),
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope: scopeOf(context),
    });
    let cleared: Record<string, unknown> | null = null;
    if (spec.act && computerTypeSecretsOnly(spec.name, args)) {
      cleared = { vault: true };
    } else if (spec.act && context.permission === "full") {
      cleared = { permission: "full" };
    } else if (spec.act) {
      const hard = computerHumanReason(spec.name, args);
      let needsHuman = true;
      if (hard) {
        context.emitDecision({
          kind: "approval",
          question: "Esta ação do bot é segura para rodar sem uma pessoa confirmar?",
          answer: null,
          confidence: null,
          threshold: context.decisions.threshold,
          outcome: "human",
          latencyMs: 0,
          model: null,
          reason: hard,
          tool: spec.name,
          callId,
        });
      } else {
        const decision = await decideApproval(await approvalState(context, spec.name, args), context.decisions, callId);
        context.emitDecision(decision);
        if (decision.outcome === "auto_approved") {
          needsHuman = false;
          cleared = { decision: "jev", model: decision.model };
        }
      }
      if (needsHuman) {
        const reject = (interactionId: string | null) => {
          log.emit({
            type: "call.settled",
            data: {
              callId,
              ...(interactionId ? { cause: { interactionId } } : {}),
              error: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." },
              outcome: "rejected",
            },
            scope: scopeOf(context),
          });
          return textResult("A pessoa negou essa ação no computador.", true);
        };
        if (context.isSchedule) return reject(null);
        const { choice, interactionId } = await context.requestApproval(
          spec.prompt?.(args) ??
            `Posso ${label.charAt(0).toLowerCase()}${label.slice(1)}${spec.name === "computer_click" && !element ? "" : " no seu Mac"}?`,
          callId,
          context.origin,
          details,
        );
        if (choice !== "approve") return reject(interactionId);
        cleared = { interactionId };
      }
    }
    log.emit({
      type: "call.started",
      data: { callId, ...(cleared ? { clearedBy: cleared } : {}) },
      scope: scopeOf(context),
    });
    try {
      const result = (await callComputer(spec.name, args, computerContext, context.signal)) as Record<
        string,
        unknown
      > | null;
      if (spec.name === "computer_ui_tree") rememberUiTree(context.bot.id, result);
      if (spec.act) {
        log.emit({
          type: "computer.action",
          data: {
            tool: spec.name,
            summary: label,
            ...(result && typeof result.screenshotPath === "string" ? { screenshotPath: result.screenshotPath } : {}),
            callId,
          },
          scope: { turnId: context.turnId },
        });
      }
      if (result && typeof result.imageBase64 === "string") {
        const { imageBase64, mimeType, ...meta } = result;
        log.emit({
          type: "call.settled",
          data: { callId, outcome: "completed", output: meta },
          scope: scopeOf(context),
        });
        context.onCallSettled(`${spec.name}() → print`);
        const content: Array<{ type: "image"; data: string; mimeType: string } | { type: "text"; text: string }> = [
          { type: "image", data: imageBase64, mimeType: String(mimeType ?? "image/png") },
          { type: "text", text: JSON.stringify(meta) },
        ];
        if (context.provider !== "claude") {
          const tree = await callComputer("computer_ui_tree", {}, computerContext, context.signal).catch(() => null);
          if (tree) content.push({ type: "text", text: `ui_tree: ${JSON.stringify(tree).slice(0, 15_000)}` });
        }
        return { content };
      }
      log.emit({
        type: "call.settled",
        data: { callId, outcome: "completed", output: clipOutput(result) },
        scope: scopeOf(context),
      });
      context.onCallSettled(`${spec.name}(${brief(args, 120)}) → ${brief(result)}`);
      return textResult(clipOutput(result));
    } catch (error) {
      const code = error instanceof ComputerError ? error.code : "TOOL_EXECUTION_FAILED";
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      log.emit({
        type: "call.settled",
        data: { callId, error: { code, message }, outcome: "failed" },
        scope: scopeOf(context),
      });
      if (code === "user_took_over" || code === "stopped")
        context.cancelTurn(code === "stopped" ? "A pessoa apertou Parar." : "Você assumiu o computador.");
      return textResult(code === "COMPUTER_UNAVAILABLE" ? `COMPUTER_UNAVAILABLE: ${message}` : message, true);
    }
  } finally {
    context.onCallEnd();
  }
}

function registerComputerTools(server: McpServer, context: ToolContext) {
  if (!context.bot.capabilities.computer) return;
  for (const spec of computerSpecs) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.shape },
      (args: Record<string, unknown>) => runComputerTool(context, spec, args ?? {}),
    );
  }
}

function registerConnectorTools(server: McpServer, context: ToolContext) {
  if (!runelayEnabled()) return;
  const settings = connectorsOf(context.bot);
  if (settings.allowed.length > 0) {
    server.registerTool(
      "connector_search",
      {
        description: `Procura ferramentas nos serviços conectados que você pode usar (${settings.allowed.join(", ")}). Devolve nomes no formato conexao.ferramenta e o formato dos argumentos.`,
        inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(15).optional() },
      },
      (args: Record<string, unknown>) =>
        runRemote(
          context,
          {
            name: "connector_search",
            capability: "connector_search",
            label: `Procurar ferramentas: ${String(args.query)}`,
            input: args,
            kind: "read",
            prompt: "",
          },
          () => searchTools(String(args.query), settings.allowed, Number(args.limit ?? 8)),
        ),
    );
    server.registerTool(
      "connector_call",
      {
        description:
          "Chama uma ferramenta de um serviço conectado pelo nome completo (conexao.ferramenta, como devolvido por connector_search). Leitura e escrita comum (criar ou atualizar issue, documento, label, comentário interno) rodam direto, sem pedir. Só mensagem para pessoas de fora, dinheiro, deploy, merge, apagar dados e escrita em banco pedem aprovação.",
        inputSchema: { tool: z.string().min(3), args: z.record(z.string(), z.unknown()).optional() },
      },
      async (args: Record<string, unknown>) => {
        const tool = String(args.tool);
        const connection = tool.split(".")[0];
        const toolArgs = (args.args ?? {}) as Record<string, unknown>;
        if (!settings.allowed.includes(connection)) {
          return textResult(`A conexão ${connection} não está liberada para você. Peça com request_connector.`, true);
        }
        const kind = classifyTool(tool, toolArgs);
        const connections = await listConnections().catch(() => []);
        const label = connections.find((item) => item.name === connection)?.label ?? connection;
        const short = tool.slice(connection.length + 1);
        return runRemote(
          context,
          {
            name: "connector_call",
            capability: `connector:${tool}`,
            label: `${label}: ${short}`,
            input: toolArgs,
            kind,
            connector: connection,
            alwaysHuman: kind !== "read" && touchesDatabase(tool),
            prompt: `Posso rodar ${label} ${short}? ${brief(toolArgs, 160)}`,
          },
          () => runelayCall("call_tool", { name: tool, args: toolArgs }),
        );
      },
    );
  }
  if (settings.memory) {
    server.registerTool(
      "memory_search",
      {
        description: "Procura nas memórias e skills da pessoa (runelay).",
        inputSchema: { query: z.string().min(1).max(300), kind: z.enum(["memory", "skill"]).optional() },
      },
      (args: Record<string, unknown>) =>
        runRemote(
          context,
          {
            name: "memory_search",
            capability: "memory_search",
            label: `Memória: ${String(args.query)}`,
            input: args,
            kind: "read",
            prompt: "",
          },
          () =>
            runelayCall("search_context", {
              query: String(args.query),
              ...(args.kind ? { kind: args.kind } : {}),
              limit: 8,
            }),
        ),
    );
    server.registerTool(
      "memory_read",
      { description: "Lê uma memória da pessoa pelo slug.", inputSchema: { slug: z.string().min(1).max(120) } },
      (args: Record<string, unknown>) =>
        runRemote(
          context,
          {
            name: "memory_read",
            capability: "memory_read",
            label: `Ler memória ${String(args.slug)}`,
            input: args,
            kind: "read",
            prompt: "",
          },
          () => runelayCall("read_memory", { slug: String(args.slug) }),
        ),
    );
    server.registerTool(
      "skill_read",
      {
        description: "Lê uma skill da pessoa pelo slug (e um arquivo dela, se path for dado).",
        inputSchema: { slug: z.string().min(1).max(120), path: z.string().optional() },
      },
      (args: Record<string, unknown>) =>
        runRemote(
          context,
          {
            name: "skill_read",
            capability: "skill_read",
            label: `Ler skill ${String(args.slug)}`,
            input: args,
            kind: "read",
            prompt: "",
          },
          () =>
            args.path
              ? runelayCall("read_skill_file", { slug: String(args.slug), path: String(args.path) })
              : runelayCall("read_skill", { slug: String(args.slug) }),
        ),
    );
    server.registerTool(
      "memory_write",
      {
        description:
          "Cria ou atualiza uma memória da pessoa (runelay). Não pede aprovação: salve direto sempre que aprender algo durável.",
        inputSchema: {
          slug: z.string().min(1).max(120),
          body: z.string().min(1).max(100_000),
          name: z.string().max(200).optional(),
          description: z.string().max(400).optional(),
        },
      },
      (args: Record<string, unknown>) =>
        runRemote(
          context,
          {
            name: "memory_write",
            capability: "memory_write",
            label: `Salvar memória ${String(args.slug)}`,
            input: { slug: args.slug, name: args.name, description: args.description },
            kind: "free",
            prompt: `Posso salvar a memória "${String(args.slug)}"? ${brief(args.body, 160)}`,
          },
          () => runelayCall("write_memory", args),
        ),
    );
  }
}

function resolveBotIds(refs: string[]) {
  const bots = listBots();
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  return refs.map((ref) => {
    const key = normalize(ref);
    const found =
      bots.find((bot) => bot.id === ref || normalize(bot.name) === key) ??
      bots.find((bot) => normalize(bot.name).includes(key) || bot.id.includes(key));
    if (!found) throw new Error(`Não achei o bot "${ref}".`);
    return found.id;
  });
}

function resolveGroup(ref: string) {
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  const key = normalize(ref);
  const groups = listGroups();
  const found =
    groups.find((group) => group.id === ref || normalize(group.name) === key) ??
    groups.find((group) => normalize(group.name).includes(key));
  if (!found) throw new Error(`Não achei o grupo "${ref}".`);
  return found;
}

async function runDirectTool(
  context: ToolContext,
  name: string,
  label: string,
  input: Record<string, unknown>,
  work: () => Promise<string>,
) {
  const callId = newCallId();
  const log = context.log;
  context.onCallStart();
  try {
    log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name, label },
        input,
        owner: owner(context),
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope: scopeOf(context),
    });
    log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
    const summary = await work();
    log.emit({
      type: "call.settled",
      data: { callId, outcome: "completed", output: summary },
      scope: scopeOf(context),
    });
    context.onCallSettled(`${name} → ${summary}`);
    return textResult(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.emit({
      type: "call.settled",
      data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message }, outcome: "failed" },
      scope: scopeOf(context),
    });
    return textResult(message, true);
  } finally {
    context.onCallEnd();
  }
}

function registerConfigTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "update_group",
    {
      description:
        "Edita um grupo existente: adiciona ou remove bots, ou renomeia. Use isto para 'adicionar/colocar fulano no grupo'; nunca crie um grupo novo para isso. Não pede aprovação.",
      inputSchema: {
        group: z.string().min(1).describe("Nome ou id do grupo"),
        add: z.array(z.string()).optional().describe("Bots para adicionar (nome ou id)"),
        remove: z.array(z.string()).optional().describe("Bots para tirar (nome ou id)"),
        name: z.string().min(1).max(60).optional(),
      },
    },
    (args: Record<string, unknown>) =>
      runDirectTool(context, "update_group", `Editar o grupo ${String(args.group)}`, args, async () => {
        const group = resolveGroup(String(args.group));
        const add = resolveBotIds((args.add as string[] | undefined) ?? []);
        const remove = new Set(resolveBotIds((args.remove as string[] | undefined) ?? []));
        const members = [...new Set([...group.members, ...add])].filter((id) => !remove.has(id));
        const updated = await updateGroup(group.id, { members, ...(args.name ? { name: String(args.name) } : {}) });
        return `Grupo ${updated?.name ?? group.name} agora tem ${members.length} bots.`;
      }),
  );
  server.registerTool(
    "archive_group",
    {
      description: "Arquiva um grupo (some da lista, dá para restaurar). Não pede aprovação.",
      inputSchema: { group: z.string().min(1).describe("Nome ou id do grupo") },
    },
    (args: Record<string, unknown>) =>
      runDirectTool(context, "archive_group", `Arquivar o grupo ${String(args.group)}`, args, async () => {
        const group = resolveGroup(String(args.group));
        await setGroupArchived(group.id, true);
        return `Arquivei o grupo ${group.name}.`;
      }),
  );
  server.registerTool(
    "create_group",
    {
      description:
        "Cria um grupo de conversa no próprio runelay bots com outros bots (pelo nome ou id). Use isto quando a pessoa pedir um grupo; nunca use o computador para isso. Não pede aprovação.",
      inputSchema: {
        name: z.string().min(1).max(60),
        members: z.array(z.string().min(1)).min(1).describe("Nomes ou ids dos bots do grupo"),
      },
    },
    async (args: Record<string, unknown>) => {
      const callId = newCallId();
      const log = context.log;
      const name = String(args.name);
      context.onCallStart();
      try {
        log.emit({
          type: "call.requested",
          data: {
            callId,
            capability: { kind: "tool", name: "create_group", label: `Criar o grupo ${name}` },
            input: args,
            owner: owner(context),
            ...(context.origin ? { origin: { agent: context.origin } } : {}),
          },
          scope: scopeOf(context),
        });
        log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
        const bots = listBots();
        const normalize = (value: string) =>
          value
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();
        const members = (args.members as string[]).map((ref) => {
          const key = normalize(ref);
          const found =
            bots.find((bot) => bot.id === ref || normalize(bot.name) === key) ??
            bots.find((bot) => normalize(bot.name).includes(key) || bot.id.includes(key));
          if (!found) throw new Error(`Não achei o bot "${ref}".`);
          return found.id;
        });
        const group = await createGroup({ name, members: [...new Set(members)] });
        const summary = `Criei o grupo ${group.name} com ${members.length} bots.`;
        log.emit({
          type: "call.settled",
          data: { callId, outcome: "completed", output: summary },
          scope: scopeOf(context),
        });
        context.onCallSettled(`create_group(${name}) → ${group.id}`);
        return textResult(summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.emit({
          type: "call.settled",
          data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message }, outcome: "failed" },
          scope: scopeOf(context),
        });
        return textResult(message, true);
      } finally {
        context.onCallEnd();
      }
    },
  );
  server.registerTool(
    "create_bot",
    {
      description:
        "Cria um bot novo no time, com nome, papel curto e instruções. Use quando a pessoa pedir um bot novo. Não pede aprovação. Ele já nasce com acesso a tudo.",
      inputSchema: {
        name: z.string().min(1).max(40),
        role: z.string().max(60).optional(),
        instructions: z
          .string()
          .max(20_000)
          .describe("Instruções permanentes em markdown: quem é, o que faz, como trabalha"),
        accent: z.enum(["amber", "red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"]).optional(),
      },
    },
    async (args: Record<string, unknown>) => {
      const callId = newCallId();
      const log = context.log;
      const name = String(args.name);
      context.onCallStart();
      try {
        log.emit({
          type: "call.requested",
          data: {
            callId,
            capability: { kind: "tool", name: "create_bot", label: `Criar o bot ${name}` },
            input: args,
            owner: owner(context),
            ...(context.origin ? { origin: { agent: context.origin } } : {}),
          },
          scope: scopeOf(context),
        });
        log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
        const body: Record<string, unknown> = { name, instructions: String(args.instructions ?? "") };
        if (args.role) body.role = String(args.role);
        if (args.accent) body.accent = String(args.accent);
        const bot = await createBot(body);
        const summary = `Criei o bot ${bot.name} (${bot.id}).`;
        log.emit({
          type: "call.settled",
          data: { callId, outcome: "completed", output: summary },
          scope: scopeOf(context),
        });
        context.onCallSettled(`create_bot(${name}) → ${bot.id}`);
        return textResult(summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.emit({
          type: "call.settled",
          data: { callId, error: { code: "TOOL_EXECUTION_FAILED", message }, outcome: "failed" },
          scope: scopeOf(context),
        });
        return textResult(message, true);
      } finally {
        context.onCallEnd();
      }
    },
  );
  server.registerTool(
    "set_role",
    {
      description: "Define o seu papel em poucas palavras (até 60 caracteres), como aparece no app.",
      inputSchema: { text: z.string().min(1).max(60) },
    },
    (args: Record<string, unknown>) =>
      runConfigTool(context, "set_role", `Mudar papel para "${String(args.text)}"`, args, "none", "", (bot) => ({
        body: { role: String(args.text) },
        summary: `Papel: "${bot.role}" → "${String(args.text)}".`,
      })),
  );
  server.registerTool(
    "update_instructions",
    {
      description:
        "Atualiza as suas instruções permanentes (markdown). mode append acrescenta ao fim; replace substitui tudo.",
      inputSchema: { markdown: z.string().min(1), mode: z.enum(["append", "replace"]).default("append") },
    },
    (args: Record<string, unknown>) =>
      runConfigTool(
        context,
        "update_instructions",
        args.mode === "replace" ? "Substituir instruções" : "Acrescentar às instruções",
        args,
        "none",
        "",
        (bot) => {
          const markdown = String(args.markdown).trim();
          const next = args.mode === "replace" ? markdown : `${bot.instructions.trim()}\n\n${markdown}`.trim();
          return {
            body: { instructions: next },
            summary: `Instruções ${args.mode === "replace" ? "substituídas" : "ampliadas"} (${bot.instructions.length} → ${next.length} caracteres).`,
          };
        },
      ),
  );
  server.registerTool(
    "add_schedule",
    {
      description:
        'Cria uma rotina recorrente. Converta o pedido da pessoa em cron de 5 campos (minuto hora dia mês dia-da-semana), por exemplo dias úteis às 9h = "0 9 * * 1-5". prompt é o que você vai fazer a cada execução. Crie direto quando a pessoa pedir; o servidor só abre card se o modo da conversa exigir.',
      inputSchema: {
        name: z.string().min(1).max(40),
        cron: z.string().min(1),
        timezone: z.string().default("America/Sao_Paulo"),
        prompt: z.string().min(1),
        description: z.string().max(200).optional(),
      },
    },
    (args: Record<string, unknown>) =>
      runConfigTool(
        context,
        "add_schedule",
        `Criar rotina ${String(args.name)} (${String(args.cron)})`,
        args,
        "jev",
        `Posso criar a rotina "${String(args.name)}" (${String(args.cron)}, ${String(args.timezone ?? "America/Sao_Paulo")})? Ela roda sozinha e gasta sua assinatura.`,
        (bot) => {
          const schedule = {
            name: String(args.name),
            cron: String(args.cron),
            timezone: String(args.timezone ?? "America/Sao_Paulo"),
            prompt: String(args.prompt),
            description: String(args.description ?? ""),
          };
          const others = bot.schedules.filter((item) => item.name !== schedule.name);
          return {
            body: { schedules: [...others, schedule] },
            summary: `Rotina "${schedule.name}" criada: ${schedule.cron} (${schedule.timezone}).`,
          };
        },
      ),
  );
  server.registerTool(
    "remove_schedule",
    {
      description: "Remove uma rotina sua pelo nome. O servidor só abre card se o modo da conversa exigir.",
      inputSchema: { name: z.string().min(1) },
    },
    (args: Record<string, unknown>) =>
      runConfigTool(
        context,
        "remove_schedule",
        `Remover rotina ${String(args.name)}`,
        args,
        "jev",
        `Posso remover a rotina "${String(args.name)}"?`,
        (bot) => {
          if (!bot.schedules.some((item) => item.name === String(args.name)))
            throw new Error(`Não existe rotina "${String(args.name)}".`);
          return {
            body: { schedules: bot.schedules.filter((item) => item.name !== String(args.name)) },
            summary: `Rotina "${String(args.name)}" removida.`,
          };
        },
      ),
  );
  server.registerTool(
    "request_connector",
    {
      description:
        "Pede acesso a um serviço conectado no runelay da pessoa (ex.: linear_server, github). Sempre pede aprovação.",
      inputSchema: { name: z.string().min(1).max(60), reason: z.string().min(1).max(300) },
    },
    (args: Record<string, unknown>) => {
      const connection = String(args.name);
      return runConfigTool(
        context,
        "request_connector",
        `Pedir acesso a ${connection}`,
        args,
        "human",
        `Posso ganhar acesso a ${connection}? Motivo: ${String(args.reason)}`,
        (bot) => {
          const current = connectorsOf(bot);
          if (current.allowed.includes(connection)) throw new Error(`Já tenho acesso a ${connection}.`);
          return {
            body: { connectors: { allowed: [...current.allowed, connection] } },
            summary: `Conexão ${connection} liberada.`,
          };
        },
      );
    },
  );
  server.registerTool(
    "request_capability",
    {
      description:
        "Pede uma capacidade nova à pessoa: browser (navegador). Consulta em banco vai pelo conector Supabase (connector_call). Sempre pede aprovação.",
      inputSchema: { name: z.enum(["browser"]), reason: z.string().min(1).max(300) },
    },
    (args: Record<string, unknown>) => {
      const capability = String(args.name);
      const label = "navegador";
      return runConfigTool(
        context,
        "request_capability",
        `Pedir ${label}`,
        args,
        "human",
        `Posso ganhar acesso a ${label}? Motivo: ${String(args.reason)}`,
        (bot) => {
          if (bot.capabilities[capability as "browser"]) throw new Error(`Já tenho ${label}.`);
          return { body: { capabilities: { [capability]: true } }, summary: `Capacidade ${label} liberada.` };
        },
      );
    },
  );
}

export function buildServer(context: ToolContext) {
  const server = new McpServer({ name: "runelay-bots", version: "3.0.0" });
  registerConfigTools(server, context);
  registerConnectorTools(server, context);
  registerComputerTools(server, context);
  registerCodeTools(server, context, () => context.runner ?? "vps");
  registerVaultTools(server, context);
  registerServerTools(server, context);
  registerThreadTools(server, context);
  registerQuestionTools(server, context);
  if (context.groupMembers.length > 0) {
    const ids = context.groupMembers.map((member) => member.id) as [string, ...string[]];
    server.registerTool(
      "handoff",
      {
        description: `Passa a vez no grupo para outro bot responder logo depois de você. Bots: ${context.groupMembers.map((member) => `${member.id} (${member.name}, ${member.role})`).join("; ")}.`,
        inputSchema: { bot: z.enum(ids), note: z.string().min(1).max(500) },
      },
      async (args: Record<string, unknown>) => {
        const target = context.groupMembers.find((member) => member.id === String(args.bot));
        context.onHandoff(String(args.bot), String(args.note));
        context.log.emit({
          type: "handoff.requested",
          data: { from: context.botId, to: String(args.bot), note: String(args.note) },
          scope: { turnId: context.turnId },
        });
        return textResult(`Ok, ${target?.name ?? args.bot} responde em seguida.`);
      },
    );
  }
  for (const tool of context.tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape },
      (args: Record<string, unknown>) => runTool(context, tool, args ?? {}),
    );
  }
  if (context.delegates.length > 0) {
    const ids = context.delegates.map((item) => item.id) as [string, ...string[]];
    const roster = context.delegates.map((item) => `${item.id} (${item.name}, ${item.role})`).join("; ");
    server.registerTool(
      "delegate",
      {
        description: `Passa uma tarefa para outro bot do time e devolve o relatório dele. O bot só vê a mensagem que você mandar, então mande o pedido completo. Bots: ${roster}.`,
        inputSchema: { bot: z.enum(ids), message: z.string().min(1) },
      },
      (args: Record<string, unknown>) => runDelegate(context, String(args.bot), String(args.message)),
    );
  }
  return server;
}

export function findToolContext(token: string) {
  return contexts.get(token);
}
