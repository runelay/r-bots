import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { issuePreviewTicket } from "../../code/routes/preview.routes";
import {
  listServers,
  onServerChange,
  onServerLog,
  previewTarget,
  rawLines,
  viewServer,
} from "../../code/services/dev-server.service";
import { listProjects } from "../services/projects.service";
import {
  deleteProfile,
  describeProject,
  forget,
  listProfiles,
  requireServer,
  restart,
  saveProfile,
  startProjectServer,
  stopServer,
} from "../services/servers.service";

function objectBody(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Corpo inválido.", "body");
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lineCount(url: URL) {
  const value = Number(url.searchParams.get("lines") ?? 500);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 2000) : 500;
}

function streamLogs(req: Req, res: Res, id: string, url: URL) {
  const server = requireServer(id);
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  const write = (value: unknown) => res.write(`${JSON.stringify(value)}\n`);
  write({ type: "snapshot", server: viewServer(server), lines: rawLines(server, lineCount(url)) });
  const offLog = onServerLog(id, (lines) => write({ type: "lines", lines }));
  const offChange = onServerChange((item, removed) => {
    if (item.id === id) write({ type: "server", server: item, removed });
  });
  const heartbeat = setInterval(write, 15_000, { type: "heartbeat" });
  const close = () => {
    offLog();
    offChange();
    clearInterval(heartbeat);
  };
  res.on("close", close);
  req.on("close", close);
}

function failure(res: Res, error: unknown) {
  if (error instanceof ValidationError || error instanceof SyntaxError) return validationResponse(res, error);
  return sendJson(res, 400, {
    ok: false,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
  });
}

export async function handleServers(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  try {
    const [, first, second] = parts;
    if (parts.length === 1 && method === "GET") return sendJson(res, 200, { servers: listServers() });
    if (parts.length === 1 && method === "POST") {
      const body = objectBody(await readBody(req));
      const port = body.port === undefined ? undefined : Number(body.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535))
        throw new ValidationError("Porta inválida.", "port");
      const { server } = await startProjectServer({
        path: text(body.path),
        cwd: text(body.cwd),
        script: text(body.script),
        cmd: text(body.cmd),
        profile: text(body.profile),
        ...(port ? { port } : {}),
        startedBy: "user",
      });
      return sendJson(res, 202, { ok: true, server });
    }
    if (first === "projects" && parts.length === 2 && method === "GET")
      return sendJson(res, 200, { projects: await listProjects() });
    if (first === "scripts" && parts.length === 2 && method === "GET")
      return sendJson(
        res,
        200,
        await describeProject({
          path: url.searchParams.get("path") ?? undefined,
          cwd: url.searchParams.get("cwd") ?? undefined,
        }),
      );
    if (first === "profiles" && parts.length === 2 && method === "GET")
      return sendJson(res, 200, { profiles: await listProfiles() });
    if (first === "profiles" && parts.length === 2 && method === "POST")
      return sendJson(res, 200, { ok: true, profile: await saveProfile(objectBody(await readBody(req))) });
    if (first === "profiles" && parts.length === 3 && method === "DELETE")
      return (await deleteProfile(second))
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { ok: false, error: "Perfil não encontrado." });
    if (first && parts.length === 2 && method === "GET") return sendJson(res, 200, viewServer(requireServer(first)));
    if (first && parts.length === 2 && method === "DELETE") {
      forget(first);
      return sendJson(res, 200, { ok: true });
    }
    if (first && second === "stop" && method === "POST")
      return sendJson(res, 200, { ok: true, server: await stopServer(first) });
    if (first && second === "preview-link" && method === "POST") {
      const server = requireServer(first);
      const target = previewTarget(server.workspaceId, server.port);
      if (!target) return sendJson(res, 409, { ok: false, error: "O servidor não está no ar." });
      const ticket = issuePreviewTicket(target.token);
      return sendJson(res, 200, { ok: true, path: `/preview/${server.workspaceId}/${server.port}/?t=${ticket}` });
    }
    if (first && second === "restart" && method === "POST") {
      const { server } = await restart(first);
      return sendJson(res, 202, { ok: true, server });
    }
    if (first && second === "logs" && parts.length === 3 && method === "GET") {
      const server = requireServer(first);
      return sendJson(res, 200, {
        server: viewServer(server),
        lines: rawLines(server, lineCount(url), url.searchParams.get("query") ?? undefined),
      });
    }
    if (first && second === "logs" && parts[3] === "stream" && method === "GET")
      return streamLogs(req, res, first, url);
  } catch (error) {
    return failure(res, error);
  }
  return notFound(res);
}
