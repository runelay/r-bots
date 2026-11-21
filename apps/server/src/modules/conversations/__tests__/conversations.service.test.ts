import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { factsOfType, makeBot, newSession, waitFor } from "../../../../test/engine-helpers";
import { fakeProviders, resetData } from "../../../../test/helpers";
import { must } from "../../../../test/must";
import { ValidationError } from "../../../shared/errors";
import type { BotDefinition } from "../../bots/services/bots.service";
import type { WorkspaceState } from "../../code/services/workspace.service";
import { cancel, deliver, isBusy } from "../../engine/services/engine.service";
import { loadConversationRows } from "../repositories/sessions.repository";
import {
  archiveConversation,
  autoTitle,
  ConversationError,
  type ConversationEvent,
  childConversations,
  conversationOf,
  conversationSessions,
  createConversation,
  delegationConversation,
  isConversationSession,
  listConversations,
  markConversation,
  moveConversation,
  notifyConversation,
  onConversation,
  publicConversation,
  recordConversationMessage,
  titleMainFromMessage,
  updateConversation,
} from "../services/conversations.service";
import { createStoredSession, type StoredSession } from "../services/sessions.service";
import { ensureThread, recordThreadMessage } from "../services/threads.service";

async function storedTitle(sessionId: string) {
  return (await loadConversationRows()).find((row) => row.meta.sessionId === sessionId)?.meta.title;
}

let bot: BotDefinition;
let events: ConversationEvent[];
let stopListening: () => void;

beforeEach(async () => {
  await resetData();
  bot = await makeBot();
  events = [];
  stopListening = onConversation((event) => events.push(event)) as unknown as () => void;
});

afterEach(async () => {
  stopListening();
});

async function busySession(session: StoredSession) {
  let release = () => undefined as undefined;
  fakeProviders.next(
    ({ emit, signal }) =>
      new Promise<void>((resolve) => {
        release = () => {
          emit({ type: "done", ok: true });
          resolve();
        };
        signal.addEventListener("abort", () => release(), { once: true });
      }),
  );
  deliver(session, { deliveryId: "d1", text: "trabalha", source: "chat" });
  await waitFor(() => fakeProviders.turns.length > 0);
  return async () => {
    release();
    await waitFor(() => !isBusy(session.meta.sessionId));
  };
}

describe("autoTitle", () => {
  test("cleans greetings, asks, code and links into a short title", async () => {
    expect(autoTitle("oi, bom dia! pode por favor, revisar o PR?")).toBe("Revisar o PR");
    expect(autoTitle("```ts\ncode\n``` https://x.com veja isso")).toBe("Veja isso");
    expect(autoTitle("  ?? ")).toBe("Nova conversa");
    const long = autoTitle("Preciso que você monte um relatório completo das campanhas de novembro com gráficos");
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(45);
    expect(autoTitle("a".repeat(60))).toBe(`${"A"}${"a".repeat(43)}…`);
  });
});

describe("createConversation", () => {
  test("uses the typed title, a title from the first message or stays pending", async () => {
    const typed = await createConversation(bot.id, { title: "  Meu título  ", permission: "edit" });
    expect(typed.meta).toMatchObject({ title: "Meu título", kind: "conversation", permission: "edit" });
    expect(typed.meta.conversation?.titleSource).toBe("user");
    expect((await factsOfType(typed, "session.started"))[0].data).toMatchObject({ conversation: true });
    const fromMessage = await createConversation(bot.id, { firstMessage: "oi, pode ver as vendas?" });
    expect(fromMessage.meta.title).toBe("Ver as vendas");
    expect(fromMessage.meta.conversation?.titleSource).toBe("auto");
    const pending = await createConversation(bot.id);
    expect(pending.meta.title).toBe("");
    expect(pending.meta.conversation?.titleSource).toBe("pending");
    const delegated = await createConversation(bot.id, {
      title: "Pedido",
      delegatedBy: { botId: "x", name: "X", sessionId: "s", callId: "c" },
    });
    expect(delegated.meta.conversation).toMatchObject({ titleSource: "auto", delegatedBy: { botId: "x" } });
    await waitFor(() => events.length >= 4);
    expect(events[0]).toMatchObject({ botId: bot.id, sessionId: typed.meta.sessionId });
  });
});

describe("publicConversation", () => {
  test("describes a regular conversation", async () => {
    const session = await createConversation(bot.id, { title: "Vendas" });
    session.meta.workspace = { repoName: "repo", branch: "feat/x", active: true } as WorkspaceState;
    const view = await publicConversation(session);
    expect(view).toMatchObject({
      sessionId: session.meta.sessionId,
      botId: bot.id,
      title: "Vendas",
      main: false,
      unread: 0,
      status: "idle",
      archivedAt: null,
      permission: null,
      effectivePermission: "default",
      code: { repoName: "repo", branch: "feat/x" },
    });
    expect(view.delegatedBy).toBeUndefined();
  });

  test("describes the main thread with its live title and counters", async () => {
    const state = await ensureThread(bot.id);
    const session = must((await listConversations(bot.id)).find((item) => item.main));
    expect(session.title).toBe("Nova conversa");
    const stored = must(conversationOf(bot.id, state.sessionId));
    stored.log.emit({ type: "delivery.consumed", data: { source: "schedule", parts: [{ kind: "text", text: "x" }] } });
    stored.log.emit({ type: "delivery.consumed", data: { source: "chat", parts: [{ kind: "file" }] } });
    stored.log.emit({ type: "delivery.consumed", data: { source: "chat" } });
    (await stored.log.lines()).push('{"delivery.consumed" broken');
    stored.log.emit({
      type: "delivery.consumed",
      data: { source: "chat", parts: [{ kind: "text", text: "pode ver as metas?" }] },
    });
    const view = await publicConversation(stored);
    expect(view).toMatchObject({ main: true, title: "Ver as metas", titleSource: "auto" });
    await waitFor(async () => (await storedTitle(state.sessionId)) === "Ver as metas");
    stored.meta.title = "Outro";
    expect((await publicConversation(stored)).title).toBe("Outro");
    await updateConversation(stored, { title: "Do usuário" });
    expect((await publicConversation(stored)).title).toBe("Do usuário");
    await recordThreadMessage(bot.id, state.sessionId, { role: "bot", text: "oi", at: "2030-01-01T00:00:00.000Z" });
    expect(await publicConversation(stored)).toMatchObject({
      unread: 1,
      updatedAt: "2030-01-01T00:00:00.000Z",
      lastMessage: { text: "oi" },
    });
  });

  test("a thread session that is no longer the main one is shown like a conversation", async () => {
    const orphan = await createStoredSession({ botId: bot.id, kind: "thread", source: "chat", title: "" });
    const view = await publicConversation(orphan);
    expect(view).toMatchObject({ main: false, title: "Nova conversa", unread: 0, titleSource: "pending" });
  });

  test("main title is set from the first user message only while it is a placeholder", async () => {
    const thread = await createStoredSession({ botId: bot.id, kind: "thread", source: "chat", title: "" });
    titleMainFromMessage(thread, "   ");
    expect(thread.meta.title).toBe("");
    titleMainFromMessage(thread, "olá, revisar contrato");
    expect(thread.meta.title).toBe("Revisar contrato");
    titleMainFromMessage(thread, "outra coisa");
    expect(thread.meta.title).toBe("Revisar contrato");
    const conversation = await createConversation(bot.id);
    titleMainFromMessage(conversation, "x");
    expect(conversation.meta.title).toBe("");
  });
});

describe("conversation listing", () => {
  test("lists the main thread first, then active or archived conversations", async () => {
    const older = await createConversation(bot.id, { title: "Antiga" });
    older.meta.startedAt = "2001-01-01T00:00:00.000Z";
    const newer = await createConversation(bot.id, { title: "Nova" });
    const archived = await createConversation(bot.id, { title: "Arquivada" });
    await archiveConversation(archived, true);
    expect((await listConversations(bot.id)).map((item) => item.title)).toEqual(["Nova", "Antiga"]);
    await ensureThread(bot.id);
    const list = await listConversations(bot.id);
    expect(list[0].main).toBe(true);
    expect(list.slice(1).map((item) => item.sessionId)).toEqual([newer.meta.sessionId, older.meta.sessionId]);
    expect((await listConversations(bot.id, true)).map((item) => item.title)).toEqual(["Arquivada"]);
    expect(conversationSessions(bot.id, true)).toEqual([archived]);
  });

  test("finds the children of a conversation oldest first and the newest delegation from a caller", async () => {
    const parent = await createConversation(bot.id, { title: "Pai" });
    const parentId = parent.meta.sessionId;
    const later = await createConversation(bot.id, { title: "Depois", meta: { parentSessionId: parentId } });
    later.meta.startedAt = "2002-01-01T00:00:00.000Z";
    const first = await createConversation(bot.id, { title: "Antes", meta: { spawnedBy: parentId } });
    first.meta.startedAt = "2001-01-01T00:00:00.000Z";
    const gone = await createConversation(bot.id, { title: "Arquivada", meta: { parentSessionId: parentId } });
    await archiveConversation(gone, true);
    expect(childConversations(parentId)).toEqual([first, later]);

    const delegatedBy = { botId: "caller", name: "Caller", sessionId: "origin", callId: "c1" };
    const oldest = await createConversation(bot.id, { title: "Delegada 1", delegatedBy });
    oldest.meta.startedAt = "2001-01-01T00:00:00.000Z";
    const newest = await createConversation(bot.id, {
      title: "Delegada 2",
      delegatedBy: { ...delegatedBy, callId: "c2" },
    });
    newest.meta.startedAt = "2003-01-01T00:00:00.000Z";
    await createConversation(bot.id, {
      title: "Outra origem",
      delegatedBy: { ...delegatedBy, sessionId: "elsewhere" },
    });
    expect(delegationConversation(bot.id, "caller", "origin")).toBe(newest);
    expect(delegationConversation(bot.id, "nobody", "origin")).toBeUndefined();
  });

  test("conversationOf only returns conversations of that bot", async () => {
    const session = await createConversation(bot.id);
    expect(conversationOf(bot.id, session.meta.sessionId)).toBe(session);
    expect(conversationOf("other", session.meta.sessionId)).toBeNull();
    expect(conversationOf(bot.id, "wrun_missing")).toBeNull();
    const plain = await newSession(bot.id, "session");
    expect(conversationOf(bot.id, plain.meta.sessionId)).toBeNull();
    expect(isConversationSession(undefined)).toBe(false);
  });

  test("notifyConversation ignores unknown and non-conversation sessions", async () => {
    const plain = await newSession(bot.id, "session");
    await notifyConversation(plain.meta.sessionId);
    await notifyConversation("wrun_missing");
    expect(events).toHaveLength(0);
  });
});

describe("recordConversationMessage", () => {
  test("tracks the last message, unread count and pending title", async () => {
    const session = await createConversation(bot.id);
    await recordConversationMessage(session, { role: "user", text: "oi, ver o funil", at: "2026-01-01T00:00:01.000Z" });
    expect(session.meta.title).toBe("Ver o funil");
    await recordConversationMessage(session, { role: "user", text: "outra", at: "2026-01-01T00:00:02.000Z" });
    expect(session.meta.title).toBe("Ver o funil");
    await recordConversationMessage(session, { role: "bot", text: "feito", at: "2026-01-01T00:00:03.000Z" });
    await recordConversationMessage(session, { role: "bot", text: "quieto", at: "2026-01-01T00:00:04.000Z" }, true);
    expect(session.meta.conversation).toMatchObject({
      unread: 1,
      updatedAt: "2026-01-01T00:00:04.000Z",
      lastMessage: { text: "quieto" },
    });
    const legacy = await newSession(bot.id, "conversation");
    legacy.meta.title = "Legado";
    await recordConversationMessage(legacy, { role: "user", text: "x", at: "2026-01-01T00:00:09.000Z" });
    expect(legacy.meta.conversation?.titleSource).toBe("auto");
    expect(legacy.meta.title).toBe("Legado");
  });
});

describe("updateConversation", () => {
  test("validates the body", async () => {
    const session = await createConversation(bot.id);
    await expect(updateConversation(session, null)).rejects.toThrow(ValidationError);
    await expect(updateConversation(session, [])).rejects.toThrow("Corpo inválido.");
    await expect(updateConversation(session, { color: "x" })).rejects.toThrow("Campo desconhecido: color.");
    await expect(updateConversation(session, { title: 3 })).rejects.toThrow("de 1 a 80");
    await expect(updateConversation(session, { title: " " })).rejects.toThrow("de 1 a 80");
    await expect(updateConversation(session, { title: "x".repeat(81) })).rejects.toThrow("de 1 a 80");
    await expect(updateConversation(session, { permission: "root" })).rejects.toThrow("Use readonly");
  });

  test("renames and sets or clears the permission", async () => {
    const session = await createConversation(bot.id);
    await updateConversation(session, { title: " Novo ", permission: "readonly" });
    expect(session.meta).toMatchObject({ title: "Novo", permission: "readonly" });
    expect(session.meta.conversation?.titleSource).toBe("user");
    await updateConversation(session, { permission: null });
    expect(session.meta.permission).toBeUndefined();
  });
});

describe("archive, read and move", () => {
  test("the main thread cannot be archived or moved", async () => {
    const state = await ensureThread(bot.id);
    const main = must(conversationOf(bot.id, state.sessionId));
    await expect(archiveConversation(main, true)).rejects.toMatchObject({ status: 400, code: "main_conversation" });
    await expect(moveConversation(main, "x")).rejects.toMatchObject({ status: 400, code: "main_conversation" });
  });

  test("archive and unarchive", async () => {
    const session = await createConversation(bot.id);
    await archiveConversation(session, true);
    expect(session.meta.conversation?.archivedAt).not.toBeNull();
    await archiveConversation(session, false);
    expect(session.meta.conversation?.archivedAt).toBeNull();
  });

  test("busy conversations cannot be archived or moved", async () => {
    const other = await makeBot();
    const session = await createConversation(bot.id);
    const finish = await busySession(session);
    await expect(archiveConversation(session, true)).rejects.toMatchObject({ status: 409, code: "turn_running" });
    await expect(moveConversation(session, other.id)).rejects.toBeInstanceOf(ConversationError);
    await finish();
  });

  test("mark read and unread", async () => {
    const session = await createConversation(bot.id);
    await markConversation(session, false);
    expect(session.meta.conversation?.unread).toBe(1);
    await markConversation(session, true);
    expect(session.meta.conversation).toMatchObject({ unread: 0 });
    expect(session.meta.conversation?.readAt).not.toBeNull();
  });

  test("move hands the conversation to another active bot", async () => {
    const other = await makeBot();
    const session = await createConversation(bot.id);
    session.meta.providerSessions = { a: "b" };
    session.meta.providerSynced = { a: "turn_0" };
    session.meta.lastEngine = { account: "vps:claude", model: "m" };
    session.meta.sdkSessionId = "sdk";
    await expect(moveConversation(session, 3)).rejects.toMatchObject({ code: "bot_unavailable" });
    await expect(moveConversation(session, "missing")).rejects.toMatchObject({ code: "bot_unavailable" });
    expect(await moveConversation(session, bot.id)).toBe(session);
    events.length = 0;
    await moveConversation(session, other.id);
    expect(session.meta).toMatchObject({ botId: other.id, sdkSessionId: null });
    expect(session.meta.providerSessions).toBeUndefined();
    expect(session.meta.providerSynced).toBeUndefined();
    expect(session.meta.lastEngine).toBeUndefined();
    expect((await factsOfType(session, "conversation.moved"))[0].data).toEqual({
      from: bot.id,
      to: other.id,
      toName: other.name,
    });
    expect(events[0]).toEqual({ botId: bot.id, sessionId: session.meta.sessionId, conversation: null });
  });
});

describe("conversation status", () => {
  test("shows a queued conversation behind the running turn", async () => {
    const session = await createConversation(bot.id);
    const finish = await busySession(session);
    expect((await publicConversation(session)).status).toBe("working");
    cancel(session);
    await finish();
    expect((await publicConversation(session)).status).toBe("idle");
  });
});
