import { notFound, type Req, type Res, readBody, sendJson } from "../../../shared/http";
import { createEvent, deleteEvent, listAccounts, listEvents, updateEvent } from "../../agenda/services/agenda.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import { createExport, exportFile, readExport } from "../../exports/services/exports.service";
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
  resolveNote,
  searchNotes,
  writeNote,
} from "../../notes/services/notes.service";
import {
  addTab,
  createSheet,
  deleteSheet,
  deleteTab,
  formatCells,
  listSheets,
  patchTab,
  readRange,
  renameSheet,
  requireSheet,
  sheetOf,
  structure,
  writeCells,
} from "../../sheets/services/sheets.service";
import { BlockError, type BlockEvent, emitUserBlockEvent } from "../services/blocks.shared";

export const blockRoots = new Set(["notes", "sheets", "agenda", "exports"]);

function queryOf(url: URL) {
  return Object.fromEntries(url.searchParams.entries()) as Record<string, string>;
}

async function bodyOf(req: Req) {
  const body = await readBody(req);
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body)))
    throw new BlockError("Corpo inválido.");
  return (body ?? {}) as Record<string, unknown>;
}

async function written<T>(res: Res, bot: BotDefinition, status: number, payload: T, event: BlockEvent | null) {
  await emitUserBlockEvent(bot.id, event);
  return sendJson(res, status, payload);
}

async function notesRoute(req: Req, res: Res, url: URL, method: string, bot: BotDefinition, path: string[]) {
  const [first, second] = path;
  if (!first) {
    if (method === "GET") return sendJson(res, 200, listNotes(bot.id, queryOf(url)));
    if (method === "POST") {
      const { note, event } = createNote(bot.id, await bodyOf(req), "user");
      return written(res, bot, 201, note, event);
    }
  }
  if (first === "tree" && !second && method === "GET") return sendJson(res, 200, noteTree(bot.id, queryOf(url)));
  if (first === "search" && !second && method === "GET") return sendJson(res, 200, searchNotes(bot.id, queryOf(url)));
  if (first === "resolve" && !second && method === "GET") {
    const query = queryOf(url);
    return sendJson(res, 200, resolveNote(bot.id, query.title ?? "", query.folder));
  }
  if (first && !second) {
    if (method === "GET") return sendJson(res, 200, noteOf(bot.id, requireNote(bot.id, first)));
    if (method === "PUT") {
      const { note, event } = writeNote(bot.id, first, await bodyOf(req), "user");
      return written(res, bot, 200, note, event);
    }
    if (method === "PATCH") {
      const { note, event } = patchNote(bot.id, first, await bodyOf(req), "user");
      return written(res, bot, 200, note, event);
    }
    if (method === "DELETE") return written(res, bot, 200, { ok: true }, deleteNote(bot.id, first, "user"));
  }
  if (first && second === "backlinks" && method === "GET")
    return sendJson(res, 200, noteBacklinks(bot.id, first, queryOf(url)));
  if (first && second === "move" && method === "POST") {
    const { note, relinked, event } = moveNote(bot.id, first, await bodyOf(req), "user");
    return written(res, bot, 200, { note, relinked }, event);
  }
  return notFound(res);
}

async function sheetsRoute(req: Req, res: Res, url: URL, method: string, bot: BotDefinition, path: string[]) {
  const [sheetId, section, tabId, action] = path;
  if (!sheetId) {
    if (method === "GET") return sendJson(res, 200, listSheets(bot.id, queryOf(url)));
    if (method === "POST") {
      const { sheet, event } = createSheet(bot.id, await bodyOf(req), "user");
      return written(res, bot, 201, sheet, event);
    }
    return notFound(res);
  }
  if (!section) {
    if (method === "GET") return sendJson(res, 200, sheetOf(requireSheet(bot.id, sheetId)));
    if (method === "PATCH") {
      const { sheet, event } = renameSheet(bot.id, sheetId, await bodyOf(req), "user");
      return written(res, bot, 200, sheet, event);
    }
    if (method === "DELETE") return written(res, bot, 200, { ok: true }, deleteSheet(bot.id, sheetId, "user"));
    return notFound(res);
  }
  if (section !== "tabs") return notFound(res);
  if (!tabId && method === "POST") {
    const { tab, event } = addTab(bot.id, sheetId, await bodyOf(req), "user");
    return written(res, bot, 201, tab, event);
  }
  if (!tabId) return notFound(res);
  if (!action) {
    if (method === "PATCH") {
      const { tab, event } = patchTab(bot.id, sheetId, tabId, await bodyOf(req), "user");
      return written(res, bot, 200, tab, event);
    }
    if (method === "DELETE") {
      const { sheet, event } = deleteTab(bot.id, sheetId, tabId, "user");
      return written(res, bot, 200, sheet, event);
    }
    return notFound(res);
  }
  if (action === "range" && method === "GET")
    return sendJson(res, 200, readRange(bot.id, sheetId, tabId, url.searchParams.get("range")));
  if (action === "cells" && method === "POST") {
    const { result, event } = writeCells(bot.id, sheetId, tabId, await bodyOf(req), "user");
    return written(res, bot, 200, result, event);
  }
  if (action === "format" && method === "POST") {
    const { result, event } = formatCells(bot.id, sheetId, tabId, await bodyOf(req), "user");
    return written(res, bot, 200, result, event);
  }
  if (action === "structure" && method === "POST") {
    const { version, tab, event } = structure(bot.id, sheetId, tabId, await bodyOf(req), "user");
    return written(res, bot, 200, { version, tab }, event);
  }
  return notFound(res);
}

async function agendaRoute(req: Req, res: Res, url: URL, method: string, bot: BotDefinition, path: string[]) {
  const [section, eventId] = path;
  if (section === "accounts" && !eventId && method === "GET") return sendJson(res, 200, await listAccounts());
  if (section !== "events") return notFound(res);
  if (!eventId) {
    if (method === "GET") return sendJson(res, 200, await listEvents(queryOf(url)));
    if (method === "POST") {
      const { event, blockEvent } = await createEvent(bot.id, await bodyOf(req), "user");
      return written(res, bot, 201, event, blockEvent);
    }
    return notFound(res);
  }
  if (method === "PATCH") {
    const { event, blockEvent } = await updateEvent(bot.id, eventId, await bodyOf(req), "user");
    return written(res, bot, 200, event, blockEvent);
  }
  if (method === "DELETE") return written(res, bot, 200, { ok: true }, await deleteEvent(bot.id, eventId, "user"));
  return notFound(res);
}

async function exportsRoute(req: Req, res: Res, method: string, bot: BotDefinition, path: string[]) {
  const [exportId, file] = path;
  if (!exportId && method === "POST") return sendJson(res, 201, await createExport(bot.id, await bodyOf(req)));
  if (exportId && !file && method === "GET") return sendJson(res, 200, readExport(bot.id, exportId));
  if (exportId && file === "file" && method === "GET") {
    const found = await exportFile(bot.id, exportId);
    res.respond(
      new Response(found.stream, {
        status: 200,
        headers: {
          "content-type": found.mime,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.fileName)}`,
          "cache-control": "private, no-store",
          ...(found.size ? { "content-length": String(found.size) } : {}),
        },
      }),
    );
    return;
  }
  return notFound(res);
}

export async function handleBotBlocks(
  req: Req,
  res: Res,
  url: URL,
  method: string,
  bot: BotDefinition,
  rest: string[],
) {
  const [root, ...path] = rest;
  try {
    if (root === "notes") return await notesRoute(req, res, url, method, bot, path);
    if (root === "sheets") return await sheetsRoute(req, res, url, method, bot, path);
    if (root === "agenda") return await agendaRoute(req, res, url, method, bot, path);
    if (root === "exports") return await exportsRoute(req, res, method, bot, path);
    return notFound(res);
  } catch (error) {
    if (error instanceof BlockError)
      return sendJson(res, error.status, {
        ok: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...error.extra,
      });
    if (error instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "JSON inválido." });
    if (/runelay|call_tool|fetch failed|timed out/i.test((error as Error)?.message ?? ""))
      return sendJson(res, 502, {
        ok: false,
        error: `A agenda não respondeu: ${(error as Error).message}`.slice(0, 300),
      });
    throw error;
  }
}
