import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import http from "node:http";
import { basename, join } from "node:path";
import {
  accents,
  type BotDefinition,
  capabilityCatalog,
  decisionsOf,
  clearSection,
  connectorsOf,
  memoryOf,
  efforts,
  engineOf,
  setDeleted,
  sidebarOf,
  updateSidebar,
  createBot,
  getBot,
  listBots,
  loadBots,
  setArchived,
  permissionOfBot,
  updateBot,
  ValidationError,
  voiceOf,
} from "./bots";
import { browserAlive, browserDir, browserHistory, browserOpen, closeIdleBrowsers, fullScreenshot, markBrowserViewed, readBrowserState } from "./browser";
import { controllerOf, setController } from "./control";
import { handleLiveUpgrade, hasLiveClients, isLiveUpgrade, publishLiveState } from "./live";
import { handleDesktopUpgrade, isDesktopUpgrade, stopAllDesktops, stopDesktop } from "./desktop";
import { dataDir, host, model, port } from "./config";
import { listAccounts, refreshAccounts } from "./accounts";
import { getCatalog, installCatalogItem, listConnections, reconnectSource, removeSource, RunelayApiError, runelayEnabled } from "./runelay";
import { listSkills, type LoadedSkill, loadSkill, skillSlugPattern } from "./skills";
import { computerHealth } from "./computer";
import { handleRunnerUpgrade, isRunnerUpgrade } from "./mac-runner";
import { createGroup, getGroup, type Group, listGroups, loadGroups, setGroupArchived, updateGroup } from "./groups";
import { answer, botStatus, botStatuses, cancel, deliver, isBusy, isRunning, onStatus, sessionStatuses } from "./engine";
import { archiveConversation, ConversationError, conversationOf, createConversation, listConversations, markConversation, moveConversation, onConversation, publicConversation, updateConversation } from "./conversations";
import { isPermissionMode } from "./permissions";
import { handleMcp } from "./mcp";
import { installConsoleRedaction } from "./redact";
import { handleVaultRoute, loadVault } from "./vault";
import { handleUsageRoute, warmUsage } from "./usage";
import { botCodeSummary, botIsCoding, handleBotCode, handleCodeRoute, handlePreview, handlePreviewUpgrade, startCodeHousekeeping } from "./code-routes";
import { stopAllDevServers } from "./devserver";
import { artifactCsp, listArtifacts, publicArtifact, readArtifact, readArtifactHtml } from "./artifacts";
import { CanvasError, layoutPreview, readCanvasDoc, saveUserCanvas } from "./canvas";
import { fire, startScheduler } from "./scheduler";
import { createStoredSession, getStoredSession, loadSessions, sessionsOf, type StoredSession } from "./sessions";
import { archiveSection, createSection, listSections, loadSections, publicSection, sectionExists, updateSection } from "./sections";
import { endAllCalls, handleVoice, handleVoices, warmVoiceLayers } from "./voice";
import { activeMarkers, sweepOrphans } from "@runelay-bots/providers/proc-tree";
import { slotStats } from "./turn-slots";
import { settleOrphanTurns } from "./turn-repair";
import { appWatching, watchApp } from "./viewers";
import { publicUpload, receiveUpload, resolveUploads, serveUpload, UploadError, type UploadMeta } from "./uploads";
import { ensureThread, markThreadRead, markThreadUnread, peekThread, publicThread, recordThreadMessage, resetThread, restoreThread } from "./threads";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

type Res = http.ServerResponse;

const acceptedFields = ["inbox", "message", "answers", "clientContext", "outputSchema", "turnPolicy", "callback", "forwardedPrincipal", "idempotencyKey", "skills", "attachments"];

function sendJson(res: Res, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

async function publicBot(bot: BotDefinition) {
  return {
    id: bot.id,
    name: bot.name,
    role: bot.role,
    accent: bot.accent,
    glyph: bot.glyph,
    sessionBasePath: `/bots/${bot.id}/eve/v1`,
    schedules: bot.schedules,
    hasBrowser: bot.capabilities.browser || (await botIsCoding(bot.id).catch(() => false)),
    instructions: bot.instructions,
    capabilities: bot.capabilities,
    engine: engineOf(bot),
    decisions: decisionsOf(bot),
    connectors: connectorsOf(bot),
    memory: memoryOf(bot),
    computer: bot.computer ?? { allowedRoots: ["~/Desktop", "~/Downloads", "~/Documents"] },
    voice: voiceOf(bot),
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    archivedAt: bot.archivedAt,
    deletedAt: bot.deletedAt ?? null,
    sidebar: sidebarOf(bot),
    permission: permissionOfBot(bot),
    conversations: await listConversations(bot.id),
    thread: { ...publicThread(await peekThread(bot.id)), running: botStatus(bot.id) !== "idle", status: botStatus(bot.id) },
    code: await botCodeSummary(bot).catch(() => null),
  };
}

async function postGreeting(bot: BotDefinition) {
  const thread = await ensureThread(bot.id);
  const session = getStoredSession(thread.sessionId);
  if (!session) return;
  const value = `Oi! Eu sou ${bot.name} e acabei de chegar no time. O que você quer que eu faça?`;
  session.log.emit({
    type: "content.completed",
    data: { kind: "text", partId: "greeting.0", phase: "reply", runId: "greeting", value, greeting: true },
    scope: { runId: "greeting" },
  });
  await recordThreadMessage(bot.id, thread.sessionId, { role: "bot", text: value, at: new Date().toISOString() });
}

async function publicGroup(group: Group) {
  const state = await ensureThread(group.id, "group");
  return {
    id: group.id,
    name: group.name,
    members: group.members,
    sessionBasePath: `/groups/${group.id}/eve/v1`,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    archivedAt: group.archivedAt,
    thread: { ...publicThread(state), running: isRunning(state.sessionId) },
  };
}

async function handleGroups(req: http.IncomingMessage, res: Res, url: URL, method: string, parts: string[]) {
  try {
    if (parts.length === 1 && method === "GET") {
      return sendJson(res, 200, await Promise.all(listGroups(url.searchParams.get("archived") === "1").map(publicGroup)));
    }
    if (parts.length === 1 && method === "POST") return sendJson(res, 201, await publicGroup(await createGroup(await readBody(req))));
    const group = getGroup(parts[1] ?? "");
    if (!group) return sendJson(res, 404, { ok: false, error: "Grupo não encontrado." });
    const tail = parts.slice(2).join("/");
    if (parts[2] === "eve") {
      if (parts[4] === "session" && !parts[5]) return sendJson(res, 405, { ok: false, error: "Grupos usam só a conversa do grupo (GET /groups/:id/thread)." });
      const owner = { id: group.id, archivedAt: group.archivedAt, deletedAt: null } as unknown as BotDefinition;
      return handleEve(req, res, url, owner, parts.slice(3));
    }
    if (tail === "" && method === "GET") return sendJson(res, 200, await publicGroup(group));
    if (tail === "" && method === "PATCH") return sendJson(res, 200, await publicGroup((await updateGroup(group.id, await readBody(req)))!));
    if ((tail === "archive" || tail === "unarchive") && method === "POST") {
      await readBody(req).catch(() => undefined);
      return sendJson(res, 200, await publicGroup((await setGroupArchived(group.id, tail === "archive"))!));
    }
    if (tail === "thread" && method === "GET") return sendJson(res, 200, (await publicGroup(group)).thread);
    if (tail === "thread/read" && method === "POST") {
      await readBody(req).catch(() => undefined);
      return sendJson(res, 200, publicThread(await markThreadRead(group.id)));
    }
    if (tail === "thread/unread" && method === "POST") {
      await readBody(req).catch(() => undefined);
      return sendJson(res, 200, publicThread(await markThreadUnread(group.id)));
    }
    return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    return validationResponse(res, error);
  }
}

async function handleConnectorActions(req: http.IncomingMessage, res: Res, url: URL, method: string, parts: string[]) {
  try {
    if (parts.length === 2 && parts[1] === "catalog" && method === "GET") {
      return sendJson(res, 200, await getCatalog((url.searchParams.get("query") ?? "").trim().slice(0, 100)));
    }
    const name = parts[1] ?? "";
    if (!/^[a-z0-9_-]{1,60}$/.test(name)) return sendJson(res, 400, { ok: false, error: "Nome de conector inválido.", field: "name" });
    if (parts.length === 3 && parts[2] === "install" && method === "POST") {
      const body = ((await readBody(req).catch(() => undefined)) ?? {}) as { token?: unknown };
      const connectorToken = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined;
      return sendJson(res, 201, await installCatalogItem(name, connectorToken));
    }
    if (parts.length === 3 && parts[2] === "reconnect" && method === "POST") {
      await readBody(req).catch(() => undefined);
      return sendJson(res, 200, await reconnectSource(name));
    }
    if (parts.length === 2 && method === "DELETE") return sendJson(res, 200, await removeSource(name));
    return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    if (error instanceof RunelayApiError) return sendJson(res, error.status, { ok: false, error: error.message });
    return sendJson(res, 502, { ok: false, error: `runelay não respondeu: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
  }
}

async function handleSections(req: http.IncomingMessage, res: Res, method: string, parts: string[]) {
  try {
    if (parts.length === 1 && method === "GET") return sendJson(res, 200, listSections().map(publicSection));
    if (parts.length === 1 && method === "POST") return sendJson(res, 201, publicSection(await createSection(await readBody(req))));
    const id = parts[1] ?? "";
    if (parts.length === 2 && method === "PATCH") {
      const section = await updateSection(id, await readBody(req));
      return section ? sendJson(res, 200, publicSection(section)) : sendJson(res, 404, { ok: false, error: "Seção não encontrada." });
    }
    if (parts.length === 3 && parts[2] === "archive" && method === "POST") {
      await readBody(req).catch(() => undefined);
      const section = await archiveSection(id);
      if (!section) return sendJson(res, 404, { ok: false, error: "Seção não encontrada." });
      await clearSection(id);
      return sendJson(res, 200, { ...publicSection(section), archivedAt: section.archivedAt });
    }
    return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    return validationResponse(res, error);
  }
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function validationResponse(res: Res, error: unknown) {
  if (error instanceof ValidationError) return sendJson(res, 400, { ok: false, error: error.message, field: error.field });
  if (error instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
  throw error;
}

async function handleBrowser(res: Res, bot: BotDefinition) {
  markBrowserViewed(bot.id);
  const state = await readBrowserState(bot.id);
  if (!state) return sendJson(res, 404, { ok: false, error: "Esse bot ainda não abriu nenhuma página." });
  sendJson(res, 200, { ...state, screenshotPath: `/bots/${bot.id}/browser/latest.png`, controller: controllerOf(bot.id), alive: await browserAlive(bot.id) });
}

async function handleFullScreenshot(res: Res, bot: BotDefinition) {
  if (!(await readBrowserState(bot.id))) return sendJson(res, 404, { ok: false, error: "Nenhum print ainda." });
  try {
    await fullScreenshot(bot.id);
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: `Não consegui tirar o print: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
  }
  return handleScreenshot(res, bot, "full.png");
}

async function handleScreenshot(res: Res, bot: BotDefinition, name = "latest.png") {
  if (name === "latest.png") markBrowserViewed(bot.id);
  const file = join(browserDir(bot.id), name);
  try {
    const info = await stat(file);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(info.size),
      "cache-control": "no-store",
      "last-modified": info.mtime.toUTCString(),
    });
    createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { ok: false, error: "Nenhum print ainda." });
  }
}

async function handleArtifacts(res: Res, bot: BotDefinition, path: string[]) {
  if (path.length === 0) return sendJson(res, 200, (await listArtifacts(bot.id)).map(publicArtifact));
  const meta = await readArtifact(bot.id, path[0]);
  if (!meta) return sendJson(res, 404, { ok: false, error: "Artefato não encontrado." });
  if (path.length === 1) return sendJson(res, 200, publicArtifact(meta));
  if (meta.kind === "canvas") {
    const latest = meta.versions[meta.versions.length - 1].n;
    const jsonMatch = path.length === 2 && path[1] === "doc" ? ["", String(latest)] : path.length === 3 && path[1] === "v" ? /^(\d{1,4})\.json$/.exec(path[2]) : null;
    if (!jsonMatch) return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
    const doc = await readCanvasDoc(bot.id, meta.id, Number(jsonMatch[1]));
    if (!doc) return sendJson(res, 404, { ok: false, error: "Versão não encontrada." });
    return sendJson(res, 200, { ...doc, version: Number(jsonMatch[1]) }, { "cache-control": "no-cache" });
  }
  const match = path.length === 3 && path[1] === "v" ? /^(\d{1,4})\.html$/.exec(path[2]) : null;
  if (!match) return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  const html = await readArtifactHtml(bot.id, meta.id, Number(match[1]));
  if (html === null) return sendJson(res, 404, { ok: false, error: "Versão não encontrada." });
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

async function handleCanvasPut(req: http.IncomingMessage, res: Res, bot: BotDefinition, artifactId: string) {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
  }
  try {
    const { meta, event } = await saveUserCanvas(bot.id, artifactId, body);
    const thread = await ensureThread(bot.id);
    getStoredSession(thread.sessionId)?.log.emit({ type: event.type, data: { ...event.data, botId: bot.id } });
    return sendJson(res, 200, publicArtifact(meta));
  } catch (error) {
    if (error instanceof CanvasError) {
      const meta = error.code === "stale" ? await readArtifact(bot.id, artifactId) : null;
      return sendJson(res, error.status, { ok: false, code: error.code, error: error.message, ...(meta ? { version: meta.versions[meta.versions.length - 1].n } : {}) });
    }
    throw error;
  }
}

async function handleSessions(res: Res, bot: BotDefinition) {
  const thread = await peekThread(bot.id);
  const entries = sessionsOf(bot.id)
    .filter((session) => session.meta.sessionId === thread?.sessionId || (session.meta.kind !== "thread" && session.meta.turnCount > 0))
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

function sessionNotActive(res: Res) {
  sendJson(res, 409, { ok: false, code: "session_not_active", error: "The session is no longer active." });
}

function checkFields(body: unknown) {
  if (body === undefined) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object.";
  for (const key of Object.keys(body)) {
    if (!acceptedFields.includes(key)) return `Unknown field '${key}'. Accepted fields: ${acceptedFields.join(", ")}.`;
  }
  const raw = body as Record<string, unknown>;
  if (raw.message !== undefined && typeof raw.message !== "string") return "Field 'message' must be a string.";
  if (raw.answers !== undefined && !Array.isArray(raw.answers)) return "Field 'answers' must be an array.";
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills) || raw.skills.length > 5) return "Field 'skills' must be an array with up to 5 slugs.";
    if (raw.skills.some((slug) => typeof slug !== "string" || !skillSlugPattern.test(slug))) return "Field 'skills' has an invalid slug.";
  }
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > 10) return "Field 'attachments' must be an array with up to 10 upload ids.";
    if (raw.attachments.some((id) => typeof id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))) return "Field 'attachments' has an invalid upload id.";
  }
  return null;
}

async function resolveSkills(res: Res, body: unknown): Promise<LoadedSkill[] | null> {
  const slugs = [...new Set(((body as { skills?: string[] } | undefined)?.skills ?? []) as string[])];
  if (slugs.length === 0) return [];
  if (!runelayEnabled()) {
    sendJson(res, 503, { ok: false, error: "runelay não está configurado no servidor." });
    return null;
  }
  try {
    return await Promise.all(slugs.map(loadSkill));
  } catch (error) {
    if (error instanceof RunelayApiError && error.status === 404) sendJson(res, 400, { ok: false, error: "Essa skill não existe mais na runelay.", field: "skills" });
    else sendJson(res, 502, { ok: false, error: `runelay não respondeu: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    return null;
  }
}

function deliveryText(message: string | undefined, skills: LoadedSkill[]) {
  if (message && message.trim()) return message;
  return skills.map((skill) => `/${skill.name}`).join(" ");
}

async function handleSkills(res: Res, url: URL) {
  if (!runelayEnabled()) return sendJson(res, 503, { ok: false, error: "runelay não está configurado no servidor." });
  try {
    return sendJson(res, 200, await listSkills(url.searchParams.get("query") ?? "", url.searchParams.get("refresh") === "1"));
  } catch (error) {
    if (error instanceof RunelayApiError) return sendJson(res, error.status, { ok: false, error: error.message });
    return sendJson(res, 502, { ok: false, error: `runelay não respondeu: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
  }
}

async function resolveAttachments(res: Res, bot: BotDefinition, body: unknown): Promise<UploadMeta[] | null> {
  const ids = [...new Set(((body as { attachments?: string[] } | undefined)?.attachments ?? []) as string[])];
  if (ids.length === 0) return [];
  const metas = await resolveUploads(bot.id, ids);
  if (!metas) {
    sendJson(res, 400, { ok: false, error: "Um dos anexos não existe mais. Anexe de novo.", field: "attachments" });
    return null;
  }
  return metas;
}

async function handleUploads(req: http.IncomingMessage, res: Res, method: string, bot: BotDefinition, rest: string[]) {
  if (rest.length === 0 && method === "POST") {
    if (bot.deletedAt) return sendJson(res, 409, { ok: false, code: "bot_deleted", error: "Esse bot foi excluído." });
    try {
      const meta = await receiveUpload(bot.id, req);
      return sendJson(res, 201, publicUpload(bot.id, meta));
    } catch (error) {
      if (error instanceof UploadError) {
        if (!res.headersSent) sendJson(res, error.status, { ok: false, error: error.message }, { connection: "close" });
        req.resume();
        return;
      }
      throw error;
    }
  }
  if ((rest.length === 1 || rest.length === 2) && (method === "GET" || method === "HEAD")) return serveUpload(req, res, bot.id, rest[0], rest[1]);
  sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
}

function accepted(res: Res, session: StoredSession, deliveryId: string) {
  sendJson(res, 202, { ok: true, sessionId: session.meta.sessionId, deliveryId }, { "x-eve-session-id": session.meta.sessionId });
}

async function handleSessionPost(req: http.IncomingMessage, res: Res, bot: BotDefinition, session: StoredSession) {
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
      const optionId = item.optionId === "approve" || item.optionId === "deny" || item.optionId === "approve_always" ? item.optionId : null;
      if (!item.interactionId || !optionId) {
        return sendJson(res, 400, { ok: false, error: "Each answer needs interactionId and optionId 'approve', 'approve_always' or 'deny'." });
      }
      if (answer(session, deliveryId, item.interactionId, optionId)) applied++;
    }
    if (applied === 0) {
      return sendJson(res, 409, { ok: false, code: "interaction_not_pending", error: "Essa aprovação não está mais pendente." });
    }
  }
  const skills = await resolveSkills(res, body);
  if (!skills) return;
  const attachments = await resolveAttachments(res, bot, body);
  if (!attachments) return;
  if ((raw.message && raw.message.trim()) || skills.length > 0 || attachments.length > 0) {
    if (bot.deletedAt) return sendJson(res, 409, { ok: false, code: "bot_deleted", error: "Esse bot foi excluído." });
    if (bot.archivedAt) return sendJson(res, 409, { ok: false, code: "bot_archived", error: "Esse bot está arquivado." });
    deliver(session, { deliveryId, text: deliveryText(raw.message, skills), source: "chat", ...(skills.length ? { skills } : {}), ...(attachments.length ? { attachments } : {}) });
  }
  accepted(res, session, deliveryId);
}

function handleStream(req: http.IncomingMessage, res: Res, url: URL, session: StoredSession) {
  const startIndex = Math.max(0, Number(url.searchParams.get("startIndex") ?? 0) || 0);
  const follow = url.searchParams.get("follow") !== "false" && url.searchParams.get("includeTailIndex") !== "1";
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-eve-stream-version": "27",
    "x-eve-session-id": session.meta.sessionId,
  });
  const lines = session.log.lines;
  for (let index = startIndex; index < lines.length; index++) res.write(`${lines[index]}\n`);
  if (!follow) {
    res.end();
    return;
  }
  const unsubscribe = session.log.subscribe((line) => res.write(`${line}\n`));
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

function handleStatusStream(req: http.IncomingMessage, res: Res) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  res.write(`${JSON.stringify({ type: "snapshot", bots: botStatuses(), sessions: sessionStatuses() })}\n`);
  const unsubscribe = onStatus((event) => res.write(`${JSON.stringify({ type: event.sessionId ? "session" : "status", ...event })}\n`));
  const unsubscribeConversations = onConversation((event) => res.write(`${JSON.stringify({ type: "conversation", ...event })}\n`));
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

function handleEvents(res: Res, url: URL, session: StoredSession) {
  const lines = session.log.lines;
  const total = lines.length;
  const limitRaw = Number(url.searchParams.get("limit") ?? 60);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 60));
  const beforeParam = url.searchParams.get("before");
  const beforeRaw = beforeParam === null || beforeParam === "" ? total : Number(beforeParam);
  if (!Number.isFinite(beforeRaw) || beforeRaw < 0) return sendJson(res, 400, { ok: false, error: "before inválido.", field: "before" });
  const end = Math.min(total, Math.floor(beforeRaw));
  const start = Math.max(0, end - limit);
  const events = [];
  for (let index = start; index < end; index++) {
    try {
      events.push({ index, ...(JSON.parse(lines[index]) as Record<string, unknown>) });
    } catch {}
  }
  sendJson(res, 200, { events, nextBefore: start > 0 ? start : null, total });
}

async function handleEve(req: http.IncomingMessage, res: Res, url: URL, bot: BotDefinition, rest: string[]) {
  if (rest[0] !== "v1" || rest[1] !== "session") return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
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
    if (bot.deletedAt) return sendJson(res, 409, { ok: false, code: "bot_deleted", error: "Esse bot foi excluído." });
    if (bot.archivedAt) return sendJson(res, 409, { ok: false, code: "bot_archived", error: "Esse bot está arquivado." });
    const message = (body as { message?: string } | undefined)?.message;
    const skills = await resolveSkills(res, body);
    if (!skills) return;
    const attachments = await resolveAttachments(res, bot, body);
    if (!attachments) return;
    const session = await createStoredSession({ botId: bot.id, kind: "session", source: "chat", title: "" });
    session.log.emit({ type: "session.started", data: { runtime: { agentId: bot.id, agentName: bot.id, engine: "claude-agent-sdk", model } } });
    const deliveryId = randomUUID();
    if ((message && message.trim()) || skills.length > 0 || attachments.length > 0) deliver(session, { deliveryId, text: deliveryText(message, skills), source: "chat", ...(skills.length ? { skills } : {}), ...(attachments.length ? { attachments } : {}) });
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
  sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
}

async function handleConversations(req: http.IncomingMessage, res: Res, url: URL, method: string, bot: BotDefinition, rest: string[]) {
  try {
    if (rest.length === 0 && method === "GET") {
      const archived = url.searchParams.get("archived") === "1";
      if (!archived) await ensureThread(bot.id);
      return sendJson(res, 200, await listConversations(bot.id, archived));
    }
    if (rest.length === 0 && method === "POST") {
      if (bot.deletedAt) return sendJson(res, 409, { ok: false, code: "bot_deleted", error: "Esse bot foi excluído." });
      if (bot.archivedAt) return sendJson(res, 409, { ok: false, code: "bot_archived", error: "Esse bot está arquivado." });
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { ok: false, error: "Corpo inválido.", field: "body" });
      for (const key of Object.keys(body)) if (!["title", "permission", "message", "skills", "attachments"].includes(key)) return sendJson(res, 400, { ok: false, error: `Campo desconhecido: ${key}.`, field: key });
      if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length > 80)) return sendJson(res, 400, { ok: false, error: "O título precisa ter até 80 caracteres.", field: "title" });
      if (body.permission !== undefined && !isPermissionMode(body.permission)) return sendJson(res, 400, { ok: false, error: "Use readonly, edit, default ou full.", field: "permission" });
      const problem = checkFields({ ...(body.message !== undefined ? { message: body.message } : {}), ...(body.skills !== undefined ? { skills: body.skills } : {}), ...(body.attachments !== undefined ? { attachments: body.attachments } : {}) });
      if (problem) return sendJson(res, 400, { ok: false, error: problem });
      const skills = await resolveSkills(res, body);
      if (!skills) return;
      const attachments = await resolveAttachments(res, bot, body);
      if (!attachments) return;
      const message = typeof body.message === "string" ? body.message : undefined;
      const session = await createConversation(bot.id, { ...(typeof body.title === "string" ? { title: body.title } : {}), ...(isPermissionMode(body.permission) ? { permission: body.permission } : {}), ...(message?.trim() ? { firstMessage: message } : {}) });
      let deliveryId: string | null = null;
      if ((message && message.trim()) || skills.length > 0 || attachments.length > 0) {
        deliveryId = randomUUID();
        deliver(session, { deliveryId, text: deliveryText(message, skills), source: "chat", ...(skills.length ? { skills } : {}), ...(attachments.length ? { attachments } : {}) });
      }
      return sendJson(res, 201, { ...(await publicConversation(session)), sessionBasePath: `/bots/${bot.id}/eve/v1`, ...(deliveryId ? { deliveryId } : {}) });
    }
    const session = conversationOf(bot.id, rest[0] ?? "");
    if (!session) return sendJson(res, 404, { ok: false, error: "Conversa não encontrada." });
    const action = rest.slice(1).join("/");
    if (action === "" && method === "GET") return sendJson(res, 200, await publicConversation(session));
    if (action === "" && method === "PATCH") return sendJson(res, 200, await publicConversation(await updateConversation(session, await readBody(req))));
    if (method !== "POST") return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
    const body = ((await readBody(req).catch(() => undefined)) ?? {}) as Record<string, unknown>;
    if (action === "archive" || action === "unarchive") return sendJson(res, 200, await publicConversation(await archiveConversation(session, action === "archive")));
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
      return sendJson(res, 200, { ...(await publicConversation(moved)), sessionBasePath: `/bots/${moved.meta.botId}/eve/v1` });
    }
    return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    if (error instanceof ConversationError) return sendJson(res, error.status, { ok: false, code: error.code, error: error.message });
    return validationResponse(res, error);
  }
}

async function threadView(bot: BotDefinition) {
  const thread = await ensureThread(bot.id);
  return { ...publicThread(thread), running: isRunning(thread.sessionId) };
}

async function route(req: http.IncomingMessage, res: Res) {
  const url = new URL(req.url ?? "/", "http://gateway.local");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  if (handlePreview(req, res, url, parts)) return;
  if (method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });
  if (parts[0] === "code") return handleCodeRoute(req, res, url, method, parts);
  if (method === "GET" && url.pathname === "/meta") {
    return sendJson(res, 200, { accents, capabilities: capabilityCatalog, engine: "multi-provider", model, efforts });
  }
  if (parts[0] === "mcp" && parts.length === 3) return handleMcp(req, res, parts[1], parts[2]);
  if (parts[0] === "vault") return handleVaultRoute(req, res, url, method, parts);
  if (method === "GET" && url.pathname === "/accounts") {
    const accounts = url.searchParams.get("refresh") === "1" ? await refreshAccounts() : await listAccounts();
    return sendJson(res, 200, accounts);
  }
  if (method === "POST" && url.pathname === "/accounts/refresh") {
    await readBody(req).catch(() => undefined);
    return sendJson(res, 200, await refreshAccounts());
  }
  if (method === "GET" && parts[0] === "usage") return handleUsageRoute(res, url, sendJson);
  if (method === "GET" && url.pathname === "/voice/voices") return handleVoices(res, url);
  if (method === "GET" && url.pathname === "/skills") return handleSkills(res, url);
  if (parts[0] === "sections") return handleSections(req, res, method, parts);
  if (parts[0] === "groups") return handleGroups(req, res, url, method, parts);
  if (method === "GET" && url.pathname === "/status") return sendJson(res, 200, { bots: botStatuses(), turns: slotStats(), warmVoice: warmVoiceLayers(), appWatching: appWatching() });
  if (method === "GET" && url.pathname === "/status/stream") return handleStatusStream(req, res);
  if (method === "GET" && url.pathname === "/computer/health") return sendJson(res, 200, await computerHealth());
  if (parts[0] === "connectors" && parts.length >= 2 && parts[1] !== "refresh") return handleConnectorActions(req, res, url, method, parts);
  if (parts[0] === "connectors" && ((parts.length === 1 && method === "GET") || (parts[1] === "refresh" && method === "POST"))) {
    if (method === "POST") await readBody(req).catch(() => undefined);
    if (!runelayEnabled()) return sendJson(res, 503, { ok: false, error: "runelay não está configurado no servidor." });
    try {
      return sendJson(res, 200, await listConnections(method === "POST" || url.searchParams.get("refresh") === "1"));
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: `runelay não respondeu: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    }
  }
  if (parts[0] !== "bots") return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });

  if (parts.length === 1) {
    if (method === "GET") {
      const includeArchived = url.searchParams.get("archived") === "1";
      const listed = listBots(includeArchived, { deleted: url.searchParams.get("deleted") === "1", hidden: url.searchParams.get("hidden") === "1" });
      const all = await Promise.all(listed.map(publicBot));
      const term = normalize(url.searchParams.get("q") ?? "");
      if (!term) return sendJson(res, 200, all);
      return sendJson(
        res,
        200,
        all.filter((bot) => [bot.name, bot.role, bot.thread.lastMessage?.text ?? ""].some((value) => normalize(value).includes(term))),
      );
    }
    if (method === "POST") {
      try {
        const bot = await createBot(await readBody(req));
        await postGreeting(bot);
        return sendJson(res, 201, await publicBot(bot));
      } catch (error) {
        return validationResponse(res, error);
      }
    }
    return sendJson(res, 405, { ok: false, error: "Método não permitido." });
  }

  const bot = getBot(parts[1] ?? "");
  if (!bot) return sendJson(res, 404, { ok: false, error: "Bot não encontrada." });
  const rest = parts.slice(2);
  const tail = rest.join("/");

  if (rest[0] === "eve") return handleEve(req, res, url, bot, rest.slice(1));
  if (rest[0] === "voice") return handleVoice(req, res, method, bot, rest.slice(1));
  if (rest[0] === "code") return handleBotCode(req, res, url, method, bot, rest.slice(1));
  if (rest[0] === "uploads") return handleUploads(req, res, method, bot, rest.slice(1));
  if (tail === "" && method === "GET") return sendJson(res, 200, await publicBot(bot));
  if (tail === "" && method === "PATCH") {
    try {
      const updated = await updateBot(bot.id, await readBody(req));
      return sendJson(res, 200, await publicBot(updated!));
    } catch (error) {
      return validationResponse(res, error);
    }
  }
  if ((tail === "delete" || tail === "restore") && method === "POST") {
    await readBody(req).catch(() => undefined);
    if (tail === "delete") stopDesktop(bot.id);
    const updated = await setDeleted(bot.id, tail === "delete");
    return sendJson(res, 200, await publicBot(updated!));
  }
  if (tail === "sidebar" && method === "PATCH") {
    try {
      const updated = await updateSidebar(bot.id, await readBody(req), sectionExists);
      return sendJson(res, 200, await publicBot(updated!));
    } catch (error) {
      return validationResponse(res, error);
    }
  }
  if (tail === "thread/unread" && method === "POST") {
    await readBody(req).catch(() => undefined);
    return sendJson(res, 200, publicThread(await markThreadUnread(bot.id)));
  }
  if ((tail === "archive" || tail === "unarchive") && method === "POST") {
    const updated = await setArchived(bot.id, tail === "archive");
    return sendJson(res, 200, await publicBot(updated!));
  }
  if (tail === "thread" && method === "GET") return sendJson(res, 200, await threadView(bot));
  if ((tail === "thread/reset" || tail === "thread/restore") && method === "POST") {
    const body = (await readBody(req).catch(() => undefined)) as { archiveId?: unknown } | undefined;
    const current = await peekThread(bot.id);
    if (current && isBusy(current.sessionId)) {
      return sendJson(res, 409, { ok: false, code: "turn_running", error: "O bot ainda está respondendo. Pare a resposta antes de limpar a conversa." });
    }
    if (tail === "thread/reset") {
      const { archiveId } = await resetThread(bot.id);
      return sendJson(res, 200, { ...(await threadView(bot)), archiveId });
    }
    const archiveId = body?.archiveId;
    if (typeof archiveId !== "string" || !/^tha_[0-9A-Z]{26}$/.test(archiveId)) {
      return sendJson(res, 400, { ok: false, error: "archiveId inválido.", field: "archiveId" });
    }
    const restored = await restoreThread(bot.id, archiveId);
    if (!restored) return sendJson(res, 404, { ok: false, error: "Essa conversa arquivada não existe mais." });
    return sendJson(res, 200, { ...(await threadView(bot)), archiveId: restored.replacedArchiveId });
  }
  if (tail === "thread/read" && method === "POST") {
    await readBody(req).catch(() => undefined);
    return sendJson(res, 200, publicThread(await markThreadRead(bot.id)));
  }
  if (rest[0] === "schedules" && rest[2] === "run" && rest.length === 3 && method === "POST") {
    await readBody(req).catch(() => undefined);
    if (bot.deletedAt) return sendJson(res, 409, { ok: false, code: "bot_deleted", error: "Esse bot foi excluído." });
    if (bot.archivedAt) return sendJson(res, 409, { ok: false, code: "bot_archived", error: "Esse bot está arquivado." });
    const schedule = bot.schedules.find((item) => item.name === rest[1]);
    if (!schedule) return sendJson(res, 404, { ok: false, error: "Rotina não encontrada." });
    const started = await fire(bot.id, schedule.name, schedule.prompt);
    if (!started) return sendJson(res, 500, { ok: false, error: "Não consegui abrir a conversa do bot." });
    return sendJson(res, 202, { ok: true, ...started, scheduleId: schedule.name });
  }
  if (tail === "browser" && method === "GET") return handleBrowser(res, bot);
  if (tail === "browser/open" && method === "POST") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
    }
    if (!bot.capabilities.browser && !(await botIsCoding(bot.id).catch(() => false))) return sendJson(res, 409, { ok: false, code: "no_browser", error: "Esse bot não tem navegador." });
    const raw = (body as { url?: unknown } | undefined)?.url;
    let target: URL | null = null;
    try {
      target = typeof raw === "string" ? new URL(raw) : null;
    } catch {
      target = null;
    }
    if (!target || !["http:", "https:"].includes(target.protocol)) {
      return sendJson(res, 400, { ok: false, error: "Use uma URL http ou https.", field: "url" });
    }
    try {
      const state = await browserOpen(bot.id, target.toString(), undefined, true);
      publishLiveState(bot.id);
      return sendJson(res, 200, { url: state.url, title: state.title, updatedAt: state.updatedAt, screenshotPath: `/bots/${bot.id}/browser/latest.png` });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: `Não consegui abrir a página: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) });
    }
  }
  if (tail === "browser/control" && method === "POST") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
    }
    const mode = (body as { mode?: unknown } | undefined)?.mode;
    if (mode !== "user" && mode !== "bot") return sendJson(res, 400, { ok: false, error: "Use mode user ou bot.", field: "mode" });
    if (!bot.capabilities.browser && !bot.capabilities.desktop && !(await botIsCoding(bot.id).catch(() => false))) return sendJson(res, 409, { ok: false, code: "no_browser", error: "Esse bot não tem navegador nem computador." });
    setController(bot.id, mode);
    return sendJson(res, 200, { ok: true, controller: controllerOf(bot.id) });
  }
  if (["browser/back", "browser/forward", "browser/reload"].includes(tail) && method === "POST") {
    await readBody(req).catch(() => undefined);
    if (!bot.capabilities.browser && !(await botIsCoding(bot.id).catch(() => false))) return sendJson(res, 409, { ok: false, code: "no_browser", error: "Esse bot não tem navegador." });
    try {
      const state = await browserHistory(bot.id, tail.split("/")[1] as "back" | "forward" | "reload");
      publishLiveState(bot.id);
      return sendJson(res, 200, { url: state.url, title: state.title, updatedAt: state.updatedAt, screenshotPath: `/bots/${bot.id}/browser/latest.png`, controller: controllerOf(bot.id) });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: `Falha no navegador: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    }
  }
  if (tail === "desktop/latest.png" && method === "GET") {
    const file = join(dataDir, "bots", bot.id, "desktop", "latest.png");
    try {
      const info = await stat(file);
      res.writeHead(200, { "content-type": "image/png", "content-length": String(info.size), "cache-control": "no-store", "last-modified": info.mtime.toUTCString() });
      createReadStream(file).pipe(res);
    } catch {
      sendJson(res, 404, { ok: false, error: "Nenhum print do computador ainda." });
    }
    return;
  }
  if (tail === "browser/full.png" && method === "GET") return handleFullScreenshot(res, bot);
  if (tail === "browser/latest.png" && method === "GET") return handleScreenshot(res, bot);
  const shot = /^browser\/(?:shots|screenshots)\/([\w-][\w.-]*\.png)$/.exec(tail);
  if (shot && method === "GET") return handleScreenshot(res, bot, join("shots", basename(shot[1])));
  if (rest[0] === "artifacts" && method === "GET") return handleArtifacts(res, bot, rest.slice(1));
  if (rest[0] === "artifacts" && rest.length === 3 && rest[2] === "doc" && method === "PUT") return handleCanvasPut(req, res, bot, rest[1]);
  if (rest[0] === "artifacts" && rest.length === 3 && rest[2] === "layout" && method === "POST") {
    try {
      return sendJson(res, 200, layoutPreview(await readBody(req)));
    } catch (error) {
      if (error instanceof CanvasError || error instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: error.message });
      throw error;
    }
  }
  if (tail === "sessions" && method === "GET") return handleSessions(res, bot);
  if (rest[0] === "conversations") return handleConversations(req, res, url, method, bot, rest.slice(1));
  sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
}

async function main() {
  installConsoleRedaction();
  await mkdir(dataDir, { recursive: true });
  await loadVault();
  await loadBots();
  void listConnections(true).catch(() => undefined);
  setInterval(() => void listConnections(true).catch(() => undefined), 5 * 60_000).unref();
  await loadSessions();
  const orphanTurns = await settleOrphanTurns();
  if (orphanTurns > 0) console.log(`settled ${orphanTurns} turns left open by a restart`);
  await loadSections();
  await loadGroups();
  startScheduler();
  warmUsage();
  startCodeHousekeeping();
  const startupOrphans = sweepOrphans();
  if (startupOrphans.length > 0) console.log(`killed ${startupOrphans.length} orphan processes at startup`);
  setInterval(() => {
    const orphans = sweepOrphans(activeMarkers());
    if (orphans.length > 0) console.log(`killed orphans: ${orphans.map((proc) => `${proc.pid} ${proc.command.slice(0, 60)}`).join("; ")}`);
    closeIdleBrowsers((botId) => botStatuses()[botId] === "working" || hasLiveClients(botId));
  }, 60_000).unref();
  void refreshAccounts().then((accounts) => console.log(`accounts: ${accounts.map((item) => `${item.id}=${item.status}`).join(", ")}`));
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      else res.end();
    });
  });
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (isRunnerUpgrade(url.pathname)) return handleRunnerUpgrade(req, socket, head);
    if (handlePreviewUpgrade(req, socket, head)) return;
    const botId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    const bot = getBot(botId);
    if (bot && bot.capabilities.desktop && isDesktopUpgrade(url.pathname)) return handleDesktopUpgrade(req, socket, head, botId);
    const browserAllowed = bot ? bot.capabilities.browser || (await botIsCoding(bot.id).catch(() => false)) : false;
    if (!isLiveUpgrade(url.pathname) || !bot || !browserAllowed) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    handleLiveUpgrade(req, socket, head, botId);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopAllDesktops();
      stopAllDevServers();
      endAllCalls();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.listen(port, host, () => console.log(`runelay bots (claude-agent-sdk, ${model}) on http://${host}:${port}`));
}

void main();
