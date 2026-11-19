import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resetData } from "../../../../test/helpers";
import { getDb } from "../../../db";
import { sheetCells, sheets, sheetTabs } from "../../../db/tables";
import { BlockError } from "../../blocks/services/blocks.shared";
import {
  addTab,
  bookFor,
  cellOf,
  createSheet,
  deleteSheet,
  deleteTab,
  formatCells,
  listSheets,
  markSheetSeen,
  maxReadCells,
  maxWriteCells,
  patchTab,
  previewOf,
  readRange,
  renameSheet,
  requireSheet,
  sheetEditNote,
  sheetOf,
  sheetTabTool,
  structure,
  writeCells,
} from "../services/sheets.service";

const bot = "bot-sheets";

beforeEach(async () => {
  await resetData();
  getDb().delete(sheetCells).run();
  getDb().delete(sheetTabs).run();
  getDb().delete(sheets).run();
});

function cells(...pairs: Array<[string, string]>) {
  return pairs.map(([a, input]) => ({ a, input }));
}

function blockError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BlockError);
    return error as BlockError;
  }
  throw new Error("expected a BlockError");
}

function make(body: Record<string, unknown> = {}, author: "bot" | "user" = "bot") {
  return createSheet(bot, { title: "Vendas", ...body }, author);
}

describe("create and list", () => {
  test("creates a sheet with default tab, preview and change range", () => {
    const { sheet, event } = make({ cells: cells(["A1", "10"], ["B3", "=A1*2"]) });
    expect(sheet).toMatchObject({ title: "Vendas", version: 1, updatedBy: "bot" });
    expect(sheet.tabs).toEqual([
      {
        id: sheet.tabs[0].id,
        name: "Planilha1",
        index: 0,
        rowCount: 3,
        colCount: 2,
        frozenRows: 0,
        frozenCols: 0,
        colWidths: {},
      },
    ]);
    expect(event.type).toBe("block.created");
    expect(event.data.changed).toEqual({ tabId: sheet.tabs[0].id, ranges: ["A1:B3"] });
    expect(readRange(bot, sheet.id, undefined, "B3").cells[0]).toMatchObject({ a: "B3", v: 20, t: "n" });
    const row = requireSheet(bot, sheet.id);
    expect(row.seenVersion).toBe(1);
  });

  test("a user-created empty sheet has no change range", () => {
    const { sheet, event } = make({ tabs: ["Um", "Dois"] }, "user");
    expect(sheet.tabs.map((tab) => tab.name)).toEqual(["Um", "Dois"]);
    expect(event.data.changed).toBeUndefined();
    expect(requireSheet(bot, sheet.id).seenVersion).toBe(0);
  });

  test("rejects bad titles, tab names and oversized writes", () => {
    expect(blockError(() => make({ title: "   " })).message).toBe("Título é obrigatório.");
    expect(blockError(() => make({ tabs: ["A", "a"] })).message).toBe("Nomes de aba repetidos.");
    expect(blockError(() => make({ tabs: ["///"] })).message).toBe("Nome da aba é obrigatório.");
    expect(blockError(() => make({ tabs: [""] })).message).toBe("Nome da aba é obrigatório.");
    const many = Array.from({ length: maxWriteCells + 1 }, () => ({ a: "A1", input: "1" }));
    expect(blockError(() => make({ cells: many })).message).toContain(`${maxWriteCells}`);
    expect(make({ tabs: ["Mês/Ano?"] }).sheet.tabs[0].name).toBe("Mês Ano");
  });

  test("lists with search and pagination", () => {
    const first = make({ title: "Orçamento 2026" }).sheet;
    make({ title: "Vendas 100%" });
    make({ title: "Outra" });
    const found = listSheets(bot, { q: "orçamento" });
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({ id: first.id, title: "Orçamento 2026", tabs: [{ name: "Planilha1" }] });
    expect(listSheets(bot, { q: "100%" }).items.map((item) => item.title)).toEqual(["Vendas 100%"]);
    const page = listSheets(bot, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(listSheets(bot, { cursor: page.nextCursor, limit: 2 }).items).toHaveLength(1);
    expect(listSheets("other-bot", {}).total).toBe(0);
  });

  test("rename, delete and missing sheet", () => {
    const { sheet } = make();
    const renamed = renameSheet(bot, sheet.id, { title: "  Novo   nome " }, "user");
    expect(renamed.sheet.title).toBe("Novo nome");
    expect(renamed.sheet.version).toBe(2);
    expect(renamed.event.data.title).toBe("Novo nome");
    const event = deleteSheet(bot, sheet.id, "bot");
    expect(event).toMatchObject({ type: "block.deleted", data: { version: 3 } });
    const missing = blockError(() => requireSheet(bot, sheet.id));
    expect(missing.status).toBe(404);
    expect(listSheets(bot, {}).total).toBe(0);
  });
});

describe("read and write", () => {
  test("reads by tab name, default window and rejects bad or huge ranges", () => {
    const { sheet } = make({ tabs: ["Dados"], cells: cells(["A1", "1"], ["A30000", "2"]) });
    expect(readRange(bot, sheet.id, "dados", "A1:A2").cells.map((cell) => cell.v)).toEqual([1]);
    expect(readRange(bot, sheet.id, null, "").range).toBe("A1:A100");
    expect(blockError(() => readRange(bot, sheet.id, "Nope", "A1")).status).toBe(404);
    expect(blockError(() => readRange(bot, sheet.id, "", "1A")).message).toBe("Endereço inválido: 1A");
    expect(blockError(() => readRange(bot, sheet.id, "", "A:A")).message).toContain(`${maxReadCells}`);
  });

  test("writes, clears and reports dependents", () => {
    const { sheet } = make({ cells: cells(["A1", "1"], ["A2", "2"], ["B1", "=A1+A2"], ["C1", "x"]) });
    const tab = sheet.tabs[0].id;
    formatCells(bot, sheet.id, tab, { ranges: "A2", format: { bold: true } }, "bot");
    const { result, event } = writeCells(
      bot,
      sheet.id,
      tab,
      { cells: cells(["A1", "5"], ["A2", ""], ["C1", ""], ["D9", ""]) },
      "bot",
    );
    expect(result.cells).toEqual([
      { a: "A1", r: 0, c: 0, input: "5", v: 5, t: "n" },
      { a: "B1", r: 0, c: 1, input: "=A1+A2", v: 5, t: "n" },
      { a: "A2", r: 1, c: 0, input: "", v: null, t: null, format: { bold: true } },
      { a: "C1", r: 0, c: 2, input: "", v: null, t: null },
      { a: "D9", r: 8, c: 3, input: "", v: null, t: null },
    ]);
    expect(event.data.changed).toEqual({ tabId: tab, ranges: ["A1:D9"] });
    expect(readRange(bot, sheet.id, tab, "C1").cells).toEqual([]);
    const updated = writeCells(bot, sheet.id, tab, { cells: cells(["A2", "R$ 3,00"]) }, "bot").result;
    expect(updated.cells.find((cell) => cell.a === "A2")).toMatchObject({ v: 3, format: { bold: true } });
    expect(updated.cells.find((cell) => cell.a === "B1")).toMatchObject({ v: 8 });
    const money = writeCells(bot, sheet.id, tab, { cells: cells(["E1", "R$ 2,50"]) }, "bot").result;
    expect(money.cells[0]).toMatchObject({ v: 2.5, format: { type: "brl", decimals: 2 } });
  });

  test("rejects bad writes and stale bot writes", () => {
    const { sheet } = make();
    const tab = sheet.tabs[0].id;
    expect(blockError(() => writeCells(bot, sheet.id, tab, { cells: [] }, "bot")).message).toBe("cells é obrigatório.");
    expect(blockError(() => writeCells(bot, sheet.id, tab, {}, "bot")).message).toBe("cells é obrigatório.");
    const many = Array.from({ length: maxWriteCells + 1 }, () => ({ a: "A1", input: "1" }));
    expect(blockError(() => writeCells(bot, sheet.id, tab, { cells: many }, "bot")).message).toContain("No máximo");
    expect(
      blockError(() => writeCells(bot, sheet.id, tab, { cells: [{ a: "ZZZZ1", input: "1" }] }, "bot")).message,
    ).toBe("Endereço inválido: ZZZZ1");
    expect(blockError(() => writeCells(bot, sheet.id, tab, { cells: [{ input: "1" }] }, "bot")).message).toBe(
      "Endereço inválido: ",
    );
    writeCells(bot, sheet.id, tab, { cells: cells(["A1", "1"]) }, "user");
    const stale = blockError(() =>
      writeCells(bot, sheet.id, tab, { cells: cells(["A1", "2"]), baseVersion: 1 }, "bot"),
    );
    expect(stale.status).toBe(409);
  });

  test("person edits merge into one version and become a notice for the bot", () => {
    const { sheet } = make({ tabs: ["Dados"] });
    const tab = sheet.tabs[0].id;
    const first = writeCells(bot, sheet.id, tab, { cells: cells(["A1", "1"]) }, "user");
    const second = writeCells(bot, sheet.id, tab, { cells: cells(["B2", "2"]) }, "user");
    expect(first.result.version).toBe(2);
    expect(second.result.version).toBe(2);
    expect(requireSheet(bot, sheet.id).userChanges).toEqual([{ tabId: tab, ranges: ["A1", "B2"] }]);
    renameSheet(bot, sheet.id, { title: "Vendas" }, "user");
    expect(requireSheet(bot, sheet.id).userChanges).toEqual([{ tabId: tab, ranges: ["A1", "B2"] }]);
    expect(sheetEditNote(bot)).toEqual([
      `- A planilha "Vendas" (${sheet.id}) foi editada pela pessoa: A1, B2 na aba "Dados" mudaram; use sheet_read antes de mudar.`,
    ]);
    expect(sheetEditNote(bot)).toEqual([]);
    markSheetSeen(bot, sheet.id);
    expect(requireSheet(bot, sheet.id)).toMatchObject({ seenVersion: 2, userChanges: null });
    markSheetSeen(bot, sheet.id);
    expect(requireSheet(bot, sheet.id).seenVersion).toBe(2);
  });

  test("edit notice without ranges or with a removed tab", () => {
    const { sheet } = make({ tabs: ["Um", "Dois"] }, "user");
    renameSheet(bot, sheet.id, { title: "Só título" }, "user");
    expect(sheetEditNote(bot)).toEqual([
      `- A planilha "Só título" (${sheet.id}) foi editada pela pessoa; use sheet_read antes de mudar.`,
    ]);
    writeCells(bot, sheet.id, sheet.tabs[1].id, { cells: cells(["A1", "2"]) }, "bot");
    expect(requireSheet(bot, sheet.id).userChanges).toBeNull();
    writeCells(bot, sheet.id, sheet.tabs[1].id, { cells: cells(["A2", "2"]) }, "user");
    const pending = requireSheet(bot, sheet.id).userChanges as unknown[];
    getDb()
      .update(sheets)
      .set({ userChanges: [{ tabId: "tab_gone", ranges: ["C3"] }, ...pending] })
      .where(eq(sheets.id, sheet.id))
      .run();
    expect(sheetEditNote(bot)[0]).toContain('C3 na aba "?"; A2 na aba "Dois" mudaram');
  });

  test("decodes stored values that are not JSON and previews the grid", () => {
    const { sheet } = make({ cells: cells(["A1", "1"], ["B2", "texto"], ["G9", "fora"]) });
    const tab = sheet.tabs[0].id;
    getDb()
      .update(sheetCells)
      .set({ value: "cru", format: { bold: true } })
      .where(eq(sheetCells.row, 1))
      .run();
    const row = getDb().select().from(sheetCells).where(eq(sheetCells.row, 1)).get()!;
    expect(cellOf(row)).toMatchObject({ a: "B2", v: "cru", format: { bold: true } });
    patchTab(bot, sheet.id, tab, { colWidths: { A: 200 } }, "bot");
    const preview = previewOf(sheet.id);
    expect(preview).toMatchObject({
      kind: "sheet",
      tab: "Planilha1",
      tabs: 1,
      rowCount: 9,
      colCount: 7,
      frozenRows: 0,
    });
    expect(preview.rows).toHaveLength(8);
    expect(preview.rows[0]).toHaveLength(6);
    expect(preview.rows[0][0]).toEqual({ v: 1, t: "n" });
    expect(preview.rows[1][1]).toEqual({ v: "cru", t: "s", format: { bold: true } });
    expect(preview.colWidths).toEqual([200, 96, 96, 96, 96, 96]);
    getDb().update(sheetTabs).set({ rowCount: 1, colCount: 1 }).where(eq(sheetTabs.id, tab)).run();
    expect(previewOf(sheet.id, tab).rows).toEqual([[{ v: 1, t: "n" }]]);
  });
});

describe("format", () => {
  test("applies, merges and clears formats", () => {
    const { sheet } = make({ cells: cells(["A1", "1"], ["B2", "2"]) });
    const tab = sheet.tabs[0].id;
    const applied = formatCells(
      bot,
      sheet.id,
      tab,
      { ranges: ["A1:B2"], format: { type: "brl", decimals: 12.7, bold: 1, align: "right" } },
      "bot",
    );
    expect(applied.result.cells.map((cell) => cell.a)).toEqual(["A1", "B1", "A2", "B2"]);
    expect(applied.result.cells[1]).toMatchObject({
      input: "",
      format: { type: "brl", decimals: 10, bold: true, align: "right" },
    });
    expect(applied.event.data.changed).toEqual({ tabId: tab, ranges: ["A1:B2"] });
    formatCells(bot, sheet.id, tab, { ranges: "A1", format: { decimals: "x" } }, "bot");
    expect(readRange(bot, sheet.id, tab, "A1").cells[0].format).toEqual({
      type: "brl",
      decimals: 0,
      bold: true,
      align: "right",
    });
    const cleared = formatCells(bot, sheet.id, tab, { ranges: ["A1:B2", "C1"], format: null }, "bot");
    expect(cleared.result.cells.map((cell) => [cell.a, cell.format ?? null])).toEqual([
      ["A1", null],
      ["B2", null],
    ]);
    expect(readRange(bot, sheet.id, tab, "A1:C2").cells.map((cell) => cell.a)).toEqual(["A1", "B2"]);
  });

  test("rejects bad formats, ranges and oversized formatting", () => {
    const { sheet } = make({ cells: cells(["A1", "1"], ["A30000", "1"]) });
    const tab = sheet.tabs[0].id;
    const run = (body: Record<string, unknown>) =>
      blockError(() => formatCells(bot, sheet.id, tab, body, "bot")).message;
    expect(run({ format: {} })).toBe("ranges é obrigatório.");
    expect(run({ ranges: [], format: {} })).toBe("ranges é obrigatório.");
    expect(run({ ranges: "A1", format: "bold" })).toBe("format inválido.");
    expect(run({ ranges: "A1" })).toBe("format inválido.");
    expect(run({ ranges: "A1", format: { type: "money" } })).toBe("Tipo de formato inválido.");
    expect(run({ ranges: "A1", format: { align: "justify" } })).toBe("Alinhamento inválido.");
    expect(run({ ranges: "1A", format: {} })).toBe("Endereço inválido: 1A");
    expect(run({ ranges: "A:A", format: {} })).toContain(`${maxWriteCells}`);
  });
});

describe("tabs", () => {
  test("adds tabs with default and custom names and rejects duplicates", () => {
    const { sheet } = make();
    const added = addTab(bot, sheet.id, {}, "user");
    expect(added.tab).toMatchObject({ name: "Planilha2", index: 1 });
    expect(added.sheet.version).toBe(2);
    expect(addTab(bot, sheet.id, { name: "Resumo" }, "bot").sheet.tabs.map((tab) => tab.name)).toEqual([
      "Planilha1",
      "Planilha2",
      "Resumo",
    ]);
    const clash = blockError(() => addTab(bot, sheet.id, { name: "resumo" }, "bot"));
    expect(clash).toMatchObject({ status: 409, code: "exists" });
  });

  test("renaming a tab rewrites formulas that point to it", () => {
    const { sheet } = make({ tabs: ["Dados", "Resumo"], cells: cells(["A1", "7"]) });
    const [dados, resumo] = sheet.tabs;
    writeCells(bot, sheet.id, resumo.id, { cells: cells(["A1", "=Dados!A1*2"], ["A2", "texto"]) }, "bot");
    const renamed = patchTab(bot, sheet.id, dados.id, { name: "Base Mês" }, "bot");
    expect(renamed.tab).toMatchObject({ name: "Base Mês", index: 0 });
    expect(readRange(bot, sheet.id, resumo.id, "A1").cells[0]).toMatchObject({ input: "='Base Mês'!A1*2", v: 14 });
    const clash = blockError(() => patchTab(bot, sheet.id, dados.id, { name: "resumo" }, "bot"));
    expect(clash.status).toBe(409);
    const same = patchTab(bot, sheet.id, dados.id, { name: "Base Mês" }, "bot");
    expect(same.tab?.name).toBe("Base Mês");
  });

  test("freezes panes and keeps only valid column widths", () => {
    const { sheet } = make();
    const tab = sheet.tabs[0].id;
    const patched = patchTab(
      bot,
      sheet.id,
      tab,
      {
        frozenRows: 99,
        frozenCols: -3,
        colWidths: { a: 120, B: 10, C: "x", D: 2000, XFE: 100, "1A": 100, E: 24.4 },
      },
      "bot",
    );
    expect(patched.tab).toMatchObject({ frozenRows: 50, frozenCols: 0, colWidths: { A: 120, E: 24 } });
    const again = patchTab(bot, sheet.id, tab, { frozenRows: "x", frozenCols: 3, colWidths: { B: 300 } }, "bot");
    expect(again.tab).toMatchObject({ frozenRows: 0, frozenCols: 3, colWidths: { A: 120, B: 300, E: 24 } });
    const untouched = patchTab(bot, sheet.id, tab, {}, "bot");
    expect(untouched.tab).toMatchObject({ frozenCols: 3 });
    expect(untouched.sheet.version).toBe(4);
  });

  test("deletes tabs but never the last one and dependents turn into #REF!", () => {
    const { sheet } = make({ tabs: ["Dados", "Resumo"], cells: cells(["A1", "7"]) });
    const [dados, resumo] = sheet.tabs;
    writeCells(bot, sheet.id, resumo.id, { cells: cells(["A1", "=Dados!A1"]) }, "bot");
    const removed = deleteTab(bot, sheet.id, dados.id, "bot");
    expect(removed.tab).toBeNull();
    expect(removed.sheet.tabs.map((tab) => tab.name)).toEqual(["Resumo"]);
    expect(readRange(bot, sheet.id, resumo.id, "A1").cells[0]).toMatchObject({ v: "#REF!", t: "e" });
    expect(blockError(() => deleteTab(bot, sheet.id, resumo.id, "bot")).message).toBe("A última aba não pode sair.");
    expect(blockError(() => deleteTab(bot, sheet.id, dados.id, "bot")).status).toBe(404);
  });

  test("a sheet whose tabs were all removed loads as an empty book", () => {
    const { sheet } = make();
    getDb()
      .update(sheetTabs)
      .set({ deletedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(sheetTabs.sheetId, sheet.id))
      .run();
    const book = bookFor(bot, sheet.id);
    expect(book.tabs).toEqual([]);
    expect(book.rows).toEqual([]);
    expect(sheetOf(book.sheet).tabs).toEqual([]);
  });
});

describe("structure", () => {
  test("inserts and deletes rows and columns, moving cells and formulas", () => {
    const { sheet } = make({
      cells: cells(["A1", "1"], ["A2", "2"], ["A3", "3"], ["B1", "=SOMA(A1:A3)"], ["C1", "=A3"]),
    });
    const tab = sheet.tabs[0].id;
    structure(bot, sheet.id, tab, { op: "delete_rows", at: 1, count: 1 }, "bot");
    expect(readRange(bot, sheet.id, tab, "A1:C3").cells.map((cell) => [cell.a, cell.input, cell.v])).toEqual([
      ["A1", "1", 1],
      ["B1", "=SOMA(A1:A2)", 4],
      ["C1", "=A2", 3],
      ["A2", "3", 3],
    ]);
    structure(bot, sheet.id, tab, { op: "insert_cols", at: 0 }, "bot");
    expect(readRange(bot, sheet.id, tab, "C1").cells[0]).toMatchObject({ input: "=SOMA(B1:B2)", v: 4 });
    const result = structure(bot, sheet.id, tab, { op: "delete_cols", at: 1, count: 1, baseVersion: 1 }, "bot");
    expect(result.tab).toMatchObject({ rowCount: 1, colCount: 3 });
    expect(result.version).toBe(4);
    expect(readRange(bot, sheet.id, tab, "B1:C1").cells.map((cell) => [cell.input, cell.v])).toEqual([
      ["=SOMA(#REF!)", "#REF!"],
      ["=#REF!", "#REF!"],
    ]);
  });

  test("rejects invalid ops and positions", () => {
    const { sheet } = make();
    const tab = sheet.tabs[0].id;
    const run = (body: Record<string, unknown>) => blockError(() => structure(bot, sheet.id, tab, body, "bot")).message;
    expect(run({ op: "rotate", at: 0 })).toBe("op inválida.");
    expect(run({ op: "insert_rows", at: -1 })).toBe("at/count inválidos.");
    expect(run({ op: "insert_rows", at: "x" })).toBe("at/count inválidos.");
    expect(run({ op: "insert_rows", at: 0, count: 0 })).toBe("at/count inválidos.");
    expect(run({ op: "insert_rows", at: 0, count: 10_001 })).toBe("at/count inválidos.");
    expect(run({ op: "insert_rows", at: 0, count: "x" })).toBe("at/count inválidos.");
  });
});

describe("sheet tab tool", () => {
  test("routes every op through the bot", () => {
    const { sheet } = make({ tabs: ["Dados"], cells: cells(["A1", "1"]) });
    const added = sheetTabTool(bot, { id: sheet.id, op: "add", name: "Extra" });
    expect(added.sheet.tabs.map((tab) => tab.name)).toEqual(["Dados", "Extra"]);
    const renamed = sheetTabTool(bot, { id: sheet.id, op: "rename", tabId: "extra", name: "Resumo" });
    expect(renamed.sheet.tabs.map((tab) => tab.name)).toEqual(["Dados", "Resumo"]);
    const frozen = sheetTabTool(bot, { id: sheet.id, op: "freeze", tabId: "Dados", frozenRows: 1, frozenCols: 1 });
    expect(frozen.sheet.tabs[0]).toMatchObject({ frozenRows: 1, frozenCols: 1 });
    const shifted = sheetTabTool(bot, {
      id: sheet.id,
      op: "structure",
      tabId: "Dados",
      structure: "insert_rows",
      at: 0,
      count: 2,
    });
    expect(shifted.event.type).toBe("block.updated");
    expect(readRange(bot, sheet.id, "Dados", "A3").cells[0]).toMatchObject({ v: 1 });
    const removed = sheetTabTool(bot, { id: sheet.id, op: "delete", tabId: "Resumo" });
    expect(removed.sheet.tabs.map((tab) => tab.name)).toEqual(["Dados"]);
    expect(blockError(() => sheetTabTool(bot, { id: sheet.id, op: "spin" })).message).toContain("op inválida");
    expect(blockError(() => sheetTabTool(bot, {})).status).toBe(404);
  });
});
