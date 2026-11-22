import { notFound, type Req, type Res, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { conversationsText } from "../../conversations/constants/conversations-messages.constants";
import { publicUpload, receiveUpload, serveUpload, UploadError } from "../services/uploads.service";

export async function handleUploads(req: Req, res: Res, method: string, bot: BotDefinition, rest: string[]) {
  if (rest.length === 0 && method === "POST") {
    if (bot.deletedAt)
      return sendJson(res, 409, { ok: false, code: "bot_deleted", error: conversationsText("botDeleted") });
    try {
      const meta = await receiveUpload(bot.id, req);
      return sendJson(res, 201, publicUpload(bot.id, meta));
    } catch (error) {
      if (error instanceof UploadError) {
        if (!res.headersSent) sendJson(res, error.status, { ok: false, error: error.message }, { connection: "close" });
        req.resume();
        return;
      }
      throw error;
    }
  }
  if ((rest.length === 1 || rest.length === 2) && (method === "GET" || method === "HEAD"))
    return serveUpload(req, res, bot.id, rest[0], rest[1]);
  notFound(res);
}
