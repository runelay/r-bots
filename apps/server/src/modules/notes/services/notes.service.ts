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
import { markers, withEllipsis } from "../../../db/search";
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
import { noteMatches, noteSearchQuery, searchNoteRows } from "../repositories/notes-search.repository";

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

async function findByTitle(botId: string, title: string, folder?: string) {
  const rows = await db()
    .select()
    .from(notes)
    .where(and(liveNotes(botId), sql`lower(${notes.title}) = ${normalizeTitle(title)}`))
    .orderBy(desc(notes.updatedAt));
  if (folder !== undefined) {
    const same = rows.find((row) => row.folder === folder);
    if (same) return same;
  }
  return rows[0] ?? null;
}

export async function requireNote(botId: string, noteId: string) {
  const [row] = await db()
    .select()
    .from(notes)
    .where(and(liveNotes(botId), eq(notes.id, noteId)))
    .limit(1);
  if (!row) throw new BlockError("Nota não encontrada.", 404);
  return row;
}

async function backlinkCount(botId: string, row: NoteRow) {
  const [result] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
    .where(
      and(
        liveNotes(botId),
        sql`(${noteLinks.targetId} = ${row.id} OR (${noteLinks.targetId} IS NULL AND lower(${noteLinks.targetTitle}) = ${normalizeTitle(row.title)}))`,
      ),
    )
    .limit(1);
  return Number(result?.count ?? 0);
}

export async function noteOf(botId: string, row: NoteRow): Promise<Note> {
  const links: NoteLink[] = [];
  for (const target of parseLinks(row.markdown)) {
    const found = await findByTitle(botId, target, row.folder);
    links.push({ target, id: found?.id ?? null, title: found?.title ?? target });
  }
  return { ...summaryOf(row), content: row.markdown, links, backlinkCount: await backlinkCount(botId, row) };
}

async function syncLinks(botId: string, row: Pick<NoteRow, "id" | "markdown" | "folder">) {
  await db().delete(noteLinks).where(eq(noteLinks.sourceId, row.id));
  const targets = parseLinks(row.markdown);
  if (!targets.length) return;
  const values = [];
  for (const target of targets)
    values.push({
      sourceId: row.id,
      targetTitle: target,
      targetId: (await findByTitle(botId, target, row.folder))?.id ?? null,
    });
  await db().insert(noteLinks).values(values);
}

async function relinkTitle(botId: string, title: string, id: string | null) {
  await db()
    .update(noteLinks)
    .set({ targetId: id })
    .where(
      and(
        inArray(noteLinks.sourceId, db().select({ id: notes.id }).from(notes).where(liveNotes(botId))),
        sql`lower(${noteLinks.targetTitle}) = ${normalizeTitle(title)}`,
      ),
    );
}

function tagCondition(tag: string) {
  const clean = tag.replace(/^#/, "").toLowerCase().replace(/[%_]/g, "");
  const needle = `#${clean}`;
  return sql`(lower(${notes.markdown}) LIKE ${`%${needle}`} OR lower(${notes.markdown}) LIKE ${`%${needle} %`} OR lower(${notes.markdown}) LIKE ${`%${needle}\n%`} OR lower(${notes.markdown}) LIKE ${`%${needle},%`} OR lower(${notes.markdown}) LIKE ${`%${needle}.%`})`;
}

export async function listNotes(botId: string, query: Record<string, unknown>): Promise<Page<NoteSummary>> {
  const { limit, offset } = pageArgs(query.cursor, query.limit);
  const conditions: SQL[] = [liveNotes(botId)];
  if (query.folder !== undefined && query.folder !== null) conditions.push(eq(notes.folder, cleanFolder(query.folder)));
  const q = typeof query.q === "string" ? noteSearchQuery(query.q) : null;
  if (q) conditions.push(noteMatches(q));
  if (typeof query.tag === "string" && query.tag.trim()) conditions.push(tagCondition(query.tag.trim()));
  const where = and(...conditions);
  const order = query.sort === "title" ? [asc(sql`lower(${notes.title})`)] : [desc(notes.updatedAt)];
  const [count] = await db().select({ count: sql<number>`count(*)::int` }).from(notes).where(where);
  const total = Number(count?.count ?? 0);
  const rows = await db()
    .select()
    .from(notes)
    .where(where)
    .orderBy(...order, asc(notes.id))
    .limit(limit)
    .offset(offset);
  return pageOf(rows.map(summaryOf), total, offset, limit);
}

export async function noteTree(botId: string, query: Record<string, unknown>): Promise<NoteTreeLevel> {
  const folder = cleanFolder(query.folder);
  const all = await db()
    .select({ folder: notes.folder, count: sql<number>`count(*)::int` })
    .from(notes)
    .where(liveNotes(botId))
    .groupBy(notes.folder);
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
    notes: await listNotes(botId, { folder, sort: "title", cursor: query.cursor, limit: query.limit }),
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

export async function searchNotes(botId: string, query: Record<string, unknown>): Promise<Page<NoteSearchHit>> {
  const titleOnly = query.mode === "title";
  const { limit, offset } = pageArgs(query.cursor, query.limit, titleOnly ? 8 : 50);
  const q = typeof query.q === "string" ? noteSearchQuery(query.q, titleOnly) : null;
  if (!q) return pageOf([], 0, offset, limit);
  const { total, rows } = await searchNoteRows(botId, q, titleOnly, limit, offset);
  const items = rows.map((row) => {
    if (titleOnly) {
      const { ranges } = rangesOf(row.titleMarked);
      return { id: row.id, title: row.title, folder: row.folder, snippet: "", ranges };
    }
    const hasBodyHit = row.snippet.includes(markers.open);
    const marked = hasBodyHit ? withEllipsis(row.snippet, row.markdown) : row.titleMarked;
    const { text, ranges } = rangesOf(marked.replace(/\s+/g, " "));
    return { id: row.id, title: row.title, folder: row.folder, snippet: text, ranges };
  });
  return pageOf(items, total, offset, limit);
}

export async function resolveNote(botId: string, title: string, folder?: string) {
  const row = await findByTitle(botId, cleanTitle(title), folder === undefined ? undefined : cleanFolder(folder));
  if (!row) throw new BlockError("Nota não encontrada.", 404);
  return noteOf(botId, row);
}

export async function noteBacklinks(
  botId: string,
  noteId: string,
  query: Record<string, unknown>,
): Promise<Page<NoteBacklink>> {
  const row = await requireNote(botId, noteId);
  const { limit, offset } = pageArgs(query.cursor, query.limit);
  const where = and(
    liveNotes(botId),
    sql`(${noteLinks.targetId} = ${row.id} OR (${noteLinks.targetId} IS NULL AND lower(${noteLinks.targetTitle}) = ${normalizeTitle(row.title)}))`,
  );
  const [count] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
    .where(where);
  const total = Number(count?.count ?? 0);
  const sources = await db()
    .select()
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
    .where(where)
    .orderBy(desc(notes.updatedAt), asc(notes.id))
    .limit(limit)
    .offset(offset);
  const items = sources.map(({ notes: source, note_links: link }) => {
    const needle = `[[${link.targetTitle.toLowerCase()}`;
    const line = source.markdown.split("\n").find((item) => item.toLowerCase().includes(needle)) ?? "";
    return { id: source.id, title: source.title, folder: source.folder, snippet: clip(line.trim(), 240) };
  });
  return pageOf(items, total, offset, limit);
}

async function assertUnique(botId: string, title: string, folder: string, except?: string) {
  const [clash] = await db()
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
    .limit(1);
  if (clash) throw new BlockError("Já existe uma nota com esse título nessa pasta.", 409, "exists", { id: clash.id });
}

export interface NoteWrite {
  note: Note;
  event: ReturnType<typeof blockEvent>;
}

export const maxNoteChars = 500_000;

function checkNoteSize(markdown: string) {
  if (markdown.length > maxNoteChars)
    throw new BlockError(`A nota passa de ${maxNoteChars} caracteres (${markdown.length}).`, 413);
}

export async function createNote(
  botId: string,
  body: Record<string, unknown>,
  author: BlockAuthor,
): Promise<NoteWrite> {
  const title = cleanTitle(body.title);
  const folder = cleanFolder(body.folder);
  const markdown = String(body.content ?? "");
  checkNoteSize(markdown);
  return writeTransaction(async () => {
    await assertUnique(botId, title, folder);
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
    await db().insert(notes).values(row);
    await syncLinks(botId, row);
    await relinkTitle(botId, title, row.id);
    const changed = markdown ? { lines: [[0, markdown.split("\n").length - 1]] as Array<[number, number]> } : undefined;
    return {
      note: await noteOf(botId, row),
      event: blockEvent("note", row.id, title, 1, author, "created", previewOf(row), changed),
    };
  });
}

async function saveContent(
  botId: string,
  current: NoteRow,
  next: { markdown: string; title?: string },
  author: BlockAuthor,
  baseVersion: unknown,
): Promise<NoteWrite> {
  checkNoteSize(next.markdown);
  staleCheck(current, baseVersion, author);
  const title = next.title === undefined ? current.title : cleanTitle(next.title);
  if (title !== current.title) await assertUnique(botId, title, current.folder, current.id);
  const lines = changedLines(current.markdown, next.markdown);
  const merge = shouldMerge(current, author);
  const version = merge ? current.version : current.version + 1;
  const pending =
    author === "user" ? mergeRanges([...((current.userChanges as Array<[number, number]>) ?? []), ...lines]) : null;
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
  await db()
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
    .where(eq(notes.id, current.id));
  await syncLinks(botId, updated);
  if (title !== current.title) {
    await relinkTitle(botId, current.title, (await findByTitle(botId, current.title))?.id ?? null);
    await relinkTitle(botId, title, updated.id);
  }
  return {
    note: await noteOf(botId, updated),
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

export async function writeNote(
  botId: string,
  noteId: string,
  body: Record<string, unknown>,
  author: BlockAuthor,
): Promise<NoteWrite> {
  if (typeof body.content !== "string") throw new BlockError("content é obrigatório.");
  return writeTransaction(async () =>
    saveContent(
      botId,
      await requireNote(botId, noteId),
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
      const at = lines.findIndex(
        (line) => /^#{1,6}\s/.test(line) && normalizeTitle(line.replace(/^#+\s*/, "")) === wanted,
      );
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

export async function patchNote(botId: string, noteId: string, body: Record<string, unknown>, author: BlockAuthor) {
  const ops = body.ops;
  if (!Array.isArray(ops) || !ops.length) throw new BlockError("ops é obrigatório.");
  return writeTransaction(async () => {
    const current = await requireNote(botId, noteId);
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

export async function moveNote(botId: string, noteId: string, body: Record<string, unknown>, author: BlockAuthor) {
  return writeTransaction(async () => {
    const current = await requireNote(botId, noteId);
    const folder = body.folder === undefined ? current.folder : cleanFolder(body.folder);
    const title = body.title === undefined ? current.title : cleanTitle(body.title);
    if (folder === current.folder && title === current.title)
      return { note: await noteOf(botId, current), relinked: 0, event: null };
    await assertUnique(botId, title, folder, current.id);
    const version = current.version + 1;
    const at = nowIso();
    await db()
      .update(notes)
      .set({
        folder,
        title,
        version,
        updatedBy: author,
        updatedAt: at,
        ...(author === "bot" ? { seenVersion: version } : {}),
      })
      .where(eq(notes.id, current.id));
    let relinked = 0;
    if (title !== current.title) {
      const sources = await db()
        .select()
        .from(noteLinks)
        .innerJoin(notes, eq(notes.id, noteLinks.sourceId))
        .where(and(liveNotes(botId), sql`lower(${noteLinks.targetTitle}) = ${normalizeTitle(current.title)}`));
      for (const { notes: source } of sources) {
        const fresh = source.id === current.id ? await requireNote(botId, current.id) : source;
        const { next, count } = rewriteLinks(fresh.markdown, current.title, title);
        if (!count) continue;
        const sourceVersion = fresh.version + 1;
        await db()
          .update(notes)
          .set({ markdown: next, version: sourceVersion, updatedAt: at, updatedBy: author })
          .where(eq(notes.id, fresh.id));
        await syncLinks(botId, { ...fresh, markdown: next });
        relinked++;
      }
      await relinkTitle(botId, title, current.id);
      await relinkTitle(botId, current.title, (await findByTitle(botId, current.title))?.id ?? null);
    }
    const row = await requireNote(botId, current.id);
    return {
      note: await noteOf(botId, row),
      relinked,
      event: blockEvent("note", row.id, row.title, row.version, author, "edited", previewOf(row)),
    };
  });
}

export async function deleteNote(botId: string, noteId: string, author: BlockAuthor) {
  return writeTransaction(async () => {
    const current = await requireNote(botId, noteId);
    const version = current.version + 1;
    await db()
      .update(notes)
      .set({ deletedAt: nowIso(), version, updatedBy: author, updatedAt: nowIso() })
      .where(eq(notes.id, current.id));
    await db().update(noteLinks).set({ targetId: null }).where(eq(noteLinks.targetId, current.id));
    return blockEvent("note", current.id, current.title, version, author, "deleted", null);
  });
}

export async function readNoteForBot(botId: string, noteId: string) {
  const row = await requireNote(botId, noteId);
  if (row.seenVersion < row.version)
    await db().update(notes).set({ seenVersion: row.version, userChanges: null }).where(eq(notes.id, row.id));
  return noteOf(botId, row);
}

export async function noteEditNote(botId: string) {
  const rows = await db()
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
    .limit(20);
  if (rows.length)
    await db()
      .update(notes)
      .set({ notifiedVersion: sql`${notes.version}` })
      .where(
        inArray(
          notes.id,
          rows.map((row) => row.id),
        ),
      );
  const lines = rows.map((row) => {
    const ranges = (row.userChanges as Array<[number, number]> | null) ?? [];
    const where = ranges.length
      ? `linhas ${ranges.map(([start, end]) => (start === end ? `${start + 1}` : `${start + 1}–${end + 1}`)).join(", ")} mudaram`
      : "o conteúdo mudou";
    return `- A nota "${row.title}" (${row.id}) foi editada pela pessoa: ${where}; use note_read antes de mudar.`;
  });
  return lines;
}
