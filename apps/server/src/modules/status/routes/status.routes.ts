import { model } from "../../../config/env";
import { type Req, type Res, sendJson } from "../../../shared/http";
import { accents, capabilityCatalog, efforts } from "../../bots/services/bots.service";
import { listServers, onServerChange } from "../../code/services/dev-server.service";
import { onConversation } from "../../conversations/services/conversations.service";
import { botStatuses, onStatus, sessionStatuses } from "../../engine/services/engine.service";
import { turnStats } from "../../engine/services/turn-queue.service";
import { integrationFlags } from "../../integrations/services/integrations.service";
import { laneCounts } from "../../jobs/services/jobs.service";
import { onPreferences } from "../../settings/services/preferences.service";
import { onSettingsChange } from "../../settings/services/settings-events.service";
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

async function jobTotals() {
  const counts = await laneCounts();
  if (!counts) return null;
  const all = Object.values(counts);
  return {
    running: all.reduce((sum, item) => sum + item.running, 0),
    queued: all.reduce((sum, item) => sum + item.queued + item.delayed, 0),
    failed: all.reduce((sum, item) => sum + item.failed, 0),
    queues: counts,
  };
}

export async function handleStatus(res: Res) {
  return sendJson(res, 200, {
    bots: botStatuses(),
    turns: await turnStats(),
    jobs: await jobTotals(),
    warmVoice: warmVoiceLayers(),
    appWatching: appWatching(),
  });
}

export function handleStatusStream(req: Req, res: Res) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  res.write(
    `${JSON.stringify({ type: "snapshot", bots: botStatuses(), sessions: sessionStatuses(), servers: listServers() })}\n`,
  );
  const unsubscribeServers = onServerChange((server, removed) =>
    res.write(`${JSON.stringify({ type: "server", server, removed })}\n`),
  );
  const unsubscribe = onStatus((event) =>
    res.write(`${JSON.stringify({ type: event.sessionId ? "session" : "status", ...event })}\n`),
  );
  const unsubscribeConversations = onConversation((event) =>
    res.write(`${JSON.stringify({ type: "conversation", ...event })}\n`),
  );
  const unsubscribeSettings = onSettingsChange((areas) =>
    res.write(`${JSON.stringify({ type: "settings", areas })}\n`),
  );
  const unsubscribePreferences = onPreferences((preferences) =>
    res.write(`${JSON.stringify({ type: "preferences", preferences })}\n`),
  );
  const heartbeat = setInterval(() => res.write(`${JSON.stringify({ type: "heartbeat" })}\n`), 15_000);
  const unwatch = watchApp();
  const close = () => {
    unwatch();
    unsubscribe();
    unsubscribeConversations();
    unsubscribeServers();
    unsubscribeSettings();
    unsubscribePreferences();
    clearInterval(heartbeat);
  };
  res.on("close", close);
  req.on("close", close);
}
