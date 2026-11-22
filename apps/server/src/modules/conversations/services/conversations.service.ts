import { model } from "../../../config/env";
import { ValidationError } from "../../../shared/errors";
import { commonText } from "../../../shared/messages";
import {
  effectivePermission,
  isPermissionMode,
  type PermissionMode,
} from "../../approvals/services/permissions.service";
import { getBot, isActive, permissionOfBot } from "../../bots/services/bots.service";
import { activeWorkspace } from "../../code/services/workspace.service";
import { conversationStatus, isBusy } from "../../engine/services/engine.service";
import { conversationsText } from "../constants/conversations-messages.constants";
import {
  allStoredSessions,
  type ConversationInfo,
  createStoredSession,
  getStoredSession,
  type SessionMeta,
  type StoredSession,
  sessionsOf,
} from "./sessions.service";
import { peekThread, type ThreadMessage } from "./threads.service";

export interface ConversationEvent {
  botId: string;
  sessionId: string;
  conversation: Awaited<ReturnType<typeof publicConversation>> | null;
}

const listeners = new Set<(event: ConversationEvent) => void>();

export function onConversation(listener: (event: ConversationEvent) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isConversationSession(session: StoredSession | undefined) {
  return Boolean(session && (session.meta.kind === "conversation" || session.meta.kind === "thread"));
}

function info(session: StoredSession): ConversationInfo {
  session.meta.conversation ??= {
    titleSource: session.meta.title ? "auto" : "pending",
    lastMessage: null,
    unread: 0,
    readAt: null,
    archivedAt: null,
    updatedAt: session.meta.startedAt,
  };
  return session.meta.conversation;
}

export async function publicConversation(session: StoredSession) {
  const meta = session.meta;
  const main = meta.kind === "thread";
  const thread = main ? await peekThread(meta.botId) : null;
  const isMain = main && thread?.sessionId === meta.sessionId;
  const details = info(session);
  const bot = getBot(meta.botId);
  const workspace = activeWorkspace(session);
  return {
    sessionId: meta.sessionId,
    botId: meta.botId,
    title: isMain ? await mainTitle(session) : meta.title || conversationsText("newConversation"),
    titleSource: details.titleSource,
    main: isMain,
    createdAt: meta.startedAt,
    updatedAt: (isMain ? thread?.lastMessage?.at : details.lastMessage?.at) ?? details.updatedAt,
    lastMessage: isMain ? (thread?.lastMessage ?? null) : details.lastMessage,
    unread: isMain ? (thread?.unread ?? 0) : details.unread,
    status: conversationStatus(meta.sessionId),
    archivedAt: details.archivedAt,
    permission: meta.permission ?? null,
    effectivePermission: effectivePermission(meta.permission, bot ? permissionOfBot(bot) : undefined),
    ...(details.delegatedBy ? { delegatedBy: details.delegatedBy } : {}),
    ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    code: workspace ? { repoName: workspace.repoName, branch: workspace.branch } : null,
  };
}

const placeholderTitles = new Set(["", "Conversa principal"]);

async function firstUserText(session: StoredSession) {
  for (const line of await session.log.lines()) {
    if (!line.includes('"delivery.consumed"')) continue;
    try {
      const parsed = JSON.parse(line) as {
        facts?: Array<{ type?: string; data?: { source?: string; parts?: Array<{ kind?: string; text?: string }> } }>;
      };
      for (const fact of parsed.facts ?? []) {
        if (fact.type !== "delivery.consumed" || fact.data?.source !== "chat") continue;
        const text = (fact.data.parts ?? [])
          .filter((part) => part.kind === "text" && part.text)
          .map((part) => part.text)
          .join(" ")
          .trim();
        if (text) return text;
      }
    } catch {}
  }
  return null;
}

async function mainTitle(session: StoredSession) {
  const details = info(session);
  if (details.titleSource === "user" && session.meta.title) return session.meta.title;
  if (!placeholderTitles.has(session.meta.title)) return session.meta.title;
  const text = await firstUserText(session);
  if (!text) return conversationsText("newConversation");
  session.meta.title = autoTitle(text);
  details.titleSource = "auto";
  void session.save();
  return session.meta.title;
}

export function titleMainFromMessage(session: StoredSession, text: string) {
  if (session.meta.kind !== "thread" || !placeholderTitles.has(session.meta.title) || !text.trim()) return;
  session.meta.title = autoTitle(text);
  info(session).titleSource = "auto";
}

export type PublicConversation = Awaited<ReturnType<typeof publicConversation>>;

export async function notifyConversation(sessionId: string) {
  const session = getStoredSession(sessionId);
  if (!session || !isConversationSession(session)) return;
  const conversation = await publicConversation(session);
  for (const listener of listeners) listener({ botId: session.meta.botId, sessionId, conversation });
}

export function conversationSessions(botId: string, archived = false) {
  return sessionsOf(botId).filter(
    (session) => session.meta.kind === "conversation" && Boolean(session.meta.conversation?.archivedAt) === archived,
  );
}

export function childConversations(sessionId: string) {
  return allStoredSessions()
    .filter(
      (session) =>
        session.meta.kind === "conversation" &&
        !session.meta.conversation?.archivedAt &&
        (session.meta.parentSessionId === sessionId || session.meta.spawnedBy === sessionId),
    )
    .sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt));
}

export async function listConversations(botId: string, archived = false) {
  const thread = archived ? null : await peekThread(botId);
  const main = thread ? getStoredSession(thread.sessionId) : undefined;
  const others = conversationSessions(botId, archived).sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
  const ordered = [...(main ? [main] : []), ...others];
  return Promise.all(ordered.map(publicConversation));
}

const fillers = /^(oi|olá|ola|bom dia|boa tarde|boa noite|e aí|e ai|hey|opa)[,!.\s]+/i;
const asks =
  /^(por favor[,\s]+|pfv[,\s]+|você pode|voce pode|vc pode|pode|consegue|preciso que você|preciso que voce|quero que você|quero que voce|me ajuda a|me ajude a|dá para|da pra|dá pra)\s+/i;

export function autoTitle(text: string) {
  let clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let index = 0; index < 3; index++) clean = clean.replace(fillers, "").replace(asks, "").trim();
  clean = clean.replace(/[?!.:;,]+$/, "").trim();
  if (!clean) return conversationsText("newConversation");
  const max = 44;
  let title = clean;
  if (title.length > max) {
    const cut = title.slice(0, max);
    const space = cut.lastIndexOf(" ");
    title = `${(space > 20 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "")}…`;
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export async function createConversation(
  botId: string,
  input: {
    title?: string;
    permission?: PermissionMode;
    delegatedBy?: ConversationInfo["delegatedBy"];
    firstMessage?: string;
    meta?: Partial<SessionMeta>;
  } = {},
) {
  const typed = input.title?.trim() ? input.title.trim().slice(0, 80) : "";
  const title = typed || (input.firstMessage?.trim() ? autoTitle(input.firstMessage) : "");
  const session = await createStoredSession({ botId, kind: "conversation", source: "chat", title });
  const now = new Date().toISOString();
  session.meta.conversation = {
    titleSource: typed ? (input.delegatedBy ? "auto" : "user") : title ? "auto" : "pending",
    lastMessage: null,
    unread: 0,
    readAt: null,
    archivedAt: null,
    updatedAt: now,
    ...(input.delegatedBy ? { delegatedBy: input.delegatedBy } : {}),
  };
  if (input.permission) session.meta.permission = input.permission;
  if (input.meta) Object.assign(session.meta, input.meta);
  session.log.emit({
    type: "session.started",
    data: { runtime: { agentId: botId, agentName: botId, engine: "claude-agent-sdk", model }, conversation: true },
  });
  await session.save();
  void notifyConversation(session.meta.sessionId);
  return session;
}

export async function recordConversationMessage(session: StoredSession, message: ThreadMessage, quiet = false) {
  const details = info(session);
  details.lastMessage = message;
  details.updatedAt = message.at;
  if (message.role === "bot" && !quiet) details.unread += 1;
  if (message.role === "user" && details.titleSource === "pending") {
    session.meta.title = autoTitle(message.text);
    details.titleSource = "auto";
  }
  await session.save();
  void notifyConversation(session.meta.sessionId);
}

export function conversationOf(botId: string, sessionId: string) {
  const session = getStoredSession(sessionId);
  if (!session || session.meta.botId !== botId || !isConversationSession(session)) return null;
  return session;
}

export async function updateConversation(session: StoredSession, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ValidationError(commonText("bodyInvalid"), "body");
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!["title", "permission"].includes(key)) throw new ValidationError(commonText("unknownField", { key }), key);
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.trim().length > 80)
      throw new ValidationError(conversationsText("titleLength"), "title");
    session.meta.title = raw.title.trim();
    info(session).titleSource = "user";
  }
  if (raw.permission !== undefined) {
    if (raw.permission === null) delete session.meta.permission;
    else if (isPermissionMode(raw.permission)) session.meta.permission = raw.permission;
    else throw new ValidationError(conversationsText("permissionInvalid"), "permission");
  }
  await session.save();
  void notifyConversation(session.meta.sessionId);
  return session;
}

export class ConversationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function archiveConversation(session: StoredSession, archived: boolean) {
  if (session.meta.kind === "thread")
    throw new ConversationError(conversationsText("mainNotArchived"), 400, "main_conversation");
  if (archived && isBusy(session.meta.sessionId))
    throw new ConversationError(conversationsText("busyArchive"), 409, "turn_running");
  info(session).archivedAt = archived ? new Date().toISOString() : null;
  await session.save();
  void notifyConversation(session.meta.sessionId);
  return session;
}

export async function markConversation(session: StoredSession, read: boolean) {
  const details = info(session);
  if (read) {
    details.unread = 0;
    details.readAt = new Date().toISOString();
  } else details.unread = Math.max(1, details.unread);
  await session.save();
  void notifyConversation(session.meta.sessionId);
  return session;
}

export async function moveConversation(session: StoredSession, targetId: unknown) {
  if (session.meta.kind === "thread")
    throw new ConversationError("A conversa principal fica com o bot.", 400, "main_conversation");
  const target = typeof targetId === "string" ? getBot(targetId) : undefined;
  if (!target || !isActive(target))
    throw new ConversationError(conversationsText("botUnavailable"), 400, "bot_unavailable");
  if (target.id === session.meta.botId) return session;
  if (isBusy(session.meta.sessionId)) throw new ConversationError(conversationsText("busyMove"), 409, "turn_running");
  const from = session.meta.botId;
  session.meta.botId = target.id;
  delete session.meta.providerSessions;
  delete session.meta.providerSynced;
  delete session.meta.lastEngine;
  session.meta.sdkSessionId = null;
  session.log.emit({ type: "conversation.moved", data: { from, to: target.id, toName: target.name } });
  await session.save();
  for (const listener of listeners) listener({ botId: from, sessionId: session.meta.sessionId, conversation: null });
  void notifyConversation(session.meta.sessionId);
  return session;
}
