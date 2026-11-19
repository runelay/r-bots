import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createEvent,
  deleteEvent,
  externalAttendeesCached,
  listAccounts,
  listEvents,
  needsApproval,
  updateEvent,
} from "../../agenda/services/agenda.service";
import type { BotTool } from "../../engine/services/bot-tools.service";
import { createExport, exportBytes } from "../../exports/services/exports.service";
import {
  createNote,
  deleteNote,
  listNotes,
  moveNote,
  noteEditNote,
  noteTree,
  patchNote,
  readNoteForBot,
  requireNote,
  resolveNote,
  searchNotes,
  writeNote,
} from "../../notes/services/notes.service";
import {
  createSheet,
  formatCells,
  listSheets,
  markSheetSeen,
  readRange,
  requireSheet,
  sheetEditNote,
  sheetOf,
  sheetTabTool,
  writeCells,
} from "../../sheets/services/sheets.service";
import { importBotFile, publicUpload } from "../../uploads/services/uploads.service";
import { BlockError } from "./blocks.shared";

const quoted = (value: unknown) => `“${String(value ?? "").trim() || "sem título"}”`;

const cellsShape = z
  .array(z.object({ a: z.string().min(2).max(12), input: z.string().max(10_000) }))
  .max(20_000)
  .describe('Células em A1, ex.: [{"a":"B2","input":"=SOMA(B3:B9)"}]. input vazio apaga.');

const formatShape = z
  .object({
    type: z.enum(["general", "number", "brl", "percent", "date", "datetime", "text"]).optional(),
    decimals: z.number().int().min(0).max(10).optional(),
    bold: z.boolean().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  })
  .nullable();

const patchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), old: z.string().min(1), new: z.string() }),
  z.object({ op: z.literal("append"), text: z.string() }),
  z.object({ op: z.literal("prepend"), text: z.string() }),
  z.object({ op: z.literal("insert_after_heading"), heading: z.string().min(1), text: z.string() }),
  z.object({ op: z.literal("toggle_task"), line: z.number().int().min(0), done: z.boolean() }),
]);

function titleOfNote(botId: string, id: unknown) {
  try {
    return requireNote(botId, String(id ?? "")).title;
  } catch {
    return "";
  }
}

function titleOfSheet(botId: string, id: unknown) {
  try {
    return requireSheet(botId, String(id ?? "")).title;
  } catch {
    return "";
  }
}

export function blockTools(botId: string): BotTool[] {
  return [
    {
      name: "note_list",
      description:
        "Lista suas notas (markdown estilo Obsidian). Filtros: folder (só aquela pasta), q (busca), tag, sort updated|title. Paginado com cursor.",
      shape: {
        folder: z.string().max(300).optional(),
        q: z.string().max(200).optional(),
        tag: z.string().max(80).optional(),
        sort: z.enum(["updated", "title"]).optional(),
        cursor: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      approval: null,
      label: () => "Listou as notas",
      run: async (input) => listNotes(botId, input),
    },
    {
      name: "note_tree",
      description: "Mostra um nível da árvore de pastas das notas (subpastas e notas da pasta).",
      shape: { folder: z.string().max(300).optional() },
      approval: null,
      label: (input) => (input.folder ? `Abriu a pasta ${quoted(input.folder)}` : "Abriu as pastas das notas"),
      run: async (input) => noteTree(botId, input),
    },
    {
      name: "note_read",
      description: "Lê uma nota inteira por id ou por título, com links [[...]] resolvidos e contagem de backlinks.",
      shape: { id: z.string().max(60).optional(), title: z.string().max(200).optional() },
      approval: null,
      label: (input) => `Leu a nota ${quoted(input.title ?? titleOfNote(botId, input.id))}`,
      run: async (input) => {
        if (input.id) return readNoteForBot(botId, String(input.id));
        if (!input.title) throw new BlockError("Passe id ou title.");
        return readNoteForBot(botId, resolveNote(botId, String(input.title)).id);
      },
    },
    {
      name: "note_search",
      description: "Busca no texto de todas as notas (sem acento e por prefixo).",
      shape: {
        q: z.string().min(1).max(200),
        cursor: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      approval: null,
      label: (input) => `Buscou ${quoted(input.q)} nas notas`,
      run: async (input) => searchNotes(botId, input),
    },
    {
      name: "note_write",
      description:
        "Cria uma nota (sem id) ou reescreve o conteúdo inteiro de uma nota (com id). Markdown com [[Título]] para ligar notas e #tag. Para mudanças pequenas prefira note_patch.",
      shape: {
        id: z.string().max(60).optional(),
        title: z.string().min(1).max(200),
        folder: z.string().max(300).optional(),
        content: z.string().max(500_000),
        baseVersion: z.number().int().optional(),
      },
      approval: null,
      label: (input) => `${input.id ? "Editou" : "Criou"} a nota ${quoted(input.title)}`,
      run: async (input) => {
        if (!input.id) {
          const { note, event } = createNote(botId, input, "bot");
          return { ...note, blockEvent: event };
        }
        const current = requireNote(botId, String(input.id));
        if (input.folder !== undefined && String(input.folder) !== current.folder)
          moveNote(botId, current.id, { folder: input.folder }, "bot");
        const { note, event } = writeNote(botId, current.id, input, "bot");
        return { ...note, blockEvent: event };
      },
    },
    {
      name: "note_patch",
      description:
        "Edita parte de uma nota: replace (trecho exato que aparece uma vez), append, prepend, insert_after_heading, toggle_task (linha 0-based). Erro em uma op cancela todas.",
      shape: { id: z.string().min(1).max(60), ops: z.array(patchOp).min(1).max(50), baseVersion: z.number().int().optional() },
      approval: null,
      label: (input) => `Editou a nota ${quoted(titleOfNote(botId, input.id))}`,
      run: async (input) => {
        const { note, event } = patchNote(botId, String(input.id), input, "bot");
        return { ...note, blockEvent: event };
      },
    },
    {
      name: "note_move",
      description: "Move a nota de pasta e/ou renomeia. Renomear reescreve os [[links]] das outras notas.",
      shape: {
        id: z.string().min(1).max(60),
        folder: z.string().max(300).optional(),
        title: z.string().min(1).max(200).optional(),
      },
      approval: null,
      label: (input) =>
        input.title ? `Renomeou a nota para ${quoted(input.title)}` : `Moveu a nota ${quoted(titleOfNote(botId, input.id))}`,
      run: async (input) => {
        const { note, relinked, event } = moveNote(botId, String(input.id), input, "bot");
        return { note, relinked, blockEvent: event };
      },
    },
    {
      name: "note_delete",
      description: "Manda a nota para a lixeira (dá para recuperar).",
      shape: { id: z.string().min(1).max(60) },
      approval: null,
      label: (input) => `Apagou a nota ${quoted(titleOfNote(botId, input.id))}`,
      run: async (input) => ({ ok: true, blockEvent: deleteNote(botId, String(input.id), "bot") }),
    },
    {
      name: "sheet_list",
      description: "Lista suas planilhas. q busca no título. Paginado com cursor.",
      shape: {
        q: z.string().max(200).optional(),
        cursor: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      approval: null,
      label: () => "Listou as planilhas",
      run: async (input) => listSheets(botId, input),
    },
    {
      name: "sheet_create",
      description:
        "Cria uma planilha (estilo Excel). tabs é a lista de nomes de abas; cells preenche a primeira aba. Use fórmulas (=SOMA, =MÉDIA, =SE, =PROCV, =PROCX, =CONT.SE, =SOMASE, ou em inglês) em vez de calcular à mão; referência entre abas: =Resumo!B2.",
      shape: {
        title: z.string().min(1).max(120),
        tabs: z.array(z.string().min(1).max(31)).max(20).optional(),
        cells: cellsShape.optional(),
      },
      approval: null,
      label: (input) => `Criou a planilha ${quoted(input.title)}`,
      run: async (input) => {
        const { sheet, event } = createSheet(botId, input, "bot");
        return { ...sheet, blockEvent: event };
      },
    },
    {
      name: "sheet_read",
      description: "Lê um intervalo (ex.: A1:F40) de uma aba com os valores já calculados. Sem tabId lê a primeira aba.",
      shape: { id: z.string().min(1).max(60), tabId: z.string().max(60).optional(), range: z.string().min(2).max(30) },
      approval: null,
      label: (input) => `Leu a planilha ${quoted(titleOfSheet(botId, input.id))}`,
      run: async (input) => {
        const range = readRange(botId, String(input.id), input.tabId, input.range);
        markSheetSeen(botId, String(input.id));
        return { sheet: sheetOf(requireSheet(botId, String(input.id))), ...range };
      },
    },
    {
      name: "sheet_write",
      description:
        "Escreve células em lote numa aba (sem tabId, a primeira). Devolve as células escritas e as dependentes recalculadas. input aceita número pt-BR (1.520,50), R$, %, data dd/mm/aaaa e fórmula com ; ou ,.",
      shape: { id: z.string().min(1).max(60), tabId: z.string().max(60).optional(), cells: cellsShape, baseVersion: z.number().int().optional() },
      approval: null,
      label: (input) => `Editou a planilha ${quoted(titleOfSheet(botId, input.id))}`,
      run: async (input) => {
        const { result, event } = writeCells(botId, String(input.id), input.tabId, input, "bot");
        markSheetSeen(botId, String(input.id));
        return { ...result, blockEvent: event };
      },
    },
    {
      name: "sheet_format",
      description: "Formata intervalos: type general|number|brl|percent|date|datetime|text, decimals, bold, align. format null limpa.",
      shape: {
        id: z.string().min(1).max(60),
        tabId: z.string().max(60).optional(),
        ranges: z.array(z.string().min(2).max(30)).min(1).max(50),
        format: formatShape,
      },
      approval: null,
      label: (input) => `Formatou a planilha ${quoted(titleOfSheet(botId, input.id))}`,
      run: async (input) => {
        const { result, event } = formatCells(botId, String(input.id), input.tabId, input, "bot");
        return { ...result, blockEvent: event };
      },
    },
    {
      name: "sheet_tab",
      description:
        "Mexe nas abas: op add {name}, rename {tabId,name}, delete {tabId}, freeze {tabId,frozenRows,frozenCols}, structure {tabId, structure: insert_rows|delete_rows|insert_cols|delete_cols, at (0-based), count}. As fórmulas são reescritas como no Excel.",
      shape: {
        id: z.string().min(1).max(60),
        op: z.enum(["add", "rename", "delete", "freeze", "structure"]),
        tabId: z.string().max(60).optional(),
        name: z.string().min(1).max(31).optional(),
        frozenRows: z.number().int().min(0).max(50).optional(),
        frozenCols: z.number().int().min(0).max(20).optional(),
        structure: z.enum(["insert_rows", "delete_rows", "insert_cols", "delete_cols"]).optional(),
        at: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(10_000).optional(),
      },
      approval: null,
      label: (input) => `Editou a planilha ${quoted(titleOfSheet(botId, input.id))}`,
      run: async (input) => {
        const { sheet, event } = sheetTabTool(botId, input);
        return { ...sheet, blockEvent: event };
      },
    },
    {
      name: "agenda_accounts",
      description: "Lista as contas do Google Calendar ligadas na runelay, com calendários e status.",
      shape: {},
      approval: null,
      label: () => "Viu as contas da agenda",
      run: async () => listAccounts(),
    },
    {
      name: "agenda_list",
      description:
        "Lista eventos de um período (start/end ISO com fuso, no máximo 62 dias) em todas as contas ligadas ou só nas de accounts (ids separados por vírgula). q filtra pelo texto no Google.",
      shape: {
        start: z.string().min(10).max(40),
        end: z.string().min(10).max(40),
        accounts: z.string().max(200).optional(),
        q: z.string().max(200).optional(),
      },
      approval: null,
      label: () => "Viu a agenda",
      run: async (input) => listEvents(input),
    },
    {
      name: "agenda_create",
      description:
        "Cria um evento numa conta (accountId de agenda_accounts). start/end em ISO com fuso (ou AAAA-MM-DD com allDay). Confirme horário e conta com a pessoa antes. Convidado de fora das contas da pessoa recebe e-mail e pede aprovação.",
      shape: {
        accountId: z.string().min(1).max(60),
        calendarId: z.string().max(200).optional(),
        title: z.string().min(1).max(300),
        start: z.string().min(10).max(40),
        end: z.string().min(10).max(40),
        allDay: z.boolean().optional(),
        location: z.string().max(500).nullable().optional(),
        description: z.string().max(8000).nullable().optional(),
        attendees: z.array(z.string().email()).max(50).optional(),
      },
      approval: (input) => {
        const outside = externalAttendeesCached(input);
        return outside.length
          ? `Posso marcar ${quoted(input.title)} e mandar convite por e-mail para ${outside.join(", ")}?`
          : null;
      },
      details: async (input) => ({
        target: { label: String(input.title ?? "evento"), role: "agenda" },
        reason: `Convite por e-mail para ${(await needsApproval(input)).join(", ")}`,
      }),
      label: (input) => `Marcou ${quoted(input.title)} na agenda`,
      run: async (input) => {
        const { event, blockEvent } = await createEvent(botId, input, "bot");
        return { ...event, blockEvent };
      },
    },
    {
      name: "agenda_update",
      description:
        "Muda um evento (eventId de agenda_list). Só funciona em evento sem convidados e não recorrente; o evento ganha um id novo.",
      shape: {
        eventId: z.string().min(1).max(600),
        title: z.string().min(1).max(300).optional(),
        start: z.string().min(10).max(40).optional(),
        end: z.string().min(10).max(40).optional(),
        allDay: z.boolean().optional(),
        location: z.string().max(500).nullable().optional(),
        description: z.string().max(8000).nullable().optional(),
      },
      approval: null,
      label: (input) => (input.title ? `Mudou ${quoted(input.title)} na agenda` : "Mudou um evento da agenda"),
      run: async (input) => {
        const { event, blockEvent } = await updateEvent(botId, String(input.eventId), input, "bot");
        return { ...event, blockEvent };
      },
    },
    {
      name: "agenda_delete",
      description: "Apaga um evento da agenda (eventId de agenda_list). Só apague quando a pessoa pedir.",
      shape: { eventId: z.string().min(1).max(600) },
      approval: null,
      label: () => "Tirou um evento da agenda",
      run: async (input) => ({ ok: true, blockEvent: await deleteEvent(botId, String(input.eventId), "bot") }),
    },
    {
      name: "export_create",
      description:
        "Exporta uma nota (docx, pdf, md) ou planilha (xlsx com fórmulas, csv da aba tabId, pdf). send:true manda o arquivo na conversa.",
      shape: {
        kind: z.enum(["note", "sheet"]),
        id: z.string().min(1).max(60),
        format: z.enum(["docx", "pdf", "md", "xlsx", "csv"]),
        tabId: z.string().max(60).optional(),
        send: z.boolean().optional(),
      },
      approval: null,
      label: (input) =>
        `Exportou ${input.kind === "sheet" ? "a planilha" : "a nota"} ${quoted(input.kind === "sheet" ? titleOfSheet(botId, input.id) : titleOfNote(botId, input.id))} em ${String(input.format).toUpperCase()}`,
      run: async (input) => {
        const job = await createExport(botId, input);
        if (job.status !== "ready") throw new BlockError(job.error ?? "A exportação falhou.");
        if (input.send !== true) return job;
        const file = await exportBytes(botId, job.id);
        const dir = join("/tmp", "runelay-exports", job.id);
        await mkdir(dir, { recursive: true });
        const path = join(dir, file.fileName);
        await writeFile(path, file.data);
        const meta = await importBotFile(botId, path, file.fileName);
        return { ...job, fileEvent: { type: "file.sent", data: { attachment: publicUpload(botId, meta) } } };
      },
    },
  ];
}

export const blocksGuide = [
  "## Notas, planilhas e agenda",
  "Você tem três blocos seus, que a pessoa vê e edita no app ao seu lado. Use direto, sem pedir permissão:",
  "- **Notas** (`note_*`): texto que a pessoa vai reler, em markdown estilo Obsidian. Ligue notas com `[[Título]]` e marque com `#tag`. Para mudar um trecho use `note_patch`; para reescrever tudo, `note_write` com id. Pastas com `/`.",
  "- **Planilhas** (`sheet_*`): números, listas com colunas e contas. Sempre escreva fórmula (`=SOMA(B2:B9)`, `=PROCV(...)`, `=Resumo!B2`), nunca um valor que você calculou de cabeça. Leia com `sheet_read` antes de mudar uma planilha que já existe.",
  "- **Agenda** (`agenda_*`): só as contas Google ligadas na runelay. Antes de criar, confirme horário e conta com a pessoa em uma linha; convidado de fora pede aprovação porque recebe e-mail.",
  "- **Exportar** (`export_create`): docx, pdf ou md da nota; xlsx, csv ou pdf da planilha. Com `send:true` o arquivo vai na conversa.",
  "Depois de criar ou editar, diga em uma frase o que mudou: a pessoa vê o bloco na conversa e não precisa de link nem id.",
].join("\n");

export function blocksEditNote(botId: string) {
  const lines = [...noteEditNote(botId), ...sheetEditNote(botId)];
  if (!lines.length) return "";
  return ["## Notas e planilhas editadas pela pessoa", ...lines, "Respeite essas edições e não desfaça o que a pessoa mudou."].join(
    "\n",
  );
}
