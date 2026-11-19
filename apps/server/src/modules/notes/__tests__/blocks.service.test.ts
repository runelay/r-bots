import { beforeEach, describe, expect, test } from "bun:test";
import { resetData } from "../../../../test/helpers";
import { getDb } from "../../../db";
import { notes, sheets } from "../../../db/tables";
import { blocksEditNote } from "../../blocks/services/block-tools.service";
import { createExport, exportBytes } from "../../exports/services/exports.service";
import { readRange, createSheet, structure, writeCells, addTab } from "../../sheets/services/sheets.service";
import {
  createNote,
  deleteNote,
  listNotes,
  moveNote,
  noteBacklinks,
  noteOf,
  noteTree,
  patchNote,
  requireNote,
  searchNotes,
  writeNote,
} from "../services/notes.service";

const bot = "bot-blocks";

beforeEach(async () => {
  await resetData();
  getDb().delete(notes).run();
  getDb().delete(sheets).run();
});

describe("notes", () => {
  test("links, backlinks, rename relink, search without accents and trash", () => {
    const plano = createNote(bot, { title: "Plano Q1", folder: "Projetos", content: "# Plano\n\n- [ ] Fechar metas #meta" }, "bot").note;
    const diario = createNote(bot, { title: "Diário", content: "Hoje revisei o [[Plano Q1|plano]] e [[Ideias]]." }, "bot").note;
    expect(noteOf(bot, requireNote(bot, diario.id)).links).toEqual([
      { target: "Plano Q1", id: plano.id, title: "Plano Q1" },
      { target: "Ideias", id: null, title: "Ideias" },
    ]);
    expect(noteBacklinks(bot, plano.id, {}).items.map((item) => item.id)).toEqual([diario.id]);
    const moved = moveNote(bot, plano.id, { title: "Plano 2027" }, "bot");
    expect(moved.relinked).toBe(1);
    expect(requireNote(bot, diario.id).markdown).toContain("[[Plano 2027|plano]]");
    expect(searchNotes(bot, { q: "diario" }).items[0]?.id).toBe(diario.id);
    expect(searchNotes(bot, { q: "revis" }).items[0]?.snippet).toContain("revisei");
    expect(searchNotes(bot, { q: "plan", mode: "title" }).items[0]?.id).toBe(plano.id);
    expect(listNotes(bot, { tag: "meta" }).total).toBe(1);
    expect(noteTree(bot, {}).folders).toEqual([{ name: "Projetos", path: "Projetos", notes: 1, folders: 0 }]);
    expect(() => createNote(bot, { title: "plano 2027", folder: "Projetos" }, "user")).toThrow();
    deleteNote(bot, diario.id, "bot");
    expect(listNotes(bot, {}).total).toBe(1);
    expect(getDb().select().from(notes).all()).toHaveLength(2);
  });

  test("patch ops, stale writes and person edit notice", () => {
    const { note } = createNote(bot, { title: "Lista", content: "# Tarefas\n- [ ] a\n\n# Fim" }, "bot");
    const patched = patchNote(
      bot,
      note.id,
      { ops: [{ op: "toggle_task", line: 1, done: true }, { op: "insert_after_heading", heading: "Tarefas", text: "- [ ] b" }] },
      "bot",
    );
    expect(patched.note.content).toBe("# Tarefas\n- [x] a\n- [ ] b\n\n# Fim");
    expect(patched.event.data.changed).toEqual({ lines: [[1, 2]] });
    writeNote(bot, note.id, { content: "# Tarefas\n- [x] a\n- [x] b\n\n# Fim" }, "user");
    expect(() => writeNote(bot, note.id, { content: "x", baseVersion: 1 }, "bot")).toThrow("Mudou");
    expect(blocksEditNote(bot)).toContain("linhas 3 mudaram");
    expect(blocksEditNote(bot)).toBe("");
  });
});

describe("sheets", () => {
  test("cross-tab formulas recalc dependents, structure and xlsx export keeps formulas", async () => {
    const { sheet } = createSheet(
      bot,
      { title: "Orçamento", tabs: ["Dados", "Resumo"], cells: [{ a: "A1", input: "10" }, { a: "A2", input: "20" }] },
      "bot",
    );
    const [dados, resumo] = sheet.tabs;
    writeCells(bot, sheet.id, resumo.id, { cells: [{ a: "B2", input: "=SOMA(Dados!A1:A2)" }] }, "bot");
    const result = writeCells(bot, sheet.id, dados.id, { cells: [{ a: "A1", input: "15" }] }, "user").result;
    expect(result.cells.map((cell) => cell.a)).toEqual(["A1"]);
    expect(readRange(bot, sheet.id, resumo.id, "B2").cells[0]).toMatchObject({ v: 35, t: "n", input: "=SOMA(Dados!A1:A2)" });
    structure(bot, sheet.id, dados.id, { op: "insert_rows", at: 0, count: 1 }, "bot");
    expect(readRange(bot, sheet.id, resumo.id, "B2").cells[0]).toMatchObject({ v: 35, input: "=SOMA(Dados!A2:A3)" });
    expect(addTab(bot, sheet.id, { name: "Extra" }, "bot").sheet.tabs).toHaveLength(3);
    const job = await createExport(bot, { kind: "sheet", id: sheet.id, format: "xlsx" });
    expect(job.status).toBe("ready");
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await exportBytes(bot, job.id)).data.buffer as ArrayBuffer);
    const cell = workbook.getWorksheet("Resumo")!.getCell("B2").value as { formula: string; result: number };
    expect(cell).toMatchObject({ formula: "SUM(Dados!A2:A3)", result: 35 });
    const csv = await createExport(bot, { kind: "sheet", id: sheet.id, format: "csv", tabId: resumo.id });
    expect(new TextDecoder().decode((await exportBytes(bot, csv.id)).data)).toContain("35");
  });
});
