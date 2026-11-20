import { sql } from "drizzle-orm";
import { type Db, getDb, queryRows } from "../../../db";
import { headlineOptions, prefixQuery, searchTerms } from "../../../db/search";

export interface NoteSearchRow {
  id: string;
  title: string;
  folder: string;
  markdown: string;
  snippet: string;
  titleMarked: string;
}

export function noteSearchQuery(q: string, titleOnly = false) {
  const terms = searchTerms(q);
  return terms.length ? prefixQuery(terms, titleOnly ? "A" : "") : null;
}

export function noteMatches(query: string) {
  return sql`notes.search @@ to_tsquery('rb_search', ${query})`;
}

export async function searchNoteRows(
  botId: string,
  query: string,
  titleOnly: boolean,
  limit: number,
  offset: number,
  db: Db = getDb(),
) {
  const match = sql`n.bot_id = ${botId} and n.deleted_at is null and n.search @@ to_tsquery('rb_search', ${query})`;
  const order = titleOnly
    ? sql`length(n.title), n.title, n.id`
    : sql`ts_rank(n.search, to_tsquery('rb_search', ${query}), 1) desc, n.updated_at desc, n.id`;
  const [count] = await queryRows<{ count: number }>(
    sql`select count(*)::int as count from notes n where ${match}`,
    db,
  );
  const rows = await queryRows<NoteSearchRow>(
    sql`with hits as (
          select n.id, n.title, n.folder, n.markdown, row_number() over (order by ${order}) as position
          from notes n where ${match}
          order by ${order} limit ${limit} offset ${offset}
        )
        select hits.id, hits.title, hits.folder, hits.markdown,
          ts_headline('rb_search', hits.markdown, to_tsquery('rb_search', ${query}), ${headlineOptions(16)}) as snippet,
          ts_headline('rb_search', hits.title, to_tsquery('rb_search', ${query}), ${`${headlineOptions(200)}, HighlightAll=true`}) as "titleMarked"
        from hits order by hits.position`,
    db,
  );
  return { total: Number(count?.count ?? 0), rows };
}
