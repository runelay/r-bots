import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { fakeProcesses, type ProcessCall, resetData } from "../../../../test/helpers";
import { getDb } from "../../../db";
import { exports, noteLinks, notes, sheetCells, sheets, sheetTabs } from "../../../db/tables";
import { BlockError } from "../../blocks/services/blocks.shared";
import { createNote } from "../../notes/services/notes.service";
import { createSheet, formatCells, patchTab, writeCells } from "../../sheets/services/sheets.service";
import { getBlobStore } from "../../storage/services/storage.service";
import {
  createExport,
  exportBytes,
  exportFile,
  mimeOf,
  noteDocx,
  readExport,
  sheetCsv,
  sheetXlsx,
} from "../services/exports.service";

const bot = "bot-exports";

beforeEach(async () => {
  await resetData();
  getDb().delete(exports).run();
  getDb().delete(noteLinks).run();
  getDb().delete(notes).run();
  getDb().delete(sheetCells).run();
  getDb().delete(sheetTabs).run();
  getDb().delete(sheets).run();
});

afterEach(() => {
  jest.useRealTimers();
});

function unzipEntry(data: Uint8Array, name: string) {
  const buffer = Buffer.from(data);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index++) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const entryName = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    if (entryName === name) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const raw = buffer.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip entry not found: ${name}`);
}

function docText(data: Uint8Array) {
  const xml = unzipEntry(data, "word/document.xml");
  return xml
    .split("</w:p>")
    .map((paragraph) => [...paragraph.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join(""))
    .map((text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
    .filter(Boolean);
}

function fakeChrome(options: { write?: boolean; hang?: boolean } = {}) {
  const pages: string[] = [];
  let spawned: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  const fake = fakeProcesses((call: ProcessCall) => {
    const output = call.args.find((arg) => arg.startsWith("--print-to-pdf="))!.slice("--print-to-pdf=".length);
    const input = call.args.at(-1)!.replace("file://", "");
    pages.push(readFileSync(input, "utf8"));
    if (options.write !== false) writeFileSync(output, "%PDF-1.4 fake");
    spawned();
    return { code: options.write === false ? 3 : 0, hang: options.hang };
  });
  return { fake, pages, started };
}

async function errorOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(BlockError);
    return error as BlockError;
  }
  throw new Error("expected a BlockError");
}

const markdown = [
  "Intro **negrito _itálico_** ~~riscado~~ `código` [link](https://example.com) [[Plano#meta|o plano]] [[Outra]] &amp; \\* fim  ",
  "quebra",
  "",
  "## Seção",
  "",
  "- item um",
  "  - sub item",
  "- [x] feito",
  "- [ ] aberto",
  "",
  "3. três",
  "4. quatro",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "> citação",
  "",
  "---",
  "",
  "| A | B |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "<div>bloco html</div>",
].join("\n");

describe("note exports", () => {
  test("docx keeps headings, lists, tasks, code, quotes, tables and wiki links as text", async () => {
    const text = docText(await noteDocx("Minha nota", markdown));
    expect(text).toEqual([
      "Minha nota",
      "Intro negrito itálico riscado código link o plano Outra & * fimquebra",
      "Seção",
      "item um",
      "sub item",
      "☑ feito",
      "☐ aberto",
      "3. três",
      "4. quatro",
      "const a = 1;",
      " ",
      "const b = 2;",
      "citação",
      "A | B",
      "1 | 2",
      "<div>bloco html</div>",
    ]);
    const titled = docText(await noteDocx("Ignorado", "# Já tem título\n\ntexto"));
    expect(titled).toEqual(["Já tem título", "texto"]);
  });

  test("md, docx and pdf exports are stored and downloadable", async () => {
    const { note } = createNote(bot, { title: "Relatório", content: "corpo [[Alvo|alias]]" }, "bot");
    const md = await createExport(bot, { kind: "note", id: note.id, format: "md" });
    expect(md).toMatchObject({ kind: "note", sourceId: note.id, format: "md", status: "ready", fileName: "Relatório.md", error: null });
    expect(md.url).toBe(`/bots/${bot}/exports/${md.id}/file`);
    const file = await exportBytes(bot, md.id);
    expect(new TextDecoder().decode(file.data)).toBe("corpo [[Alvo|alias]]");
    expect(file).toMatchObject({ fileName: "Relatório.md", mime: "text/markdown; charset=utf-8", size: 20 });
    const docx = await createExport(bot, { kind: "note", id: note.id, format: "docx" });
    expect(docText((await exportBytes(bot, docx.id)).data)).toEqual(["Relatório", "corpo alias"]);
    const chrome = fakeChrome();
    const pdf = await createExport(bot, { kind: "note", id: note.id, format: "pdf" });
    expect(pdf).toMatchObject({ status: "ready", fileName: "Relatório.pdf", size: 13 });
    expect(new TextDecoder().decode((await exportBytes(bot, pdf.id)).data)).toBe("%PDF-1.4 fake");
    expect(chrome.fake.calls[0].args).toContain("--headless=new");
    expect(chrome.pages[0]).toContain("<h1>Relatório</h1>");
    expect(chrome.pages[0]).toContain("<p>corpo alias</p>");
  });

  test("pdf of a note with its own title skips the extra heading and escapes html", async () => {
    const { note } = createNote(bot, { title: "A & B", content: "# Topo <x>\n\ntexto" }, "bot");
    const chrome = fakeChrome();
    await createExport(bot, { kind: "note", id: note.id, format: "pdf" });
    expect(chrome.pages[0]).toContain("<title>A &amp; B</title>");
    expect(chrome.pages[0]).not.toContain("<h1>A &amp; B</h1>");
  });

  test("a chromium that writes nothing marks the export failed", async () => {
    const { note } = createNote(bot, { title: "Falha" }, "bot");
    fakeChrome({ write: false });
    const job = await createExport(bot, { kind: "note", id: note.id, format: "pdf" });
    expect(job).toMatchObject({ status: "failed", url: null, error: "Chromium não gerou o PDF (código 3)." });
    expect((await errorOf(() => exportFile(bot, job.id))).status).toBe(404);
  });

  test("a chromium that hangs is killed after the timeout", async () => {
    const { note } = createNote(bot, { title: "Lenta" }, "bot");
    jest.useFakeTimers();
    const chrome = fakeChrome({ write: false, hang: true });
    const pending = createExport(bot, { kind: "note", id: note.id, format: "pdf" });
    await chrome.started;
    jest.advanceTimersByTime(60_000);
    const job = await pending;
    expect(chrome.fake.calls[0].child.signals).toEqual(["SIGTERM"]);
    expect(job).toMatchObject({ status: "failed", error: "Chromium não gerou o PDF (código 1)." });
  });
});

describe("sheet exports", () => {
  function sample() {
    const { sheet } = createSheet(
      bot,
      {
        title: "Vendas",
        tabs: ["Dados", "Vazia"],
        cells: [
          { a: "A1", input: "Produto" },
          { a: "B1", input: "R$ 1.234,5" },
          { a: "C1", input: "12,5%" },
          { a: "D1", input: "20/11/2026" },
          { a: "E1", input: "VERDADEIRO" },
          { a: "F1", input: "=1/0" },
          { a: "G1", input: '=B1*2' },
          { a: "H1", input: '=D1+1' },
          { a: "A2", input: 'diz "oi", tchau' },
          { a: "B2", input: "1234567,891" },
          { a: "C2", input: "-5" },
          { a: "D2", input: "=E1" },
          { a: "E2", input: "FALSO" },
        ],
      },
      "bot",
    );
    const tab = sheet.tabs[0].id;
    formatCells(bot, sheet.id, tab, { ranges: "C2", format: { type: "number", decimals: 1, bold: true, align: "center" } }, "bot");
    formatCells(bot, sheet.id, tab, { ranges: ["A3"], format: { type: "datetime" } }, "bot");
    formatCells(bot, sheet.id, tab, { ranges: ["B3"], format: { type: "text" } }, "bot");
    formatCells(bot, sheet.id, tab, { ranges: ["C3"], format: { type: "general" } }, "bot");
    formatCells(bot, sheet.id, tab, { ranges: ["D3"], format: { type: "percent", decimals: 2 } }, "bot");
    formatCells(bot, sheet.id, tab, { ranges: ["E3"], format: { type: "brl", decimals: 0 } }, "bot");
    formatCells(bot, sheet.id, tab, { ranges: ["F3"], format: { type: "number" } }, "bot");
    patchTab(bot, sheet.id, tab, { frozenRows: 1, colWidths: { A: 140 } }, "bot");
    return { sheet, tab, empty: sheet.tabs[1].id };
  }

  test("xlsx keeps values, formulas, formats, frozen panes and widths", async () => {
    const { sheet } = sample();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await sheetXlsx(bot, sheet.id)).buffer as ArrayBuffer);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["Dados", "Vazia"]);
    const ws = workbook.getWorksheet("Dados")!;
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1, xSplit: 0 });
    expect(workbook.getWorksheet("Vazia")!.views ?? []).toEqual([]);
    expect(ws.getColumn("A").width).toBe(20);
    expect(ws.getCell("A1").value).toBe("Produto");
    expect(ws.getCell("B1")).toMatchObject({ value: 1234.5, numFmt: '"R$" #,##0.00' });
    expect(ws.getCell("C1")).toMatchObject({ value: 0.125, numFmt: "0%" });
    expect(ws.getCell("D1").value).toEqual(new Date("2026-11-20T00:00:00Z"));
    expect(ws.getCell("D1").numFmt).toBe("dd/mm/yyyy");
    expect(ws.getCell("E1").value).toBe(true);
    expect(ws.getCell("F1").value).toEqual({ formula: "1/0", result: { error: "#DIV/0!" } });
    expect(ws.getCell("G1").value).toEqual({ formula: "B1*2", result: 2469 });
    expect(ws.getCell("D2").value).toEqual({ formula: "E1", result: true });
    expect(ws.getCell("C2")).toMatchObject({ value: -5, numFmt: "#,##0.0" });
    expect(ws.getCell("C2").font).toEqual({ bold: true });
    expect(ws.getCell("C2").alignment).toEqual({ horizontal: "center" });
    expect(ws.getCell("A3")).toMatchObject({ value: null, numFmt: "dd/mm/yyyy hh:mm" });
    expect(ws.getCell("B3").numFmt).toBe("@");
    expect(ws.getCell("C3").numFmt).toBeUndefined();
    expect(ws.getCell("D3").numFmt).toBe("0.00%");
    expect(ws.getCell("E3").numFmt).toBe('"R$" #,##0');
    expect(ws.getCell("F3").numFmt).toBe("#,##0");
  });

  test("xlsx writes error cells and date results stored on formulas", async () => {
    const { sheet, tab } = sample();
    getDb().update(sheetCells).set({ type: "e", value: JSON.stringify("#N/A") }).where(eq(sheetCells.input, "Produto")).run();
    getDb()
      .update(sheetCells)
      .set({ type: "d", value: JSON.stringify("2026-01-02") })
      .where(eq(sheetCells.input, "=D1+1"))
      .run();
    expect(tab).toBeTruthy();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await sheetXlsx(bot, sheet.id)).buffer as ArrayBuffer);
    const ws = workbook.getWorksheet("Dados")!;
    expect(ws.getCell("A1").value).toEqual({ error: "#N/A" });
    expect(ws.getCell("H1").value).toEqual({ formula: "D1+1", result: 46024 });
  });

  test("csv shows what the grid shows, quoted and with a BOM", () => {
    const { sheet, tab, empty } = sample();
    const csv = sheetCsv(bot, sheet.id, tab);
    const lines = csv.slice(1).split("\r\n");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe('Produto,"R$\u00a01.234,50","12,5%",20/11/2026,VERDADEIRO,#DIV/0!,2469,46347');
    expect(lines[1]).toBe('"diz ""oi"", tchau","1234567,891",-5,VERDADEIRO,FALSO,,,');
    expect(lines[2]).toBe(",,,,,,,");
    expect(lines[3]).toBe("");
    expect(sheetCsv(bot, sheet.id)).toBe(csv);
    expect(sheetCsv(bot, sheet.id, empty)).toBe("﻿\r\n");
  });

  test("pdf renders a table with alignment and bold", async () => {
    const { sheet, tab, empty } = sample();
    writeCells(bot, sheet.id, tab, { cells: [{ a: "A4", input: "<b>" }] }, "bot");
    const chrome = fakeChrome();
    const job = await createExport(bot, { kind: "sheet", id: sheet.id, format: "pdf", tabId: tab });
    expect(job).toMatchObject({ status: "ready", fileName: "Vendas.pdf" });
    const page = chrome.pages[0];
    expect(page).toContain("<h2>Vendas · Dados</h2>");
    expect(page).toContain("<tr><th></th><th>A</th><th>B</th>");
    expect(page).toContain('<td style="text-align:left">Produto</td>');
    expect(page).toContain('<td style="text-align:right">R$\u00a01.234,50</td>');
    expect(page).toContain('<td style="text-align:center;font-weight:600">-5</td>');
    expect(page).toContain('<td style="text-align:left">&lt;b&gt;</td>');
    expect(page).toContain('<td style="text-align:left"></td>');
    const blank = await createExport(bot, { kind: "sheet", id: sheet.id, format: "pdf", tabId: empty });
    expect(blank.status).toBe("ready");
    expect(chrome.pages[1]).toContain("<table><tr><th></th></tr></table>");
  });

  test("xlsx and csv exports go through the job pipeline", async () => {
    const { sheet, tab } = sample();
    const xlsx = await createExport(bot, { kind: "sheet", id: sheet.id, format: "xlsx" });
    expect(xlsx).toMatchObject({ status: "ready", fileName: "Vendas.xlsx" });
    expect((await exportFile(bot, xlsx.id)).mime).toBe(mimeOf("xlsx"));
    const csv = await createExport(bot, { kind: "sheet", id: sheet.id, format: "csv", tabId: tab });
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode((await exportBytes(bot, csv.id)).data)).toBe(
      sheetCsv(bot, sheet.id, tab),
    );
    const missingTab = await createExport(bot, { kind: "sheet", id: sheet.id, format: "csv", tabId: "tab_nope" });
    expect(missingTab).toMatchObject({ status: "failed", error: "Aba não encontrada." });
  });
});

describe("export jobs", () => {
  test("validates kind, format and source", async () => {
    const { note } = createNote(bot, { title: "N" }, "bot");
    expect((await errorOf(() => createExport(bot, { kind: "video", id: note.id }))).message).toBe("kind precisa ser note ou sheet.");
    expect((await errorOf(() => createExport(bot, { kind: "note", id: note.id, format: "xlsx" }))).message).toBe(
      "Formato inválido para nota: use docx, pdf, md.",
    );
    expect((await errorOf(() => createExport(bot, { kind: "sheet", id: "x" }))).message).toBe(
      "Formato inválido para planilha: use xlsx, csv, pdf.",
    );
    expect((await errorOf(() => createExport(bot, { kind: "note", format: "md" }))).status).toBe(404);
    expect((await errorOf(() => createExport(bot, { kind: "sheet", id: "nope", format: "csv" }))).status).toBe(404);
    expect(getDb().select().from(exports).all()).toEqual([]);
  });

  test("reads jobs per bot and reports a missing file", async () => {
    const { note } = createNote(bot, { title: "N", content: "x" }, "bot");
    const job = await createExport(bot, { kind: "note", id: note.id, format: "md" });
    expect(readExport(bot, job.id)).toEqual(job);
    expect((await errorOf(async () => readExport("other", job.id))).status).toBe(404);
    expect((await errorOf(() => exportFile("other", job.id))).status).toBe(404);
    const row = getDb().select().from(exports).where(eq(exports.id, job.id)).get()!;
    await getBlobStore().delete(row.blobKey!);
    const gone = await errorOf(() => exportFile(bot, job.id));
    expect(gone).toMatchObject({ status: 404, message: "Arquivo da exportação não encontrado." });
    getDb().update(exports).set({ fileName: null, size: null }).where(eq(exports.id, job.id)).run();
    expect(readExport(bot, job.id)).toMatchObject({ fileName: "", size: null });
  });

  test("mime types", () => {
    expect(mimeOf("pdf")).toBe("application/pdf");
    expect(mimeOf("csv")).toBe("text/csv; charset=utf-8");
    expect(mimeOf("zip")).toBe("application/octet-stream");
  });
});
