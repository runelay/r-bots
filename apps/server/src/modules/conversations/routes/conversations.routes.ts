import { randomUUID } from "node:crypto";
import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { isPermissionMode } from "../../approvals/services/permissions.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import { deliver } from "../../engine/services/engine.service";
import { searchMessages } from "../repositories/sessions.repository";
import {
  archiveConversation,
  ConversationError,
  conversationOf,
  createConversation,
  listConversations,
  markConversation,
  moveConversation,
  publicConversation,
  updateConversation,
} from "../services/conversations.service";
import { ensureThread, markThreadRead, markThreadUnread } from "../services/threads.service";
import { checkFields, deliveryText, rejectInactiveBot, resolveAttachments, resolveSkills } from "./delivery-input";

function handleSearch(res: Res, url: URL, bot: BotDefinition) {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return sendJson(res, 400, { ok: false, error: "Mande o texto da busca em q.", field: "q" });
  if (q.length > 200)
    return sendJson(res, 400, { ok: false, error: "A busca pode ter até 200 caracteres.", field: "q" });
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const cursor = Number(url.searchParams.get("cursor") ?? 0);
  const page = searchMessages({
    q,
    botId: bot.id,
    limit: Number.isFinite(limit) ? limit : 20,
    cursor: Number.isFinite(cursor) ? cursor : 0,
  });
  return sendJson(res, 200, page);
}

export async function handleConversations(
  req: Req,
  res: Res,
  url: URL,
  method: string,
  bot: BotDefinition,
  rest: string[],
) {
  try {
    if (rest.length === 0 && method === "GET") {
      const archived = url.searchParams.get("archived") === "1";
      if (!archived) await ensureThread(bot.id);
      return sendJson(res, 200, await listConversations(bot.id, archived));
    }
    if (rest.length === 0 && method === "POST") {
      if (rejectInactiveBot(res, bot)) return;
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body))
        return sendJson(res, 400, { ok: false, error: "Corpo inválido.", field: "body" });
      for (const key of Object.keys(body))
        if (!["title", "permission", "message", "skills", "attachments"].includes(key))
          return sendJson(res, 400, { ok: false, error: `Campo desconhecido: ${key}.`, field: key });
      if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length > 80))
        return sendJson(res, 400, { ok: false, error: "O título precisa ter até 80 caracteres.", field: "title" });
      if (body.permission !== undefined && !isPermissionMode(body.permission))
        return sendJson(res, 400, { ok: false, error: "Use readonly, edit, default ou full.", field: "permission" });
      const problem = checkFields({
        ...(body.message !== undefined ? { message: body.message } : {}),
        ...(body.skills !== undefined ? { skills: body.skills } : {}),
        ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      });
      if (problem) return sendJson(res, 400, { ok: false, error: problem });
      const skills = await resolveSkills(res, body);
      if (!skills) return;
      const attachments = await resolveAttachments(res, bot, body);
      if (!attachments) return;
      const message = typeof body.message === "string" ? body.message : undefined;
      const session = await createConversation(bot.id, {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(isPermissionMode(body.permission) ? { permission: body.permission } : {}),
        ...(message?.trim() ? { firstMessage: message } : {}),
      });
      let deliveryId: string | null = null;
      if (message?.trim() || skills.length > 0 || attachments.length > 0) {
        deliveryId = randomUUID();
        deliver(session, {
          deliveryId,
          text: deliveryText(message, skills),
          source: "chat",
          ...(skills.length ? { skills } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      }
      return sendJson(res, 201, {
        ...(await publicConversation(session)),
        sessionBasePath: `/bots/${bot.id}/eve/v1`,
        ...(deliveryId ? { deliveryId } : {}),
      });
    }
    if (rest[0] === "search" && rest.length === 1 && method === "GET") return handleSearch(res, url, bot);
    const session = conversationOf(bot.id, rest[0] ?? "");
    if (!session) return sendJson(res, 404, { ok: false, error: "Conversa não encontrada." });
    const action = rest.slice(1).join("/");
    if (action === "" && method === "GET") return sendJson(res, 200, await publicConversation(session));
    if (action === "" && method === "PATCH")
      return sendJson(res, 200, await publicConversation(await updateConversation(session, await readBody(req))));
    if (method !== "POST") return notFound(res);
    const body = ((await readBody(req).catch(() => undefined)) ?? {}) as Record<string, unknown>;
    if (action === "archive" || action === "unarchive")
      return sendJson(res, 200, await publicConversation(await archiveConversation(session, action === "archive")));
    if (action === "read" || action === "unread") {
      if (session.meta.kind === "thread") {
        if (action === "read") await markThreadRead(bot.id);
        else await markThreadUnread(bot.id);
        return sendJson(res, 200, await publicConversation(session));
      }
      return sendJson(res, 200, await publicConversation(await markConversation(session, action === "read")));
    }
    if (action === "move") {
      const moved = await moveConversation(session, body.botId);
      return sendJson(res, 200, {
        ...(await publicConversation(moved)),
        sessionBasePath: `/bots/${moved.meta.botId}/eve/v1`,
      });
    }
    return notFound(res);
  } catch (error) {
    if (error instanceof ConversationError)
      return sendJson(res, error.status, { ok: false, code: error.code, error: error.message });
    return validationResponse(res, error);
  }
}
