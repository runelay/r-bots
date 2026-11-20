import { randomBytes } from "node:crypto";
import { type Req, type Res, requestContext, sendJson } from "../../../shared/http";
import { type Socket, type SocketHandler, socketOpen } from "../../../shared/ws";
import { previewCookieName } from "../../auth/services/auth.middleware";
import { effectiveHost } from "../../auth/services/origins.service";
import { findPreviewByToken, previewTarget } from "../services/dev-server.service";

export const previewSessionMs = 2 * 60 * 60_000;
const maxSessions = 500;

const strippedRequestHeaders = ["cookie", "authorization", "x-api-key"];
const strippedRequestPrefixes = ["proxy-", "tailscale-", "x-forwarded-"];
const strippedResponseHeaders = ["set-cookie", "clear-site-data", "service-worker-allowed"];

type PreviewSession = { token: string; expiresAt: number };

const sessions = new Map<string, PreviewSession>();
const consumed = new Set<string>();
let clock: () => number = Date.now;

export function usePreviewClock(now: (() => number) | null) {
  clock = now ?? Date.now;
}

export function resetPreviewSessions() {
  sessions.clear();
  consumed.clear();
}

export function previewOrigin(env: Record<string, string | undefined> = Bun.env) {
  const value = env.BOTS_PREVIEW_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function previewHost(env: Record<string, string | undefined> = Bun.env) {
  return previewOrigin(env)?.host.toLowerCase() ?? null;
}

export function onPreviewHost(request: Request) {
  const host = previewHost();
  return host !== null && effectiveHost(request) === host;
}

function prune(at: number) {
  for (const [id, session] of sessions) if (session.expiresAt <= at) sessions.delete(id);
  for (const token of consumed) if (!findPreviewByToken(token)) consumed.delete(token);
  while (sessions.size >= maxSessions) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function cookieValue(header: string | null | undefined) {
  const match = (header ?? "").match(new RegExp(`(?:^|;\\s*)${previewCookieName}=([\\w-]+)`));
  return match?.[1] ?? null;
}

function sessionTarget(header: string | null | undefined) {
  const id = cookieValue(header);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= clock()) return null;
  return findPreviewByToken(session.token);
}

function previewAllowedHere(request: Request) {
  const host = previewHost();
  return host === null || effectiveHost(request) === host;
}

export function isPreviewTraffic(request: Request, apiRoots: ReadonlySet<string>) {
  const first = requestContext(request).parts[0] ?? "";
  if (first === "preview") return true;
  if (!previewAllowedHere(request)) return false;
  if (previewHost() === null && apiRoots.has(first)) return false;
  return sessionTarget(request.headers.get("cookie")) !== null;
}

function isHttps(request: Request) {
  const context = requestContext(request);
  if (context.viaProxy) return request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  return new URL(request.url).protocol === "https:";
}

function forwardHeaders(source: Headers, port: number) {
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (strippedRequestHeaders.includes(lower) || strippedRequestPrefixes.some((prefix) => lower.startsWith(prefix)))
      continue;
    headers.set(lower, value);
  }
  headers.set("host", `localhost:${port}`);
  headers.set("accept-encoding", "identity");
  return headers;
}

const compressibleTypes = /^(text\/|application\/(javascript|json|xml|wasm|manifest\+json)|image\/svg\+xml)/i;

function wantsGzip(acceptEncoding: string | null) {
  return /\bgzip\b/i.test(acceptEncoding ?? "");
}

function filterResponse(answer: Response, acceptEncoding: string | null) {
  const headers = new Headers(answer.headers);
  for (const name of strippedResponseHeaders) headers.delete(name);
  const compress =
    answer.body !== null &&
    wantsGzip(acceptEncoding) &&
    !headers.has("content-encoding") &&
    compressibleTypes.test(headers.get("content-type") ?? "") &&
    !/event-stream/i.test(headers.get("content-type") ?? "") &&
    answer.status !== 204 &&
    answer.status !== 304;
  if (!compress) return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
  headers.delete("content-length");
  headers.set("content-encoding", "gzip");
  headers.append("vary", "accept-encoding");
  return new Response(answer.body!.pipeThrough(new CompressionStream("gzip")), {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

function proxy(req: Req, res: Res, port: number, path: string) {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  fetch(`http://localhost:${port}${path}`, {
    method: req.method,
    headers: forwardHeaders(req.raw.headers, port),
    body: hasBody ? req.raw.body : undefined,
    redirect: "manual",
  })
    .then((answer) => res.respond(filterResponse(answer, req.raw.headers.get("accept-encoding"))))
    .catch((error: Error) => {
      console.error("preview proxy failed", error);
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: "O servidor de desenvolvimento não respondeu." });
    });
}

function denied(res: Res) {
  sendJson(res, 403, { ok: false, error: "Prévia indisponível: o servidor parou ou o link venceu." });
  return true;
}

function exchange(req: Req, res: Res, url: URL, parts: string[]) {
  const port = Number(parts[2]);
  const target = parts[1] && Number.isInteger(port) ? previewTarget(parts[1], port) : null;
  const given = url.searchParams.get("t");
  const rest = `/${parts
    .slice(3)
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  if (!target) return denied(res);
  const origin = previewOrigin();
  if (origin && !onPreviewHost(req.raw)) {
    if (given !== target.token) return denied(res);
    const next = new URL(url.pathname, origin);
    next.search = url.search;
    res.writeHead(302, { location: next.toString(), "cache-control": "no-store" });
    res.end();
    return true;
  }
  const current = sessionTarget(req.headers.cookie);
  if (given !== target.token || consumed.has(target.token)) {
    if (current?.token === target.token) {
      res.writeHead(302, { location: rest, "cache-control": "no-store" });
      res.end();
      return true;
    }
    return denied(res);
  }
  const at = clock();
  prune(at);
  consumed.add(target.token);
  const id = randomBytes(24).toString("base64url");
  sessions.set(id, { token: target.token, expiresAt: at + previewSessionMs });
  const secure = isHttps(req.raw) ? "; Secure" : "";
  res.writeHead(302, {
    location: rest,
    "set-cookie": `${previewCookieName}=${id}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${previewSessionMs / 1000}`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end();
  return true;
}

export function handlePreview(req: Req, res: Res, url: URL, parts: string[], apiRoots: ReadonlySet<string>) {
  if (parts[0] === "preview") return exchange(req, res, url, parts);
  if (!isPreviewTraffic(req.raw, apiRoots)) return false;
  if (req.headers["service-worker"]?.toLowerCase() === "script") return denied(res);
  const target = sessionTarget(req.headers.cookie);
  if (!target) return false;
  proxy(req, res, target.port, req.url ?? "/");
  return true;
}

export function previewUpgradeTarget(req: Req, apiRoots: ReadonlySet<string>) {
  if (requestContext(req.raw).parts[0] === "preview") return null;
  if (!isPreviewTraffic(req.raw, apiRoots)) return null;
  const target = sessionTarget(req.headers.cookie);
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
