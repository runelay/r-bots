import { beforeEach, describe, expect, test } from "bun:test";
import type { CellFormat } from "@runelay-bots/protocol";
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
  await getDb().delete(sheetCells);
  await getDb().delete(sheetTabs);
  await getDb().delete(sheets);
});

function cells(...pairs: Array<[string, string]>) {
  return pairs.map(([a, input]) => ({ a, input }));
}

async function blockError(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(BlockError);
    return error as BlockError;
  }
  throw new Error("expected a BlockError");
}

async function make(body: Record<string, unknown> = {}, author: "bot" | "user" = "bot") {
  return await createSheet(bot, { title: "Vendas", ...body }, author);
}

describe("create and list", () => {
  test("creates a sheet with default tab, preview and change range", async () => {
    const { sheet, event } = await make({ cells: cells(["A1", "10"], ["B3", "=A1*2"]) });
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
    expect((await readRange(bot, sheet.id, undefined, "B3")).cells[0]).toMatchObject({ a: "B3", v: 20, t: "n" });
    const row = await requireSheet(bot, sheet.id);
    expect(row.seenVersion).toBe(1);
  });

  test("a user-created empty sheet has no change range", async () => {
    const { sheet, event } = await make({ tabs: ["Um", "Dois"] }, "user");
    expect(sheet.tabs.map((tab) => tab.name)).toEqual(["Um", "Dois"]);
    expect(event.data.changed).toBeUndefined();
    expect((await requireSheet(bot, sheet.id)).seenVersion).toBe(0);
  });

  test("rejects bad titles, tab names and oversized writes", async () => {
    expect((await blockError(async () => await make({ title: "   " }))).message).toBe("Título é obrigatório.");
    expect((await blockError(async () => await make({ tabs: ["A", "a"] }))).message).toBe("Nomes de aba repetidos.");
    expect((await blockError(async () => await make({ tabs: ["///"] }))).message).toBe("Nome da aba é obrigatório.");
    expect((await blockError(async () => await make({ tabs: [""] }))).message).toBe("Nome da aba é obrigatório.");
    const many = Array.from({ length: maxWriteCells + 1 }, () => ({ a: "A1", input: "1" }));
    expect((await blockError(async () => await make({ cells: many }))).message).toContain(`${maxWriteCells}`);
    expect((await make({ tabs: ["Mês/Ano?"] })).sheet.tabs[0].name).toBe("Mês Ano");
  });

  test("lists with search and pagination", async () => {
    const first = (await make({ title: "Orçamento 2026" })).sheet;
    await make({ title: "Vendas 100%" });
    await make({ title: "Outra" });
    const found = await listSheets(bot, { q: "orçamento" });
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({ id: first.id, title: "Orçamento 2026", tabs: [{ name: "Planilha1" }] });
    expect((await listSheets(bot, { q: "100%" })).items.map((item) => item.title)).toEqual(["Vendas 100%"]);
    const page = await listSheets(bot, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect((await listSheets(bot, { cursor: page.nextCursor, limit: 2 })).items).toHaveLength(1);
    expect((await listSheets("other-bot", {})).total).toBe(0);
  });

  test("rename, delete and missing sheet", async () => {
    const { sheet } = await make();
    const renamed = await renameSheet(bot, sheet.id, { title: "  Novo   nome " }, "user");
    expect(renamed.sheet.title).toBe("Novo nome");
    expect(renamed.sheet.version).toBe(2);
    expect(renamed.event.data.title).toBe("Novo nome");
    const event = await deleteSheet(bot, sheet.id, "bot");
    expect(event).toMatchObject({ type: "block.deleted", data: { version: 3 } });
    const missing = await blockError(async () => await requireSheet(bot, sheet.id));
    expect(missing.status).toBe(404);
    expect((await listSheets(bot, {})).total).toBe(0);
  });
});

describe("read and write", () => {
  test("reads by tab name, default window and rejects bad or huge ranges", async () => {
    const { sheet } = await make({ tabs: ["Dados"], cells: cells(["A1", "1"], ["A30000", "2"]) });
    expect((await readRange(bot, sheet.id, "dados", "A1:A2")).cells.map((cell) => cell.v)).toEqual([1]);
    expect((await readRange(bot, sheet.id, null, "")).range).toBe("A1:A100");
    expect((await blockError(async () => await readRange(bot, sheet.id, "Nope", "A1"))).status).toBe(404);
    expect((await blockError(async () => await readRange(bot, sheet.id, "", "1A"))).message).toBe(
      "Endereço inválido: 1A",
    );
    expect((await blockError(async () => await readRange(bot, sheet.id, "", "A:A"))).message).toContain(
      `${maxReadCells}`,
    );
  });

  test("writes, clears and reports dependents", async () => {
    const { sheet } = await make({ cells: cells(["A1", "1"], ["A2", "2"], ["B1", "=A1+A2"], ["C1", "x"]) });
    const tab = sheet.tabs[0].id;
    await formatCells(bot, sheet.id, tab, { ranges: "A2", format: { bold: true } }, "bot");
    const { result, event } = await writeCells(
      bot,
      sheet.id,
      tab,
      { cells: cells(["A1", "5"], ["A2", ""], ["C1", ""], ["D9", ""]) },
      "bot",
    );
    expect(result.cells).toEqual([
      { a: "A1", r: 0, c: 0, input: "5", v: 5, t: "n" },
      { a: "B1", r: 0, c: 1, input: "=A1+A2", v: 5, t: "n" },
      { a: "A2", r: 1, c: 0, input: "", v: null, t: null, format: { bold: true } as CellFormat },
      { a: "C1", r: 0, c: 2, input: "", v: null, t: null },
      { a: "D9", r: 8, c: 3, input: "", v: null, t: null },
    ]);
    expect(event.data.changed).toEqual({ tabId: tab, ranges: ["A1:D9"] });
    expect((await readRange(bot, sheet.id, tab, "C1")).cells).toEqual([]);
    const updated = (await writeCells(bot, sheet.id, tab, { cells: cells(["A2", "R$ 3,00"]) }, "bot")).result;
    expect(updated.cells.find((cell) => cell.a === "A2")).toMatchObject({ v: 3, format: { bold: true } });
    expect(updated.cells.find((cell) => cell.a === "B1")).toMatchObject({ v: 8 });
    const money = (await writeCells(bot, sheet.id, tab, { cells: cells(["E1", "R$ 2,50"]) }, "bot")).result;
    expect(money.cells[0]).toMatchObject({ v: 2.5, format: { type: "brl", decimals: 2 } });
  });

  test("rejects bad writes and stale bot writes", async () => {
    const { sheet } = await make();
    const tab = sheet.tabs[0].id;
    expect((await blockError(async () => await writeCells(bot, sheet.id, tab, { cells: [] }, "bot"))).message).toBe(
      "cells é obrigatório.",
    );
    expect((await blockError(async () => await writeCells(bot, sheet.id, tab, {}, "bot"))).message).toBe(
      "cells é obrigatório.",
    );
    const many = Array.from({ length: maxWriteCells + 1 }, () => ({ a: "A1", input: "1" }));
    expect(
      (await blockError(async () => await writeCells(bot, sheet.id, tab, { cells: many }, "bot"))).message,
    ).toContain("No máximo");
    expect(
      (
        await blockError(
          async () => await writeCells(bot, sheet.id, tab, { cells: [{ a: "ZZZZ1", input: "1" }] }, "bot"),
        )
      ).message,
    ).toBe("Endereço inválido: ZZZZ1");
    expect(
      (await blockError(async () => await writeCells(bot, sheet.id, tab, { cells: [{ input: "1" }] }, "bot"))).message,
    ).toBe("Endereço inválido: ");
    await writeCells(bot, sheet.id, tab, { cells: cells(["A1", "1"]) }, "user");
    const stale = await blockError(
      async () => await writeCells(bot, sheet.id, tab, { cells: cells(["A1", "2"]), baseVersion: 1 }, "bot"),
    );
    expect(stale.status).toBe(409);
  });

  test("person edits merge into one version and become a notice for the bot", async () => {
    const { sheet } = await make({ tabs: ["Dados"] });
    const tab = sheet.tabs[0].id;
    const first = await writeCells(bot, sheet.id, tab, { cells: cells(["A1", "1"]) }, "user");
    const second = await writeCells(bot, sheet.id, tab, { cells: cells(["B2", "2"]) }, "user");
    expect(first.result.version).toBe(2);
    expect(second.result.version).toBe(2);
    expect((await requireSheet(bot, sheet.id)).userChanges).toEqual([{ tabId: tab, ranges: ["A1", "B2"] }]);
    await renameSheet(bot, sheet.id, { title: "Vendas" }, "user");
    expect((await requireSheet(bot, sheet.id)).userChanges).toEqual([{ tabId: tab, ranges: ["A1", "B2"] }]);
    expect(await sheetEditNote(bot)).toEqual([
      `- A planilha "Vendas" (${sheet.id}) foi editada pela pessoa: A1, B2 na aba "Dados" mudaram; use sheet_read antes de mudar.`,
    ]);
    expect(await sheetEditNote(bot)).toEqual([]);
    await markSheetSeen(bot, sheet.id);
    expect(await requireSheet(bot, sheet.id)).toMatchObject({ seenVersion: 2, userChanges: null });
    await markSheetSeen(bot, sheet.id);
    expect((await requireSheet(bot, sheet.id)).seenVersion).toBe(2);
  });

  test("edit notice without ranges or with a removed tab", async () => {
    const { sheet } = await make({ tabs: ["Um", "Dois"] }, "user");
    await renameSheet(bot, sheet.id, { title: "Só título" }, "user");
    expect(await sheetEditNote(bot)).toEqual([
      `- A planilha "Só título" (${sheet.id}) foi editada pela pessoa; use sheet_read antes de mudar.`,
    ]);
    await writeCells(bot, sheet.id, sheet.tabs[1].id, { cells: cells(["A1", "2"]) }, "bot");
    expect((await requireSheet(bot, sheet.id)).userChanges).toBeNull();
    await writeCells(bot, sheet.id, sheet.tabs[1].id, { cells: cells(["A2", "2"]) }, "user");
    const pending = (await requireSheet(bot, sheet.id)).userChanges as unknown[];
    await getDb()
      .update(sheets)
      .set({ userChanges: [{ tabId: "tab_gone", ranges: ["C3"] }, ...pending] })
      .where(eq(sheets.id, sheet.id));
    expect((await sheetEditNote(bot))[0]).toContain('C3 na aba "?"; A2 na aba "Dois" mudaram');
  });

  test("decodes stored values that are not JSON and previews the grid", async () => {
    const { sheet } = await make({ cells: cells(["A1", "1"], ["B2", "texto"], ["G9", "fora"]) });
    const tab = sheet.tabs[0].id;
    await getDb()
      .update(sheetCells)
      .set({ value: "cru", format: { bold: true } })
      .where(eq(sheetCells.row, 1));
    const row = (await getDb().select().from(sheetCells).where(eq(sheetCells.row, 1)).limit(1))[0]!;
    expect(cellOf(row)).toMatchObject({ a: "B2", v: "cru", format: { bold: true } });
    await patchTab(bot, sheet.id, tab, { colWidths: { A: 200 } }, "bot");
    const preview = await previewOf(sheet.id);
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
    expect(preview.rows[1][1]).toEqual({ v: "cru", t: "s", format: { bold: true } as CellFormat });
    expect(preview.colWidths).toEqual([200, 96, 96, 96, 96, 96]);
    await getDb().update(sheetTabs).set({ rowCount: 1, colCount: 1 }).where(eq(sheetTabs.id, tab));
    expect((await previewOf(sheet.id, tab)).rows).toEqual([[{ v: 1, t: "n" }]]);
  });
});

describe("format", () => {
  test("applies, merges and clears formats", async () => {
    const { sheet } = await make({ cells: cells(["A1", "1"], ["B2", "2"]) });
    const tab = sheet.tabs[0].id;
    const applied = await formatCells(
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
    await formatCells(bot, sheet.id, tab, { ranges: "A1", format: { decimals: "x" } }, "bot");
    expect((await readRange(bot, sheet.id, tab, "A1")).cells[0].format).toEqual({
      type: "brl",
      decimals: 0,
      bold: true,
      align: "right",
    });
    const cleared = await formatCells(bot, sheet.id, tab, { ranges: ["A1:B2", "C1"], format: null }, "bot");
    expect(cleared.result.cells.map((cell) => [cell.a, cell.format ?? null])).toEqual([
      ["A1", null],
      ["B2", null],
    ]);
    expect((await readRange(bot, sheet.id, tab, "A1:C2")).cells.map((cell) => cell.a)).toEqual(["A1", "B2"]);
  });

  test("rejects bad formats, ranges and oversized formatting", async () => {
    const { sheet } = await make({ cells: cells(["A1", "1"], ["A30000", "1"]) });
    const tab = sheet.tabs[0].id;
    const run = async (body: Record<string, unknown>) =>
      (await blockError(async () => await formatCells(bot, sheet.id, tab, body, "bot"))).message;
    expect(await run({ format: {} })).toBe("ranges é obrigatório.");
    expect(await run({ ranges: [], format: {} })).toBe("ranges é obrigatório.");
    expect(await run({ ranges: "A1", format: "bold" })).toBe("format inválido.");
    expect(await run({ ranges: "A1" })).toBe("format inválido.");
    expect(await run({ ranges: "A1", format: { type: "money" } })).toBe("Tipo de formato inválido.");
    expect(await run({ ranges: "A1", format: { align: "justify" } })).toBe("Alinhamento inválido.");
    expect(await run({ ranges: "1A", format: {} })).toBe("Endereço inválido: 1A");
    expect(await run({ ranges: "A:A", format: {} })).toContain(`${maxWriteCells}`);
  });
});

describe("tabs", () => {
  test("adds tabs with default and custom names and rejects duplicates", async () => {
    const { sheet } = await make();
    const added = await addTab(bot, sheet.id, {}, "user");
    expect(added.tab).toMatchObject({ name: "Planilha2", index: 1 });
    expect(added.sheet.version).toBe(2);
    expect((await addTab(bot, sheet.id, { name: "Resumo" }, "bot")).sheet.tabs.map((tab) => tab.name)).toEqual([
      "Planilha1",
      "Planilha2",
      "Resumo",
    ]);
    const clash = await blockError(async () => await addTab(bot, sheet.id, { name: "resumo" }, "bot"));
    expect(clash).toMatchObject({ status: 409, code: "exists" });
  });

  test("renaming a tab rewrites formulas that point to it", async () => {
    const { sheet } = await make({ tabs: ["Dados", "Resumo"], cells: cells(["A1", "7"]) });
    const [dados, resumo] = sheet.tabs;
    await writeCells(bot, sheet.id, resumo.id, { cells: cells(["A1", "=Dados!A1*2"], ["A2", "texto"]) }, "bot");
    const renamed = await patchTab(bot, sheet.id, dados.id, { name: "Base Mês" }, "bot");
    expect(renamed.tab).toMatchObject({ name: "Base Mês", index: 0 });
    expect((await readRange(bot, sheet.id, resumo.id, "A1")).cells[0]).toMatchObject({
      input: "='Base Mês'!A1*2",
      v: 14,
    });
    const clash = await blockError(async () => await patchTab(bot, sheet.id, dados.id, { name: "resumo" }, "bot"));
    expect(clash.status).toBe(409);
    const same = await patchTab(bot, sheet.id, dados.id, { name: "Base Mês" }, "bot");
    expect(same.tab?.name).toBe("Base Mês");
  });

  test("freezes panes and keeps only valid column widths", async () => {
    const { sheet } = await make();
    const tab = sheet.tabs[0].id;
    const patched = await patchTab(
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
    const again = await patchTab(bot, sheet.id, tab, { frozenRows: "x", frozenCols: 3, colWidths: { B: 300 } }, "bot");
    expect(again.tab).toMatchObject({ frozenRows: 0, frozenCols: 3, colWidths: { A: 120, B: 300, E: 24 } });
    const untouched = await patchTab(bot, sheet.id, tab, {}, "bot");
    expect(untouched.tab).toMatchObject({ frozenCols: 3 });
    expect(untouched.sheet.version).toBe(4);
  });

  test("deletes tabs but never the last one and dependents turn into #REF!", async () => {
    const { sheet } = await make({ tabs: ["Dados", "Resumo"], cells: cells(["A1", "7"]) });
    const [dados, resumo] = sheet.tabs;
    await writeCells(bot, sheet.id, resumo.id, { cells: cells(["A1", "=Dados!A1"]) }, "bot");
    const removed = await deleteTab(bot, sheet.id, dados.id, "bot");
    expect(removed.tab).toBeNull();
    expect(removed.sheet.tabs.map((tab) => tab.name)).toEqual(["Resumo"]);
    expect((await readRange(bot, sheet.id, resumo.id, "A1")).cells[0]).toMatchObject({ v: "#REF!", t: "e" });
    expect((await blockError(async () => await deleteTab(bot, sheet.id, resumo.id, "bot"))).message).toBe(
      "A última aba não pode sair.",
    );
    expect((await blockError(async () => await deleteTab(bot, sheet.id, dados.id, "bot"))).status).toBe(404);
  });

  test("a sheet whose tabs were all removed loads as an empty book", async () => {
    const { sheet } = await make();
    await getDb()
      .update(sheetTabs)
      .set({ deletedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(sheetTabs.sheetId, sheet.id));
    const book = await bookFor(bot, sheet.id);
    expect(book.tabs).toEqual([]);
    expect(book.rows).toEqual([]);
    expect((await sheetOf(book.sheet)).tabs).toEqual([]);
  });
});

describe("structure", () => {
  test("inserts and deletes rows and columns, moving cells and formulas", async () => {
    const { sheet } = await make({
      cells: cells(["A1", "1"], ["A2", "2"], ["A3", "3"], ["B1", "=SOMA(A1:A3)"], ["C1", "=A3"]),
    });
    const tab = sheet.tabs[0].id;
    await structure(bot, sheet.id, tab, { op: "delete_rows", at: 1, count: 1 }, "bot");
    expect((await readRange(bot, sheet.id, tab, "A1:C3")).cells.map((cell) => [cell.a, cell.input, cell.v])).toEqual([
      ["A1", "1", 1],
      ["B1", "=SOMA(A1:A2)", 4],
      ["C1", "=A2", 3],
      ["A2", "3", 3],
    ]);
    await structure(bot, sheet.id, tab, { op: "insert_cols", at: 0 }, "bot");
    expect((await readRange(bot, sheet.id, tab, "C1")).cells[0]).toMatchObject({ input: "=SOMA(B1:B2)", v: 4 });
    const result = await structure(bot, sheet.id, tab, { op: "delete_cols", at: 1, count: 1, baseVersion: 1 }, "bot");
    expect(result.tab).toMatchObject({ rowCount: 1, colCount: 3 });
    expect(result.version).toBe(4);
    expect((await readRange(bot, sheet.id, tab, "B1:C1")).cells.map((cell) => [cell.input, cell.v])).toEqual([
      ["=SOMA(#REF!)", "#REF!"],
      ["=#REF!", "#REF!"],
    ]);
  });

  test("rejects invalid ops and positions", async () => {
    const { sheet } = await make();
    const tab = sheet.tabs[0].id;
    const run = async (body: Record<string, unknown>) =>
      (await blockError(() => structure(bot, sheet.id, tab, body, "bot"))).message;
    expect(await run({ op: "rotate", at: 0 })).toBe("op inválida.");
    expect(await run({ op: "insert_rows", at: -1 })).toBe("at/count inválidos.");
    expect(await run({ op: "insert_rows", at: "x" })).toBe("at/count inválidos.");
    expect(await run({ op: "insert_rows", at: 0, count: 0 })).toBe("at/count inválidos.");
    expect(await run({ op: "insert_rows", at: 0, count: 10_001 })).toBe("at/count inválidos.");
    expect(await run({ op: "insert_rows", at: 0, count: "x" })).toBe("at/count inválidos.");
  });
});

describe("sheet tab tool", () => {
  test("routes every op through the bot", async () => {
    const { sheet } = await make({ tabs: ["Dados"], cells: cells(["A1", "1"]) });
    const added = await sheetTabTool(bot, { id: sheet.id, op: "add", name: "Extra" });
    expect(added.sheet.tabs.map((tab) => tab.name)).toEqual(["Dados", "Extra"]);
    const renamed = await sheetTabTool(bot, { id: sheet.id, op: "rename", tabId: "extra", name: "Resumo" });
    expect(renamed.sheet.tabs.map((tab) => tab.name)).toEqual(["Dados", "Resumo"]);
    const frozen = await sheetTabTool(bot, {
      id: sheet.id,
      op: "freeze",
      tabId: "Dados",
      frozenRows: 1,
      frozenCols: 1,
    });
    expect(frozen.sheet.tabs[0]).toMatchObject({ frozenRows: 1, frozenCols: 1 });
    const shifted = await sheetTabTool(bot, {
      id: sheet.id,
      op: "structure",
      tabId: "Dados",
      structure: "insert_rows",
      at: 0,
      count: 2,
    });
    expect(shifted.event.type).toBe("block.updated");
    expect((await readRange(bot, sheet.id, "Dados", "A3")).cells[0]).toMatchObject({ v: 1 });
    const removed = await sheetTabTool(bot, { id: sheet.id, op: "delete", tabId: "Resumo" });
    expect(removed.sheet.tabs.map((tab) => tab.name)).toEqual(["Dados"]);
    expect((await blockError(async () => await sheetTabTool(bot, { id: sheet.id, op: "spin" }))).message).toContain(
      "op inválida",
    );
    expect((await blockError(async () => await sheetTabTool(bot, {}))).status).toBe(404);
  });
});
