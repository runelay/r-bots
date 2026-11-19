import { randomUUID, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { AccountProbe, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { type WebSocket, WebSocketServer } from "ws";

export const runnerConnectPath = "/runner/connect";

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnStream = {
  emit: (event: ProviderEvent) => void;
  finish: () => void;
};

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const runnerToken = process.env.RUNNER_TOKEN ?? "";
let client: WebSocket | null = null;
let hello: Record<string, unknown> = {};
let connectedAt: string | null = null;
const pending = new Map<string, Pending>();
const turns = new Map<string, TurnStream>();
const eventListeners = new Set<(event: { type: string; botId?: string }) => void>();
const changeListeners = new Set<(connected: boolean) => void>();

export class MacRunnerUnavailable extends Error {}

function authorized(req: http.IncomingMessage) {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const expected = Buffer.from(runnerToken);
  return runnerToken.length >= 24 && given.length === expected.length && timingSafeEqual(given, expected);
}

export function macRunnerAuthorized(req: http.IncomingMessage) {
  return authorized(req);
}

export function macRunnerSupports(capability: string) {
  return (
    macRunnerConnected() && Array.isArray(hello.capabilities) && (hello.capabilities as unknown[]).includes(capability)
  );
}

export function isRunnerUpgrade(pathname: string) {
  return pathname === runnerConnectPath;
}

export function macRunnerConnected() {
  return client !== null && client.readyState === client.OPEN;
}

export function macRunnerInfo() {
  return { connected: macRunnerConnected(), connectedAt, version: hello.version ?? null };
}

export function onMacRunnerChange(listener: (connected: boolean) => void) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChange(connected: boolean) {
  for (const listener of changeListeners) {
    try {
      listener(connected);
    } catch {}
  }
}

function send(message: Record<string, unknown>) {
  if (!client || client.readyState !== client.OPEN)
    throw new MacRunnerUnavailable("O app runelay bots não está conectado.");
  client.send(JSON.stringify(message));
}

function dropClient(socket: WebSocket) {
  if (client !== socket) return;
  client = null;
  connectedAt = null;
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new MacRunnerUnavailable("O app runelay bots desconectou."));
    pending.delete(id);
  }
  for (const [id, stream] of turns) {
    stream.emit({ type: "done", ok: false, message: "O app runelay bots fechou no meio do turno." });
    stream.finish();
    turns.delete(id);
  }
  console.log(`${new Date().toISOString()} mac runner disconnected`);
  notifyChange(false);
}

function onMessage(raw: string) {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = typeof message.id === "string" ? message.id : "";
  if (message.type === "hello") {
    hello = message;
    return;
  }
  if (message.type === "response") {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(message);
    return;
  }
  if (message.type === "turn.event") {
    const stream = turns.get(id);
    if (stream && message.event && typeof message.event === "object") stream.emit(message.event as ProviderEvent);
    return;
  }
  if (message.type === "turn.end") {
    const stream = turns.get(id);
    if (!stream) return;
    turns.delete(id);
    stream.finish();
    return;
  }
  if (message.type === "computer.event") {
    const event = message.event as { type: string; botId?: string } | undefined;
    if (!event || typeof event.type !== "string") return;
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

export function handleRunnerUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  if (!authorized(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const previous = client;
    client = ws;
    hello = {};
    connectedAt = new Date().toISOString();
    if (previous && previous !== ws) {
      dropClientSilently(previous);
      previous.close(4000, "replaced");
    }
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {}
    }, 15_000);
    ws.on("message", (data, isBinary) => {
      alive = true;
      if (!isBinary) onMessage(data.toString());
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      dropClient(ws);
    });
    ws.on("error", () => undefined);
    console.log(`${new Date().toISOString()} mac runner connected`);
    notifyChange(true);
  });
}

function dropClientSilently(socket: WebSocket) {
  socket.removeAllListeners("close");
  socket.on("close", () => undefined);
}

function request(op: string, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new MacRunnerUnavailable("O Mac não respondeu a tempo."));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    signal?.addEventListener(
      "abort",
      () => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        reject(new MacRunnerUnavailable("Cancelado."));
      },
      { once: true },
    );
    try {
      send({ type: "request", id, op, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

export async function macAccounts() {
  const response = await request("accounts", {}, 90_000);
  if (response.ok === false) throw new Error(String(response.error ?? "O Mac não listou as contas."));
  return (response.result ?? []) as AccountProbe[];
}

export async function macComputerHealth() {
  const response = await request("computer.health", {}, 5000);
  return (response.body ?? { ok: false }) as Record<string, unknown>;
}

export async function macComputerCall(tool: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await request("computer.tool", { tool, body }, 180_000, signal);
  return {
    status: Number(response.status ?? 500),
    body: (response.body ?? {}) as { ok?: boolean; code?: string; error?: string; result?: unknown },
  };
}

export async function macTranscribeFile(audioBase64: string, name: string, signal?: AbortSignal) {
  const response = await request("transcribe_file", { body: { audioBase64, name, locale: "pt-BR" } }, 240_000, signal);
  if (response.ok === false) throw new Error(String(response.error ?? "O Mac não transcreveu."));
  return String((response.result as { text?: unknown } | undefined)?.text ?? "").trim();
}

export async function macUsageLimits() {
  const response = await request("usage.limits", {}, 45_000);
  if (response.ok === false) throw new Error(String(response.error ?? "O Mac não leu os limites."));
  return (response.result ?? {}) as Record<string, unknown>;
}

export async function macUsageBuckets(since: number) {
  const response = await request("usage.buckets", { body: { since } }, 600_000);
  if (response.ok === false) throw new Error(String(response.error ?? "O Mac não leu o uso."));
  return (response.result ?? {}) as Record<string, unknown>;
}

export async function macSecretResolve(body: {
  name: string;
  botId: string;
  botName: string;
  tool: string;
  domain: string | null;
}) {
  return request("secret.resolve", { body }, 95_000);
}

export function watchMacComputerEvents(listener: (event: { type: string; botId?: string }) => void) {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function runMacTurn(turn: TurnRequest, signal: AbortSignal, emit: (event: ProviderEvent) => void) {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done)
        emit({
          type: "done",
          ok: false,
          message: signal.aborted ? "cancelled" : "O Mac encerrou o turno sem resposta.",
        });
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      try {
        send({ type: "turn.cancel", id: turn.turnId });
      } catch {}
      setTimeout(() => {
        const stream = turns.get(turn.turnId);
        if (!stream) return;
        turns.delete(turn.turnId);
        stream.finish();
      }, 5000).unref();
    };
    turns.set(turn.turnId, {
      emit: (event) => {
        if (event.type === "done") done = true;
        emit(event);
      },
      finish,
    });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      send({ type: "turn.start", id: turn.turnId, turn });
    } catch (error) {
      turns.delete(turn.turnId);
      emit({ type: "done", ok: false, message: error instanceof Error ? error.message : String(error) });
      done = true;
      finish();
    }
  });
}
