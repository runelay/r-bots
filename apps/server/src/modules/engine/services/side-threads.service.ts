import { randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAccounts } from "../../accounts/services/accounts.service";
import { effectivePermission } from "../../approvals/services/permissions.service";
import { type BotDefinition, getBot, isActive, resolveBotRef } from "../../bots/services/bots.service";
import { activeWorkspace, activeWorkspaces } from "../../code/services/workspace.service";
import {
  autoTitle,
  ConversationError,
  childConversations,
  createConversation,
  isConversationSession,
  publicConversation,
} from "../../conversations/services/conversations.service";
import { handoffBlock, threadItems } from "../../conversations/services/handoff.service";
import { getStoredSession, type SessionMeta, type StoredSession } from "../../conversations/services/sessions.service";
import { readUpload, type UploadMeta } from "../../uploads/services/uploads.service";
import { conversationStatus, type DelegationHooks, type DelegationResult, deliver } from "./engine.service";
import type { ToolContext } from "./mcp-gateway.service";

export const sideLimits = { depth: 2, running: 5 };

export function threadDepth(session: StoredSession) {
  let depth = 0;
  const seen = new Set<string>([session.meta.sessionId]);
  let current: StoredSession | undefined = session;
  while (current) {
    const up: string | undefined = current.meta.parentSessionId ?? current.meta.spawnedBy;
    if (!up || seen.has(up)) break;
    seen.add(up);
    current = getStoredSession(up);
    if (current) depth++;
  }
  return depth;
}

function runningChildren(sessionId: string) {
  return childConversations(sessionId).filter((child) => conversationStatus(child.meta.sessionId) !== "idle").length;
}

function checkSpawn(origin: StoredSession) {
  if (origin.meta.kind === "group")
    throw new ConversationError("Conversa de grupo não abre conversa secundária.", 400, "group_session");
  if (threadDepth(origin) >= sideLimits.depth)
    throw new ConversationError(
      `Limite de ${sideLimits.depth} níveis: esta conversa já é filha de uma conversa filha.`,
      400,
      "depth_limit",
    );
  if (runningChildren(origin.meta.sessionId) >= sideLimits.running)
    throw new ConversationError(
      `Esta conversa já tem ${sideLimits.running} conversas filhas rodando. Espere alguma terminar.`,
      409,
      "too_many_threads",
    );
}

async function forkableKeys(meta: SessionMeta) {
  const keys = Object.keys(meta.providerSessions ?? {});
  if (keys.length === 0) return [];
  const accounts = await listAccounts().catch(() => []);
  return keys.filter((key) => {
    const id = key.split("@")[0] ?? key;
    return (accounts.find((item) => item.id === id)?.provider ?? id.split(":")[1]) === "claude";
  });
}

async function sideSeed(parent: StoredSession): Promise<Partial<SessionMeta>> {
  const open = activeWorkspaces(parent).map((item) => structuredClone(item));
  const primary = activeWorkspace(parent);
  const keys = await forkableKeys(parent.meta);
  const sessions = parent.meta.providerSessions ?? {};
  return {
    parentSessionId: parent.meta.sessionId,
    ...(open.length > 0
      ? { workspaces: open, workspace: open.find((item) => item.id === primary?.id) ?? open[open.length - 1] }
      : {}),
    ...(keys.length > 0
      ? { providerSessions: Object.fromEntries(keys.map((key) => [key, sessions[key] ?? ""])), forkPending: keys }
      : {}),
  };
}

function clip(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function openSideThread(
  parent: StoredSession,
  input: { text?: string; title?: string; report?: boolean } = {},
) {
  if (!isConversationSession(parent))
    throw new ConversationError("Conversa secundária só sai de uma conversa.", 400, "not_conversation");
  checkSpawn(parent);
  const bot = getBot(parent.meta.botId);
  if (!isActive(bot)) throw new ConversationError("Esse bot não está disponível.", 400, "bot_unavailable");
  const text = input.text?.trim() ?? "";
  const base = input.title?.trim() || (text ? autoTitle(text) : (await publicConversation(parent)).title);
  const side = await createConversation(bot.id, {
    title: clip(`↳ ${base}`, 80),
    ...(parent.meta.permission ? { permission: parent.meta.permission } : {}),
    meta: await sideSeed(parent),
  });
  let deliveryId: string | null = null;
  if (text) {
    deliveryId = randomUUID();
    await deliver(side, {
      deliveryId,
      text,
      source: "chat",
      ...(input.report ? { delegation: reportHooks(parent.meta.sessionId, side) } : {}),
    });
  }
  return { session: side, deliveryId };
}

function reportHooks(parentId: string, side: StoredSession): DelegationHooks {
  return {
    onStart: () => undefined,
    onAwaiting: () => undefined,
    finish: (result) => {
      void reportToParent(parentId, side, result).catch((error) =>
        console.warn(`side result ${side.meta.sessionId}: ${error instanceof Error ? error.message : String(error)}`),
      );
    },
  };
}

export async function reportToParent(parentId: string, side: StoredSession, result: DelegationResult) {
  const parent = getStoredSession(parentId);
  if (!parent) return;
  const title = side.meta.title;
  const body =
    result.outcome === "completed"
      ? result.reply.trim() || "Terminou sem responder."
      : result.outcome === "cancelled"
        ? "Parou antes de terminar."
        : `Falhou: ${result.error ?? "erro desconhecido"}`;
  const attachments: UploadMeta[] = [];
  for (const file of result.files ?? []) {
    if (file.botId !== parent.meta.botId) continue;
    const meta = await readUpload(file.botId, file.attachment.uploadId).catch(() => null);
    if (meta && !attachments.some((item) => item.uploadId === meta.uploadId)) attachments.push(meta);
  }
  await deliver(parent, {
    deliveryId: randomUUID(),
    text: `Resultado da conversa secundária “${title}” (${side.meta.sessionId}):\n${body}`,
    source: "chat",
    side: { sessionId: side.meta.sessionId, title, outcome: result.outcome },
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

export async function createThread(
  origin: StoredSession,
  originBot: BotDefinition,
  input: { bot?: string; title?: string; message: string },
) {
  checkSpawn(origin);
  const target = input.bot?.trim() ? resolveBotRef(input.bot) : originBot;
  if (!isActive(target)) throw new ConversationError(`O bot ${input.bot} não está disponível.`, 400, "bot_unavailable");
  const other = target.id !== originBot.id;
  const text = other
    ? `${originBot.name} (${originBot.role || "bot do time"}), outro bot do time, abriu esta conversa com você:\n${input.message}`
    : input.message;
  const session = await createConversation(target.id, {
    ...(input.title?.trim() ? { title: input.title } : {}),
    firstMessage: input.message,
    permission: effectivePermission(origin.meta.permission, originBot.permission),
    meta: { spawnedBy: origin.meta.sessionId },
  });
  await deliver(session, { deliveryId: randomUUID(), text, source: "chat" });
  return session;
}

export async function sideContext(session: StoredSession, fresh: boolean) {
  const parentId = session.meta.parentSessionId;
  const parent = parentId ? getStoredSession(parentId) : undefined;
  if (!parent) return { note: "", carry: "" };
  const workspaces = activeWorkspaces(session);
  const note = [
    "## Conversa secundária",
    `Esta é uma conversa secundária aberta a partir da conversa “${parent.meta.title || "principal"}” (${parent.meta.sessionId}). Você começou com o contexto dela; trabalhe aqui só no pedido desta conversa, em paralelo com a principal.`,
    workspaces.length > 0
      ? `A conversa principal usa a mesma worktree (${workspaces.map((item) => item.path).join(", ")}) e pode estar editando os mesmos arquivos agora. Releia o arquivo antes de editar, não desfaça mudanças que você não fez e não rode git reset, checkout, stash ou clean nessa worktree.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!fresh) return { note, carry: "" };
  const block = await handoffBlock(parent, { key: "", currentTurnId: "", full: true });
  return {
    note,
    carry: block
      ? `## Contexto da conversa principal\nO que aconteceu na conversa de onde esta saiu (os itens são dela; leia com \`thread_read\`).\n\n${block}`
      : "",
  };
}

export async function publicThread(session: StoredSession) {
  const view = await publicConversation(session);
  return {
    sessionId: view.sessionId,
    botId: view.botId,
    title: view.title,
    kind: session.meta.parentSessionId ? "side" : "thread",
    status: view.status,
    lastMessage: view.lastMessage,
    createdAt: view.createdAt,
  };
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function logged(
  context: ToolContext,
  name: string,
  label: string,
  input: Record<string, unknown>,
  run: () => Promise<unknown>,
) {
  const callId = `call_${randomBytes(9).toString("base64url")}`;
  const scope = { runId: context.runId(), turnId: context.turnId };
  context.onCallStart();
  try {
    context.log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name, label },
        input,
        owner: context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() },
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope,
    });
    context.log.emit({ type: "call.started", data: { callId }, scope });
    try {
      const output = await run();
      context.log.emit({ type: "call.settled", data: { callId, outcome: "completed", output }, scope });
      context.onCallSettled(`${name} → ${clip(JSON.stringify(output), 160)}`);
      return textResult(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.log.emit({
        type: "call.settled",
        data: { callId, outcome: "failed", error: { code: "TOOL_EXECUTION_FAILED", message } },
        scope,
      });
      context.onCallSettled(`${name} → falhou: ${clip(message, 160)}`);
      return textResult(message, true);
    }
  } finally {
    context.onCallEnd();
  }
}

function originOf(context: ToolContext) {
  const session = getStoredSession(context.sessionId);
  if (!session) throw new Error("Conversa não encontrada.");
  return session;
}

export function registerSideThreadTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "thread_side",
    {
      description:
        "Abre uma conversa secundária filha desta, com todo o contexto daqui (mesmo bot, mesma worktree), e roda a tarefa em paralelo. Volta na hora com o id; quando ela terminar, o resultado (texto final e arquivos) chega nesta conversa como mensagem. Use para subtarefas independentes e demoradas.",
      inputSchema: { message: z.string().min(1).max(20_000), title: z.string().min(1).max(80).optional() },
    },
    (args: Record<string, unknown>) => {
      const message = String(args.message);
      const title = typeof args.title === "string" ? args.title : undefined;
      return logged(context, "thread_side", "Abrir conversa secundária", { message, title }, async () => {
        const { session } = await openSideThread(originOf(context), {
          text: message,
          ...(title ? { title } : {}),
          report: true,
        });
        return {
          sessionId: session.meta.sessionId,
          title: session.meta.title,
          status: conversationStatus(session.meta.sessionId),
          note: "Roda em paralelo. O resultado volta para esta conversa como mensagem quando terminar; não fique esperando.",
        };
      });
    },
  );
  server.registerTool(
    "thread_create",
    {
      description:
        "Abre uma conversa nova e independente (sua ou de outro bot, pelo id ou nome) com uma primeira mensagem, que começa a rodar sozinha. Não traz o contexto daqui nem devolve resultado: mande o pedido completo. Volta na hora com o id.",
      inputSchema: {
        message: z.string().min(1).max(20_000),
        title: z.string().min(1).max(80).optional(),
        bot: z.string().min(1).max(120).optional(),
      },
    },
    (args: Record<string, unknown>) => {
      const input = {
        message: String(args.message),
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.bot === "string" ? { bot: args.bot } : {}),
      };
      return logged(context, "thread_create", "Abrir conversa nova", input, async () => {
        const session = await createThread(originOf(context), context.bot, input);
        return publicThread(session);
      });
    },
  );
  server.registerTool(
    "thread_list",
    {
      description:
        "Lista as conversas filhas desta (secundárias e as abertas com thread_create), com status (working, awaiting, queued, idle) e a última mensagem.",
      inputSchema: {},
    },
    () =>
      logged(context, "thread_list", "Ver conversas filhas", {}, async () => ({
        threads: await Promise.all(childConversations(context.sessionId).map(publicThread)),
      })),
  );
}

export function readableThread(context: Pick<ToolContext, "botId" | "sessionId">, threadId: string) {
  const session = getStoredSession(threadId);
  if (!session || !isConversationSession(session)) return null;
  const meta = session.meta;
  const own = meta.botId === context.botId;
  const child = meta.parentSessionId === context.sessionId || meta.spawnedBy === context.sessionId;
  return own || child ? session : null;
}

export async function readThread(context: Pick<ToolContext, "botId" | "sessionId">, threadId: string, limit = 10) {
  const session = readableThread(context, threadId);
  if (!session) return { error: "Não achei essa conversa entre as suas e as filhas desta." };
  const items = (await threadItems(session))
    .filter((item) => item.kind === "user_message" || item.kind === "assistant_message")
    .slice(-limit);
  return {
    ...(await publicThread(session)),
    messages: items.map((item) => ({
      itemId: item.id,
      role: item.role,
      at: item.at,
      text: item.text.length > 4_000 ? `${item.text.slice(0, 4_000)}…` : item.text,
    })),
  };
}
