import { httpText, notFound, type Req, type Res, readBody, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { CanvasError, layoutPreview, readCanvasDoc, saveUserCanvas } from "../../canvas/services/canvas.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import { artifactsText } from "../constants/artifacts-messages.constants";
import {
  artifactCsp,
  listArtifacts,
  publicArtifact,
  readArtifact,
  readArtifactHtml,
} from "../services/artifacts.service";

async function handleArtifacts(res: Res, bot: BotDefinition, path: string[]) {
  if (path.length === 0) return sendJson(res, 200, (await listArtifacts(bot.id)).map(publicArtifact));
  const meta = await readArtifact(bot.id, path[0]);
  if (!meta) return sendJson(res, 404, { ok: false, error: artifactsText("notFound") });
  if (path.length === 1) return sendJson(res, 200, publicArtifact(meta));
  if (meta.kind === "canvas") {
    const latest = meta.versions[meta.versions.length - 1].n;
    const jsonMatch =
      path.length === 2 && path[1] === "doc"
        ? ["", String(latest)]
        : path.length === 3 && path[1] === "v"
          ? /^(\d{1,4})\.json$/.exec(path[2])
          : null;
    if (!jsonMatch) return notFound(res);
    const doc = await readCanvasDoc(bot.id, meta.id, Number(jsonMatch[1]));
    if (!doc) return sendJson(res, 404, { ok: false, error: artifactsText("versionNotFound") });
    return sendJson(res, 200, { ...doc, version: Number(jsonMatch[1]) }, { "cache-control": "no-cache" });
  }
  const match = path.length === 3 && path[1] === "v" ? /^(\d{1,4})\.html$/.exec(path[2]) : null;
  if (!match) return notFound(res);
  const html = await readArtifactHtml(bot.id, meta.id, Number(match[1]));
  if (html === null) return sendJson(res, 404, { ok: false, error: artifactsText("versionNotFound") });
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    "content-security-policy": artifactCsp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-cache",
  });
  res.end(html);
}

async function handleCanvasPut(req: Req, res: Res, bot: BotDefinition, artifactId: string) {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: httpText("invalidJson"), field: "body" });
  }
  try {
    const { meta, event } = await saveUserCanvas(bot.id, artifactId, body);
    const thread = await ensureThread(bot.id);
    getStoredSession(thread.sessionId)?.log.emit({ type: event.type, data: { ...event.data, botId: bot.id } });
    return sendJson(res, 200, publicArtifact(meta));
  } catch (error) {
    if (error instanceof CanvasError) {
      const meta = error.code === "stale" ? await readArtifact(bot.id, artifactId) : null;
      return sendJson(res, error.status, {
        ok: false,
        code: error.code,
        error: error.message,
        ...(meta ? { version: meta.versions[meta.versions.length - 1].n } : {}),
      });
    }
    throw error;
  }
}

export async function handleBotArtifacts(req: Req, res: Res, method: string, bot: BotDefinition, rest: string[]) {
  if (method === "GET") return handleArtifacts(res, bot, rest);
  if (rest.length === 2 && rest[1] === "doc" && method === "PUT") return handleCanvasPut(req, res, bot, rest[0]);
  if (rest.length === 2 && rest[1] === "layout" && method === "POST") {
    try {
      return sendJson(res, 200, layoutPreview(await readBody(req)));
    } catch (error) {
      if (error instanceof CanvasError || error instanceof SyntaxError)
        return sendJson(res, 400, { ok: false, error: error.message });
      throw error;
    }
  }
  notFound(res);
}
