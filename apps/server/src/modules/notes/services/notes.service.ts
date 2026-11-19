import type {
  BlockAuthor,
  Note,
  NoteBacklink,
  NoteFolder,
  NoteLink,
  NotePatchOp,
  NotePreview,
  NoteSearchHit,
  NoteSummary,
  NoteTreeLevel,
  Page,
} from "@runelay-bots/protocol";
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { type Db, getDb, writeTransaction } from "../../../db";
import { noteLinks, notes } from "../../../db/tables";
import {
  BlockError,
  blockEvent,
  changedLines,
  clip,
  mergeRanges,
  newId,
  normalizeTitle,
  nowIso,
  pageArgs,
  pageOf,
  plainText,
  shouldMerge,
  staleCheck,
} from "../../blocks/services/blocks.shared";

type NoteRow = typeof notes.$inferSelect;

const linkPattern = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;
const tagPattern = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function db(): Db {
  return getDb();
}

export function cleanFolder(value: unknown) {
  return String(value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 300);
}

function cleanTitle(value: unknown) {
  const title = String(value ?? "")
    .replace(/[[\]|#\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (!title) throw new BlockError("Título é obrigatório.");
  return title;
}

export function parseLinks(markdown: string) {
  const titles = new Map<string, string>();
  for (const match of markdown.matchAll(linkPattern)) {
    const title = match[1].trim();
    if (title && !titles.has(normalizeTitle(title))) titles.set(normalizeTitle(title), title);
  }
  return [...titles.values()];
}

export function parseTags(markdown: string) {
  const body = markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const tags = new Set<string>();
  for (const match of body.matchAll(tagPattern)) tags.add(match[2].toLowerCase());
  return [...tags];
}

function excerptOf(markdown: string) {
  return clip(plainText(markdown), 160);
}

export function previewOf(row: Pick<NoteRow, "folder" | "markdown">): NotePreview {
  const lines = row.markdown.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (kept.length >= 14 || size + line.length + 1 > 600) break;
    kept.push(line);
    size += line.length + 1;
  }
  const excerpt = kept.join("\n") + (kept.length < lines.length ? "\n…" : "");
  const words = plainText(row.markdown).split(/\s+/).filter(Boolean).length;
  return { kind: "note", folder: row.folder, excerpt, words };
}

function summaryOf(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    folder: row.folder,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy as BlockAuthor,
    excerpt: excerptOf(row.markdown),
    tags: parseTags(row.markdown),
  };
}

function liveNotes(botId: string) {
  return and(eq(notes.botId, botId), isNull(notes.deletedAt)) as SQL;
}

function findByTitle(botId: string, title: string, folder?: string) {
  const rows = db()
    .select()
    .from(notes)
    .where(and(liveNotes(botId), sql`lower(${notes.title}) = ${normalizeTitle(title)}`))
    .orderBy(desc(notes.updatedAt))
    .all();
  if (folder !== undefined) {
    const same = rows.find((row) => row.folder === folder);
    if (same) return same;
  }
  return rows[0] ?? null;
}

export function requireNote(botId: string, noteId: string) {
  const row = db()
    .select()
    .from(notes)
    .where(and(liveNotes(botId), eq(notes.id, noteId)))
    .get();
  if (!row) throw new BlockError("Nota não encontrada.", 404);
  return row;
}

function backlinkCount(botId: string, row: NoteRow) {
  const result = db()
    .select({ count: sql<number>`count(*)` })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
    .where(
      and(
        liveNotes(botId),
        sql`(${noteLinks.targetId} = ${row.id} OR (${noteLinks.targetId} IS NULL AND lower(${noteLinks.targetTitle}) = ${normalizeTitle(row.title)}))`,
      ),
    )
    .get();
  return Number(result?.count ?? 0);
}

export function noteOf(botId: string, row: NoteRow): Note {
  const links: NoteLink[] = parseLinks(row.markdown).map((target) => {
    const found = findByTitle(botId, target, row.folder);
    return { target, id: found?.id ?? null, title: found?.title ?? target };
  });
  return { ...summaryOf(row), content: row.markdown, links, backlinkCount: backlinkCount(botId, row) };
}

function syncLinks(botId: string, row: Pick<NoteRow, "id" | "markdown" | "folder">) {
  db().delete(noteLinks).where(eq(noteLinks.sourceId, row.id)).run();
  const targets = parseLinks(row.markdown);
  if (!targets.length) return;
  db()
    .insert(noteLinks)
    .values(
      targets.map((target) => ({
        sourceId: row.id,
        targetTitle: target,
        targetId: findByTitle(botId, target, row.folder)?.id ?? null,
      })),
    )
    .run();
}

function relinkTitle(botId: string, title: string, id: string | null) {
  const sources = db()
    .select({ id: notes.id })
    .from(notes)
    .where(liveNotes(botId))
    .all()
    .map((item) => item.id);
  if (!sources.length) return;
  db()
    .update(noteLinks)
    .set({ targetId: id })
    .where(and(inArray(noteLinks.sourceId, sources), sql`lower(${noteLinks.targetTitle}) = ${normalizeTitle(title)}`))
    .run();
}

function ftsQuery(q: string, column?: "title") {
  const terms = q
    .normalize("NFC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12)
    .map((term) => `"${term.replace(/"/g, "")}"*`);
  if (!terms.length) return null;
  return column ? `${column} : (${terms.join(" ")})` : terms.join(" ");
}

function tagCondition(tag: string) {
  const clean = tag.replace(/^#/, "").toLowerCase().replace(/[%_]/g, "");
  const needle = `#${clean}`;
  return sql`(lower(${notes.markdown}) LIKE ${`%${needle}`} OR lower(${notes.markdown}) LIKE ${`%${needle} %`} OR lower(${notes.markdown}) LIKE ${`%${needle}\n%`} OR lower(${notes.markdown}) LIKE ${`%${needle},%`} OR lower(${notes.markdown}) LIKE ${`%${needle}.%`})`;
}

export function listNotes(botId: string, query: Record<string, unknown>): Page<NoteSummary> {
  const { limit, offset } = pageArgs(query.cursor, query.limit);
  const conditions: SQL[] = [liveNotes(botId)];
  if (query.folder !== undefined && query.folder !== null)
    conditions.push(eq(notes.folder, cleanFolder(query.folder)));
  const q = typeof query.q === "string" ? ftsQuery(query.q) : null;
  if (q) conditions.push(sql`${notes.id} IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ${q})`);
  if (typeof query.tag === "string" && query.tag.trim()) conditions.push(tagCondition(query.tag.trim()));
  const where = and(...conditions);
  const order = query.sort === "title" ? [asc(sql`lower(${notes.title})`)] : [desc(notes.updatedAt)];
  const total = Number(
    db()
      .select({ count: sql<number>`count(*)` })
      .from(notes)
      .where(where)
      .get()?.count ?? 0,
  );
  const rows = db()
    .select()
    .from(notes)
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset)
    .all();
  return pageOf(rows.map(summaryOf), total, offset, limit);
}

export function noteTree(botId: string, query: Record<string, unknown>): NoteTreeLevel {
  const folder = cleanFolder(query.folder);
  const all = db()
    .select({ folder: notes.folder, count: sql<number>`count(*)` })
    .from(notes)
    .where(liveNotes(botId))
    .groupBy(notes.folder)
    .all();
  const prefix = folder ? `${folder}/` : "";
  const children = new Map<string, NoteFolder>();
  for (const item of all) {
    if (!item.folder.startsWith(prefix) || item.folder === folder) continue;
    const name = item.folder.slice(prefix.length).split("/")[0];
    const path = `${prefix}${name}`;
    const entry = children.get(name) ?? { name, path, notes: 0, folders: 0 };
    children.set(name, entry);
  }
  for (const entry of children.values()) {
    const sub = new Set<string>();
    for (const item of all) {
      if (item.folder === entry.path) entry.notes = Number(item.count);
      else if (item.folder.startsWith(`${entry.path}/`))
        sub.add(item.folder.slice(entry.path.length + 1).split("/")[0]);
    }
    entry.folders = sub.size;
  }
  const folders = [...children.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return {
    folder,
    folders,
    notes: listNotes(botId, { folder, sort: "title", cursor: query.cursor, limit: query.limit }),
  };
}

function rangesOf(marked: string) {
  const ranges: Array<[number, number]> = [];
  let text = "";
  let start = -1;
  for (const char of marked) {
    if (char === "\u0001") start = text.length;
    else if (char === "\u0002") {
      if (start >= 0) ranges.push([start, text.length]);
      start = -1;
    } else text += char;
  }
  return { text, ranges };
}

export function searchNotes(botId: string, query: Record<string, unknown>): Page<NoteSearchHit> {
  const titleOnly = query.mode === "title";
  const { limit, offset } = pageArgs(query.cursor, query.limit, titleOnly ? 8 : 50);
  const q = typeof query.q === "string" ? ftsQuery(query.q, titleOnly ? "title" : undefined) : null;
  if (!q) return pageOf([], 0, offset, limit);
  const sqlite = db().$client;
  const params = { $q: q, $bot: botId };
  const total = Number(
    sqlite
      .query<{ count: number }, Record<string, string>>(
        "SELECT count(*) AS count FROM notes_fts f JOIN notes n ON n.id = f.note_id WHERE notes_fts MATCH $q AND n.bot_id = $bot AND n.deleted_at IS NULL",
      )
      .get(params)?.count ?? 0,
  );
  const rows = sqlite
    .query<
      { id: string; title: string; folder: string; snippet: string; titleMarked: string },
      Record<string, string | number>
    >(
      `SELECT n.id, n.title, n.folder, snippet(notes_fts, 2, char(1), char(2), '…', 16) AS snippet, highlight(notes_fts, 1, char(1), char(2)) AS titleMarked FROM notes_fts f JOIN notes n ON n.id = f.note_id WHERE notes_fts MATCH $q AND n.bot_id = $bot AND n.deleted_at IS NULL ORDER BY ${titleOnly ? "length(n.title), n.title" : "bm25(notes_fts, 0, 4.0, 1.0)"} LIMIT $limit OFFSET $offset`,
    )
    .all({ ...params, $limit: limit, $offset: offset });
  const items = rows.map((row) => {
    if (titleOnly) {
      const { ranges } = rangesOf(row.titleMarked);
      return { id: row.id, title: row.title, folder: row.folder, snippet: "", ranges };
    }
    const hasBodyHit = row.snippet.includes("\u0001");
    const { text, ranges } = rangesOf((hasBodyHit ? row.snippet : row.titleMarked).replace(/\s+/g, " "));
    return { id: row.id, title: row.title, folder: row.folder, snippet: text, ranges };
  });
  return pageOf(items, total, offset, limit);
}

export function resolveNote(botId: string, title: string, folder?: string) {
  const row = findByTitle(botId, cleanTitle(title), folder === undefined ? undefined : cleanFolder(folder));
  if (!row) throw new BlockError("Nota não encontrada.", 404);
  return noteOf(botId, row);
}

export function noteBacklinks(botId: string, noteId: string, query: Record<string, unknown>): Page<NoteBacklink> {
  const row = requireNote(botId, noteId);
  const { limit, offset } = pageArgs(query.cursor, query.limit);
  const where = and(
    liveNotes(botId),
    sql`(${noteLinks.targetId} = ${row.id} OR (${noteLinks.targetId} IS NULL AND lower(${noteLinks.targetTitle}) = ${normalizeTitle(row.title)}))`,
  );
  const total = Number(
    db()
      .select({ count: sql<number>`count(*)` })
      .from(noteLinks)
      .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
      .where(where)
      .get()?.count ?? 0,
  );
  const sources = db()
    .select()
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
    .where(where)
    .orderBy(desc(notes.updatedAt))
    .limit(limit)
    .offset(offset)
    .all();
  const items = sources.map(({ notes: source, note_links: link }) => {
    const needle = `[[${link.targetTitle.toLowerCase()}`;
    const line = source.markdown.split("\n").find((item) => item.toLowerCase().includes(needle)) ?? "";
    return { id: source.id, title: source.title, folder: source.folder, snippet: clip(line.trim(), 240) };
  });
  return pageOf(items, total, offset, limit);
}

function assertUnique(botId: string, title: string, folder: string, except?: string) {
  const clash = db()
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        liveNotes(botId),
        eq(notes.folder, folder),
        sql`lower(${notes.title}) = ${normalizeTitle(title)}`,
        except ? sql`${notes.id} <> ${except}` : undefined,
      ),
    )
    .get();
  if (clash) throw new BlockError("Já existe uma nota com esse título nessa pasta.", 409, "exists", { id: clash.id });
}

export interface NoteWrite {
  note: Note;
  event: ReturnType<typeof blockEvent>;
}

export function createNote(botId: string, body: Record<string, unknown>, author: BlockAuthor): NoteWrite {
  const title = cleanTitle(body.title);
  const folder = cleanFolder(body.folder);
  const markdown = String(body.content ?? "");
  return writeTransaction(() => {
    assertUnique(botId, title, folder);
    const at = nowIso();
    const row: NoteRow = {
      id: newId("note"),
      botId,
      folder,
      title,
      markdown,
      version: 1,
      updatedBy: author,
      seenVersion: author === "bot" ? 1 : 0,
      notifiedVersion: 0,
      userChanges: author === "user" && markdown ? [[0, markdown.split("\n").length - 1]] : null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    db().insert(notes).values(row).run();
    syncLinks(botId, row);
    relinkTitle(botId, title, row.id);
    const changed = markdown ? { lines: [[0, markdown.split("\n").length - 1]] as Array<[number, number]> } : undefined;
    return {
      note: noteOf(botId, row),
      event: blockEvent("note", row.id, title, 1, author, "created", previewOf(row), changed),
    };
  });
}

function saveContent(
  botId: string,
  current: NoteRow,
  next: { markdown: string; title?: string },
  author: BlockAuthor,
  baseVersion: unknown,
): NoteWrite {
  staleCheck(current, baseVersion, author);
  const title = next.title === undefined ? current.title : cleanTitle(next.title);
  if (title !== current.title) assertUnique(botId, title, current.folder, current.id);
  const lines = changedLines(current.markdown, next.markdown);
  const merge = shouldMerge(current, author);
  const version = merge ? current.version : current.version + 1;
  const pending = author === "user" ? mergeRanges([...((current.userChanges as Array<[number, number]>) ?? []), ...lines]) : null;
  const updated: NoteRow = {
    ...current,
    title,
    markdown: next.markdown,
    version,
    updatedBy: author,
    updatedAt: nowIso(),
    seenVersion: author === "bot" ? version : current.seenVersion,
    userChanges: author === "bot" ? null : pending,
  };
  db()
    .update(notes)
    .set({
      title: updated.title,
      markdown: updated.markdown,
      version: updated.version,
      updatedBy: updated.updatedBy,
      updatedAt: updated.updatedAt,
      seenVersion: updated.seenVersion,
      userChanges: updated.userChanges,
    })
    .where(eq(notes.id, current.id))
    .run();
  syncLinks(botId, updated);
  if (title !== current.title) {
    relinkTitle(botId, current.title, findByTitle(botId, current.title)?.id ?? null);
    relinkTitle(botId, title, updated.id);
  }
  return {
    note: noteOf(botId, updated),
    event: blockEvent(
      "note",
      updated.id,
      updated.title,
      updated.version,
      author,
      "edited",
      previewOf(updated),
      lines.length ? { lines } : undefined,
    ),
  };
}

export function writeNote(
  botId: string,
  noteId: string,
  body: Record<string, unknown>,
  author: BlockAuthor,
): NoteWrite {
  if (typeof body.content !== "string") throw new BlockError("content é obrigatório.");
  return writeTransaction(() =>
    saveContent(
      botId,
      requireNote(botId, noteId),
      { markdown: body.content as string, ...(body.title !== undefined ? { title: String(body.title) } : {}) },
      author,
      body.baseVersion,
    ),
  );
}

export function applyOps(markdown: string, ops: NotePatchOp[]) {
  let text = markdown;
  for (const [index, op] of ops.entries()) {
    const where = `op ${index + 1}`;
    if (op.op === "replace") {
      const old = String(op.old ?? "");
      if (!old) throw new BlockError(`${where}: "old" vazio.`);
      const first = text.indexOf(old);
      if (first < 0) throw new BlockError(`${where}: o trecho não foi encontrado.`);
      if (text.indexOf(old, first + 1) >= 0) throw new BlockError(`${where}: o trecho aparece mais de uma vez.`);
      text = text.slice(0, first) + String(op.new ?? "") + text.slice(first + old.length);
    } else if (op.op === "append") {
      const add = String(op.text ?? "");
      text = text && !text.endsWith("\n") ? `${text}\n${add}` : `${text}${add}`;
    } else if (op.op === "prepend") {
      const add = String(op.text ?? "");
      text = add.endsWith("\n") || !text ? `${add}${text}` : `${add}\n${text}`;
    } else if (op.op === "insert_after_heading") {
      const lines = text.split("\n");
      const wanted = normalizeTitle(String(op.heading ?? "").replace(/^#+\s*/, ""));
      const at = lines.findIndex((line) => /^#{1,6}\s/.test(line) && normalizeTitle(line.replace(/^#+\s*/, "")) === wanted);
      if (at < 0) throw new BlockError(`${where}: o título "${op.heading}" não foi encontrado.`);
      const level = lines[at].match(/^#+/)?.[0].length ?? 1;
      let end = at + 1;
      while (end < lines.length) {
        const heading = lines[end].match(/^(#{1,6})\s/);
        if (heading && heading[1].length <= level) break;
        end++;
      }
      while (end > at + 1 && lines[end - 1].trim() === "") end--;
      lines.splice(end, 0, ...String(op.text ?? "").split("\n"));
      text = lines.join("\n");
    } else if (op.op === "toggle_task") {
      const lines = text.split("\n");
      const line = Number(op.line);
      const current = lines[line];
      if (current === undefined || !/^\s*[-*+]\s+\[[ xX]\]/.test(current))
        throw new BlockError(`${where}: a linha ${line} não é uma tarefa.`);
      lines[line] = current.replace(/\[[ xX]\]/, op.done ? "[x]" : "[ ]");
      text = lines.join("\n");
    } else throw new BlockError(`${where}: operação desconhecida.`);
  }
  return text;
}

export function patchNote(botId: string, noteId: string, body: Record<string, unknown>, author: BlockAuthor) {
  const ops = body.ops;
  if (!Array.isArray(ops) || !ops.length) throw new BlockError("ops é obrigatório.");
  return writeTransaction(() => {
    const current = requireNote(botId, noteId);
    const markdown = applyOps(current.markdown, ops as NotePatchOp[]);
    return saveContent(botId, current, { markdown }, author, body.baseVersion);
  });
}

function rewriteLinks(markdown: string, from: string, to: string) {
  let count = 0;
  const next = markdown.replace(linkPattern, (whole, target: string, section?: string, alias?: string) => {
    if (normalizeTitle(target) !== normalizeTitle(from)) return whole;
    count++;
    return `[[${to}${section ?? ""}${alias ?? ""}]]`;
  });
  return { next, count };
}

export function moveNote(botId: string, noteId: string, body: Record<string, unknown>, author: BlockAuthor) {
  return writeTransaction(() => {
    const current = requireNote(botId, noteId);
    const folder = body.folder === undefined ? current.folder : cleanFolder(body.folder);
    const title = body.title === undefined ? current.title : cleanTitle(body.title);
    if (folder === current.folder && title === current.title)
      return { note: noteOf(botId, current), relinked: 0, event: null };
    assertUnique(botId, title, folder, current.id);
    const version = current.version + 1;
    const at = nowIso();
    db()
      .update(notes)
      .set({
        folder,
        title,
        version,
        updatedBy: author,
        updatedAt: at,
        ...(author === "bot" ? { seenVersion: version } : {}),
      })
      .where(eq(notes.id, current.id))
      .run();
    let relinked = 0;
    if (title !== current.title) {
      const sources = db()
        .select()
        .from(noteLinks)
        .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
        .where(and(liveNotes(botId), sql`lower(${noteLinks.targetTitle}) = ${normalizeTitle(current.title)}`))
        .all();
      for (const { notes: source } of sources) {
        const fresh = source.id === current.id ? requireNote(botId, current.id) : source;
        const { next, count } = rewriteLinks(fresh.markdown, current.title, title);
        if (!count) continue;
        const sourceVersion = fresh.version + 1;
        db()
          .update(notes)
          .set({ markdown: next, version: sourceVersion, updatedAt: at, updatedBy: author })
          .where(eq(notes.id, fresh.id))
          .run();
        syncLinks(botId, { ...fresh, markdown: next });
        relinked++;
      }
      relinkTitle(botId, title, current.id);
      relinkTitle(botId, current.title, findByTitle(botId, current.title)?.id ?? null);
    }
    const row = requireNote(botId, current.id);
    return {
      note: noteOf(botId, row),
      relinked,
      event: blockEvent("note", row.id, row.title, row.version, author, "edited", previewOf(row)),
    };
  });
}

export function deleteNote(botId: string, noteId: string, author: BlockAuthor) {
  return writeTransaction(() => {
    const current = requireNote(botId, noteId);
    const version = current.version + 1;
    db()
      .update(notes)
      .set({ deletedAt: nowIso(), version, updatedBy: author, updatedAt: nowIso() })
      .where(eq(notes.id, current.id))
      .run();
    db().update(noteLinks).set({ targetId: null }).where(eq(noteLinks.targetId, current.id)).run();
    return blockEvent("note", current.id, current.title, version, author, "deleted", null);
  });
}

export function readNoteForBot(botId: string, noteId: string) {
  const row = requireNote(botId, noteId);
  if (row.seenVersion < row.version)
    db().update(notes).set({ seenVersion: row.version, userChanges: null }).where(eq(notes.id, row.id)).run();
  return noteOf(botId, row);
}

export function noteEditNote(botId: string) {
  const rows = db()
    .select()
    .from(notes)
    .where(
      and(
        liveNotes(botId),
        eq(notes.updatedBy, "user"),
        sql`${notes.version} > ${notes.seenVersion}`,
        sql`${notes.version} > ${notes.notifiedVersion}`,
      ),
    )
    .orderBy(desc(notes.updatedAt))
    .limit(20)
    .all();
  const lines = rows.map((row) => {
    db().update(notes).set({ notifiedVersion: row.version }).where(eq(notes.id, row.id)).run();
    const ranges = (row.userChanges as Array<[number, number]> | null) ?? [];
    const where = ranges.length
      ? `linhas ${ranges.map(([start, end]) => (start === end ? `${start + 1}` : `${start + 1}–${end + 1}`)).join(", ")} mudaram`
      : "o conteúdo mudou";
    return `- A nota "${row.title}" (${row.id}) foi editada pela pessoa: ${where}; use note_read antes de mudar.`;
  });
  return lines;
}
