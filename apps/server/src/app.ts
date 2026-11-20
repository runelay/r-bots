import type { Server } from "bun";
import { handleAccounts, handleAccountsRefresh } from "./modules/accounts/routes/accounts.routes";
import { isRunnerUpgrade, runnerSocket, runnerUpgradeData } from "./modules/accounts/services/mac-runner.service";
import { gate, isLocalExec, principalOf, requestAllowed } from "./modules/auth/gate";
import { unauthorized } from "./modules/auth/services/auth.middleware";
import { avatarMaxBytes } from "./modules/auth/services/avatar.service";
import { handleBots } from "./modules/bots/routes/bots.routes";
import { getBot } from "./modules/bots/services/bots.service";
import { desktopSocket, isDesktopUpgrade } from "./modules/browser/services/desktop.service";
import { isLiveUpgrade, liveSocket } from "./modules/browser/services/live-view.service";
import { handleCodeRoute } from "./modules/code/routes/code.routes";
import {
  handlePreview,
  isPreviewTraffic,
  onPreviewHost,
  previewSocket,
  previewUpgradeTarget,
} from "./modules/code/routes/preview.routes";
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
import {
  buildRequestContext,
  internalError,
  notFound,
  Req,
  Res,
  requestContext,
  setRequestContext,
  withSecurityHeaders,
} from "./shared/http";
import type { SocketData, SocketHandler } from "./shared/ws";

type RouteHandler = (req: Req, res: Res, url: URL, method: string, parts: string[]) => unknown;

interface RouteEntry {
  root: string;
  match?: (method: string, parts: string[]) => boolean;
  handle: RouteHandler;
}

const exactly =
  (expected: string, ...path: string[]) =>
  (method: string, parts: string[]) =>
    method === expected && parts.length === path.length + 1 && path.every((part, index) => parts[index + 1] === part);

export const routeTable: RouteEntry[] = [
  { root: "health", match: exactly("GET"), handle: (_req, res) => handleHealth(res) },
  { root: "code", handle: (req, res, url, method, parts) => handleCodeRoute(req, res, url, method, parts) },
  { root: "meta", match: exactly("GET"), handle: (_req, res) => handleMeta(res) },
  {
    root: "mcp",
    match: (_method, parts) => parts.length === 3,
    handle: (req, res, _url, _method, parts) => handleMcp(req, res, parts[1], parts[2]),
  },
  { root: "vault", handle: (req, res, url, method, parts) => handleVaultRoute(req, res, url, method, parts) },
  { root: "integrations", handle: (req, res, _url, method, parts) => handleIntegrations(req, res, method, parts) },
  { root: "accounts", match: exactly("GET"), handle: (_req, res, url) => handleAccounts(res, url) },
  { root: "accounts", match: exactly("POST", "refresh"), handle: (req, res) => handleAccountsRefresh(req, res) },
  { root: "devices", handle: (req, res, _url, method, parts) => handleDevices(req, res, method, parts) },
  { root: "usage", match: (method) => method === "GET", handle: (_req, res, url) => handleUsageRoute(res, url) },
  { root: "voice", match: exactly("GET", "voices"), handle: (_req, res, url) => handleVoices(res, url) },
  { root: "skills", match: exactly("GET"), handle: (_req, res, url) => handleSkills(res, url) },
  { root: "sections", handle: (req, res, _url, method, parts) => handleSections(req, res, method, parts) },
  { root: "groups", handle: (req, res, url, method, parts) => handleGroups(req, res, url, method, parts) },
  { root: "jobs", handle: (req, res, url, method, parts) => handleJobs(req, res, url, method, parts) },
  { root: "status", match: exactly("GET"), handle: (_req, res) => handleStatus(res) },
  { root: "status", match: exactly("GET", "stream"), handle: (req, res) => handleStatusStream(req, res) },
  { root: "computer", match: exactly("GET", "health"), handle: (_req, res) => handleComputerHealth(res) },
  {
    root: "connectors",
    match: (_method, parts) => parts.length >= 2 && parts[1] !== "refresh",
    handle: (req, res, url, method, parts) => handleConnectorActions(req, res, url, method, parts),
  },
  {
    root: "connectors",
    match: (method, parts) => (parts.length === 1 && method === "GET") || (parts[1] === "refresh" && method === "POST"),
    handle: (req, res, url, method) => handleConnections(req, res, url, method),
  },
  { root: "bots", handle: (req, res, url, method, parts) => handleBots(req, res, url, method, parts) },
];

export const apiRoots: ReadonlySet<string> = new Set([
  ...routeTable.map((entry) => entry.root),
  "api",
  "auth",
  "device",
  "runner",
  "preview",
]);

const kb = 1024;
const mb = kb * kb;
const bodyMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const nonRunnerMessageLimit = mb;

export function bodyLimitFor(method: string, parts: string[]) {
  if (!bodyMethods.has(method)) return null;
  const [first, second, third] = parts;
  if (first === "bots" && third === "uploads") return null;
  if (first === "mcp" || first === "voice" || (first === "bots" && third === "voice")) return 32 * mb;
  if (first === "auth" && second === "me" && third === "avatar") return avatarMaxBytes;
  if (first === "api" || (first === "auth" && (second === "setup" || second === "invites"))) return 16 * kb;
  if (first === "bots" || first === "groups") return 4 * mb;
  if (first === "code") return mb;
  return 64 * kb;
}

function failure(status: number, error: string, code: string) {
  return Response.json({ ok: false, error, code }, { status, headers: { "cache-control": "no-store" } });
}

export function checkBody(request: Request, parts: string[]) {
  const limit = bodyLimitFor(request.method, parts);
  if (limit === null) return null;
  const declared = request.headers.get("content-length");
  if (declared === null) {
    if (request.headers.has("transfer-encoding"))
      return failure(411, "Envie o tamanho do corpo (Content-Length).", "length_required");
    return null;
  }
  const size = Number(declared);
  if (!Number.isFinite(size) || size < 0) return failure(400, "Content-Length inválido.", "bad_request");
  if (size > limit) return failure(413, "O corpo da requisição passa do limite desta rota.", "too_large");
  return null;
}

async function route(req: Req, res: Res) {
  const context = requestContext(req.raw);
  const url = new URL(req.url ?? "/", "http://gateway.local");
  const parts = context.parts;
  const method = req.method ?? "GET";
  if (handlePreview(req, res, url, parts, apiRoots)) return;
  if (!requestAllowed(req.raw)) return res.respond(unauthorized());
  for (const entry of routeTable)
    if (entry.root === parts[0] && (entry.match?.(method, parts) ?? true))
      return entry.handle(req, res, url, method, parts);
  notFound(res);
}

type Handler = (req: Req, res: Res) => unknown;

function run(request: Request, handler: Handler) {
  const req = new Req(request);
  const res = new Res(request.signal);
  Promise.resolve()
    .then(() => handler(req, res))
    .catch((error) => internalError(res, error));
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
  const context = requestContext(request);
  const accept = (data: SocketData, headers?: Record<string, string>) =>
    server.upgrade(request, { data, ...(headers ? { headers } : {}) })
      ? undefined
      : new Response("Upgrade failed", { status: 400 });
  if (isRunnerUpgrade(context.pathname)) {
    const data = runnerUpgradeData(req);
    if (!data) return new Response(null, { status: 401 });
    return accept(data);
  }
  const preview = previewUpgradeTarget(req, apiRoots);
  if (preview) {
    const protocol = preview.protocols[0];
    return accept({ kind: "preview", ...preview }, protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined);
  }
  if (!requestAllowed(request)) return new Response(null, { status: 401 });
  const botId = context.parts[1] ?? "";
  const bot = getBot(botId);
  if (bot?.capabilities.desktop && isDesktopUpgrade(context.pathname)) return accept({ kind: "desktop", botId });
  const browserAllowed = bot ? bot.capabilities.browser || (await botIsCoding(bot.id).catch(() => false)) : false;
  if (!isLiveUpgrade(context.pathname) || !bot || !browserAllowed) return new Response(null, { status: 404 });
  return accept({ kind: "live", botId });
}

export async function serve(request: Request, server: Server<SocketData>) {
  const peer = server.requestIP(request)?.address ?? "";
  const context = buildRequestContext(request, peer, Number(server.port));
  if (!context) return withSecurityHeaders(failure(400, "Caminho inválido.", "bad_path"), "/");
  setRequestContext(request, context);
  const preview = isPreviewTraffic(request, apiRoots);
  const finish = (response: Response | undefined) =>
    response && !preview ? withSecurityHeaders(response, context.pathname) : response;
  if (onPreviewHost(request) && !preview) return finish(failure(404, "Rota não encontrada.", "not_found"));
  const tooLarge = preview ? null : checkBody(request, context.parts);
  if (tooLarge) return finish(tooLarge);
  const blocked = await gate(request, { bypass: () => preview });
  if (blocked) return finish(blocked);
  if (principalOf(request) || preview || context.parts[0] === "mcp" || isLocalExec(request)) server.timeout(request, 0);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return finish(await upgrade(request, server));
  return finish(await run(request, route));
}

export function startServer(hostname: string, port: number) {
  return Bun.serve<SocketData>({
    hostname,
    port,
    idleTimeout: 30,
    maxRequestBodySize: 128 * mb,
    fetch: serve,
    websocket: {
      maxPayloadLength: 32 * mb,
      idleTimeout: 960,
      open: (ws) => sockets[ws.data.kind]?.open(ws),
      message: (ws, message) => {
        if (ws.data.kind !== "runner" && message.length > nonRunnerMessageLimit) {
          ws.close(1009, "message too big");
          return;
        }
        sockets[ws.data.kind]?.message(ws, message);
      },
      close: (ws, code, reason) => sockets[ws.data.kind]?.close(ws, code, reason),
      pong: (ws) => sockets[ws.data.kind]?.pong?.(ws),
    },
  });
}
