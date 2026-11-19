import { type Req, type Res, sendJson } from "../../../shared/http";
import { type Socket, type SocketHandler, socketOpen } from "../../../shared/ws";
import type { BotDefinition } from "../../bots/services/bots.service";
import { type Fact, getStoredSession, type StoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import { isBusy, isRunning } from "../../engine/services/engine.service";
import { listGrants, listWorktrees, removeGrant, touchWorktree } from "../repositories/code.repository";
import { closeTaskWorkspace, deliverWorkspace, openTaskWorkspace } from "../services/actions.service";
import { devServersOf, findPreviewByToken, previewTarget, stopDevServers } from "../services/dev-server.service";
import { finishWorkspace, kickPr, refreshPr, reopenPr } from "../services/pull-request.service";
import {
  activeWorkspace,
  allDiffs,
  CodeError,
  changedFiles,
  codeSummary,
  fileDiff,
  listRepos,
  publicWorkspace,
  restoreCheckpoint,
  revertFile,
  type WorkspaceState,
} from "../services/workspace.service";

async function readBody(req: Req) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as Record<string, unknown>;
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodeError("Corpo inválido.");
  return value as Record<string, unknown>;
}

function fail(res: Res, error: unknown) {
  if (error instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "JSON inválido." });
  if (error instanceof CodeError) return sendJson(res, error.status, { ok: false, error: error.message });
  return sendJson(res, 500, {
    ok: false,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
  });
}

export async function handleCodeRoute(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  try {
    if (parts[1] === "repos" && method === "GET") {
      const repos = await listRepos(url.searchParams.get("refresh") === "1");
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      return sendJson(res, 200, query ? repos.filter((repo) => repo.name.toLowerCase().includes(query)) : repos);
    }
    if (parts[1] === "grants" && method === "GET") return sendJson(res, 200, await listGrants());
    if (parts[1] === "grants" && method === "DELETE") {
      const body = await readBody(req);
      const removed = await removeGrant(String(body.repo ?? ""), String(body.key ?? ""));
      return removed
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { ok: false, error: "Essa permissão não existe." });
    }
    if (parts[1] === "worktrees" && method === "GET") return sendJson(res, 200, await listWorktrees());
    return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    return fail(res, error);
  }
}

async function sessionFor(bot: BotDefinition, url: URL) {
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) {
    const session = getStoredSession(sessionId);
    if (!session || session.meta.botId !== bot.id) throw new CodeError("Conversa não encontrada.", 404);
    return session;
  }
  const thread = await ensureThread(bot.id);
  const session = getStoredSession(thread.sessionId);
  if (!session) throw new CodeError("Conversa não encontrada.", 404);
  return session;
}

function requireWorkspace(session: StoredSession) {
  const workspace = activeWorkspace(session);
  if (!workspace) throw new CodeError("Esta conversa não tem repositório aberto.", 404);
  return workspace;
}

async function codeState(session: StoredSession) {
  const workspace = activeWorkspace(session);
  if (!workspace)
    return {
      workspace: null,
      files: [],
      servers: [],
      checkpoints: checkpointsOf(session, null),
      running: isRunning(session.meta.sessionId),
    };
  const files = await changedFiles(workspace).catch(() => []);
  return {
    workspace: {
      ...publicWorkspace(workspace),
      files: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    },
    files,
    servers: devServersOf(workspace),
    checkpoints: checkpointsOf(session, workspace),
    running: isRunning(session.meta.sessionId),
  };
}

function clipLabel(text: string) {
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function duration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function attachmentLabel(attachments: Array<{ kind?: string; name?: string; duration?: number }>) {
  const first = attachments[0];
  if (!first) return null;
  const extra = attachments.length > 1 ? ` e mais ${attachments.length - 1}` : "";
  if (first.kind === "audio")
    return `Áudio${typeof first.duration === "number" ? ` de ${duration(first.duration)}` : ""}${extra}`;
  if (first.kind === "video")
    return `Vídeo${typeof first.duration === "number" ? ` de ${duration(first.duration)}` : ""}${extra}`;
  if (first.kind === "image") return `${attachments.length > 1 ? `${attachments.length} imagens` : "Imagem"}`;
  return `${first.name ?? "Arquivo"}${extra}`;
}

function requestLabel(data: Record<string, unknown>) {
  const parts = (data.parts as Array<{ text?: string }> | undefined) ?? [];
  const text = parts
    .map((part) => part.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const attachments =
    (data.attachments as Array<{ kind?: string; name?: string; duration?: number }> | undefined) ?? [];
  const body = text || attachmentLabel(attachments);
  const from = (data.from as { name?: string } | undefined)?.name;
  if (data.source === "delegate" || from) return body ? clipLabel(`${from ?? "Outro bot"} pediu: ${body}`) : null;
  if (data.source === "schedule") return clipLabel(`Rotina: ${body ?? String(data.scheduleId ?? "")}`.trim());
  return body ? clipLabel(body) : null;
}

function turnRequests(session: StoredSession) {
  const requests = new Map<string, string>();
  for (const line of session.log.lines) {
    try {
      for (const fact of JSON.parse(line).facts as Fact[]) {
        if (fact.type !== "delivery.consumed" || !fact.scope?.turnId || requests.has(fact.scope.turnId)) continue;
        const label = requestLabel(fact.data);
        if (label) requests.set(fact.scope.turnId, label);
      }
    } catch {}
  }
  return requests;
}

function checkpointsOf(session: StoredSession, workspace: WorkspaceState | null) {
  const reverted = new Set(session.meta.revertedTurns ?? []);
  const requests = turnRequests(session);
  return (session.meta.checkpoints ?? [])
    .filter((item) => (!workspace || item.workspaceId === workspace.id) && !reverted.has(item.turnId))
    .map((item) => ({
      turnId: item.turnId,
      at: item.at,
      workspaceId: item.workspaceId,
      request: requests.get(item.turnId) ?? null,
    }));
}

function turnNumber(turnId: string) {
  const match = turnId.match(/^turn_(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function turnsFrom(session: StoredSession, first: number) {
  const ids = new Set<string>();
  for (const line of session.log.lines) {
    try {
      for (const fact of JSON.parse(line).facts as Fact[]) {
        const turnId = fact.scope?.turnId ?? (typeof fact.data.turnId === "string" ? fact.data.turnId : null);
        if (turnId && turnNumber(turnId) >= first) ids.add(turnId);
      }
    } catch {}
  }
  return [...ids].sort((a, b) => turnNumber(a) - turnNumber(b));
}

async function rewind(session: StoredSession, turnId: string) {
  const number = turnNumber(turnId);
  if (number < 0) throw new CodeError("Turno inválido.");
  if (isBusy(session.meta.sessionId))
    throw new CodeError("O bot ainda está trabalhando. Pare a resposta antes de desfazer.", 409);
  const workspace = activeWorkspace(session) ?? session.meta.workspace ?? null;
  const reverted = new Set(session.meta.revertedTurns ?? []);
  const checkpoint = (session.meta.checkpoints ?? [])
    .filter(
      (item) =>
        !reverted.has(item.turnId) &&
        (!workspace || item.workspaceId === workspace.id) &&
        turnNumber(item.turnId) >= number,
    )
    .sort((a, b) => turnNumber(a.turnId) - turnNumber(b.turnId))[0];
  let files = { restored: 0, removed: 0 };
  if (checkpoint && workspace) {
    await stopDevServers(workspace);
    files = await restoreCheckpoint(workspace, checkpoint);
  }
  const turnIds = turnsFrom(session, number).filter((id) => !reverted.has(id));
  session.meta.revertedTurns = [...reverted, ...turnIds];
  session.meta.providerSessions = {};
  session.meta.carryOver = null;
  session.meta.pendingNotes = [];
  await session.save();
  session.log.emit({
    type: "turn.reverted",
    data: {
      turnId,
      turnIds,
      files: Boolean(checkpoint && workspace),
      ...files,
      ...(checkpoint ? { checkpoint: checkpoint.ref } : {}),
    },
  });
  return { turnId, turnIds, filesRestored: Boolean(checkpoint && workspace), ...files };
}

export async function handleBotCode(req: Req, res: Res, url: URL, method: string, bot: BotDefinition, rest: string[]) {
  try {
    const tail = rest.join("/");
    const session = await sessionFor(bot, url);
    if (tail === "" && method === "GET") return sendJson(res, 200, await codeState(session));
    if (tail === "workspace" && method === "POST") {
      const body = await readBody(req);
      if (typeof body.repo !== "string" || !body.repo.trim()) throw new CodeError("Diga qual repositório.");
      if (isBusy(session.meta.sessionId))
        throw new CodeError("O bot ainda está trabalhando. Abra o repositório quando ele terminar.", 409);
      const task =
        typeof body.task === "string" && body.task.trim()
          ? body.task
          : `${String(body.repo).split("/").pop()} ${new Date().toISOString().slice(0, 10)}`;
      const { workspace, created } = await openTaskWorkspace(session, bot.id, String(body.repo), task);
      return sendJson(res, created ? 201 : 200, {
        ...(await codeState(session)),
        created,
        workspace: await codeSummary(workspace),
      });
    }
    if (tail === "workspace" && method === "DELETE") {
      if (isBusy(session.meta.sessionId)) throw new CodeError("O bot ainda está trabalhando.", 409);
      const closed = await closeTaskWorkspace(session);
      return closed
        ? sendJson(res, 200, { ok: true, path: closed.path, branch: closed.branch })
        : sendJson(res, 404, { ok: false, error: "Esta conversa não tem repositório aberto." });
    }
    if (tail === "files" && method === "GET")
      return sendJson(res, 200, await changedFiles(requireWorkspace(session), url.searchParams.get("fresh") === "1"));
    if (tail === "diff" && method === "GET") {
      const workspace = requireWorkspace(session);
      const path = url.searchParams.get("path");
      void touchWorktree(workspace.id);
      return sendJson(res, 200, path ? await fileDiff(workspace, path) : await allDiffs(workspace));
    }
    if (tail === "revert" && method === "POST") {
      const workspace = requireWorkspace(session);
      const body = await readBody(req);
      const path = await revertFile(workspace, String(body.path ?? ""));
      session.log.emit({ type: "code.reverted", data: { workspaceId: workspace.id, path, by: "user" } });
      return sendJson(res, 200, { ok: true, path });
    }
    if (tail === "rewind" && method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 200, await rewind(session, String(body.turnId ?? "")));
    }
    if (tail === "deliver" && method === "POST") {
      const workspace = requireWorkspace(session);
      if (isBusy(session.meta.sessionId)) throw new CodeError("O bot ainda está trabalhando.", 409);
      const body = await readBody(req);
      const action =
        body.action === "pr" ? "pr" : body.action === "push" ? "push" : body.action === "commit" ? "commit" : null;
      if (!action) throw new CodeError("action precisa ser commit, push ou pr.");
      const result = await deliverWorkspace(workspace, {
        action,
        message: String(body.message ?? ""),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.body === "string" ? { body: body.body } : {}),
      });
      session.log.emit({ type: "code.delivered", data: { workspaceId: workspace.id, by: "user", ...result } });
      if (result.prUrl) kickPr(session, result.prUrl);
      return sendJson(res, 200, result);
    }
    if (tail === "finish" && method === "POST") return sendJson(res, 200, await finishWorkspace(session, "user"));
    if (tail === "pr" && method === "GET") {
      requireWorkspace(session);
      return sendJson(res, 200, {
        pr: url.searchParams.get("refresh") === "1" ? await refreshPr(session) : (activeWorkspace(session)?.pr ?? null),
      });
    }
    if (tail === "pr/reopen" && method === "POST") return sendJson(res, 200, { pr: await reopenPr(session) });
    if (tail === "servers" && method === "GET") return sendJson(res, 200, devServersOf(requireWorkspace(session)));
    if (tail === "servers/stop" && method === "POST") {
      const body = await readBody(req);
      const stopped = await stopDevServers(
        requireWorkspace(session),
        typeof body.port === "number" ? body.port : undefined,
      );
      return sendJson(res, 200, { ok: true, stopped: stopped.map((item) => item.port) });
    }
    return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    return fail(res, error);
  }
}

const apiPrefixes = new Set([
  "health",
  "meta",
  "mcp",
  "accounts",
  "voice",
  "skills",
  "sections",
  "groups",
  "computer",
  "connectors",
  "bots",
  "code",
  "preview",
  "api",
  "auth",
  "device",
]);
const cookieName = "rb_preview";

function previewCookie(req: Req) {
  const header = req.headers.cookie ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${cookieName}=([\\w-]+)`));
  return match ? findPreviewByToken(match[1]) : null;
}

function proxy(req: Req, res: Res, port: number, path: string) {
  const headers = new Headers(req.raw.headers);
  headers.set("host", `localhost:${port}`);
  headers.set("accept-encoding", "identity");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  fetch(`http://localhost:${port}${path}`, {
    method: req.method,
    headers,
    body: hasBody ? req.raw.body : undefined,
    redirect: "manual",
  })
    .then((answer) => res.respond(answer))
    .catch((error: Error) => {
      if (!res.headersSent)
        sendJson(res, 502, { ok: false, error: `O servidor de desenvolvimento não respondeu: ${error.message}` });
      else res.end();
    });
}

export function isPreviewTraffic(request: Request) {
  const first = new URL(request.url).pathname.split("/").filter(Boolean)[0] ?? "";
  if (first === "preview") return true;
  if (apiPrefixes.has(first)) return false;
  const match = (request.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${cookieName}=([\\w-]+)`));
  return match ? findPreviewByToken(match[1]) !== null : false;
}

export function handlePreview(req: Req, res: Res, url: URL, parts: string[]) {
  if (parts[0] === "preview") {
    const port = Number(parts[2]);
    const target = parts[1] && Number.isInteger(port) ? previewTarget(parts[1], port) : null;
    if (!target || url.searchParams.get("t") !== target.token) {
      sendJson(res, 403, { ok: false, error: "Prévia indisponível: o servidor parou ou o link venceu." });
      return true;
    }
    const rest = `/${parts.slice(3).join("/")}`;
    res.writeHead(302, {
      location: rest,
      "set-cookie": `${cookieName}=${target.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
      "cache-control": "no-store",
    });
    res.end();
    return true;
  }
  if (apiPrefixes.has(parts[0] ?? "")) return false;
  const target = previewCookie(req);
  if (!target) return false;
  proxy(req, res, target.port, req.url ?? "/");
  return true;
}

export function previewUpgradeTarget(req: Req) {
  const url = new URL(req.url ?? "/", "http://gateway.local");
  const first = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (apiPrefixes.has(first)) return null;
  const target = previewCookie(req);
  if (!target) return null;
  const protocols = (req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return { port: target.port, path: req.url ?? "/", protocols };
}

type PreviewRelay = { upstream: WebSocket; queue: Array<string | Buffer> };
const previewRelays = new WeakMap<Socket, PreviewRelay>();

export const previewSocket: SocketHandler = {
  open(client) {
    const protocols = (client.data.protocols as string[] | undefined) ?? [];
    const upstream = new WebSocket(
      `ws://localhost:${client.data.port}${client.data.path}`,
      protocols.length > 0 ? protocols : undefined,
    );
    upstream.binaryType = "arraybuffer";
    const relay: PreviewRelay = { upstream, queue: [] };
    previewRelays.set(client, relay);
    upstream.addEventListener("open", () => {
      for (const message of relay.queue) upstream.send(message);
      relay.queue = [];
    });
    upstream.addEventListener("message", (event) => {
      if (client.readyState !== socketOpen) return;
      client.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
    });
    upstream.addEventListener("close", () => client.close());
    upstream.addEventListener("error", () => client.close());
  },
  message(client, message) {
    const relay = previewRelays.get(client);
    if (!relay) return;
    if (relay.upstream.readyState === WebSocket.OPEN) relay.upstream.send(message);
    else relay.queue.push(message);
  },
  close(client) {
    const relay = previewRelays.get(client);
    previewRelays.delete(client);
    if (relay && relay.upstream.readyState <= WebSocket.OPEN) relay.upstream.close();
  },
};
