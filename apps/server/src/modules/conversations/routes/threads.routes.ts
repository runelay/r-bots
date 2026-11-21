import { notFound, type Req, type Res, readBody, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { isBusy, isRunning } from "../../engine/services/engine.service";
import { sessionReactions } from "../services/reactions.service";
import {
  ensureThread,
  markThreadRead,
  markThreadUnread,
  peekThread,
  publicThread,
  resetThread,
  restoreThread,
} from "../services/threads.service";

async function threadView(bot: BotDefinition) {
  const thread = await ensureThread(bot.id);
  return {
    ...publicThread(thread),
    running: isRunning(thread.sessionId),
    reactions: await sessionReactions(thread.sessionId),
  };
}

export async function handleBotThread(req: Req, res: Res, method: string, bot: BotDefinition, tail: string) {
  if (tail === "thread/unread" && method === "POST") {
    await readBody(req).catch(() => undefined);
    return sendJson(res, 200, publicThread(await markThreadUnread(bot.id)));
  }
  if (tail === "thread" && method === "GET") return sendJson(res, 200, await threadView(bot));
  if ((tail === "thread/reset" || tail === "thread/restore") && method === "POST") {
    const body = (await readBody(req).catch(() => undefined)) as { archiveId?: unknown } | undefined;
    const current = await peekThread(bot.id);
    if (current && isBusy(current.sessionId)) {
      return sendJson(res, 409, {
        ok: false,
        code: "turn_running",
        error: "O bot ainda está respondendo. Pare a resposta antes de limpar a conversa.",
      });
    }
    if (tail === "thread/reset") {
      const { archiveId } = await resetThread(bot.id);
      return sendJson(res, 200, { ...(await threadView(bot)), archiveId });
    }
    const archiveId = body?.archiveId;
    if (typeof archiveId !== "string" || !/^tha_[0-9A-Z]{26}$/.test(archiveId)) {
      return sendJson(res, 400, { ok: false, error: "archiveId inválido.", field: "archiveId" });
    }
    const restored = await restoreThread(bot.id, archiveId);
    if (!restored) return sendJson(res, 404, { ok: false, error: "Essa conversa arquivada não existe mais." });
    return sendJson(res, 200, { ...(await threadView(bot)), archiveId: restored.replacedArchiveId });
  }
  if (tail === "thread/read" && method === "POST") {
    await readBody(req).catch(() => undefined);
    return sendJson(res, 200, publicThread(await markThreadRead(bot.id)));
  }
  notFound(res);
}
