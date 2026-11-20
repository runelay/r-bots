import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CellFormat, ExportFormat, ExportJob, SheetCell } from "@runelay-bots/protocol";
import { exportFormatsFor } from "@runelay-bots/protocol";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  TextRun,
} from "docx";
import { and, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { type Lexer, Marked, marked, type Token, type Tokens } from "marked";
import { env } from "../../../config/env";
import { getDb } from "../../../db";
import { exports } from "../../../db/tables";
import { BlockError, newId, nowIso } from "../../blocks/services/blocks.shared";
import { defineJob, jobsActive, runJob } from "../../jobs/services/jobs.service";
import { requireNote } from "../../notes/services/notes.service";
import { address, colLetters, excelSerial, toEngineFormula } from "../../sheets/services/formula";
import { bookFor, cellOf } from "../../sheets/services/sheets.service";
import { getBlobStore, putBlob, safeName } from "../../storage/services/storage.service";

const chromeBinary = env.DESKTOP_CHROME ?? "/opt/runelay-chrome/chrome";

const mimes: Record<ExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

type ExportRow = typeof exports.$inferSelect;

export function mimeOf(format: string) {
  return mimes[format as ExportFormat] ?? "application/octet-stream";
}

function jobOf(botId: string, row: ExportRow): ExportJob {
  return {
    id: row.id,
    kind: row.sourceType as "note" | "sheet",
    sourceId: row.sourceId,
    format: row.format as ExportFormat,
    status: row.status as ExportJob["status"],
    fileName: row.fileName ?? "",
    size: row.size ?? null,
    url: row.status === "ready" ? `/bots/${encodeURIComponent(botId)}/exports/${row.id}/file` : null,
    error: row.error ?? null,
    createdAt: row.createdAt,
  };
}

function inlineRuns(
  tokens: Token[] | undefined,
  style: { bold?: boolean; italics?: boolean; strike?: boolean } = {},
): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  for (const token of tokens ?? []) {
    if (token.type === "strong") runs.push(...inlineRuns((token as Tokens.Strong).tokens, { ...style, bold: true }));
    else if (token.type === "em") runs.push(...inlineRuns((token as Tokens.Em).tokens, { ...style, italics: true }));
    else if (token.type === "del") runs.push(...inlineRuns((token as Tokens.Del).tokens, { ...style, strike: true }));
    else if (token.type === "codespan")
      runs.push(new TextRun({ text: (token as Tokens.Codespan).text, font: "Menlo", ...style }));
    else if (token.type === "link") runs.push(...inlineRuns((token as Tokens.Link).tokens, { ...style }));
    else if (token.type === "br") runs.push(new TextRun({ text: "", break: 1 }));
    else if ("tokens" in token && Array.isArray(token.tokens)) runs.push(...inlineRuns(token.tokens as Token[], style));
    else
      runs.push(
        new TextRun({ text: wikiText(decodeEntities((token as { text?: string }).text ?? token.raw)), ...style }),
      );
  }
  return runs;
}

function decodeEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function wikiText(text: string) {
  return text.replace(
    /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
    (_m, target: string, alias?: string) => alias ?? target,
  );
}

const headingLevels = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function blockParagraphs(tokens: Token[], depth = 0): Paragraph[] {
  const out: Paragraph[] = [];
  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      out.push(new Paragraph({ heading: headingLevels[heading.depth - 1], children: inlineRuns(heading.tokens) }));
    } else if (token.type === "paragraph")
      out.push(new Paragraph({ children: inlineRuns((token as Tokens.Paragraph).tokens) }));
    else if (token.type === "list") {
      const list = token as Tokens.List;
      list.items.forEach((item, index) => {
        const inline = item.tokens.filter((child) => child.type === "text" || child.type === "paragraph");
        const nested = item.tokens.filter((child) => child.type === "list");
        const marker = item.task
          ? item.checked
            ? "☑ "
            : "☐ "
          : list.ordered
            ? `${Number(list.start ?? 1) + index}. `
            : "";
        out.push(
          new Paragraph({
            ...(list.ordered || item.task ? { indent: { left: 360 * (depth + 1) } } : { bullet: { level: depth } }),
            children: [
              new TextRun(marker),
              ...inline.flatMap((child) => inlineRuns((child as Tokens.Text).tokens ?? [child])),
            ],
          }),
        );
        out.push(...blockParagraphs(nested, depth + 1));
      });
    } else if (token.type === "code") {
      for (const line of (token as Tokens.Code).text.split("\n"))
        out.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" },
            children: [new TextRun({ text: line || " ", font: "Menlo", size: 18 })],
          }),
        );
    } else if (token.type === "blockquote") {
      for (const paragraph of blockParagraphs((token as Tokens.Blockquote).tokens, depth)) out.push(paragraph);
    } else if (token.type === "hr") out.push(new Paragraph({ thematicBreak: true }));
    else if (token.type === "table") {
      const table = token as Tokens.Table;
      out.push(
        new Paragraph({
          children: [new TextRun({ text: table.header.map((cell) => cell.text).join(" | "), bold: true })],
        }),
      );
      for (const row of table.rows)
        out.push(new Paragraph({ children: [new TextRun(row.map((cell) => cell.text).join(" | "))] }));
    } else if (token.type === "space") continue;
    else if ("text" in token) out.push(new Paragraph({ children: [new TextRun(wikiText(String(token.text)))] }));
  }
  return out;
}

export async function noteDocx(title: string, markdown: string) {
  const tokens = (marked.lexer as typeof Lexer.lex)(markdown);
  const startsWithTitle = tokens[0]?.type === "heading";
  const document = new Document({
    title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [
      {
        children: [
          ...(startsWithTitle
            ? []
            : [
                new Paragraph({
                  heading: HeadingLevel.TITLE,
                  alignment: AlignmentType.LEFT,
                  children: [new TextRun(title)],
                }),
              ]),
          ...blockParagraphs(tokens),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const safeImageData = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export function safeUrl(raw: string, image: boolean) {
  const href = raw.trim();
  if (image) return safeImageData.test(href) ? href : null;
  if (href.startsWith("#")) return href;
  try {
    const protocol = new URL(href).protocol;
    return ["http:", "https:", "mailto:"].includes(protocol) ? href : null;
  } catch {
    return null;
  }
}

const printMarked = new Marked({
  gfm: true,
  renderer: {
    html(token) {
      return escapeHtml(token.text);
    },
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      const href = safeUrl(token.href, false);
      if (!href) return label;
      return `<a href="${escapeHtml(href)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ""}>${label}</a>`;
    },
    image(token) {
      const src = safeUrl(token.href, true);
      if (!src) return escapeHtml(token.text);
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}">`;
    },
  },
});

export const printCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

function printPage(title: string, css: string, body: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta http-equiv="Content-Security-Policy" content="${printCsp}"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}

const printCss =
  "body{font:14px/1.55 -apple-system,'Inter','Helvetica Neue',Arial,sans-serif;color:#1d1d1f;margin:0;padding:0}h1,h2,h3{line-height:1.25}code,pre{font-family:Menlo,monospace;font-size:12px}pre{background:#f4f4f5;padding:10px;border-radius:6px;white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #d4d4d8;padding:4px 8px;font-size:12px}th{background:#f4f4f5}blockquote{color:#52525b;border-left:3px solid #d4d4d8;margin:0;padding-left:12px}@page{margin:18mm}";

export const pdfChromeFlags = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-pdf-header-footer",
  "--blink-settings=scriptEnabled=false",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--proxy-server=127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--no-first-run",
  "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
];

export async function htmlToPdf(html: string) {
  const dir = await mkdtemp(join(tmpdir(), "runelay-export-"));
  try {
    await chmod(dir, 0o700);
    const input = join(dir, "page.html");
    const output = join(dir, "page.pdf");
    await writeFile(input, html, { mode: 0o600 });
    const proc = Bun.spawn(
      [
        chromeBinary,
        ...pdfChromeFlags,
        `--user-data-dir=${join(dir, "profile")}`,
        `--print-to-pdf=${output}`,
        `file://${input}`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), 60_000);
    const code = await proc.exited;
    clearTimeout(timer);
    const pdf = await readFile(output).catch(() => null);
    if (!pdf?.length) throw new Error(`Chromium não gerou o PDF (código ${code}).`);
    return new Uint8Array(pdf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function noteHtml(title: string, markdown: string) {
  const body = printMarked.parse(wikiText(markdown), { async: false });
  const heading = /^\s*#\s/.test(markdown) ? "" : `<h1>${escapeHtml(title)}</h1>`;
  return printPage(title, printCss, `${heading}${body}`);
}

export async function notePdf(title: string, markdown: string) {
  return htmlToPdf(noteHtml(title, markdown));
}

function numFmt(format: CellFormat | undefined) {
  if (!format) return undefined;
  const decimals = format.decimals ?? (format.type === "brl" ? 2 : format.type === "percent" ? 0 : undefined);
  const zeros = decimals ? `.${"0".repeat(decimals)}` : "";
  if (format.type === "brl") return `"R$" #,##0${zeros}`;
  if (format.type === "percent") return `0${zeros}%`;
  if (format.type === "number") return `#,##0${zeros}`;
  if (format.type === "date") return "dd/mm/yyyy";
  if (format.type === "datetime") return "dd/mm/yyyy hh:mm";
  if (format.type === "text") return "@";
  return undefined;
}

function plainValue(cell: SheetCell) {
  if (cell.t === "d" && typeof cell.v === "string") return new Date(`${cell.v.slice(0, 10)}T00:00:00Z`);
  if (cell.t === "e") return { error: String(cell.v) } as ExcelJS.CellErrorValue;
  return cell.v;
}

const networkFunctions =
  /\b(WEBSERVICE|HYPERLINK|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTFEED|IMPORTRANGE|IMAGE|FILTERXML|RTD|DDE|DDEAUTO|CALL|REGISTER(?:\.ID)?|EXEC)\s*\(/i;

export function reachesNetwork(formula: string) {
  return networkFunctions.test(formula) || formula.includes("|");
}

export async function sheetXlsx(botId: string, sheetId: string) {
  const { sheet, tabs, rows } = await bookFor(botId, sheetId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "runelay bots";
  workbook.title = sheet.title;
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const tab of tabs) {
    const worksheet = workbook.addWorksheet(tab.name, {
      views:
        tab.frozenRows || tab.frozenCols ? [{ state: "frozen", xSplit: tab.frozenCols, ySplit: tab.frozenRows }] : [],
    });
    for (const [letters, width] of Object.entries(tab.colWidths ?? {}))
      worksheet.getColumn(letters).width = Math.max(4, Math.round(width / 7));
    for (const row of rows.filter((item) => item.tabId === tab.id)) {
      const cell = cellOf(row);
      const target = worksheet.getCell(row.row + 1, row.col + 1);
      if (cell.input.trim().startsWith("=") && reachesNetwork(cell.input)) {
        target.value = cell.input.trim();
        target.numFmt = "@";
        continue;
      }
      if (cell.input.trim().startsWith("=")) {
        const result =
          cell.t === "d" && typeof cell.v === "string"
            ? excelSerial(cell.v)
            : cell.t === "e"
              ? { error: cell.v }
              : cell.v;
        target.value = { formula: toEngineFormula(cell.input.trim()), result } as ExcelJS.CellFormulaValue;
      } else if (cell.input) target.value = plainValue(cell) as ExcelJS.CellValue;
      const format = cell.format;
      const pattern = numFmt(format);
      if (pattern) target.numFmt = pattern;
      if (format?.bold) target.font = { bold: true };
      if (format?.align) target.alignment = { horizontal: format.align };
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function displayValue(cell: SheetCell) {
  if (cell.v === null) return "";
  if (cell.t === "b") return cell.v ? "VERDADEIRO" : "FALSO";
  if (cell.t === "n" && typeof cell.v === "number") {
    const format = cell.format;
    const fixed =
      format?.decimals === undefined
        ? null
        : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals };
    if (format?.type === "percent")
      return `${(cell.v * 100).toLocaleString("pt-BR", fixed ?? { maximumFractionDigits: 2 })}%`;
    if (format?.type === "brl")
      return cell.v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", ...(fixed ?? {}) });
    return cell.v.toLocaleString("pt-BR", {
      ...(fixed ?? { maximumFractionDigits: 10 }),
      useGrouping: format?.type === "number",
    });
  }
  if (cell.t === "d" && typeof cell.v === "string") {
    const [y, m, d] = cell.v.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }
  return String(cell.v);
}

export const maxExportCells = 200_000;

async function tabGrid(botId: string, sheetId: string, tabId?: string | null) {
  const { sheet, tabs, rows } = await bookFor(botId, sheetId);
  const tab = tabs.find((item) => item.id === tabId) ?? tabs[0];
  if (tabId && tab.id !== tabId) throw new BlockError("Aba não encontrada.", 404);
  if (tab.rowCount * tab.colCount > maxExportCells)
    throw new BlockError(
      `A aba tem ${tab.rowCount} linhas por ${tab.colCount} colunas em uso; o limite para exportar é de ${maxExportCells.toLocaleString("pt-BR")} células. Divida a aba ou exporte em xlsx.`,
      413,
    );
  const cells = rows.filter((item) => item.tabId === tab.id).map(cellOf);
  const grid: string[][] = Array.from({ length: tab.rowCount }, () => Array.from({ length: tab.colCount }, () => ""));
  const styles = new Map<string, CellFormat>();
  for (const cell of cells) {
    grid[cell.r][cell.c] = displayValue(cell);
    if (cell.format) styles.set(address(cell.r, cell.c), cell.format);
  }
  return { sheet, tab, grid, styles };
}

const numberLike = /^-[\d.,\s\u00a0]+%?$/;

export function csvSafe(value: string) {
  if (!/^[=+\-@\t\r]/.test(value) || numberLike.test(value)) return value;
  return `'${value}`;
}

export async function sheetCsv(botId: string, sheetId: string, tabId?: string | null) {
  const { grid } = await tabGrid(botId, sheetId, tabId);
  const quote = (raw: string) => {
    const value = csvSafe(raw);
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  return `﻿${grid.map((row) => row.map(quote).join(",")).join("\r\n")}\r\n`;
}

export async function sheetPdf(botId: string, sheetId: string, tabId?: string | null) {
  const { sheet, tab, grid, styles } = await tabGrid(botId, sheetId, tabId);
  const head = `<tr><th></th>${grid[0]?.map((_, c) => `<th>${colLetters(c)}</th>`).join("") ?? ""}</tr>`;
  const body = grid
    .map(
      (row, r) =>
        `<tr><th>${r + 1}</th>${row
          .map((value, c) => {
            const format = styles.get(address(r, c));
            const align = format?.align ?? (/^[-R$\d.,%\s]+$/.test(value) && value ? "right" : "left");
            return `<td style="text-align:${align}${format?.bold ? ";font-weight:600" : ""}">${escapeHtml(value)}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return htmlToPdf(
    printPage(
      sheet.title,
      `${printCss}@page{size:A4 landscape}`,
      `<h2>${escapeHtml(sheet.title)} · ${escapeHtml(tab.name)}</h2><table>${head}${body}</table>`,
    ),
  );
}

async function render(
  botId: string,
  kind: "note" | "sheet",
  sourceId: string,
  format: ExportFormat,
  tabId?: string | null,
) {
  if (kind === "note") {
    const note = await requireNote(botId, sourceId);
    const base = note.title;
    if (format === "md") return { name: `${base}.md`, data: new TextEncoder().encode(note.markdown) };
    if (format === "docx") return { name: `${base}.docx`, data: await noteDocx(note.title, note.markdown) };
    return { name: `${base}.pdf`, data: await notePdf(note.title, note.markdown) };
  }
  const { sheet } = await bookFor(botId, sourceId);
  if (format === "xlsx") return { name: `${sheet.title}.xlsx`, data: await sheetXlsx(botId, sourceId) };
  if (format === "csv")
    return { name: `${sheet.title}.csv`, data: new TextEncoder().encode(await sheetCsv(botId, sourceId, tabId)) };
  return { name: `${sheet.title}.pdf`, data: await sheetPdf(botId, sourceId, tabId) };
}

export async function renderExport(botId: string, exportId: string, final = true) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(exports)
    .where(and(eq(exports.id, exportId), eq(exports.botId, botId)))
    .limit(1);
  if (!row || row.status === "ready") return;
  const kind = row.sourceType === "sheet" ? "sheet" : "note";
  try {
    const file = await render(botId, kind, row.sourceId, row.format as ExportFormat, row.tabId);
    const fileName = safeName(file.name);
    const key = `bots/${botId}/exports/${exportId}/${fileName}`;
    const stored = await putBlob(key, file.data, { mime: mimeOf(row.format), botId });
    await db
      .update(exports)
      .set({ status: "ready", blobKey: key, fileName, size: stored.size, error: null, finishedAt: nowIso() })
      .where(eq(exports.id, exportId));
  } catch (error) {
    if (!final) throw error;
    await db
      .update(exports)
      .set({
        status: "failed",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        finishedAt: nowIso(),
      })
      .where(eq(exports.id, exportId));
    throw error;
  }
}

export const exportJobType = "export.render";
export const exportAttempts = 3;
export const exportWaitMs = 90_000;

export interface ExportPayload {
  botId: string;
  exportId: string;
}

defineJob<ExportPayload>(exportJobType, {
  attempts: exportAttempts,
  backoffMs: 1000,
  handler: (payload, context) => renderExport(payload.botId, payload.exportId, context.attempt >= exportAttempts),
});

export async function createExport(botId: string, body: Record<string, unknown>) {
  const kind = body.kind === "sheet" ? "sheet" : body.kind === "note" ? "note" : null;
  if (!kind) throw new BlockError("kind precisa ser note ou sheet.");
  const format = String(body.format ?? "") as ExportFormat;
  if (!exportFormatsFor(kind).includes(format))
    throw new BlockError(
      `Formato inválido para ${kind === "note" ? "nota" : "planilha"}: use ${exportFormatsFor(kind).join(", ")}.`,
    );
  const sourceId = String(body.id ?? "");
  const tabId = typeof body.tabId === "string" && body.tabId ? body.tabId : null;
  if (kind === "note") await requireNote(botId, sourceId);
  else await bookFor(botId, sourceId);
  const id = newId("exp");
  const createdAt = nowIso();
  await getDb()
    .insert(exports)
    .values({ id, botId, sourceType: kind, sourceId, format, status: "pending", tabId, createdAt });
  try {
    if (!jobsActive()) await renderExport(botId, id);
    else
      await runJob<ExportPayload>(exportJobType, { botId, exportId: id }, { id: `export-${id}`, waitMs: exportWaitMs });
  } catch (error) {
    console.warn(`export ${id} falhou: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readExport(botId, id);
}

export async function readExport(botId: string, exportId: string) {
  const [row] = await getDb()
    .select()
    .from(exports)
    .where(and(eq(exports.id, exportId), eq(exports.botId, botId)))
    .limit(1);
  if (!row) throw new BlockError("Exportação não encontrada.", 404);
  return jobOf(botId, row);
}

export async function exportFile(botId: string, exportId: string) {
  const [row] = await getDb()
    .select()
    .from(exports)
    .where(and(eq(exports.id, exportId), eq(exports.botId, botId)))
    .limit(1);
  if (row?.status !== "ready" || !row.blobKey) throw new BlockError("Exportação não encontrada.", 404);
  const stream = await getBlobStore().get(row.blobKey);
  if (!stream) throw new BlockError("Arquivo da exportação não encontrado.", 404);
  return { stream, fileName: row.fileName ?? "arquivo", mime: mimeOf(row.format), size: row.size };
}

export async function exportBytes(botId: string, exportId: string) {
  const file = await exportFile(botId, exportId);
  return { ...file, data: new Uint8Array(await new Response(file.stream).arrayBuffer()) };
}
