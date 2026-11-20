import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { freshDb } from "../../../../test/db-helpers";
import { type Db, queryRows } from "../../../db";
import {
  appendEventRow,
  eventRows,
  factTypes,
  lastEventAt,
  lineOf,
  loadConversationRows,
  messageOf,
  saveConversationRow,
  searchMessages,
} from "../repositories/sessions.repository";

const t = (minute: number) => new Date(Date.UTC(2030, 0, 1, 0, minute)).toISOString();

async function seed(sessionId: string, botId: string, db: Db) {
  await saveConversationRow(
    {
      sessionId,
      botId,
      startedAt: t(0),
      conversation: { lastMessage: { role: "user", text: "oi" }, unread: 2, readAt: t(1), archivedAt: t(2) },
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
  test("stores the conversation columns with defaults and the last event time", async () => {
    const db = await freshDb();
    await seed("s1", "b1", db);
    await saveConversationRow({ sessionId: "s2", botId: "b1", startedAt: t(30) }, db, t(40));
    const [row] = await queryRows<Record<string, unknown>>(
      sql`select kind, title, source, updated_at, archived_at, unread, read_at, last_message from conversations where session_id = 's1'`,
      db,
    );
    expect(row).toEqual({
      kind: "session",
      title: "",
      source: "chat",
      updated_at: new Date(t(0)),
      archived_at: new Date(t(2)),
      unread: 2,
      read_at: new Date(t(1)),
      last_message: { role: "user", text: "oi" },
    });
    const [other] = await queryRows<{ updated_at: Date }>(
      sql`select updated_at from conversations where session_id = 's2'`,
      db,
    );
    expect(other.updated_at).toEqual(new Date(t(40)));
    await appendEventRow("s1", 1, t(5), said("x"), db);
    expect((await loadConversationRows(db)).map((item) => [item.meta.sessionId, item.lastSeq, item.lastAt])).toEqual([
      ["s1", 1, t(5)],
      ["s2", 0, null],
    ]);
  });

  test("appends events once per sequence, keeps the facts text and reads ranges and the last time", async () => {
    const db = await freshDb();
    await seed("s1", "b1", db);
    await appendEventRow("s1", 1, t(1), said("um \u0000 dois"), db);
    await appendEventRow("s1", 1, t(9), said("repetido"), db);
    await appendEventRow("s1", 2, "", [{ type: "x", data: { order: 1, a: 2 } }], db);
    const rows = await eventRows("s1", 0, 5, db);
    expect(rows.map((row) => [row.seq, row.at])).toEqual([
      [1, t(1)],
      [2, ""],
    ]);
    expect(rows[1].facts).toBe('[{"type":"x","data":{"order":1,"a":2}}]');
    const [text] = await queryRows<{ text: string }>(sql`select text from conversation_events where seq = 1`, db);
    expect(text.text).toBe("um � dois");
    expect(await lastEventAt("s1", db)).toBe(t(1));
    expect(await lastEventAt("none", db)).toBeNull();
    expect((await loadConversationRows(db))[0].lastSeq).toBe(2);
    expect((await eventRows("s1", 1, 5, db)).map((row) => row.seq)).toEqual([2]);
  });
});

describe("searchMessages", () => {
  test("finds messages by accent-free prefix, per bot, newest first and in pages", async () => {
    const db = await freshDb();
    await seed("s1", "b1", db);
    await seed("s2", "b2", db);
    await appendEventRow("s1", 1, t(1), said("Relatório de produção"), db);
    await appendEventRow("s1", 2, t(2), answered("produção ok"), db);
    await appendEventRow("s2", 1, t(3), said("produção no outro bot"), db);
    await appendEventRow("s2", 2, t(4), [{ type: "turn.started" }], db);
    const all = await searchMessages({ q: "produc", limit: 2 }, db);
    expect(all.hits.map((hit) => [hit.botId, hit.sessionId, hit.index, hit.at, hit.role])).toEqual([
      ["b2", "s2", 0, t(3), "user"],
      ["b1", "s1", 1, t(2), "bot"],
    ]);
    expect(all.hits[0].snippet).toBe("[produção] no outro bot");
    expect(all.nextCursor).not.toBeNull();
    const next = await searchMessages({ q: "PRODUCAO", limit: 2, cursor: all.nextCursor ?? 0 }, db);
    expect(next.hits.map((hit) => hit.at)).toEqual([t(1)]);
    expect(next.hits[0].snippet).toBe("Relatório de [produção]");
    expect(next.nextCursor).toBeNull();
    expect((await searchMessages({ q: "produção", botId: "b1", limit: 0 }, db)).hits).toHaveLength(1);
    expect((await searchMessages({ q: "produc", botId: "b1", cursor: -1, limit: 500 }, db)).hits).toHaveLength(2);
    expect((await searchMessages({ q: "relat prod" }, db)).hits).toHaveLength(1);
    await appendEventRow("s2", 3, t(5), said("/Pr summary e snake_case"), db);
    expect((await searchMessages({ q: "pr summ" }, db)).hits.map((hit) => hit.index)).toEqual([2]);
    expect((await searchMessages({ q: "case" }, db)).hits).toHaveLength(1);
    expect(await searchMessages({ q: "  !! ", botId: "b1" }, db)).toEqual({ hits: [], nextCursor: null });
  });

  test("clips long messages with an ellipsis and hides an unknown role", async () => {
    const db = await freshDb();
    await seed("s1", "b1", db);
    const long = `${"palavra ".repeat(30)}achado ${"resto ".repeat(30)}`.trim();
    await appendEventRow("s1", 1, t(1), said(long), db);
    await db.execute(
      sql`insert into conversation_events (session_id, seq, at, types, role, text, facts) values ('s1', 2, now(), '', 'system', 'aviso geral', '[]')`,
    );
    const [hit] = (await searchMessages({ q: "achado" }, db)).hits;
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(true);
    expect(hit.snippet).toContain("[achado]");
    expect((await searchMessages({ q: "aviso" }, db)).hits.map((item) => item.role)).toEqual([null]);
  });

  test("uses the shared database by default", async () => {
    expect(await searchMessages({ q: "zzzz-nada-zzzz" })).toEqual({ hits: [], nextCursor: null });
  });
});
