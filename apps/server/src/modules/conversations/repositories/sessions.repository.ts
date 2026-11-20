import { sql } from "drizzle-orm";
import { type Db, getDb, queryRows } from "../../../db";
import type { Json } from "../../../db/rows";
import { headlineOptions, markers, prefixQuery, searchTerms, withEllipsis } from "../../../db/search";
import { conversations } from "../../../db/tables";
import type { SessionMeta } from "../services/sessions.service";

export interface EventRow {
  seq: number;
  at: string;
  types: string;
  facts: string;
}

type StoredEvent = {
  seq: number;
  at: string | Date | null;
  types: string;
  facts: string;
};

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
    } else if (
      fact?.type === "content.completed" &&
      fact.data?.kind === "text" &&
      typeof fact.data.value === "string"
    ) {
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
    lastMessage: (conversation.lastMessage as Json | undefined) ?? null,
    turnCount: Number(value.turnCount ?? 0),
    runCount: Number(value.runCount ?? 0),
    meta: value,
  };
}

function isoOrEmpty(value: string | Date | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function eventOf(row: StoredEvent): EventRow {
  return { seq: Number(row.seq), at: isoOrEmpty(row.at), types: row.types, facts: row.facts };
}

export async function loadConversationRows(db: Db = getDb()) {
  const rows = await db
    .select({
      meta: conversations.meta,
      lastSeq: conversations.lastSeq,
      lastAt: sql<
        string | Date | null
      >`(select e.at from conversation_events e where e.session_id = conversations.session_id and e.at is not null order by e.seq desc limit 1)`,
    })
    .from(conversations)
    .orderBy(conversations.startedAt);
  return rows.map((row) => ({
    meta: row.meta as unknown as SessionMeta,
    lastSeq: row.lastSeq,
    lastAt: row.lastAt ? isoOrEmpty(row.lastAt) : null,
  }));
}

export async function saveConversationRow(meta: SessionMeta | Json, db: Db = getDb(), lastAt?: string) {
  const { sessionId, ...columns } = conversationColumns(meta, lastAt);
  await db
    .insert(conversations)
    .values({ sessionId, ...columns })
    .onConflictDoUpdate({ target: conversations.sessionId, set: columns });
}

export async function appendEventRow(sessionId: string, seq: number, at: string, facts: unknown[], db: Db = getDb()) {
  const message = messageOf(facts);
  const text = message.text?.replaceAll("\u0000", "\uFFFD") ?? null;
  await db.execute(
    sql`with inserted as (
      insert into conversation_events (session_id, seq, at, types, role, text, facts)
      values (${sessionId}, ${seq}, ${at || null}, ${factTypes(facts)}, ${message.role}, ${text}, ${JSON.stringify(facts)}::text::json)
      on conflict (session_id, seq) do nothing
    )
    update conversations set last_seq = greatest(last_seq, ${seq}) where session_id = ${sessionId}`,
  );
}

export async function eventRows(sessionId: string, afterSeq: number, uptoSeq: number, db: Db = getDb()) {
  const rows = await queryRows<StoredEvent>(
    sql`select seq, at, types, facts::text as facts from conversation_events
        where session_id = ${sessionId} and seq > ${afterSeq} and seq <= ${uptoSeq} order by seq`,
    db,
  );
  return rows.map(eventOf);
}

export async function lastEventAt(sessionId: string, db: Db = getDb()) {
  const [row] = await queryRows<{ at: string | Date }>(
    sql`select at from conversation_events where session_id = ${sessionId} and at is not null order by seq desc limit 1`,
    db,
  );
  return row ? isoOrEmpty(row.at) : null;
}

export async function searchMessages(
  input: { q: string; botId?: string; limit?: number; cursor?: number },
  db: Db = getDb(),
): Promise<SearchPage> {
  const terms = searchTerms(input.q);
  if (!terms.length) return { hits: [], nextCursor: null };
  const query = prefixQuery(terms);
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));
  const cursor = input.cursor && input.cursor > 0 ? input.cursor : Number.MAX_SAFE_INTEGER;
  const rows = await queryRows<{
    id: string | number;
    bot_id: string;
    session_id: string;
    seq: number;
    at: string | Date | null;
    role: string | null;
    text: string;
    headline: string;
  }>(
    sql`with hits as (
          select e.id, c.bot_id, e.session_id, e.seq, e.at, e.role, e.text
          from conversation_events e
          join conversations c on c.session_id = e.session_id
          where e.text is not null and e.search @@ to_tsquery('rb_search', ${query})
            and e.id < ${cursor} and (${input.botId ?? null}::text is null or c.bot_id = ${input.botId ?? null})
          order by e.id desc
          limit ${limit + 1}
        )
        select hits.*, ts_headline('rb_search', hits.text, to_tsquery('rb_search', ${query}), ${headlineOptions(16)}) as headline
        from hits order by hits.id desc`,
    db,
  );
  const page = rows.slice(0, limit);
  return {
    hits: page.map((row) => ({
      botId: row.bot_id,
      sessionId: row.session_id,
      index: Number(row.seq) - 1,
      at: isoOrEmpty(row.at),
      role: row.role === "user" || row.role === "bot" ? row.role : null,
      snippet: withEllipsis(row.headline, row.text).replaceAll(markers.open, "[").replaceAll(markers.close, "]"),
    })),
    nextCursor: rows.length > limit ? Number(page.at(-1)?.id ?? 0) || null : null,
  };
}
