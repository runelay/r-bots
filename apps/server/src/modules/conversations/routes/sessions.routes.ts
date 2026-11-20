import { randomUUID } from "node:crypto";
import { model } from "../../../config/env";
import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { answer, answerQuestion, cancel, deliver } from "../../engine/services/engine.service";
import { isQuestionAnswer } from "../../questions/services/questions.service";
import { lineOf } from "../repositories/sessions.repository";
import { createStoredSession, getStoredSession, type StoredSession, sessionsOf } from "../services/sessions.service";
import { peekThread } from "../services/threads.service";
import {
  accepted,
  checkFields,
  deliveryText,
  rejectInactiveBot,
  resolveAttachments,
  resolveSkills,
} from "./delivery-input";

function sessionNotActive(res: Res) {
  sendJson(res, 409, { ok: false, code: "session_not_active", error: "The session is no longer active." });
}

export async function handleSessions(res: Res, bot: BotDefinition) {
  const thread = await peekThread(bot.id);
  const entries = sessionsOf(bot.id)
    .filter(
      (session) =>
        session.meta.sessionId === thread?.sessionId || (session.meta.kind !== "thread" && session.meta.turnCount > 0),
    )
    .map((session) => ({
      sessionId: session.meta.sessionId,
      title: session.meta.kind === "thread" ? "Conversa principal" : session.meta.title,
      startedAt: session.meta.startedAt,
      source: session.meta.source,
      ...(session.meta.scheduleId ? { scheduleId: session.meta.scheduleId } : {}),
      thread: session.meta.sessionId === thread?.sessionId,
    }))
    .sort((a, b) => Number(b.thread) - Number(a.thread) || b.startedAt.localeCompare(a.startedAt));
  sendJson(res, 200, entries);
}

async function handleSessionPost(req: Req, res: Res, bot: BotDefinition, session: StoredSession) {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
  }
  const problem = checkFields(body);
  if (problem) return sendJson(res, 400, { ok: false, error: problem });
  const raw = (body ?? {}) as { message?: string; answers?: Array<{ interactionId?: string; optionId?: string }> };
  const deliveryId = randomUUID();
  if (raw.answers && raw.answers.length > 0) {
    let applied = 0;
    for (const item of raw.answers) {
      if (isQuestionAnswer(item)) {
        try {
          if (item.interactionId && answerQuestion(session, deliveryId, item.interactionId, item)) applied++;
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return sendJson(res, 400, { ok: false, error: error.message, field: error.field });
        }
        continue;
      }
      const optionId =
        item.optionId === "approve" || item.optionId === "deny" || item.optionId === "approve_always"
          ? item.optionId
          : null;
      if (!item.interactionId || !optionId) {
        return sendJson(res, 400, {
          ok: false,
          error: "Each answer needs interactionId and optionId 'approve', 'approve_always' or 'deny'.",
        });
      }
      if (answer(session, deliveryId, item.interactionId, optionId)) applied++;
    }
    if (applied === 0) {
      return sendJson(res, 409, {
        ok: false,
        code: "interaction_not_pending",
        error: "Essa aprovação ou pergunta não está mais pendente.",
      });
    }
  }
  const skills = await resolveSkills(res, body);
  if (!skills) return;
  const attachments = await resolveAttachments(res, bot, body);
  if (!attachments) return;
  if (raw.message?.trim() || skills.length > 0 || attachments.length > 0) {
    if (rejectInactiveBot(res, bot)) return;
    await deliver(session, {
      deliveryId,
      text: deliveryText(raw.message, skills),
      source: "chat",
      ...(skills.length ? { skills } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  }
  accepted(res, session, deliveryId);
}

async function handleStream(req: Req, res: Res, url: URL, session: StoredSession) {
  const startIndex = Math.max(0, Number(url.searchParams.get("startIndex") ?? 0) || 0);
  const follow = url.searchParams.get("follow") !== "false" && url.searchParams.get("includeTailIndex") !== "1";
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-eve-stream-version": "27",
    "x-eve-session-id": session.meta.sessionId,
  });
  const chunk = 500;
  const end = session.log.size;
  const replay = async () => {
    for (let index = startIndex; index < end; index += chunk)
      for (const line of await session.log.slice(index, Math.min(end, index + chunk))) res.write(`${line}\n`);
  };
  if (!follow) {
    await replay();
    res.end();
    return;
  }
  const pending: string[] = [];
  let live = false;
  const unsubscribe = session.log.subscribe((line) => (live ? res.write(`${line}\n`) : pending.push(line)));
  await replay();
  for (const line of pending) res.write(`${line}\n`);
  live = true;
  const heartbeat = setInterval(() => res.write(`${JSON.stringify({ $eve: "heartbeat" })}\n`), 15_000);
  const lease = setTimeout(() => {
    res.write(`${JSON.stringify({ $eve: "stream.lease-ended" })}\n`);
    res.end();
  }, 5 * 60_000);
  const close = () => {
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(lease);
  };
  res.on("close", close);
  req.on("close", close);
}

async function handleEvents(res: Res, url: URL, session: StoredSession) {
  const total = session.log.size;
  const limitRaw = Number(url.searchParams.get("limit") ?? 60);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 60));
  const beforeParam = url.searchParams.get("before");
  const beforeRaw = beforeParam === null || beforeParam === "" ? total : Number(beforeParam);
  if (!Number.isFinite(beforeRaw) || beforeRaw < 0)
    return sendJson(res, 400, { ok: false, error: "before inválido.", field: "before" });
  const end = Math.min(total, Math.floor(beforeRaw));
  const start = Math.max(0, end - limit);
  const events = [];
  for (const row of await session.log.rows(start, end)) {
    try {
      events.push({ index: row.seq - 1, ...(JSON.parse(lineOf(row)) as Record<string, unknown>) });
    } catch {}
  }
  sendJson(res, 200, { events, nextBefore: start > 0 ? start : null, total });
}

export async function handleEve(req: Req, res: Res, url: URL, bot: BotDefinition, rest: string[]) {
  if (rest[0] !== "v1" || rest[1] !== "session") return notFound(res);
  const sessionId = rest[2];
  if (!sessionId) {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
    }
    const problem = checkFields(body);
    if (problem) return sendJson(res, 400, { ok: false, error: problem });
    if (rejectInactiveBot(res, bot)) return;
    const message = (body as { message?: string } | undefined)?.message;
    const skills = await resolveSkills(res, body);
    if (!skills) return;
    const attachments = await resolveAttachments(res, bot, body);
    if (!attachments) return;
    const session = await createStoredSession({ botId: bot.id, kind: "session", source: "chat", title: "" });
    session.log.emit({
      type: "session.started",
      data: { runtime: { agentId: bot.id, agentName: bot.id, engine: "claude-agent-sdk", model } },
    });
    const deliveryId = randomUUID();
    if (message?.trim() || skills.length > 0 || attachments.length > 0)
      await deliver(session, {
        deliveryId,
        text: deliveryText(message, skills),
        source: "chat",
        ...(skills.length ? { skills } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
    return accepted(res, session, deliveryId);
  }
  const session = getStoredSession(sessionId);
  if (!session || session.meta.botId !== bot.id) return sessionNotActive(res);
  const action = rest[3] ?? "";
  if (action === "" && req.method === "POST") return handleSessionPost(req, res, bot, session);
  if (action === "stream" && req.method === "GET") return handleStream(req, res, url, session);
  if (action === "events" && req.method === "GET") return handleEvents(res, url, session);
  if (action === "cancel" && req.method === "POST") {
    await readBody(req).catch(() => undefined);
    cancel(session);
    return accepted(res, session, randomUUID());
  }
  notFound(res);
}
