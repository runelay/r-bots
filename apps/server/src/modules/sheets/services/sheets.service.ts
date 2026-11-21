import type {
  BlockAuthor,
  CellFormat,
  CellType,
  CellValue,
  Page,
  Sheet,
  SheetCell,
  SheetPreview,
  SheetRange,
  SheetStructureOp,
  SheetSummary,
  SheetTab,
} from "@runelay-bots/protocol";
import { and, asc, desc, eq, gte, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import { type Db, getDb, writeTransaction } from "../../../db";
import { sheetCells, sheets, sheetTabs } from "../../../db/tables";
import {
  BlockError,
  blockEvent,
  newId,
  normalizeTitle,
  nowIso,
  pageArgs,
  pageOf,
  shouldMerge,
  staleCheck,
} from "../../blocks/services/blocks.shared";
import {
  address,
  type BookCell,
  type BookTab,
  colIndex,
  colLetters,
  maxCols,
  parseAddress,
  parseInput,
  parseRange,
  rangeText,
  renameSheetRefs,
  shiftFormula,
  Workbook,
} from "./formula";

type SheetRow = typeof sheets.$inferSelect;
type TabRow = typeof sheetTabs.$inferSelect;
type CellRow = typeof sheetCells.$inferSelect;

export const maxReadCells = 10_000;
export const maxWriteCells = 20_000;
const defaultWidth = 96;

interface PendingChange {
  tabId: string;
  ranges: string[];
}

function db(): Db {
  return getDb();
}

function cleanTitle(value: unknown, what = "Título") {
  const title = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!title) throw new BlockError(`${what} é obrigatório.`);
  return title;
}

function cleanTabName(value: unknown) {
  const name = cleanTitle(value, "Nome da aba")
    .replace(/[[\]:*?/\\]/g, " ")
    .trim()
    .slice(0, 31);
  if (!name) throw new BlockError("Nome da aba é obrigatório.");
  return name;
}

function liveSheets(botId: string) {
  return and(eq(sheets.botId, botId), isNull(sheets.deletedAt)) as SQL;
}

export async function requireSheet(botId: string, sheetId: string) {
  const row = (
    await db()
      .select()
      .from(sheets)
      .where(and(liveSheets(botId), eq(sheets.id, sheetId)))
      .limit(1)
  )[0];
  if (!row) throw new BlockError("Planilha não encontrada.", 404);
  return row;
}

async function tabsOf(sheetId: string) {
  return await db()
    .select()
    .from(sheetTabs)
    .where(and(eq(sheetTabs.sheetId, sheetId), isNull(sheetTabs.deletedAt)))
    .orderBy(asc(sheetTabs.position));
}

async function requireTab(sheetId: string, tabId?: unknown) {
  const tabs = await tabsOf(sheetId);
  if (tabId === undefined || tabId === null || tabId === "") return tabs[0];
  const tab = tabs.find((item) => item.id === tabId || normalizeTitle(item.name) === normalizeTitle(String(tabId)));
  if (!tab) throw new BlockError("Aba não encontrada.", 404);
  return tab;
}

function publicTab(tab: TabRow, index: number): SheetTab {
  return {
    id: tab.id,
    name: tab.name,
    index,
    rowCount: tab.rowCount,
    colCount: tab.colCount,
    frozenRows: tab.frozenRows,
    frozenCols: tab.frozenCols,
    colWidths: tab.colWidths ?? {},
  };
}

export async function sheetOf(row: SheetRow): Promise<Sheet> {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy as BlockAuthor,
    tabs: (await tabsOf(row.id)).map(publicTab),
  };
}

async function summaryOf(row: SheetRow): Promise<SheetSummary> {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy as BlockAuthor,
    tabs: (await tabsOf(row.id)).map((tab) => ({ id: tab.id, name: tab.name })),
  };
}

function decodeValue(row: CellRow): CellValue {
  if (row.value === null || row.value === undefined) return null;
  try {
    return JSON.parse(row.value) as CellValue;
  } catch {
    return row.value;
  }
}

function formatOf(value: unknown): CellFormat {
  return { type: "general", ...(value as Partial<CellFormat>) };
}

export function cellOf(row: CellRow): SheetCell {
  return {
    a: address(row.row, row.col),
    r: row.row,
    c: row.col,
    input: row.input,
    v: decodeValue(row),
    t: (row.type as CellType) ?? null,
    ...(row.format ? { format: formatOf(row.format) } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export async function listSheets(botId: string, query: Record<string, unknown>): Promise<Page<SheetSummary>> {
  const { limit, offset } = pageArgs(query.cursor, query.limit);
  const q = typeof query.q === "string" ? query.q.trim().toLowerCase() : "";
  const where = and(
    liveSheets(botId),
    q ? sql`lower(${sheets.title}) LIKE ${`%${q.replace(/[%_]/g, "")}%`}` : undefined,
  );
  const total = Number(
    (await db().select({ count: sql<number>`count(*)::int` }).from(sheets).where(where).limit(1))[0]?.count ?? 0,
  );
  const rows = await db()
    .select()
    .from(sheets)
    .where(where)
    .orderBy(desc(sheets.updatedAt), asc(sheets.id))
    .limit(limit)
    .offset(offset);
  return pageOf(await Promise.all(rows.map(summaryOf)), total, offset, limit);
}

async function loadBook(sheetId: string) {
  const tabs = await tabsOf(sheetId);
  const rows = tabs.length
    ? await db()
        .select()
        .from(sheetCells)
        .where(
          inArray(
            sheetCells.tabId,
            tabs.map((tab) => tab.id),
          ),
        )
    : [];
  const book: BookTab[] = tabs.map((tab) => ({
    id: tab.id,
    name: tab.name,
    rowCount: tab.rowCount,
    colCount: tab.colCount,
    cells: new Map<string, BookCell>(),
  }));
  const byId = new Map(book.map((tab) => [tab.id, tab]));
  for (const row of rows) {
    byId.get(row.tabId)?.cells.set(`${row.row},${row.col}`, {
      r: row.row,
      c: row.col,
      input: row.input,
      v: decodeValue(row),
      t: (row.type as CellType) ?? null,
      error: row.error,
    });
  }
  return { tabs, book, rows };
}

async function recalc(sheetId: string) {
  const { book, rows } = await loadBook(sheetId);
  const computed = new Workbook(book).computeAll();
  const changed: Array<{ tabId: string; row: number; col: number }> = [];
  for (const row of rows) {
    const result = computed.get(row.tabId)?.get(`${row.row},${row.col}`);
    if (!result) continue;
    const value = result.v === null ? null : JSON.stringify(result.v);
    if (
      value === row.value &&
      (result.t ?? null) === (row.type ?? null) &&
      (result.error ?? null) === (row.error ?? null)
    )
      continue;
    await db()
      .update(sheetCells)
      .set({ value, type: result.t, error: result.error })
      .where(and(eq(sheetCells.tabId, row.tabId), eq(sheetCells.row, row.row), eq(sheetCells.col, row.col)));
    changed.push({ tabId: row.tabId, row: row.row, col: row.col });
  }
  return changed;
}

async function refreshBounds(tabId: string) {
  const bounds = (
    await db()
      .select({
        rows: sql<number>`coalesce(max(${sheetCells.row}), -1)`,
        cols: sql<number>`coalesce(max(${sheetCells.col}), -1)`,
      })
      .from(sheetCells)
      .where(eq(sheetCells.tabId, tabId))
      .limit(1)
  )[0];
  await db()
    .update(sheetTabs)
    .set({ rowCount: Number(bounds?.rows ?? -1) + 1, colCount: Number(bounds?.cols ?? -1) + 1 })
    .where(eq(sheetTabs.id, tabId));
}

async function cellsAt(tabId: string, points: Array<{ row: number; col: number }>) {
  if (!points.length) return [];
  const rows = await db()
    .select()
    .from(sheetCells)
    .where(eq(sheetCells.tabId, tabId))
    .orderBy(asc(sheetCells.row), asc(sheetCells.col));
  const wanted = new Set(points.map((point) => `${point.row},${point.col}`));
  return rows.filter((row) => wanted.has(`${row.row},${row.col}`)).map(cellOf);
}

async function bump(current: SheetRow, author: BlockAuthor, change: PendingChange | null) {
  const merge = shouldMerge(current, author);
  const version = merge ? current.version : current.version + 1;
  const previous = (current.userChanges as PendingChange[] | null) ?? [];
  const pending =
    author === "user" && change
      ? [
          ...previous.filter((item) => item.tabId !== change.tabId),
          {
            tabId: change.tabId,
            ranges: [...(previous.find((item) => item.tabId === change.tabId)?.ranges ?? []), ...change.ranges].slice(
              -12,
            ),
          },
        ]
      : author === "user"
        ? previous
        : null;
  const updatedAt = nowIso();
  await db()
    .update(sheets)
    .set({
      version,
      updatedBy: author,
      updatedAt,
      userChanges: pending,
      ...(author === "bot" ? { seenVersion: version } : {}),
    })
    .where(eq(sheets.id, current.id));
  return { ...current, version, updatedBy: author, updatedAt };
}

export async function previewOf(sheetId: string, tabId?: string): Promise<SheetPreview> {
  const tabs = await tabsOf(sheetId);
  const tab = tabs.find((item) => item.id === tabId) ?? tabs[0];
  const rows = await db()
    .select()
    .from(sheetCells)
    .where(and(eq(sheetCells.tabId, tab.id), lte(sheetCells.row, 7), lte(sheetCells.col, 5)));
  const height = Math.min(8, Math.max(tab.rowCount, 1));
  const width = Math.min(6, Math.max(tab.colCount, 1));
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ v: null as CellValue, t: null as CellType })),
  ) as SheetPreview["rows"];
  for (const row of rows) {
    if (row.row >= height || row.col >= width) continue;
    grid[row.row][row.col] = {
      v: decodeValue(row),
      t: (row.type as CellType) ?? null,
      ...(row.format ? { format: formatOf(row.format) } : {}),
    };
  }
  const widths = tab.colWidths ?? {};
  return {
    kind: "sheet",
    tab: tab.name,
    tabs: tabs.length,
    rows: grid,
    rowCount: tab.rowCount,
    colCount: tab.colCount,
    frozenRows: tab.frozenRows,
    colWidths: Array.from({ length: width }, (_, index) => widths[colLetters(index)] ?? defaultWidth),
  };
}

async function writeInto(tab: TabRow, cells: Array<{ a: string; input: string }>) {
  const written: Array<{ row: number; col: number }> = [];
  for (const cell of cells) {
    let point: { r: number; c: number };
    try {
      point = parseAddress(String(cell.a ?? ""));
    } catch (error) {
      throw new BlockError((error as Error).message);
    }
    const input = String(cell.input ?? "");
    const where = and(eq(sheetCells.tabId, tab.id), eq(sheetCells.row, point.r), eq(sheetCells.col, point.c));
    const existing = (await db().select().from(sheetCells).where(where).limit(1))[0];
    if (!input) {
      if (existing?.format)
        await db()
          .update(sheetCells)
          .set({ input: "", value: null, type: null, error: null, formula: null })
          .where(where);
      else if (existing) await db().delete(sheetCells).where(where);
      written.push({ row: point.r, col: point.c });
      continue;
    }
    const parsed = parseInput(input);
    const format = existing?.format ?? (parsed.hint as unknown as Record<string, unknown> | undefined) ?? null;
    const values = {
      input,
      formula: parsed.formula,
      value: parsed.formula || parsed.v === null ? null : JSON.stringify(parsed.v),
      type: parsed.formula ? null : parsed.t,
      error: null,
      format,
    };
    if (existing) await db().update(sheetCells).set(values).where(where);
    else
      await db()
        .insert(sheetCells)
        .values({ tabId: tab.id, row: point.r, col: point.c, ...values });
    written.push({ row: point.r, col: point.c });
  }
  return written;
}

function boundingRange(points: Array<{ row: number; col: number }>) {
  if (!points.length) return null;
  return rangeText({
    r1: Math.min(...points.map((p) => p.row)),
    c1: Math.min(...points.map((p) => p.col)),
    r2: Math.max(...points.map((p) => p.row)),
    c2: Math.max(...points.map((p) => p.col)),
  });
}

async function changedAfterWrite(sheetId: string, tab: TabRow, written: Array<{ row: number; col: number }>) {
  await refreshBounds(tab.id);
  const dependents = await recalc(sheetId);
  const sameTab = [...written, ...dependents.filter((item) => item.tabId === tab.id)];
  const seen = new Set<string>();
  const unique = sameTab.filter((item) => {
    const id = `${item.row},${item.col}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const writtenKeys = new Set(written.map((item) => `${item.row},${item.col}`));
  const cleared = written.filter((item) => writtenKeys.has(`${item.row},${item.col}`)).map((item) => ({ ...item }));
  const present = await cellsAt(tab.id, unique);
  const presentKeys = new Set(present.map((cell) => `${cell.r},${cell.c}`));
  const empties: SheetCell[] = cleared
    .filter((item) => !presentKeys.has(`${item.row},${item.col}`))
    .map((item) => ({ a: address(item.row, item.col), r: item.row, c: item.col, input: "", v: null, t: null }));
  return [...present, ...empties];
}

export async function createSheet(botId: string, body: Record<string, unknown>, author: BlockAuthor) {
  const title = cleanTitle(body.title);
  const names = Array.isArray(body.tabs) && body.tabs.length ? body.tabs.map(cleanTabName) : ["Planilha1"];
  if (new Set(names.map(normalizeTitle)).size !== names.length) throw new BlockError("Nomes de aba repetidos.");
  const cells = Array.isArray(body.cells) ? (body.cells as Array<{ a: string; input: string }>) : [];
  if (cells.length > maxWriteCells) throw new BlockError(`No máximo ${maxWriteCells} células por escrita.`);
  return writeTransaction(async () => {
    const at = nowIso();
    const row: SheetRow = {
      id: newId("sheet"),
      folder: "",
      title,
      botId,
      version: 1,
      updatedBy: author,
      seenVersion: author === "bot" ? 1 : 0,
      notifiedVersion: 0,
      userChanges: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    await db().insert(sheets).values(row);
    await db()
      .insert(sheetTabs)
      .values(names.map((name, position) => ({ id: newId("tab"), sheetId: row.id, name, position })));
    const [first] = await tabsOf(row.id);
    const written = cells.length ? await writeInto(first, cells) : [];
    if (written.length) {
      await refreshBounds(first.id);
      await recalc(row.id);
    }
    const range = boundingRange(written);
    return {
      sheet: await sheetOf(row),
      event: blockEvent(
        "sheet",
        row.id,
        title,
        1,
        author,
        "created",
        await previewOf(row.id, first.id),
        range ? { tabId: first.id, ranges: [range] } : undefined,
      ),
    };
  });
}

export async function readRange(
  botId: string,
  sheetId: string,
  tabId: unknown,
  rangeInput: unknown,
): Promise<SheetRange> {
  const sheet = await requireSheet(botId, sheetId);
  const tab = await requireTab(sheet.id, tabId);
  let range: ReturnType<typeof parseRange>;
  try {
    range = parseRange(String(rangeInput || "A1:Z100"));
  } catch (error) {
    throw new BlockError((error as Error).message);
  }
  const r2 = Math.min(range.r2, Math.max(tab.rowCount - 1, range.r1));
  const c2 = Math.min(range.c2, Math.max(tab.colCount - 1, range.c1));
  if ((r2 - range.r1 + 1) * (c2 - range.c1 + 1) > maxReadCells)
    throw new BlockError(`No máximo ${maxReadCells} células por leitura; peça uma janela menor.`);
  const rows = await db()
    .select()
    .from(sheetCells)
    .where(
      and(
        eq(sheetCells.tabId, tab.id),
        gte(sheetCells.row, range.r1),
        lte(sheetCells.row, range.r2),
        gte(sheetCells.col, range.c1),
        lte(sheetCells.col, range.c2),
      ),
    )
    .orderBy(asc(sheetCells.row), asc(sheetCells.col));
  return { tabId: tab.id, range: rangeText({ ...range, r2, c2 }), version: sheet.version, cells: rows.map(cellOf) };
}

export async function writeCells(
  botId: string,
  sheetId: string,
  tabId: unknown,
  body: Record<string, unknown>,
  author: BlockAuthor,
) {
  const cells = body.cells;
  if (!Array.isArray(cells) || !cells.length) throw new BlockError("cells é obrigatório.");
  if (cells.length > maxWriteCells) throw new BlockError(`No máximo ${maxWriteCells} células por escrita.`);
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    staleCheck(sheet, body.baseVersion, author);
    const tab = await requireTab(sheet.id, tabId);
    const written = await writeInto(tab, cells as Array<{ a: string; input: string }>);
    const result = await changedAfterWrite(sheet.id, tab, written);
    const range = boundingRange(written);
    const next = await bump(sheet, author, range ? { tabId: tab.id, ranges: [range] } : null);
    return {
      result: { version: next.version, cells: result },
      event: blockEvent(
        "sheet",
        sheet.id,
        sheet.title,
        next.version,
        author,
        "edited",
        await previewOf(sheet.id, tab.id),
        range ? { tabId: tab.id, ranges: [range] } : undefined,
      ),
    };
  });
}

function cleanFormat(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new BlockError("format inválido.");
  const input = value as Record<string, unknown>;
  const types = ["general", "number", "brl", "percent", "date", "datetime", "text"];
  const out: Record<string, unknown> = {};
  if (input.type !== undefined) {
    if (!types.includes(String(input.type))) throw new BlockError("Tipo de formato inválido.");
    out.type = input.type;
  }
  if (input.decimals !== undefined) out.decimals = Math.max(0, Math.min(10, Math.floor(Number(input.decimals) || 0)));
  if (input.bold !== undefined) out.bold = Boolean(input.bold);
  if (input.align !== undefined) {
    if (!["left", "center", "right"].includes(String(input.align))) throw new BlockError("Alinhamento inválido.");
    out.align = input.align;
  }
  return out;
}

export async function formatCells(
  botId: string,
  sheetId: string,
  tabId: unknown,
  body: Record<string, unknown>,
  author: BlockAuthor,
) {
  const ranges = Array.isArray(body.ranges)
    ? body.ranges.map(String)
    : typeof body.ranges === "string"
      ? [body.ranges]
      : [];
  if (!ranges.length) throw new BlockError("ranges é obrigatório.");
  const format = cleanFormat(body.format);
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    staleCheck(sheet, body.baseVersion, author);
    const tab = await requireTab(sheet.id, tabId);
    const touched: Array<{ row: number; col: number }> = [];
    const texts: string[] = [];
    for (const text of ranges) {
      let range: ReturnType<typeof parseRange>;
      try {
        range = parseRange(text);
      } catch (error) {
        throw new BlockError((error as Error).message);
      }
      const r2 = Math.min(range.r2, Math.max(tab.rowCount - 1, range.r1));
      const c2 = Math.min(range.c2, Math.max(tab.colCount - 1, range.c1));
      if ((r2 - range.r1 + 1) * (c2 - range.c1 + 1) + touched.length > maxWriteCells)
        throw new BlockError(`No máximo ${maxWriteCells} células por formatação.`);
      texts.push(rangeText({ ...range, r2, c2 }));
      for (let r = range.r1; r <= r2; r++)
        for (let c = range.c1; c <= c2; c++) {
          const where = and(eq(sheetCells.tabId, tab.id), eq(sheetCells.row, r), eq(sheetCells.col, c));
          const existing = (await db().select().from(sheetCells).where(where).limit(1))[0];
          if (existing) {
            const merged = format ? { ...(existing.format ?? {}), ...format } : null;
            if (!merged && !existing.input) await db().delete(sheetCells).where(where);
            else await db().update(sheetCells).set({ format: merged }).where(where);
          } else if (format) await db().insert(sheetCells).values({ tabId: tab.id, row: r, col: c, input: "", format });
          touched.push({ row: r, col: c });
        }
    }
    await refreshBounds(tab.id);
    const next = await bump(sheet, author, { tabId: tab.id, ranges: texts });
    return {
      result: { version: next.version, cells: await cellsAt(tab.id, touched) },
      event: blockEvent(
        "sheet",
        sheet.id,
        sheet.title,
        next.version,
        author,
        "edited",
        await previewOf(sheet.id, tab.id),
        {
          tabId: tab.id,
          ranges: texts,
        },
      ),
    };
  });
}

export async function renameSheet(botId: string, sheetId: string, body: Record<string, unknown>, author: BlockAuthor) {
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    staleCheck(sheet, body.baseVersion, author);
    const title = cleanTitle(body.title);
    await db().update(sheets).set({ title }).where(eq(sheets.id, sheet.id));
    const next = await bump({ ...sheet, title }, author, null);
    return {
      sheet: await sheetOf({ ...next, title }),
      event: blockEvent("sheet", sheet.id, title, next.version, author, "edited", await previewOf(sheet.id)),
    };
  });
}

export async function deleteSheet(botId: string, sheetId: string, author: BlockAuthor) {
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    const version = sheet.version + 1;
    await db()
      .update(sheets)
      .set({ deletedAt: nowIso(), version, updatedBy: author, updatedAt: nowIso() })
      .where(eq(sheets.id, sheet.id));
    return blockEvent("sheet", sheet.id, sheet.title, version, author, "deleted", null);
  });
}

async function rewriteAll(sheetId: string, rewrite: (input: string, ownTab: string) => string) {
  const { tabs, rows } = await loadBook(sheetId);
  const names = new Map(tabs.map((tab) => [tab.id, tab.name]));
  for (const row of rows) {
    if (!row.input.trim().startsWith("=")) continue;
    const next = rewrite(row.input, names.get(row.tabId) ?? "");
    if (next === row.input) continue;
    await db()
      .update(sheetCells)
      .set({ input: next, formula: next })
      .where(and(eq(sheetCells.tabId, row.tabId), eq(sheetCells.row, row.row), eq(sheetCells.col, row.col)));
  }
}

async function sheetResult(sheet: SheetRow, author: BlockAuthor, tabId?: string) {
  const next = await bump(sheet, author, null);
  const sheetPublic = await sheetOf(next);
  return {
    sheet: sheetPublic,
    event: blockEvent("sheet", sheet.id, sheet.title, next.version, author, "edited", await previewOf(sheet.id, tabId)),
  };
}

async function tabResult(_botId: string, sheet: SheetRow, tab: TabRow, author: BlockAuthor) {
  const base = await sheetResult(sheet, author, tab.id);
  const row = await requireTabRow(tab.id);
  const index = (await tabsOf(sheet.id)).findIndex((item) => item.id === tab.id);
  return { sheet: base.sheet, tab: publicTab(row, index), event: base.event };
}

async function requireTabRow(tabId: string) {
  const row = (await db().select().from(sheetTabs).where(eq(sheetTabs.id, tabId)).limit(1))[0];
  if (!row) throw new BlockError("Aba não encontrada.", 404);
  return row;
}

export async function addTab(botId: string, sheetId: string, body: Record<string, unknown>, author: BlockAuthor) {
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    const tabs = await tabsOf(sheet.id);
    const name = cleanTabName(body.name ?? `Planilha${tabs.length + 1}`);
    if (tabs.some((tab) => normalizeTitle(tab.name) === normalizeTitle(name)))
      throw new BlockError("Já existe uma aba com esse nome.", 409, "exists");
    const position =
      Number(
        (
          await db()
            .select({ max: sql<number>`coalesce(max(${sheetTabs.position}), -1)` })
            .from(sheetTabs)
            .where(eq(sheetTabs.sheetId, sheet.id))
            .limit(1)
        )[0]?.max ?? -1,
      ) + 1;
    const id = newId("tab");
    await db().insert(sheetTabs).values({ id, sheetId: sheet.id, name, position });
    await recalc(sheet.id);
    return await tabResult(botId, sheet, await requireTabRow(id), author);
  });
}

export async function patchTab(
  botId: string,
  sheetId: string,
  tabId: string,
  body: Record<string, unknown>,
  author: BlockAuthor,
) {
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    const tab = await requireTab(sheet.id, tabId);
    const set: Partial<TabRow> = {};
    if (body.name !== undefined) {
      const name = cleanTabName(body.name);
      if (
        (await tabsOf(sheet.id)).some(
          (item) => item.id !== tab.id && normalizeTitle(item.name) === normalizeTitle(name),
        )
      )
        throw new BlockError("Já existe uma aba com esse nome.", 409, "exists");
      if (name !== tab.name) {
        await rewriteAll(sheet.id, (input) => renameSheetRefs(input, tab.name, name));
        set.name = name;
      }
    }
    if (body.frozenRows !== undefined)
      set.frozenRows = Math.max(0, Math.min(50, Math.floor(Number(body.frozenRows) || 0)));
    if (body.frozenCols !== undefined)
      set.frozenCols = Math.max(0, Math.min(20, Math.floor(Number(body.frozenCols) || 0)));
    if (body.colWidths && typeof body.colWidths === "object") {
      const widths = { ...(tab.colWidths ?? {}) };
      for (const [letters, width] of Object.entries(body.colWidths as Record<string, unknown>)) {
        if (!/^[A-Za-z]{1,3}$/.test(letters) || colIndex(letters) >= maxCols) continue;
        const value = Math.round(Number(width));
        if (Number.isFinite(value) && value >= 24 && value <= 1200) widths[letters.toUpperCase()] = value;
      }
      set.colWidths = widths;
    }
    if (Object.keys(set).length) await db().update(sheetTabs).set(set).where(eq(sheetTabs.id, tab.id));
    if (set.name) await recalc(sheet.id);
    return await tabResult(botId, sheet, tab, author);
  });
}

export async function deleteTab(botId: string, sheetId: string, tabId: string, author: BlockAuthor) {
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    const tabs = await tabsOf(sheet.id);
    const tab = await requireTab(sheet.id, tabId);
    if (tabs.length <= 1) throw new BlockError("A última aba não pode sair.");
    await db()
      .update(sheetTabs)
      .set({ deletedAt: nowIso(), position: -1 - Date.now() })
      .where(eq(sheetTabs.id, tab.id));
    await recalc(sheet.id);
    const base = await sheetResult(sheet, author);
    return { sheet: base.sheet, tab: null, event: base.event };
  });
}

export async function structure(
  botId: string,
  sheetId: string,
  tabId: string,
  body: Record<string, unknown>,
  author: BlockAuthor,
) {
  const ops: SheetStructureOp[] = ["insert_rows", "delete_rows", "insert_cols", "delete_cols"];
  const op = body.op as SheetStructureOp;
  if (!ops.includes(op)) throw new BlockError("op inválida.");
  const at = Math.floor(Number(body.at));
  const count = Math.floor(Number(body.count ?? 1));
  if (!Number.isFinite(at) || at < 0 || !Number.isFinite(count) || count < 1 || count > 10_000)
    throw new BlockError("at/count inválidos.");
  return writeTransaction(async () => {
    const sheet = await requireSheet(botId, sheetId);
    staleCheck(sheet, body.baseVersion, author);
    const tab = await requireTab(sheet.id, tabId);
    const axis = sql.identifier(op.endsWith("rows") ? "row" : "col");
    if (op.startsWith("delete"))
      await db().execute(
        sql`delete from sheet_cells where tab_id = ${tab.id} and ${axis} >= ${at} and ${axis} < ${at + count}`,
      );
    const shift = op.startsWith("insert") ? count : -count;
    const from = op.startsWith("insert") ? at : at + count;
    await db().execute(
      sql`update sheet_cells set ${axis} = -(${axis} + ${shift}) - 1 where tab_id = ${tab.id} and ${axis} >= ${from}`,
    );
    await db().execute(sql`update sheet_cells set ${axis} = -${axis} - 1 where tab_id = ${tab.id} and ${axis} < 0`);
    await rewriteAll(sheet.id, (input, ownTab) => shiftFormula(input, ownTab, tab.name, op, at, count));
    await refreshBounds(tab.id);
    await recalc(sheet.id);
    const result = await tabResult(botId, sheet, tab, author);
    return { version: result.sheet.version, tab: result.tab, event: result.event, sheet: result.sheet };
  });
}

export async function sheetTabTool(botId: string, input: Record<string, unknown>) {
  const sheetId = String(input.id ?? "");
  const op = String(input.op ?? "");
  if (op === "add") return addTab(botId, sheetId, { name: input.name }, "bot");
  const tab = await requireTab((await requireSheet(botId, sheetId)).id, input.tabId);
  if (op === "rename") return patchTab(botId, sheetId, tab.id, { name: input.name }, "bot");
  if (op === "delete") return deleteTab(botId, sheetId, tab.id, "bot");
  if (op === "freeze")
    return patchTab(botId, sheetId, tab.id, { frozenRows: input.frozenRows, frozenCols: input.frozenCols }, "bot");
  if (op === "structure") {
    const result = await structure(
      botId,
      sheetId,
      tab.id,
      { op: input.structure, at: input.at, count: input.count },
      "bot",
    );
    return { sheet: result.sheet, event: result.event };
  }
  throw new BlockError("op inválida: use add, rename, delete, freeze ou structure.");
}

export async function markSheetSeen(botId: string, sheetId: string) {
  const sheet = await requireSheet(botId, sheetId);
  if (sheet.seenVersion < sheet.version)
    await db().update(sheets).set({ seenVersion: sheet.version, userChanges: null }).where(eq(sheets.id, sheet.id));
}

export async function sheetEditNote(botId: string) {
  const rows = await db()
    .select()
    .from(sheets)
    .where(
      and(
        liveSheets(botId),
        eq(sheets.updatedBy, "user"),
        sql`${sheets.version} > ${sheets.seenVersion}`,
        sql`${sheets.version} > ${sheets.notifiedVersion}`,
      ),
    )
    .orderBy(desc(sheets.updatedAt))
    .limit(20);
  const lines: string[] = [];
  for (const row of rows) {
    await db().update(sheets).set({ notifiedVersion: row.version }).where(eq(sheets.id, row.id));
    const tabs = new Map((await tabsOf(row.id)).map((tab) => [tab.id, tab.name]));
    const changes = ((row.userChanges as PendingChange[] | null) ?? [])
      .map((item) => `${item.ranges.join(", ")} na aba "${tabs.get(item.tabId) ?? "?"}"`)
      .join("; ");
    lines.push(
      `- A planilha "${row.title}" (${row.id}) foi editada pela pessoa${changes ? `: ${changes} mudaram` : ""}; use sheet_read antes de mudar.`,
    );
  }
  return lines;
}

export async function bookFor(botId: string, sheetId: string) {
  const sheet = await requireSheet(botId, sheetId);
  const { tabs, rows } = await loadBook(sheet.id);
  return { sheet, tabs, rows };
}
