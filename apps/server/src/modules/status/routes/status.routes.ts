import { model } from "../../../config/env";
import { type Req, type Res, sendJson } from "../../../shared/http";
import { accents, capabilityCatalog, efforts } from "../../bots/services/bots.service";
import { onConversation } from "../../conversations/services/conversations.service";
import { botStatuses, onStatus, sessionStatuses } from "../../engine/services/engine.service";
import { slotStats } from "../../engine/services/turn-slots.service";
import { integrationFlags } from "../../integrations/services/integrations.service";
import { warmVoiceLayers } from "../../voice/services/voice.service";
import { appWatching, watchApp } from "../services/viewers.service";

export function handleHealth(res: Res) {
  return sendJson(res, 200, { ok: true });
}

export function handleMeta(res: Res) {
  return sendJson(res, 200, {
    accents,
    capabilities: capabilityCatalog,
    engine: "multi-provider",
    model,
    efforts,
    integrations: integrationFlags(),
  });
}

export function handleStatus(res: Res) {
  return sendJson(res, 200, {
    bots: botStatuses(),
    turns: slotStats(),
    warmVoice: warmVoiceLayers(),
    appWatching: appWatching(),
  });
}

export function handleStatusStream(req: Req, res: Res) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  res.write(`${JSON.stringify({ type: "snapshot", bots: botStatuses(), sessions: sessionStatuses() })}\n`);
  const unsubscribe = onStatus((event) =>
    res.write(`${JSON.stringify({ type: event.sessionId ? "session" : "status", ...event })}\n`),
  );
  const unsubscribeConversations = onConversation((event) =>
    res.write(`${JSON.stringify({ type: "conversation", ...event })}\n`),
  );
  const heartbeat = setInterval(() => res.write(`${JSON.stringify({ type: "heartbeat" })}\n`), 15_000);
  const unwatch = watchApp();
  const close = () => {
    unwatch();
    unsubscribe();
    unsubscribeConversations();
    clearInterval(heartbeat);
  };
  res.on("close", close);
  req.on("close", close);
}
