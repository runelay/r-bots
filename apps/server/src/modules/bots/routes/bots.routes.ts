import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { commonText } from "../../../shared/messages";
import { handleBotArtifacts } from "../../artifacts/routes/artifacts.routes";
import { blockRoots, handleBotBlocks } from "../../blocks/routes/blocks.routes";
import { handleBotBrowser } from "../../browser/routes/browser.routes";
import { stopDesktop } from "../../browser/services/desktop.service";
import { handleBotCode } from "../../code/routes/code.routes";
import { handleConversations } from "../../conversations/routes/conversations.routes";
import { handleEve, handleSessions } from "../../conversations/routes/sessions.routes";
import { handleBotThread } from "../../conversations/routes/threads.routes";
import { handleBotSchedules } from "../../schedules/routes/schedules.routes";
import { sectionExists } from "../../sections/services/sections.service";
import { handleUploads } from "../../uploads/routes/uploads.routes";
import { handleVoice } from "../../voice/routes/voice.routes";
import { postGreeting, publicBot } from "../services/bot-view.service";
import {
  createBot,
  getBot,
  listBots,
  setArchived,
  setDeleted,
  updateBot,
  updateSidebar,
} from "../services/bots.service";

function normalize(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

async function handleBotList(req: Req, res: Res, url: URL, method: string) {
  if (method === "GET") {
    const includeArchived = url.searchParams.get("archived") === "1";
    const listed = listBots(includeArchived, {
      deleted: url.searchParams.get("deleted") === "1",
      hidden: url.searchParams.get("hidden") === "1",
    });
    const all = await Promise.all(listed.map(publicBot));
    const term = normalize(url.searchParams.get("q") ?? "");
    if (!term) return sendJson(res, 200, all);
    return sendJson(
      res,
      200,
      all.filter((bot) =>
        [bot.name, bot.role, bot.thread.lastMessage?.text ?? ""].some((value) => normalize(value).includes(term)),
      ),
    );
  }
  if (method === "POST") {
    try {
      const bot = await createBot(await readBody(req));
      await postGreeting(bot);
      return sendJson(res, 201, await publicBot(bot));
    } catch (error) {
      return validationResponse(res, error);
    }
  }
  return sendJson(res, 405, { ok: false, error: commonText("methodNotAllowed") });
}

export async function handleBots(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  if (parts.length === 1) return handleBotList(req, res, url, method);

  const bot = getBot(parts[1] ?? "");
  if (!bot) return sendJson(res, 404, { ok: false, error: commonText("botNotFound") });
  const rest = parts.slice(2);
  const tail = rest.join("/");

  if (rest[0] === "eve") return handleEve(req, res, url, bot, rest.slice(1));
  if (rest[0] === "voice") return handleVoice(req, res, method, bot, rest.slice(1));
  if (rest[0] === "code") return handleBotCode(req, res, url, method, bot, rest.slice(1));
  if (rest[0] === "uploads") return handleUploads(req, res, method, bot, rest.slice(1));
  if (tail === "" && method === "GET") return sendJson(res, 200, await publicBot(bot));
  if (tail === "" && method === "PATCH") {
    try {
      const updated = await updateBot(bot.id, await readBody(req));
      if (!updated) return sendJson(res, 404, { ok: false, error: commonText("botNotFound") });
      return sendJson(res, 200, await publicBot(updated));
    } catch (error) {
      return validationResponse(res, error);
    }
  }
  if ((tail === "delete" || tail === "restore") && method === "POST") {
    await readBody(req).catch(() => undefined);
    if (tail === "delete") stopDesktop(bot.id);
    const updated = await setDeleted(bot.id, tail === "delete");
    if (!updated) return sendJson(res, 404, { ok: false, error: commonText("botNotFound") });
    return sendJson(res, 200, await publicBot(updated));
  }
  if (tail === "sidebar" && method === "PATCH") {
    try {
      const updated = await updateSidebar(bot.id, await readBody(req), sectionExists);
      if (!updated) return sendJson(res, 404, { ok: false, error: commonText("botNotFound") });
      return sendJson(res, 200, await publicBot(updated));
    } catch (error) {
      return validationResponse(res, error);
    }
  }
  if ((tail === "archive" || tail === "unarchive") && method === "POST") {
    const updated = await setArchived(bot.id, tail === "archive");
    if (!updated) return sendJson(res, 404, { ok: false, error: commonText("botNotFound") });
    return sendJson(res, 200, await publicBot(updated));
  }
  if (rest[0] === "thread") return handleBotThread(req, res, method, bot, tail);
  if (rest[0] === "schedules") return handleBotSchedules(req, res, method, bot, rest.slice(1));
  if (rest[0] === "browser" || rest[0] === "desktop") return handleBotBrowser(req, res, method, bot, tail);
  if (rest[0] === "artifacts") return handleBotArtifacts(req, res, method, bot, rest.slice(1));
  if (blockRoots.has(rest[0] ?? "")) return handleBotBlocks(req, res, url, method, bot, rest);
  if (tail === "sessions" && method === "GET") return handleSessions(res, bot);
  if (rest[0] === "conversations") return handleConversations(req, res, url, method, bot, rest.slice(1));
  notFound(res);
}
