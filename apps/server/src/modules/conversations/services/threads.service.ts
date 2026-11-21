import { ulid } from "ulid";
import { model } from "../../../config/env";
import {
  deleteThreadRow,
  readArchivedThread,
  readLiveThread,
  saveArchivedThread,
  saveLiveThread,
} from "../repositories/threads.repository";
import { notifyConversation, recordConversationMessage, titleMainFromMessage } from "./conversations.service";
import { createStoredSession, getStoredSession } from "./sessions.service";

export interface ThreadMessage {
  role: "user" | "bot";
  text: string;
  at: string;
  botId?: string;
}

export interface ThreadState {
  sessionId: string;
  lastMessage: ThreadMessage | null;
  unread: number;
  readAt: string | null;
}

const states = new Map<string, ThreadState>();
const creating = new Map<string, Promise<ThreadState>>();

async function load(botId: string) {
  const cached = states.get(botId);
  if (cached) return cached;
  const stored = await readLiveThread(botId);
  if (stored && getStoredSession(stored.sessionId)) {
    states.set(botId, stored);
    return stored;
  }
  return null;
}

async function startThread(botId: string, kind: "thread" | "group") {
  const session = await createStoredSession({
    botId,
    kind,
    source: "chat",
    title: kind === "group" ? "Conversa do grupo" : "Conversa principal",
  });
  session.log.emit({
    type: "session.started",
    data: { runtime: { agentId: botId, agentName: botId, engine: "claude-agent-sdk", model }, thread: true },
  });
  const state: ThreadState = { sessionId: session.meta.sessionId, lastMessage: null, unread: 0, readAt: null };
  states.set(botId, state);
  await saveLiveThread(botId, state);
  return state;
}

export async function ensureThread(botId: string, kind: "thread" | "group" = "thread") {
  const cached = states.get(botId);
  if (cached) return cached;
  const pending = creating.get(botId);
  if (pending) return pending;
  const promise = load(botId).then((existing) => existing ?? startThread(botId, kind));
  creating.set(botId, promise);
  try {
    return await promise;
  } finally {
    creating.delete(botId);
  }
}

export async function peekThread(botId: string) {
  return load(botId);
}

export function publicThread(state: ThreadState | null) {
  if (!state) return { sessionId: null, lastMessage: null, unread: 0, total: 0 };
  const { sessionId, lastMessage, unread } = state;
  return { sessionId, lastMessage, unread, total: getStoredSession(sessionId)?.log.size ?? 0 };
}

async function mutate(botId: string, sessionId: string, update: (state: ThreadState) => void) {
  const state = await load(botId);
  if (!state || state.sessionId !== sessionId) return;
  update(state);
  await saveLiveThread(botId, state);
}

export async function recordThreadMessage(botId: string, sessionId: string, message: ThreadMessage, quiet = false) {
  const session = getStoredSession(sessionId);
  if (session?.meta.kind === "conversation") return recordConversationMessage(session, message, quiet);
  if (session && message.role === "user") {
    titleMainFromMessage(session, message.text);
    await session.save();
  }
  await mutate(botId, sessionId, (state) => {
    state.lastMessage = message;
    if (message.role === "bot" && !quiet) state.unread += 1;
  });
  void notifyConversation(sessionId);
}

export async function markThreadRead(botId: string) {
  const state = await ensureThread(botId, botId.startsWith("grp_") ? "group" : "thread");
  state.unread = 0;
  state.readAt = new Date().toISOString();
  await saveLiveThread(botId, state);
  void notifyConversation(state.sessionId);
  return state;
}

export async function markThreadUnread(botId: string) {
  const state = await ensureThread(botId, botId.startsWith("grp_") ? "group" : "thread");
  state.unread = Math.max(1, state.unread);
  await saveLiveThread(botId, state);
  void notifyConversation(state.sessionId);
  return state;
}

async function archiveState(botId: string, state: ThreadState) {
  const archiveId = `tha_${ulid()}`;
  await saveArchivedThread(botId, archiveId, new Date().toISOString(), { ...state });
  return archiveId;
}

function hasMessages(state: ThreadState) {
  return (getStoredSession(state.sessionId)?.log.size ?? 0) > 1;
}

export async function resetThread(botId: string) {
  const current = await ensureThread(botId);
  const archiveId = await archiveState(botId, current);
  const previous = getStoredSession(current.sessionId);
  const next = await startThread(botId, "thread");
  const session = getStoredSession(next.sessionId);
  if (session && previous?.meta.scheduleSummaries) {
    session.meta.scheduleSummaries = { ...previous.meta.scheduleSummaries };
    await session.save();
  }
  return { state: next, archiveId };
}

export async function restoreThread(botId: string, archiveId: string) {
  const archived = await readArchivedThread(botId, archiveId);
  const restored = archived ? getStoredSession(archived.state.sessionId) : undefined;
  if (!archived || !restored) return null;
  const current = await load(botId);
  const replacedArchiveId = current && hasMessages(current) ? await archiveState(botId, current) : null;
  const summaries = current ? getStoredSession(current.sessionId)?.meta.scheduleSummaries : undefined;
  if (summaries) {
    restored.meta.scheduleSummaries = { ...restored.meta.scheduleSummaries, ...summaries };
    await restored.save();
  }
  states.set(botId, archived.state);
  await saveLiveThread(botId, archived.state);
  await deleteThreadRow(archiveId);
  return { state: archived.state, replacedArchiveId };
}
