import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { factsOf, factsOfType, makeBot } from "../../../../test/engine-helpers";
import { resetData } from "../../../../test/helpers";
import { must } from "../../../../test/must";
import { getDb } from "../../../db";
import { forgetSecretValue, rememberSecretValue } from "../../../shared/redact";
import {
  appendEventRow,
  eventRows,
  loadConversationRows,
  parseLine,
  saveConversationRow,
} from "../repositories/sessions.repository";
import {
  readArchivedThread,
  readLiveThread,
  saveArchivedThread,
  saveLiveThread,
} from "../repositories/threads.repository";
import {
  allStoredSessions,
  createStoredSession,
  EventLog,
  evictIdleLogs,
  getStoredSession,
  loadSessions,
  newSessionId,
  sessionsOf,
  titleFrom,
} from "../services/sessions.service";
import {
  ensureThread,
  markThreadRead,
  markThreadUnread,
  peekThread,
  publicThread,
  recordThreadMessage,
  resetThread,
  restoreThread,
} from "../services/threads.service";
import { settleOrphanTurns } from "../services/turn-repair.service";

beforeEach(async () => {
  await resetData();
});

async function storedSessionId(botId = "log-bot") {
  return (await createStoredSession({ botId, kind: "session", source: "chat", title: "" })).meta.sessionId;
}

async function storedMeta(sessionId: string) {
  return (await loadConversationRows()).find((row) => row.meta.sessionId === sessionId);
}

describe("EventLog", () => {
  test("emits ordered, redacted lines to listeners and to the database", async () => {
    const sessionId = await storedSessionId();
    const log = new EventLog(sessionId);
    const seen: string[] = [];
    const unsubscribe = log.subscribe((line) => seen.push(line));
    rememberSecretValue("test-secret", "super-secret-value");
    try {
      log.emit({ type: "a", data: { token: "super-secret-value" } }, { type: "b", data: {} });
      log.emit({ type: "c", data: {} });
    } finally {
      forgetSecretValue("test-secret");
    }
    log.progress({ type: "content.delta", data: { delta: "x" } });
    unsubscribe();
    log.emit({ type: "d", data: {} });
    expect(seen).toHaveLength(3);
    expect(JSON.parse(seen[2])).toEqual({ progress: { type: "content.delta", data: { delta: "x" } } });
    expect(log.size).toBe(3);
    const [first, second] = (await log.lines()).map((line) => JSON.parse(line));
    expect(first.facts[0].data.token).toBe("••••");
    expect(Date.parse(second.at)).toBeGreaterThan(Date.parse(first.at));
    const rows = await eventRows(sessionId, 0, 10);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[2].facts).toContain('"type":"d"');
    expect((await storedMeta(sessionId))?.lastSeq).toBe(3);
  });

  test("reads stored lines, keeps timestamps increasing after them and slices by sequence", async () => {
    const sessionId = await storedSessionId();
    const future = new Date(Date.now() + 60_000).toISOString();
    await appendEventRow(sessionId, 1, future, [{ type: "old", data: {} }]);
    const broken = parseLine("{broken");
    await appendEventRow(sessionId, 2, broken.at, broken.facts);
    const empty = parseLine(JSON.stringify({ facts: "nope" }));
    await appendEventRow(sessionId, 3, empty.at, empty.facts);
    const log = new EventLog(sessionId, 3);
    await log.load();
    expect(await log.slice(1)).toEqual(["{broken", '{"at":"","facts":[]}']);
    expect(await log.slice(2, 1)).toEqual([]);
    expect((await log.rows(-5, 99)).map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(await log.lines()).toHaveLength(3);
    expect((await log.lines())[1]).toBe("{broken");
    log.emit({ type: "x", data: {} });
    expect(Date.parse(JSON.parse((await log.lines())[3]).at)).toBeGreaterThan(Date.parse(future));
    expect(await log.slice(3)).toEqual([(await log.lines())[3]]);
    const missing = new EventLog("wrun_missing");
    await missing.load();
    expect(await missing.lines()).toEqual([]);
  });

  test("restarts from the epoch when no stored event has a time", async () => {
    const sessionId = await storedSessionId();
    const log = new EventLog(sessionId);
    log.emit({ type: "x", data: {} });
    expect(Date.parse(JSON.parse((await log.lines())[0]).at)).toBeGreaterThan(0);
  });

  test("logs and drops events for a session that was never stored", async () => {
    const log = new EventLog("wrun_unknown");
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      log.emit({ type: "x", data: {} });
      await log.flush();
      expect(String(errors.mock.calls[0]?.[0])).toBe("event wrun_unknown#1 not saved");
    } finally {
      errors.mockRestore();
    }
    expect(await eventRows("wrun_unknown", 0, 10)).toEqual([]);
  });

  test("evicts idle caches only without listeners", async () => {
    const sessionId = await storedSessionId();
    const log = new EventLog(sessionId);
    log.emit({ type: "x", data: {} });
    expect(await log.lines()).toHaveLength(1);
    const later = Date.now() + 31 * 60_000;
    expect(log.evictIfIdle(Date.now())).toBe(false);
    const stop = log.subscribe(() => undefined);
    expect(log.evictIfIdle(later)).toBe(false);
    stop();
    expect(evictIdleLogs(later)).toBeGreaterThanOrEqual(1);
    expect(log.evictIfIdle(later)).toBe(false);
    expect(await log.slice(0)).toHaveLength(1);
    expect(await log.lines()).toHaveLength(1);
  });
});

describe("stored sessions", () => {
  test("create, save and look sessions up by bot", async () => {
    const session = await createStoredSession({
      botId: "s-bot",
      kind: "session",
      source: "schedule",
      title: "Rotina",
      scheduleId: "diaria",
    });
    expect(session.meta.sessionId).toMatch(/^wrun_[0-9A-Z]{26}$/);
    expect(session.meta).toMatchObject({ scheduleId: "diaria", turnCount: 0, runCount: 0, sdkSessionId: null });
    expect(getStoredSession(session.meta.sessionId)).toBe(session);
    expect(allStoredSessions()).toContain(session);
    expect(sessionsOf("s-bot")).toEqual([session]);
    expect((await storedMeta(session.meta.sessionId))?.meta).toMatchObject({ title: "Rotina", scheduleId: "diaria" });
    session.meta.title = "Rotina nova";
    await session.save();
    expect((await storedMeta(session.meta.sessionId))?.meta.title).toBe("Rotina nova");
    const plain = await createStoredSession({ botId: "s-bot", kind: "thread", source: "chat", title: "" });
    expect(plain.meta.scheduleId).toBeUndefined();
    expect(newSessionId()).not.toBe(newSessionId());
  });

  test("loadSessions reads stored rows, migrates the old sdk session and skips rows without an id", async () => {
    const id = newSessionId();
    const startedAt = new Date().toISOString();
    await saveConversationRow({
      sessionId: id,
      botId: "loaded-bot",
      kind: "session",
      title: "Antiga",
      startedAt,
      source: "chat",
      sdkSessionId: "sdk-1",
      turnCount: 1,
      runCount: 1,
      usageTotals: null,
    });
    await appendEventRow(id, 1, startedAt, []);
    const kept = newSessionId();
    await saveConversationRow({
      sessionId: kept,
      botId: "loaded-bot",
      startedAt,
      sdkSessionId: "sdk-2",
      providerSessions: { "vps:codex": "c-1" },
    });
    await getDb().execute(
      sql`insert into conversations (session_id, bot_id, kind, title, source, started_at, updated_at, meta) values ('junk', 'loaded-bot', 'session', '', 'chat', now(), now(), '{}')`,
    );
    const every = spyOn(globalThis, "setInterval");
    await loadSessions();
    const [sweep, period] = every.mock.calls[0] as unknown as [() => unknown, number];
    clearInterval(every.mock.results[0].value as ReturnType<typeof setInterval>);
    every.mockRestore();
    expect(period).toBe(5 * 60_000);
    expect(sweep()).toBe(0);
    const loaded = getStoredSession(id);
    expect(loaded?.meta.providerSessions).toEqual({ "vps:claude": "sdk-1" });
    expect(loaded?.log.size).toBe(1);
    expect(await loaded?.log.lines()).toHaveLength(1);
    expect(getStoredSession(kept)?.meta.providerSessions).toEqual({ "vps:codex": "c-1" });
    expect(getStoredSession("junk")).toBeUndefined();
  });

  test("titleFrom collapses whitespace and clips at 80 characters", async () => {
    expect(titleFrom("  oi \n  tudo bem ")).toBe("oi tudo bem");
    const long = titleFrom("a".repeat(100));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("settleOrphanTurns", () => {
  test("cancels turns that started but never settled", async () => {
    const session = await createStoredSession({ botId: "orphan-bot", kind: "session", source: "chat", title: "" });
    session.log.emit({ type: "turn.started", data: { turnId: "turn_0" } });
    session.log.emit({ type: "turn.settled", data: { turnId: "turn_0", outcome: "completed" } });
    session.log.emit({ type: "turn.started", data: { turnId: "turn_1" } }, { type: "turn.started", data: {} });
    session.log.emit({ type: "call.started", data: { callId: "c" } });
    (await session.log.lines()).push('{"turn.broken"');
    const clean = await createStoredSession({ botId: "orphan-bot", kind: "session", source: "chat", title: "" });
    clean.log.emit({ type: "delivery.admitted", data: {} });
    expect(await settleOrphanTurns()).toBeGreaterThanOrEqual(1);
    const settled = await factsOfType(session, "turn.settled");
    expect(settled.at(-1)?.data).toEqual({ outcome: "cancelled", turnId: "turn_1", reason: "server_restart" });
    expect(await factsOfType(clean, "turn.settled")).toHaveLength(0);
    expect(await settleOrphanTurns()).toBe(0);
  });

  test("keeps going when the repaired session cannot be saved", async () => {
    const session = await createStoredSession({ botId: "orphan-bot", kind: "session", source: "chat", title: "" });
    session.log.emit({ type: "turn.started", data: { turnId: "turn_0" } });
    session.save = () => Promise.reject(new Error("disk full"));
    expect(await settleOrphanTurns()).toBe(1);
    expect(await factsOfType(session, "turn.settled")).toHaveLength(1);
  });
});

describe("threads", () => {
  test("ensureThread creates the main thread once, even when asked twice at the same time", async () => {
    const bot = await makeBot();
    const [first, second] = await Promise.all([ensureThread(bot.id), ensureThread(bot.id)]);
    expect(first).toBe(second);
    expect(await ensureThread(bot.id)).toBe(first);
    expect(await peekThread(bot.id)).toBe(first);
    const session = getStoredSession(first.sessionId);
    expect(session?.meta).toMatchObject({ kind: "thread", title: "Conversa principal" });
    expect((await factsOf(must(session)))[0]).toMatchObject({ type: "session.started", data: { thread: true } });
    expect(await readLiveThread(bot.id)).toEqual(first);
    expect(publicThread(first)).toEqual({ sessionId: first.sessionId, lastMessage: null, unread: 0, total: 1 });
    expect(publicThread(null)).toEqual({ sessionId: null, lastMessage: null, unread: 0, total: 0 });
  });

  test("peekThread reads a stored thread whose session exists and ignores stale ones", async () => {
    const session = await createStoredSession({ botId: "disk-bot", kind: "thread", source: "chat", title: "" });
    const state = { sessionId: session.meta.sessionId, lastMessage: null, unread: 2, readAt: null };
    await saveLiveThread("disk-bot", state);
    expect(await peekThread("disk-bot")).toEqual(state);
    await saveLiveThread("stale-bot", { ...state, sessionId: "wrun_gone" });
    expect(await peekThread("stale-bot")).toBeNull();
    expect(publicThread({ ...state, sessionId: "wrun_gone" }).total).toBe(0);
  });

  test("groups get a group thread", async () => {
    const state = await markThreadRead("grp_test_group");
    expect(getStoredSession(state.sessionId)?.meta).toMatchObject({ kind: "group", title: "Conversa do grupo" });
    expect(state.unread).toBe(0);
    expect(state.readAt).not.toBeNull();
  });

  test("recordThreadMessage updates the last message, unread count and the main title", async () => {
    const bot = await makeBot();
    const state = await ensureThread(bot.id);
    const session = must(getStoredSession(state.sessionId));
    await recordThreadMessage(bot.id, state.sessionId, {
      role: "user",
      text: "oi, pode montar o relatório?",
      at: "2026-01-01T00:00:01.000Z",
    });
    expect(session.meta.title).toBe("Montar o relatório");
    expect(state.lastMessage?.text).toBe("oi, pode montar o relatório?");
    await recordThreadMessage(bot.id, state.sessionId, { role: "bot", text: "feito", at: "2026-01-01T00:00:02.000Z" });
    await recordThreadMessage(
      bot.id,
      state.sessionId,
      { role: "bot", text: "quieto", at: "2026-01-01T00:00:03.000Z" },
      true,
    );
    expect(state.unread).toBe(1);
    await recordThreadMessage(bot.id, "wrun_other", { role: "bot", text: "x", at: "2026-01-01T00:00:04.000Z" });
    expect(state.lastMessage?.text).toBe("quieto");
    expect((await markThreadUnread(bot.id)).unread).toBe(1);
    expect((await markThreadRead(bot.id)).unread).toBe(0);
    expect((await markThreadUnread(bot.id)).unread).toBe(1);
  });

  test("recordThreadMessage on a conversation updates the conversation instead", async () => {
    const session = await createStoredSession({ botId: "conv-bot", kind: "conversation", source: "chat", title: "" });
    await recordThreadMessage("conv-bot", session.meta.sessionId, {
      role: "bot",
      text: "oi",
      at: "2026-01-01T00:00:09.000Z",
    });
    expect(session.meta.conversation).toMatchObject({ unread: 1, lastMessage: { text: "oi" } });
  });

  test("reset archives the current thread and restore brings it back", async () => {
    const bot = await makeBot();
    const original = await ensureThread(bot.id);
    const originalSession = must(getStoredSession(original.sessionId));
    originalSession.meta.scheduleSummaries = { diaria: "ok" };
    const { state: fresh, archiveId } = await resetThread(bot.id);
    expect(archiveId).toMatch(/^tha_/);
    expect(fresh.sessionId).not.toBe(original.sessionId);
    const freshSession = must(getStoredSession(fresh.sessionId));
    expect(freshSession.meta.scheduleSummaries).toEqual({ diaria: "ok" });
    freshSession.meta.scheduleSummaries = { diaria: "novo", semanal: "s" };
    expect(await restoreThread(bot.id, "tha_missing")).toBeNull();
    const restored = await restoreThread(bot.id, archiveId);
    expect(restored?.state.sessionId).toBe(original.sessionId);
    expect(restored?.replacedArchiveId).toBeNull();
    expect(originalSession.meta.scheduleSummaries).toEqual({ diaria: "novo", semanal: "s" });
    expect((await peekThread(bot.id))?.sessionId).toBe(original.sessionId);
    expect(await restoreThread(bot.id, archiveId)).toBeNull();
  });

  test("restoring over a thread with messages archives it first", async () => {
    const bot = await makeBot();
    const original = await ensureThread(bot.id);
    const { state: fresh, archiveId } = await resetThread(bot.id);
    must(getStoredSession(fresh.sessionId)).log.emit({ type: "delivery.consumed", data: {} });
    const restored = await restoreThread(bot.id, archiveId);
    expect(restored?.state.sessionId).toBe(original.sessionId);
    expect(restored?.replacedArchiveId).toMatch(/^tha_/);
  });

  test("restore without a current thread and with an archive whose session is gone", async () => {
    const session = await createStoredSession({ botId: "arch-bot", kind: "thread", source: "chat", title: "" });
    const state = { sessionId: session.meta.sessionId, lastMessage: null, unread: 0, readAt: null };
    await saveArchivedThread("arch-bot", "tha_01JAAAAAAAAAAAAAAAAAAAAAAA", "2026-01-01T00:00:00.000Z", state);
    const restored = await restoreThread("arch-bot", "tha_01JAAAAAAAAAAAAAAAAAAAAAAA");
    expect(restored).toEqual({ state, replacedArchiveId: null });
    expect(await readArchivedThread("arch-bot", "tha_01JAAAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(await readLiveThread("arch-bot")).toEqual(state);
    await saveArchivedThread("arch-bot", "tha_gone", "2026-01-01T00:00:00.000Z", { ...state, sessionId: "wrun_gone" });
    expect(await restoreThread("arch-bot", "tha_gone")).toBeNull();
    expect((await readArchivedThread("arch-bot", "tha_gone"))?.state.sessionId).toBe("wrun_gone");
    expect(await readArchivedThread("other-bot", "tha_gone")).toBeNull();
    await saveLiveThread("arch-bot", { sessionId: state.sessionId });
    expect(await readLiveThread("arch-bot")).toEqual({ ...state, lastMessage: null });
  });
});
