import type { Server } from "bun";
import { handleAccounts, handleAccountsRefresh } from "./modules/accounts/routes/accounts.routes";
import { isRunnerUpgrade, runnerSocket, runnerUpgradeData } from "./modules/accounts/services/mac-runner.service";
import { gate } from "./modules/auth/gate";
import { handleBots } from "./modules/bots/routes/bots.routes";
import { getBot } from "./modules/bots/services/bots.service";
import { desktopSocket, isDesktopUpgrade } from "./modules/browser/services/desktop.service";
import { isLiveUpgrade, liveSocket } from "./modules/browser/services/live-view.service";
import {
  handleCodeRoute,
  handlePreview,
  isPreviewTraffic,
  previewSocket,
  previewUpgradeTarget,
} from "./modules/code/routes/code.routes";
import { botIsCoding } from "./modules/code/services/bot-code.service";
import { handleComputerHealth } from "./modules/computer/routes/computer.routes";
import { handleConnections, handleConnectorActions } from "./modules/connectors/routes/connectors.routes";
import { handleDevices } from "./modules/devices/routes/devices.routes";
import { handleMcp } from "./modules/engine/routes/mcp.routes";
import { handleGroups } from "./modules/groups/routes/groups.routes";
import { handleIntegrations } from "./modules/integrations/routes/integrations.routes";
import { handleJobs } from "./modules/jobs/routes/jobs.routes";
import { handleSections } from "./modules/sections/routes/sections.routes";
import { handleSkills } from "./modules/skills/routes/skills.routes";
import { handleHealth, handleMeta, handleStatus, handleStatusStream } from "./modules/status/routes/status.routes";
import { handleUsageRoute } from "./modules/usage/routes/usage.routes";
import { handleVaultRoute } from "./modules/vault/routes/vault.routes";
import { handleVoices } from "./modules/voice/routes/voice.routes";
import { noteClientTimezone } from "./shared/clock";
import { notFound, Req, Res, sendJson } from "./shared/http";
import type { SocketData, SocketHandler } from "./shared/ws";

async function route(req: Req, res: Res) {
  const url = new URL(req.url ?? "/", "http://gateway.local");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  if (handlePreview(req, res, url, parts)) return;
  if (method === "GET" && url.pathname === "/health") return handleHealth(res);
  if (parts[0] === "code") return handleCodeRoute(req, res, url, method, parts);
  if (method === "GET" && url.pathname === "/meta") return handleMeta(res);
  if (parts[0] === "mcp" && parts.length === 3) return handleMcp(req, res, parts[1], parts[2]);
  if (parts[0] === "vault") return handleVaultRoute(req, res, url, method, parts);
  if (parts[0] === "integrations") return handleIntegrations(req, res, method, parts);
  if (method === "GET" && url.pathname === "/accounts") return handleAccounts(res, url);
  if (method === "POST" && url.pathname === "/accounts/refresh") return handleAccountsRefresh(req, res);
  if (parts[0] === "devices") return handleDevices(req, res, method, parts);
  if (method === "GET" && parts[0] === "usage") return handleUsageRoute(res, url);
  if (method === "GET" && url.pathname === "/voice/voices") return handleVoices(res, url);
  if (method === "GET" && url.pathname === "/skills") return handleSkills(res, url);
  if (parts[0] === "sections") return handleSections(req, res, method, parts);
  if (parts[0] === "groups") return handleGroups(req, res, url, method, parts);
  if (parts[0] === "jobs") return handleJobs(req, res, url, method, parts);
  if (method === "GET" && url.pathname === "/status") return handleStatus(res);
  if (method === "GET" && url.pathname === "/status/stream") return handleStatusStream(req, res);
  if (method === "GET" && url.pathname === "/computer/health") return handleComputerHealth(res);
  if (parts[0] === "connectors" && parts.length >= 2 && parts[1] !== "refresh")
    return handleConnectorActions(req, res, url, method, parts);
  if (
    parts[0] === "connectors" &&
    ((parts.length === 1 && method === "GET") || (parts[1] === "refresh" && method === "POST"))
  )
    return handleConnections(req, res, url, method);
  if (parts[0] === "bots") return handleBots(req, res, url, method, parts);
  notFound(res);
}

type Handler = (req: Req, res: Res) => unknown;

function run(request: Request, handler: Handler) {
  const req = new Req(request);
  const res = new Res(request.signal);
  Promise.resolve()
    .then(() => handler(req, res))
    .catch((error) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      else res.end();
    });
  return res.response;
}

const sockets: Record<string, SocketHandler> = {
  runner: runnerSocket,
  live: liveSocket,
  desktop: desktopSocket,
  preview: previewSocket,
};

async function upgrade(request: Request, server: Server<SocketData>) {
  const req = new Req(request);
  const url = new URL(request.url);
  const accept = (data: SocketData, headers?: Record<string, string>) =>
    server.upgrade(request, { data, ...(headers ? { headers } : {}) })
      ? undefined
      : new Response("Upgrade failed", { status: 400 });
  if (isRunnerUpgrade(url.pathname)) {
    const data = runnerUpgradeData(req);
    if (!data) return new Response(null, { status: 401 });
    return accept(data);
  }
  const preview = previewUpgradeTarget(req);
  if (preview) {
    const protocol = preview.protocols[0];
    return accept({ kind: "preview", ...preview }, protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined);
  }
  const botId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
  const bot = getBot(botId);
  if (bot?.capabilities.desktop && isDesktopUpgrade(url.pathname)) return accept({ kind: "desktop", botId });
  const browserAllowed = bot ? bot.capabilities.browser || (await botIsCoding(bot.id).catch(() => false)) : false;
  if (!isLiveUpgrade(url.pathname) || !bot || !browserAllowed) return new Response(null, { status: 404 });
  return accept({ kind: "live", botId });
}

async function guarded(request: Request, next: () => Response | Promise<Response | undefined> | undefined) {
  const blocked = await gate(request, () => isPreviewTraffic(request));
  return blocked ?? next();
}

function getOnly(handler: (res: Res, url: URL) => unknown) {
  return (request: Request) =>
    guarded(request, () =>
      run(request, (req, res) => (req.method === "GET" ? handler(res, new URL(request.url)) : route(req, res))),
    );
}

export function startServer(hostname: string, port: number) {
  return Bun.serve<SocketData>({
    hostname,
    port,
    idleTimeout: 0,
    maxRequestBodySize: 128 * 1024 * 1024,
    routes: {
      "/health": getOnly((res) => handleHealth(res)),
      "/meta": getOnly((res) => handleMeta(res)),
      "/accounts": getOnly((res, url) => handleAccounts(res, url)),
      "/voice/voices": getOnly((res, url) => handleVoices(res, url)),
      "/skills": getOnly((res, url) => handleSkills(res, url)),
      "/computer/health": getOnly((res) => handleComputerHealth(res)),
    },
    fetch(request, server) {
      return guarded(request, () => {
        noteClientTimezone(request.headers.get("x-timezone"));
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return upgrade(request, server);
        return run(request, route);
      });
    },
    websocket: {
      maxPayloadLength: 32 * 1024 * 1024,
      idleTimeout: 960,
      open: (ws) => sockets[ws.data.kind]?.open(ws),
      message: (ws, message) => sockets[ws.data.kind]?.message(ws, message),
      close: (ws, code, reason) => sockets[ws.data.kind]?.close(ws, code, reason),
      pong: (ws) => sockets[ws.data.kind]?.pong?.(ws),
    },
  });
}
