import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeAgenda, toolCallsOf } from "../../../../test/agenda-helpers";
import { makeBot } from "../../../../test/engine-helpers";
import { encodeEventId } from "../../agenda/services/agenda.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import type { BotTool } from "../../engine/services/bot-tools.service";
import * as exportsService from "../../exports/services/exports.service";
import { createNote, requireNote, writeNote } from "../../notes/services/notes.service";
import { requireSheet } from "../../sheets/services/sheets.service";
import { blocksEditNote, blocksGuide, blockTools } from "../services/block-tools.service";
import type { BlockEvent } from "../services/blocks.shared";

const spies: Array<{ mockRestore(): void }> = [];
const signal = new AbortController().signal;
let bot: BotDefinition;

beforeAll(async () => {
  bot = await makeBot();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function toolOf(name: string): BotTool {
  const found = blockTools(bot.id).find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function run<T = Record<string, unknown>>(name: string, input: Record<string, unknown>) {
  return (await toolOf(name).run(input, signal)) as T & { blockEvent?: BlockEvent };
}

function label(name: string, input: Record<string, unknown>) {
  return toolOf(name).label(input);
}

describe("tool list", () => {
  test("exposes every block tool without approval except agenda_create", () => {
    const tools = blockTools(bot.id);
    expect(tools.map((item) => item.name)).toEqual([
      "note_list",
      "note_tree",
      "note_read",
      "note_search",
      "note_write",
      "note_patch",
      "note_move",
      "note_delete",
      "sheet_list",
      "sheet_create",
      "sheet_read",
      "sheet_write",
      "sheet_format",
      "sheet_tab",
      "agenda_accounts",
      "agenda_list",
      "agenda_create",
      "agenda_update",
      "agenda_delete",
      "export_create",
    ]);
    expect(tools.filter((item) => item.approval).map((item) => item.name)).toEqual(["agenda_create"]);
    expect(blocksGuide).toContain("## Notas, planilhas e agenda");
    expect(blocksGuide).toContain("`export_create`");
  });
});

describe("notes", () => {
  test("write, read, patch, move, list, search and delete", async () => {
    const folder = `Pasta ${Math.random().toString(36).slice(2, 7)}`;
    expect(label("note_write", { title: "Plano" })).toBe("Criou a nota “Plano”");
    const created = await run<{ id: string; title: string; version: number }>("note_write", {
      title: "Plano",
      folder,
      content: "# Metas\n- [ ] vender",
    });
    expect(created.blockEvent?.type).toBe("block.created");
    expect(created.title).toBe("Plano");
    expect(label("note_write", { id: created.id, title: "Plano" })).toBe("Editou a nota “Plano”");

    const same = await run<{ content: string }>("note_write", { id: created.id, title: "Plano", folder, content: "# Metas\n- [ ] vender mais" });
    expect(same.content).toBe("# Metas\n- [ ] vender mais");
    const moved = await run<{ folder: string }>("note_write", {
      id: created.id,
      title: "Plano",
      folder: `${folder}/Sub`,
      content: "# Metas\n- [ ] vender mais",
    });
    expect(moved.folder).toBe(`${folder}/Sub`);
    expect(requireNote(bot.id, created.id).folder).toBe(`${folder}/Sub`);

    expect(label("note_read", { id: created.id })).toBe("Leu a nota “Plano”");
    expect(label("note_read", { title: "Outra" })).toBe("Leu a nota “Outra”");
    expect(label("note_read", { id: "missing" })).toBe("Leu a nota “sem título”");
    expect(((await run("note_read", { id: created.id })) as { id: string }).id).toBe(created.id);
    expect(((await run("note_read", { title: "Plano" })) as { id: string }).id).toBe(created.id);
    await expect(run("note_read", {})).rejects.toThrow("Passe id ou title.");

    expect(label("note_patch", { id: created.id })).toBe("Editou a nota “Plano”");
    const patched = await run<{ content: string }>("note_patch", { id: created.id, ops: [{ op: "toggle_task", line: 1, done: true }] });
    expect(patched.content).toBe("# Metas\n- [x] vender mais");
    expect(patched.blockEvent?.data.changed).toEqual({ lines: [[1, 1]] });

    expect(label("note_list", {})).toBe("Listou as notas");
    expect(((await run("note_list", { folder: `${folder}/Sub` })) as { total: number }).total).toBe(1);
    expect(label("note_tree", {})).toBe("Abriu as pastas das notas");
    expect(label("note_tree", { folder })).toBe(`Abriu a pasta “${folder}”`);
    expect(((await run("note_tree", { folder })) as { folders: Array<{ name: string }> }).folders.map((item) => item.name)).toEqual(["Sub"]);
    expect(label("note_search", { q: "vender" })).toBe("Buscou “vender” nas notas");
    const hits = (await run("note_search", { q: "vender" })) as { items: Array<{ id: string }> };
    expect(hits.items.map((item) => item.id)).toContain(created.id);

    expect(label("note_move", { id: created.id, title: "Plano 2027" })).toBe("Renomeou a nota para “Plano 2027”");
    expect(label("note_move", { id: created.id })).toBe("Moveu a nota “Plano”");
    const renamed = (await run("note_move", { id: created.id, title: "Plano 2027" })) as {
      note: { title: string };
      relinked: number;
    };
    expect(renamed.note.title).toBe("Plano 2027");
    expect(renamed.relinked).toBe(0);
    expect(renamed.blockEvent?.type).toBe("block.updated");

    expect(label("note_delete", { id: created.id })).toBe("Apagou a nota “Plano 2027”");
    const deleted = await run("note_delete", { id: created.id });
    expect(deleted.ok).toBe(true);
    expect(deleted.blockEvent?.type).toBe("block.deleted");
  });

  test("blocksEditNote reports the person's edits once", () => {
    const other = `edits-${Math.random().toString(36).slice(2, 8)}`;
    expect(blocksEditNote(other)).toBe("");
    const { note } = createNote(other, { title: "Compras", content: "leite" }, "bot");
    writeNote(other, note.id, { content: "leite\npão" }, "user");
    const text = blocksEditNote(other);
    expect(text.startsWith("## Notas e planilhas editadas pela pessoa")).toBe(true);
    expect(text).toContain("Compras");
    expect(text.endsWith("Respeite essas edições e não desfaça o que a pessoa mudou.")).toBe(true);
    expect(blocksEditNote(other)).toBe("");
  });
});

describe("sheets", () => {
  test("create, read, write, format and tab ops", async () => {
    expect(label("sheet_create", { title: "Caixa" })).toBe("Criou a planilha “Caixa”");
    const sheet = await run<{ id: string; tabs: Array<{ id: string; name: string }> }>("sheet_create", {
      title: "Caixa",
      tabs: ["Dados"],
      cells: [
        { a: "A1", input: "10" },
        { a: "A2", input: "=A1*2" },
      ],
    });
    expect(sheet.blockEvent?.type).toBe("block.created");
    expect(label("sheet_read", { id: sheet.id })).toBe("Leu a planilha “Caixa”");
    expect(label("sheet_read", { id: "missing" })).toBe("Leu a planilha “sem título”");
    const read = await run<{ sheet: { id: string }; cells: Array<{ a: string; v: unknown }> }>("sheet_read", {
      id: sheet.id,
      range: "A1:A2",
    });
    expect(read.sheet.id).toBe(sheet.id);
    expect(read.cells.map((cell) => [cell.a, cell.v])).toEqual([
      ["A1", 10],
      ["A2", 20],
    ]);

    expect(label("sheet_write", { id: sheet.id })).toBe("Editou a planilha “Caixa”");
    const written = await run<{ cells: Array<{ a: string; v: unknown }> }>("sheet_write", {
      id: sheet.id,
      cells: [{ a: "A1", input: "15" }],
    });
    expect(written.cells.find((cell) => cell.a === "A2")?.v).toBe(30);
    expect(written.blockEvent?.type).toBe("block.updated");

    expect(label("sheet_format", { id: sheet.id })).toBe("Formatou a planilha “Caixa”");
    const formatted = await run("sheet_format", { id: sheet.id, ranges: ["A1:A2"], format: { type: "brl", bold: true } });
    expect(formatted.blockEvent?.type).toBe("block.updated");

    expect(label("sheet_tab", { id: sheet.id })).toBe("Editou a planilha “Caixa”");
    const added = await run<{ tabs: Array<{ name: string }> }>("sheet_tab", { id: sheet.id, op: "add", name: "Resumo" });
    expect(added.tabs.map((tab) => tab.name)).toEqual(["Dados", "Resumo"]);
    expect(added.blockEvent?.type).toBe("block.updated");

    expect(label("sheet_list", {})).toBe("Listou as planilhas");
    const list = (await run("sheet_list", { q: "Caixa" })) as { items: Array<{ id: string }> };
    expect(list.items.map((item) => item.id)).toContain(sheet.id);
    expect(requireSheet(bot.id, sheet.id).title).toBe("Caixa");
  });
});

describe("agenda", () => {
  test("accounts, list, create with approval, update and delete", async () => {
    const [account] = await fakeAgenda([
      {
        email: "dona@casa.com",
        events: {
          primary: [
            {
              id: "solo",
              summary: "Foco",
              start: { dateTime: "2026-11-20T09:00:00-03:00" },
              end: { dateTime: "2026-11-20T10:00:00-03:00" },
            },
          ],
        },
      },
    ]);
    expect(label("agenda_accounts", {})).toBe("Viu as contas da agenda");
    const accounts = (await toolOf("agenda_accounts").run({}, signal)) as Array<{ id: string; email: string }>;
    expect(accounts.map((item) => item.email)).toEqual(["dona@casa.com"]);

    expect(label("agenda_list", {})).toBe("Viu a agenda");
    const list = (await run("agenda_list", { start: "2026-11-20", end: "2026-11-21" })) as { items: Array<{ title: string }> };
    expect(list.items.map((item) => item.title)).toEqual(["Foco"]);

    const create = toolOf("agenda_create");
    const input = {
      accountId: account.name,
      title: "Almoço",
      start: "2026-11-20T12:00:00-03:00",
      end: "2026-11-20T13:00:00-03:00",
    };
    expect(create.approval?.(input)).toBeNull();
    expect(create.approval?.({ ...input, attendees: ["dona@casa.com", "amigo@fora.com"] })).toBe(
      "Posso marcar “Almoço” e mandar convite por e-mail para amigo@fora.com?",
    );
    expect(await create.details?.({ ...input, attendees: ["amigo@fora.com"] })).toEqual({
      target: { label: "Almoço", role: "agenda" },
      reason: "Convite por e-mail para amigo@fora.com",
    });
    expect(await create.details?.({ attendees: [] })).toEqual({
      target: { label: "evento", role: "agenda" },
      reason: "Convite por e-mail para ",
    });
    expect(create.label(input)).toBe("Marcou “Almoço” na agenda");
    const created = (await create.run(input, signal)) as { id: string; title: string; blockEvent: BlockEvent };
    expect(created.title).toBe("Almoço");
    expect(created.blockEvent.data).toMatchObject({ kind: "agenda", author: "bot", changed: { eventIds: [created.id] } });

    expect(label("agenda_update", { title: "Foco total" })).toBe("Mudou “Foco total” na agenda");
    expect(label("agenda_update", {})).toBe("Mudou um evento da agenda");
    const soloId = encodeEventId(account.name, "primary", "solo");
    const updated = (await run("agenda_update", { eventId: soloId, title: "Foco total" })) as { title: string };
    expect(updated.title).toBe("Foco total");
    expect(updated.blockEvent?.data.author).toBe("bot");
    expect(account.deleted).toEqual([{ calendarId: "primary", eventId: "solo" }]);

    expect(label("agenda_delete", {})).toBe("Tirou um evento da agenda");
    const deleted = await run("agenda_delete", { eventId: created.id });
    expect(deleted.ok).toBe(true);
    expect(deleted.blockEvent?.type).toBe("block.updated");
    expect(toolCallsOf(`${account.name}.calendar_delete_event`)).toHaveLength(2);
  });
});

describe("export_create", () => {
  test("labels and exports a note without sending", async () => {
    const { note } = createNote(bot.id, { title: "Relatório", content: "# Oi" }, "bot");
    expect(label("export_create", { kind: "note", id: note.id, format: "md" })).toBe("Exportou a nota “Relatório” em MD");
    const job = (await run("export_create", { kind: "note", id: note.id, format: "md" })) as { status: string; fileEvent?: unknown };
    expect(job.status).toBe("ready");
    expect(job.fileEvent).toBeUndefined();
  });

  test("sends the exported sheet as a file", async () => {
    const sheet = await run<{ id: string }>("sheet_create", { title: "Gastos", cells: [{ a: "A1", input: "5" }] });
    expect(label("export_create", { kind: "sheet", id: sheet.id, format: "csv" })).toBe("Exportou a planilha “Gastos” em CSV");
    const job = (await run("export_create", { kind: "sheet", id: sheet.id, format: "csv", send: true })) as {
      id: string;
      status: string;
      fileEvent: { type: string; data: { attachment: { name: string; url: string } } };
    };
    await rm(join("/tmp", "runelay-exports", job.id), { recursive: true, force: true });
    expect(job.status).toBe("ready");
    expect(job.fileEvent.type).toBe("file.sent");
    expect(job.fileEvent.data.attachment.name).toMatch(/\.csv$/);
    expect(job.fileEvent.data.attachment.url).toStartWith(`/bots/${encodeURIComponent(bot.id)}/uploads/`);
  });

  test("turns a failed export into an error", async () => {
    const failed = { id: "exp_x", status: "failed" } as Awaited<ReturnType<typeof exportsService.createExport>>;
    spies.push(
      spyOn(exportsService, "createExport")
        .mockResolvedValueOnce({ ...failed, error: "Sem espaço." })
        .mockResolvedValueOnce({ ...failed, error: null }),
    );
    await expect(run("export_create", { kind: "note", id: "n", format: "md" })).rejects.toThrow("Sem espaço.");
    await expect(run("export_create", { kind: "note", id: "n", format: "md" })).rejects.toThrow("A exportação falhou.");
  });
});
