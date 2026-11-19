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
