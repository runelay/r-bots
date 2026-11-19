import type http from "node:http";
import { ValidationError } from "./errors";

export type Req = http.IncomingMessage;
export type Res = http.ServerResponse;

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
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
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
