import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../../db";
import {
  appendEventRow,
  eventRows,
  factTypes,
  lastEventAt,
  lineOf,
  loadConversationRows,
  messageOf,
  resetSessionStatements,
  saveConversationRow,
  searchMessages,
} from "../repositories/sessions.repository";

function seed(sessionId: string, botId: string, db: ReturnType<typeof openDatabase>) {
  saveConversationRow(
    {
      sessionId,
      botId,
      startedAt: "2030-01-01T00:00:00.000Z",
      conversation: { lastMessage: { role: "user", text: "oi" }, unread: 2, readAt: "r", archivedAt: "a" },
    },
    db,
  );
}

function said(text: string) {
  return [{ type: "delivery.consumed", data: { parts: [{ kind: "text", text }] } }];
}

function answered(text: string) {
  return [{ type: "content.completed", data: { kind: "text", value: text } }];
}

describe("messageOf and factTypes", () => {
  test("joins user parts and bot text and keeps the first role", () => {
    expect(
      messageOf([
        ...said("pergunta"),
        { type: "delivery.consumed", data: { parts: [{ kind: "file" }, { kind: "text" }] } },
        { type: "delivery.consumed" },
        ...answered("resposta"),
        { type: "content.completed", data: { kind: "image", value: "x" } },
        { type: "content.completed", data: { kind: "text", value: 1 } },
        null,
      ]),
    ).toEqual({ role: "user", text: "pergunta\nresposta" });
    expect(messageOf(answered("só bot"))).toEqual({ role: "bot", text: "só bot" });
    expect(messageOf([{ type: "turn.started" }])).toEqual({ role: null, text: null });
    expect(factTypes([{ type: "a" }, {}, null, { type: "b" }])).toBe("a b");
  });

  test("lineOf rebuilds stored lines and returns an empty unparsed line as blank", () => {
    expect(lineOf({ at: "t", types: "a", facts: "[]" })).toBe('{"at":"t","facts":[]}');
    expect(lineOf({ at: "", types: "legacy.unparsed", facts: "[{}]" })).toBe("");
  });
});

describe("conversation rows", () => {
  test("stores the conversation columns with defaults and the last event time", () => {
    const db = openDatabase(":memory:");
    seed("s1", "b1", db);
    saveConversationRow({ sessionId: "s2", botId: "b1", startedAt: "2029-01-01T00:00:00.000Z" }, db, "2031-01-01");
    const row = db.$client
      .query<Record<string, unknown>, []>(
        "SELECT kind, title, source, updated_at, archived_at, unread, read_at, last_message FROM conversations WHERE session_id = 's1'",
      )
      .get();
    expect(row).toEqual({
      kind: "session",
      title: "",
      source: "chat",
      updated_at: "2030-01-01T00:00:00.000Z",
      archived_at: "a",
      unread: 2,
      read_at: "r",
      last_message: JSON.stringify({ role: "user", text: "oi" }),
    });
    expect(
      db.$client.query<{ updated_at: string }, []>("SELECT updated_at FROM conversations WHERE session_id = 's2'").get(),
    ).toEqual({ updated_at: "2031-01-01" });
    expect(loadConversationRows(db).map((item) => [item.meta.sessionId, item.lastSeq])).toEqual([
      ["s2", 0],
      ["s1", 0],
    ]);
  });

  test("appends events once per sequence and reads ranges and the last time", () => {
    const db = openDatabase(":memory:");
    seed("s1", "b1", db);
    appendEventRow("s1", 1, "t1", said("um"), db);
    appendEventRow("s1", 1, "t9", said("repetido"), db);
    appendEventRow("s1", 2, "", [], db);
    expect(eventRows("s1", 0, 5, db).map((row) => [row.seq, row.at])).toEqual([
      [1, "t1"],
      [2, ""],
    ]);
    expect(lastEventAt("s1", db)).toBe("t1");
    expect(lastEventAt("none", db)).toBeNull();
    expect(loadConversationRows(db)[0].lastSeq).toBe(2);
    resetSessionStatements();
    expect(eventRows("s1", 1, 5, db).map((row) => row.seq)).toEqual([2]);
  });
});

describe("searchMessages", () => {
  test("finds messages by accent-free prefix, per bot, newest first and in pages", () => {
    const db = openDatabase(":memory:");
    seed("s1", "b1", db);
    seed("s2", "b2", db);
    appendEventRow("s1", 1, "t1", said("Relatório de produção"), db);
    appendEventRow("s1", 2, "t2", answered("produção ok"), db);
    appendEventRow("s2", 1, "t3", said("produção no outro bot"), db);
    appendEventRow("s2", 2, "t4", [{ type: "turn.started" }], db);
    const all = searchMessages({ q: "produc", limit: 2 }, db);
    expect(all.hits.map((hit) => [hit.botId, hit.sessionId, hit.index, hit.at, hit.role])).toEqual([
      ["b2", "s2", 0, "t3", "user"],
      ["b1", "s1", 1, "t2", "bot"],
    ]);
    expect(all.hits[0].snippet).toContain("[produção]");
    expect(all.nextCursor).not.toBeNull();
    const next = searchMessages({ q: "produc", limit: 2, cursor: all.nextCursor! }, db);
    expect(next.hits.map((hit) => hit.at)).toEqual(["t1"]);
    expect(next.nextCursor).toBeNull();
    expect(searchMessages({ q: "produção", botId: "b1", limit: 0 }, db).hits).toHaveLength(1);
    expect(searchMessages({ q: "produc", botId: "b1", cursor: -1, limit: 500 }, db).hits).toHaveLength(2);
    expect(searchMessages({ q: "  !! ", botId: "b1" }, db)).toEqual({ hits: [], nextCursor: null });
  });

  test("hides an unknown role", () => {
    const db = openDatabase(":memory:");
    seed("s1", "b1", db);
    db.$client.run(
      "INSERT INTO conversation_events (session_id, seq, at, types, role, text, facts) VALUES ('s1', 1, 't', '', 'system', 'aviso geral', '[]')",
    );
    expect(searchMessages({ q: "aviso" }, db).hits.map((hit) => hit.role)).toEqual([null]);
  });

  test("uses the shared database by default", () => {
    expect(searchMessages({ q: "zzzz-nada-zzzz" })).toEqual({ hits: [], nextCursor: null });
  });
});
