import { EventEmitter } from "node:events";
import type { BunFile } from "bun";
import { ValidationError } from "./errors";

type Headers = Record<string, string | undefined>;
type Body = string | Uint8Array | BunFile | Blob;

export class Req extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  private consumed = false;

  constructor(readonly raw: Request) {
    super();
    const url = new URL(raw.url);
    this.method = raw.method;
    this.url = `${url.pathname}${url.search}`;
    this.headers = Object.fromEntries([...raw.headers].map(([key, value]) => [key.toLowerCase(), value]));
    raw.signal.addEventListener("abort", () => this.emit("close"), { once: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    if (this.consumed || !this.raw.body) return;
    this.consumed = true;
    for await (const chunk of this.raw.body) yield Buffer.from(chunk);
  }

  resume() {
    if (this.consumed || !this.raw.body) return;
    this.consumed = true;
    void this.raw.body.cancel().catch(() => undefined);
  }
}

export class Res extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  readonly response: Promise<Response>;
  private headers: Headers = {};
  private settle!: (response: Response) => void;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(signal: AbortSignal) {
    super();
    this.response = new Promise((resolve) => {
      this.settle = resolve;
    });
    signal.addEventListener("abort", () => this.finish(), { once: true });
  }

  writeHead(status: number, headers: Headers = {}) {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  write(chunk: string | Uint8Array) {
    if (this.closed) return false;
    this.open();
    try {
      this.controller?.enqueue(typeof chunk === "string" ? this.encoder.encode(chunk) : chunk);
    } catch {
      this.finish();
      return false;
    }
    return true;
  }

  end(body?: Body) {
    if (this.closed) return;
    if (!this.headersSent) {
      this.headersSent = true;
      this.settle(new Response(body ?? null, { status: this.statusCode, headers: this.cleanHeaders() }));
      this.finish();
      return;
    }
    if (typeof body === "string" || body instanceof Uint8Array) this.write(body);
    try {
      this.controller?.close();
    } catch {}
    this.finish();
  }

  respond(response: Response) {
    if (this.headersSent) return;
    this.headersSent = true;
    if (!response.body) {
      this.settle(response);
      this.finish();
      return;
    }
    const done = () => this.finish();
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        flush() {
          done();
        },
      }),
    );
    this.settle(
      new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
    );
  }

  private open() {
    if (this.headersSent) return;
    this.headersSent = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => this.finish(),
    });
    this.settle(new Response(stream, { status: this.statusCode, headers: this.cleanHeaders() }));
  }

  private cleanHeaders() {
    return Object.fromEntries(
      Object.entries(this.headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

export function sendJson(res: Res, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
}

export async function readBody(req: Req) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

export function sendFile(res: Res, file: BunFile | Blob, headers: Record<string, string>, status = 200) {
  res.writeHead(status, headers);
  res.end(file);
}

export function notFound(res: Res) {
  sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
}

export function validationResponse(res: Res, error: unknown) {
  if (error instanceof ValidationError)
    return sendJson(res, 400, { ok: false, error: error.message, field: error.field });
  if (error instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
  throw error;
}

export function runelayFailure(res: Res, error: unknown) {
  return sendJson(res, 502, {
    ok: false,
    error: `runelay não respondeu: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
  });
}

type WebHeaders = globalThis.Headers;

export interface RequestContext {
  pathname: string;
  parts: string[];
  peer: string;
  viaProxy: boolean;
  clientIp: string;
  listenPort: number | null;
}

const contexts = new WeakMap<Request, RequestContext>();
const encodedHex = /%[0-9a-f]{2}/i;
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
const proxyHeaderPrefixes = ["x-forwarded-", "tailscale-"];
const proxyHeaderNames = new Set(["forwarded", "x-real-ip"]);

export function normalizePath(pathname: string): { pathname: string; parts: string[] } | null {
  if (pathname.includes("\\")) return null;
  const parts: string[] = [];
  for (const raw of pathname.split("/")) {
    if (!raw) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === "..") return null;
    if (decoded.includes("/") || decoded.includes("\\") || encodedHex.test(decoded)) return null;
    if (Array.from(decoded).some((char) => (char.codePointAt(0) ?? 0) < 0x20)) return null;
    parts.push(decoded);
  }
  return { pathname: `/${parts.join("/")}`, parts };
}

export function isLoopback(address: string) {
  return loopbackAddresses.has(address) || address.startsWith("127.");
}

export function hasProxyHeaders(headers: WebHeaders) {
  for (const name of headers.keys()) {
    const lower = name.toLowerCase();
    if (proxyHeaderNames.has(lower) || proxyHeaderPrefixes.some((prefix) => lower.startsWith(prefix))) return true;
  }
  return false;
}

export function viaTrustedProxy(headers: WebHeaders, peer: string) {
  if (!isLoopback(peer)) return false;
  return headers.has("tailscale-user-login") || headers.has("tailscale-headers-info");
}

export function clientIpOf(headers: WebHeaders, peer: string) {
  if (viaTrustedProxy(headers, peer)) {
    const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return peer || "unknown";
}

export function buildRequestContext(request: Request, peer: string, listenPort: number | null = null) {
  const normalized = normalizePath(new URL(request.url).pathname);
  if (!normalized) return null;
  const context: RequestContext = {
    ...normalized,
    peer,
    viaProxy: viaTrustedProxy(request.headers, peer),
    clientIp: clientIpOf(request.headers, peer),
    listenPort,
  };
  return context;
}

export function setRequestContext(request: Request, context: RequestContext) {
  contexts.set(request, context);
  return context;
}

export function requestContext(request: Request): RequestContext {
  const known = contexts.get(request);
  if (known) return known;
  const built = buildRequestContext(request, "") ?? {
    pathname: "/",
    parts: [],
    peer: "",
    viaProxy: false,
    clientIp: "unknown",
    listenPort: null,
  };
  contexts.set(request, built);
  return built;
}

const baseSecurityHeaders: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

function needsNoStore(headers: WebHeaders, pathname: string) {
  const type = headers.get("content-type") ?? "";
  if (type.includes("json")) return true;
  return pathname === "/device" || pathname.startsWith("/auth/") || pathname.startsWith("/api/auth");
}

const embeddablePath = /^\/bots\/[^/]+\/(artifacts|uploads)(\/|$)/;

export function withSecurityHeaders(response: Response, pathname: string) {
  const headers = new globalThis.Headers(response.headers);
  const embeddable = embeddablePath.test(pathname);
  for (const [name, value] of Object.entries(baseSecurityHeaders))
    if (!headers.has(name) && !(embeddable && name === "cross-origin-resource-policy")) headers.set(name, value);
  if (!headers.has("cache-control") && needsNoStore(headers, pathname)) headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function internalError(res: Res, error: unknown) {
  const errorId = crypto.randomUUID().slice(0, 8);
  console.error(`request failed (${errorId})`, error);
  if (!res.headersSent)
    sendJson(res, 500, { ok: false, error: "Algo deu errado no servidor. Tente de novo.", errorId });
  else res.end();
  return errorId;
}
