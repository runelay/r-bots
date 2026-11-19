import type { Statement } from "bun:sqlite";
import { type Db, getDb } from "../../../db";
import type { Json } from "../../../db/rows";
import type { SessionMeta } from "../services/sessions.service";

export interface EventRow {
  seq: number;
  at: string;
  types: string;
  facts: string;
}

export interface SearchHit {
  botId: string;
  sessionId: string;
  index: number;
  at: string;
  role: "user" | "bot" | null;
  snippet: string;
}

export interface SearchPage {
  hits: SearchHit[];
  nextCursor: number | null;
}

const unparsed = "legacy.unparsed";

export function messageOf(facts: unknown[]) {
  const texts: string[] = [];
  let role: "user" | "bot" | null = null;
  for (const fact of facts as { type?: string; data?: Json }[]) {
    if (fact?.type === "delivery.consumed") {
      const parts = (fact.data?.parts ?? []) as { kind?: string; text?: string }[];
      for (const part of parts) if (part.kind === "text" && part.text) texts.push(part.text);
      role ??= "user";
    } else if (fact?.type === "content.completed" && fact.data?.kind === "text" && typeof fact.data.value === "string") {
      texts.push(fact.data.value);
      role ??= "bot";
    }
  }
  return texts.length ? { role, text: texts.join("\n") } : { role: null, text: null };
}

export function factTypes(facts: unknown[]) {
  return (facts as { type?: string }[])
    .map((fact) => fact?.type)
    .filter(Boolean)
    .join(" ");
}

export function lineOf(row: Pick<EventRow, "at" | "types" | "facts">) {
  if (row.types === unparsed) {
    const [fact] = JSON.parse(row.facts) as { data?: { line?: string } }[];
    return String(fact?.data?.line ?? "");
  }
  return `{"at":${JSON.stringify(row.at)},"facts":${row.facts}}`;
}

export function parseLine(line: string): { at: string; facts: unknown[] } {
  try {
    const parsed = JSON.parse(line) as { at?: string; facts?: unknown[] };
    return { at: parsed.at ?? "", facts: Array.isArray(parsed.facts) ? parsed.facts : [] };
  } catch {
    return { at: "", facts: [{ type: unparsed, data: { line } }] };
  }
}

function conversationColumns(meta: SessionMeta | Json, lastAt?: string) {
  const value = meta as Json;
  const conversation = (value.conversation as Json | undefined) ?? {};
  return {
    sessionId: String(value.sessionId),
    botId: String(value.botId),
    kind: String(value.kind ?? "session"),
    title: String(value.title ?? ""),
    source: String(value.source ?? "chat"),
    scheduleId: (value.scheduleId as string | undefined) ?? null,
    startedAt: String(value.startedAt),
    updatedAt: String(conversation.updatedAt ?? lastAt ?? value.startedAt),
    archivedAt: (conversation.archivedAt as string | null | undefined) ?? null,
    unread: Number(conversation.unread ?? 0),
    readAt: (conversation.readAt as string | null | undefined) ?? null,
    lastMessage: conversation.lastMessage ? JSON.stringify(conversation.lastMessage) : null,
    turnCount: Number(value.turnCount ?? 0),
    runCount: Number(value.runCount ?? 0),
    meta: JSON.stringify(value),
  };
}

class Statements {
  readonly saveConversation: Statement;
  readonly insertEvent: Statement;
  readonly bumpSeq: Statement;
  readonly range: Statement<EventRow, [string, number, number]>;
  readonly lastAt: Statement<{ at: string }, [string]>;
  readonly all: Statement<{ meta: string; last_seq: number }, []>;

  constructor(readonly db: Db) {
    const client = db.$client;
    this.saveConversation = client.query(
      `INSERT INTO conversations (session_id, bot_id, kind, title, source, schedule_id, started_at, updated_at, archived_at, unread, read_at, last_message, turn_count, run_count, meta)
       VALUES ($sessionId, $botId, $kind, $title, $source, $scheduleId, $startedAt, $updatedAt, $archivedAt, $unread, $readAt, $lastMessage, $turnCount, $runCount, $meta)
       ON CONFLICT (session_id) DO UPDATE SET bot_id = excluded.bot_id, kind = excluded.kind, title = excluded.title, source = excluded.source,
         schedule_id = excluded.schedule_id, started_at = excluded.started_at, updated_at = excluded.updated_at, archived_at = excluded.archived_at,
         unread = excluded.unread, read_at = excluded.read_at, last_message = excluded.last_message, turn_count = excluded.turn_count,
         run_count = excluded.run_count, meta = excluded.meta`,
    );
    this.insertEvent = client.query(
      "INSERT INTO conversation_events (session_id, seq, at, types, role, text, facts) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, seq) DO NOTHING",
    );
    this.bumpSeq = client.query("UPDATE conversations SET last_seq = max(last_seq, ?) WHERE session_id = ?");
    this.range = client.query<EventRow, [string, number, number]>(
      "SELECT seq, at, types, facts FROM conversation_events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq",
    );
    this.lastAt = client.query<{ at: string }, [string]>(
      "SELECT at FROM conversation_events WHERE session_id = ? AND at != '' ORDER BY seq DESC LIMIT 1",
    );
    this.all = client.query<{ meta: string; last_seq: number }, []>(
      "SELECT meta, last_seq FROM conversations ORDER BY started_at",
    );
  }
}

let cached: Statements | null = null;

function statements(db: Db = getDb()) {
  if (!cached || cached.db !== db) cached = new Statements(db);
  return cached;
}

export function resetSessionStatements() {
  cached = null;
}

export function loadConversationRows(db?: Db) {
  return statements(db)
    .all.all()
    .map((row) => ({ meta: JSON.parse(row.meta) as SessionMeta, lastSeq: row.last_seq }));
}

export function saveConversationRow(meta: SessionMeta | Json, db?: Db, lastAt?: string) {
  statements(db).saveConversation.run(conversationColumns(meta, lastAt) as never);
}

export function appendEventRow(sessionId: string, seq: number, at: string, facts: unknown[], db?: Db) {
  const message = messageOf(facts);
  const current = statements(db);
  current.db.$client
    .transaction(() => {
      current.insertEvent.run(sessionId, seq, at, factTypes(facts), message.role, message.text, JSON.stringify(facts));
      current.bumpSeq.run(seq, sessionId);
    })
    .immediate();
}

export function eventRows(sessionId: string, afterSeq: number, uptoSeq: number, db?: Db) {
  return statements(db).range.all(sessionId, afterSeq, uptoSeq);
}

export function lastEventAt(sessionId: string, db?: Db) {
  return statements(db).lastAt.get(sessionId)?.at ?? null;
}

function ftsQuery(text: string) {
  const terms = text
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12);
  return terms.length ? terms.map((term) => `"${term}"*`).join(" ") : null;
}

export function searchMessages(
  input: { q: string; botId?: string; limit?: number; cursor?: number },
  db: Db = getDb(),
): SearchPage {
  const match = ftsQuery(input.q);
  if (!match) return { hits: [], nextCursor: null };
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));
  const cursor = input.cursor && input.cursor > 0 ? input.cursor : Number.MAX_SAFE_INTEGER;
  const rows = db.$client
    .query<
      { id: number; bot_id: string; session_id: string; seq: number; at: string; role: string | null; snippet: string },
      [string, number, string | null, string | null, number]
    >(
      `SELECT e.id, c.bot_id, e.session_id, e.seq, e.at, e.role, snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet
       FROM messages_fts
       JOIN conversation_events e ON e.id = messages_fts.rowid
       JOIN conversations c ON c.session_id = e.session_id
       WHERE messages_fts MATCH ? AND e.id < ? AND (? IS NULL OR c.bot_id = ?)
       ORDER BY e.id DESC
       LIMIT ?`,
    )
    .all(match, cursor, input.botId ?? null, input.botId ?? null, limit + 1);
  const page = rows.slice(0, limit);
  return {
    hits: page.map((row) => ({
      botId: row.bot_id,
      sessionId: row.session_id,
      index: row.seq - 1,
      at: row.at,
      role: row.role === "user" || row.role === "bot" ? row.role : null,
      snippet: row.snippet,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
