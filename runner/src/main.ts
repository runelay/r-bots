import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import http from "node:http";
import { join, resolve } from "node:path";
import { probe, runTurn } from "../../shared/providers/index";
import { type ProviderEvent, providers, type TurnRequest } from "../../shared/types";

const host = process.env.RUNNER_HOST ?? "100.122.172.127";
const port = Number(process.env.RUNNER_PORT ?? 4790);
const token = process.env.RUNNER_TOKEN ?? "";
const dataDir = process.env.RUNNER_DATA ?? join(resolve(import.meta.dirname, ".."), "data");
const turns = new Map<string, AbortController>();
const executorUrl = process.env.EXECUTOR_URL ?? "http://127.0.0.1:4791";
const executorTokenFile = process.env.EXECUTOR_TOKEN_FILE ?? join(homedir(), "Library", "Application Support", "runelay bots", "executor.token");

async function executorToken() {
  try {
    return (await readFile(executorTokenFile, "utf8")).trim();
  } catch {
    return null;
  }
}

function unavailable(res: http.ServerResponse, detail: string) {
  sendJson(res, 503, { ok: false, code: "COMPUTER_UNAVAILABLE", error: `O app runelay bots não está disponível no Mac (${detail}).` });
}

async function proxyComputer(req: http.IncomingMessage, res: http.ServerResponse, path: string, method: "GET" | "POST") {
  const token = await executorToken();
  if (!token) return unavailable(res, "sem token do executor");
  const body = method === "POST" ? Buffer.concat(await (async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return chunks; })()) : undefined;
  let upstream: Response;
  try {
    upstream = await fetch(`${executorUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      signal: path === "/events" ? undefined : AbortSignal.timeout(170_000),
    });
  } catch (error) {
    return unavailable(res, error instanceof Error ? error.message : String(error));
  }
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => undefined));
  while (true) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done) break;
    res.write(value);
  }
  res.end();
}

if (token.length < 24) {
  console.error("RUNNER_TOKEN ausente ou curto.");
  process.exit(1);
}

function authorized(req: http.IncomingMessage) {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
}

function validTurn(body: unknown): body is TurnRequest {
  if (!body || typeof body !== "object") return false;
  const raw = body as Record<string, unknown>;
  return (
    typeof raw.turnId === "string" &&
    (providers as readonly unknown[]).includes(raw.provider) &&
    typeof raw.model === "string" &&
    typeof raw.systemPrompt === "string" &&
    typeof raw.prompt === "string" &&
    typeof raw.workKey === "string"
  );
}

async function startTurn(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "JSON inválido." });
  }
  if (!validTurn(body)) return sendJson(res, 400, { ok: false, error: "Turno inválido." });
  const controller = new AbortController();
  turns.set(body.turnId, controller);
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const emit = (event: ProviderEvent) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  console.log(`${new Date().toISOString()} turn ${body.turnId} ${body.provider}/${body.model}`);
  try {
    await runTurn(body, dataDir, controller.signal, emit);
  } finally {
    turns.delete(body.turnId);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://runner.local");
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, runner: "mac", turns: turns.size });
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "Não autorizado." });
    if (req.method === "GET" && url.pathname === "/accounts") {
      return sendJson(res, 200, await Promise.all(providers.map((provider) => probe(provider))));
    }
    if (req.method === "POST" && url.pathname === "/turns") return startTurn(req, res);
    if (req.method === "GET" && url.pathname === "/computer/health") return proxyComputer(req, res, "/health", "GET");
    if (req.method === "GET" && url.pathname === "/computer/events") return proxyComputer(req, res, "/events", "GET");
    const computerTool = url.pathname.match(/^\/computer\/([a-z_]+)$/);
    if (req.method === "POST" && computerTool) return proxyComputer(req, res, `/tools/${computerTool[1]}`, "POST");
    const cancel = url.pathname.match(/^\/turns\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancel) {
      const controller = turns.get(decodeURIComponent(cancel[1]));
      controller?.abort();
      return sendJson(res, 202, { ok: true, cancelled: Boolean(controller) });
    }
    sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) });
    else res.end();
  }
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(port, host, () => console.log(`runelay runner on http://${host}:${port}`));
