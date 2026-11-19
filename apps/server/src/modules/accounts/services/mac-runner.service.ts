import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AccountProbe, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { env } from "../../../config/env";
import type { Req } from "../../../shared/http";
import { type Socket, type SocketHandler, socketOpen } from "../../../shared/ws";
import { authActive, principalOf } from "../../auth/gate";

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

const runnerToken = env.RUNNER_TOKEN;
let client: Socket | null = null;
const heartbeats = new WeakMap<Socket, { alive: boolean; timer: ReturnType<typeof setInterval> }>();
let hello: Record<string, unknown> = {};
let connectedAt: string | null = null;
const pending = new Map<string, Pending>();
const turns = new Map<string, TurnStream>();
const eventListeners = new Set<(event: { type: string; botId?: string }) => void>();
const changeListeners = new Set<(connected: boolean) => void>();

export class MacRunnerUnavailable extends Error {}

function authorized(req: Req) {
  if (authActive()) return principalOf(req.raw) !== null;
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const expected = Buffer.from(runnerToken);
  return runnerToken.length >= 24 && given.length === expected.length && timingSafeEqual(given, expected);
}

export function macRunnerAuthorized(req: Req) {
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
  return client !== null && client.readyState === socketOpen;
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
  if (!client || client.readyState !== socketOpen)
    throw new MacRunnerUnavailable("O app runelay bots não está conectado.");
  client.send(JSON.stringify(message));
}

function dropClient(socket: Socket) {
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

export function runnerUpgradeAllowed(req: Req) {
  return authorized(req);
}

export const runnerSocket: SocketHandler = {
  open(ws) {
    const previous = client;
    client = ws;
    hello = {};
    connectedAt = new Date().toISOString();
    if (previous && previous !== ws) previous.close(4000, "replaced");
    const beat = {
      alive: true,
      timer: setInterval(() => {
        if (!beat.alive) {
          ws.terminate();
          return;
        }
        beat.alive = false;
        try {
          ws.ping();
        } catch {}
      }, 15_000),
    };
    heartbeats.set(ws, beat);
    console.log(`${new Date().toISOString()} mac runner connected`);
    notifyChange(true);
  },
  message(ws, message) {
    const beat = heartbeats.get(ws);
    if (beat) beat.alive = true;
    if (typeof message === "string") onMessage(message);
  },
  pong(ws) {
    const beat = heartbeats.get(ws);
    if (beat) beat.alive = true;
  },
  close(ws) {
    const beat = heartbeats.get(ws);
    if (beat) clearInterval(beat.timer);
    heartbeats.delete(ws);
    dropClient(ws);
  },
};

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

export async function macReadFile(path: string, maxBytes: number, signal?: AbortSignal) {
  const response = await request("file.read", { body: { path, maxBytes } }, 120_000, signal);
  if (response.ok === false) throw new Error(String(response.error ?? "O Mac não enviou o arquivo."));
  const result = (response.result ?? {}) as { path?: unknown; name?: unknown; base64?: unknown };
  return {
    path: String(result.path ?? path),
    name: String(result.name ?? ""),
    bytes: Buffer.from(String(result.base64 ?? ""), "base64"),
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
