import { notFound, type Req, type Res, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import {
  armIdle,
  type CallEvent,
  credentials,
  endCall,
  fastModel,
  findCall,
  listVoices,
  onUtterance,
  rateCall,
  startCall,
  type VoiceCall,
  VoiceError,
} from "../services/voice.service";

async function readJson(req: Req) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function handleRating(res: Res, req: Req, bot: BotDefinition, callId: string) {
  const body = await readJson(req);
  const rating = body.rating === "up" || body.rating === "down" || body.rating === null ? body.rating : undefined;
  if (rating === undefined)
    return sendJson(res, 400, { ok: false, error: "Use rating up, down ou null.", field: "rating" });
  if (!(await rateCall(bot, callId, rating)))
    return sendJson(res, 404, { ok: false, code: "call_not_found", error: "Chamada não encontrada." });
  return sendJson(res, 200, { ok: true, callId, rating });
}

function streamCall(req: Req, res: Res, call: VoiceCall) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-voice-call-id": call.id,
  });
  const write = (event: CallEvent) => res.write(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
  write({ type: "call.ready", callId: call.id, sessionId: call.session.meta.sessionId, pending: call.pending });
  call.listeners.add(write);
  armIdle(call);
  const heartbeat = setInterval(() => res.write(`${JSON.stringify({ type: "heartbeat" })}\n`), 15_000);
  const close = () => {
    clearInterval(heartbeat);
    if (call.listeners.delete(write)) armIdle(call);
  };
  res.on("close", close);
  req.on("close", close);
}

export async function handleVoices(res: Res, url: URL) {
  try {
    return sendJson(res, 200, await listVoices(url.searchParams.get("refresh") === "1"));
  } catch (error) {
    if (error instanceof VoiceError) return sendJson(res, error.status, { ok: false, error: error.message });
    return sendJson(res, 502, {
      ok: false,
      error: `ElevenLabs não respondeu: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    });
  }
}

export async function handleVoice(req: Req, res: Res, method: string, bot: BotDefinition, rest: string[]) {
  try {
    if (rest[0] !== "session") return notFound(res);
    if (rest.length === 1 && method === "POST") {
      await readJson(req).catch(() => ({}));
      if (bot.deletedAt) return sendJson(res, 409, { ok: false, code: "bot_deleted", error: "Esse bot foi excluído." });
      if (bot.archivedAt)
        return sendJson(res, 409, { ok: false, code: "bot_archived", error: "Esse bot está arquivado." });
      const [call, creds] = await Promise.all([startCall(bot), credentials(bot, ["stt", "tts"])]);
      return sendJson(res, 201, {
        callId: call.id,
        sessionId: call.session.meta.sessionId,
        streamPath: `/bots/${bot.id}/voice/session/${call.id}/stream`,
        fastModel,
        ...creds,
      });
    }
    if (rest[2] === "rating" && method === "POST") return handleRating(res, req, bot, rest[1] ?? "");
    const call = findCall(rest[1] ?? "");
    if (!call || call.botId !== bot.id)
      return sendJson(res, 404, { ok: false, code: "call_not_found", error: "Essa chamada já terminou." });
    const action = rest[2] ?? "";
    if (action === "stream" && method === "GET") return streamCall(req, res, call);
    if (action === "tokens" && method === "POST") {
      const body = await readJson(req);
      const types: Array<"stt" | "tts"> = Array.isArray(body.types)
        ? (body.types as unknown[]).filter((item): item is "stt" | "tts" => item === "stt" || item === "tts")
        : ["stt", "tts"];
      return sendJson(res, 200, await credentials(bot, types.length > 0 ? types : ["stt", "tts"]));
    }
    if (action === "utterance" && method === "POST") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return sendJson(res, 400, { ok: false, error: "Mande o texto da fala.", field: "text" });
      return sendJson(res, 202, {
        ok: true,
        ...(await onUtterance(call, text.slice(0, 4_000), body.interrupted === true)),
      });
    }
    if (action === "interrupt" && method === "POST") {
      await readJson(req).catch(() => ({}));
      const cut = call.speaking;
      call.fast.cancelAll();
      return sendJson(res, 200, { ok: true, interrupted: cut });
    }
    if (action === "" && method === "DELETE") {
      endCall(call);
      return sendJson(res, 200, { ok: true });
    }
    return notFound(res);
  } catch (error) {
    if (error instanceof VoiceError) return sendJson(res, error.status, { ok: false, error: error.message });
    if (error instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
    throw error;
  }
}
