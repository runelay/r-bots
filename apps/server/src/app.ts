import http from "node:http";
import type { Duplex } from "node:stream";
import { handleAccounts, handleAccountsRefresh } from "./modules/accounts/routes/accounts.routes";
import { handleRunnerUpgrade, isRunnerUpgrade } from "./modules/accounts/services/mac-runner.service";
import { handleBots } from "./modules/bots/routes/bots.routes";
import { getBot } from "./modules/bots/services/bots.service";
import { handleDesktopUpgrade, isDesktopUpgrade } from "./modules/browser/services/desktop.service";
import { handleLiveUpgrade, isLiveUpgrade } from "./modules/browser/services/live-view.service";
import { handleCodeRoute, handlePreview, handlePreviewUpgrade } from "./modules/code/routes/code.routes";
import { botIsCoding } from "./modules/code/services/bot-code.service";
import { handleComputerHealth } from "./modules/computer/routes/computer.routes";
import { handleConnections, handleConnectorActions } from "./modules/connectors/routes/connectors.routes";
import { handleMcp } from "./modules/engine/routes/mcp.routes";
import { handleGroups } from "./modules/groups/routes/groups.routes";
import { handleSections } from "./modules/sections/routes/sections.routes";
import { handleSkills } from "./modules/skills/routes/skills.routes";
import { handleHealth, handleMeta, handleStatus, handleStatusStream } from "./modules/status/routes/status.routes";
import { handleUsageRoute } from "./modules/usage/routes/usage.routes";
import { handleVaultRoute } from "./modules/vault/routes/vault.routes";
import { handleVoices } from "./modules/voice/routes/voice.routes";
import { notFound, type Req, type Res, sendJson } from "./shared/http";

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
  if (method === "GET" && url.pathname === "/accounts") return handleAccounts(res, url);
  if (method === "POST" && url.pathname === "/accounts/refresh") return handleAccountsRefresh(req, res);
  if (method === "GET" && parts[0] === "usage") return handleUsageRoute(res, url);
  if (method === "GET" && url.pathname === "/voice/voices") return handleVoices(res, url);
  if (method === "GET" && url.pathname === "/skills") return handleSkills(res, url);
  if (parts[0] === "sections") return handleSections(req, res, method, parts);
  if (parts[0] === "groups") return handleGroups(req, res, url, method, parts);
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

async function upgrade(req: Req, socket: Duplex, head: Buffer) {
  const url = new URL(req.url ?? "/", "http://gateway.local");
  if (isRunnerUpgrade(url.pathname)) return handleRunnerUpgrade(req, socket, head);
  if (handlePreviewUpgrade(req, socket, head)) return;
  const botId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
  const bot = getBot(botId);
  if (bot?.capabilities.desktop && isDesktopUpgrade(url.pathname))
    return handleDesktopUpgrade(req, socket, head, botId);
  const browserAllowed = bot ? bot.capabilities.browser || (await botIsCoding(bot.id).catch(() => false)) : false;
  if (!isLiveUpgrade(url.pathname) || !bot || !browserAllowed) {
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  handleLiveUpgrade(req, socket, head, botId);
}

export function createServer() {
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      else res.end();
    });
  });
  server.on("upgrade", upgrade);
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}
