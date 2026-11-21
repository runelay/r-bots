import { randomUUID } from "node:crypto";
import type {
  AccountProbe,
  BoxSpec,
  BoxStatus,
  EnvironmentCapacity,
  HookRequestFrame,
  HookResponseFrame,
  NativeToolGate,
  NativeToolHooks,
  ProviderEvent,
  RemoteTurnStart,
  TurnRequest,
} from "@runelay-bots/protocol";
import { host, port } from "../../../config/env";
import type { Req } from "../../../shared/http";
import { type Socket, type SocketData, type SocketHandler, socketOpen } from "../../../shared/ws";
import { authActive, currentAuthModule, onUserRevoked, principalOf } from "../../auth/gate";
import { ownerRole } from "../../auth/services/auth.service";
import {
  boxesCapability,
  capacityRefusal,
  failedHookMessage,
  invalidHookMessage,
  missingHooksMessage,
} from "../../environments/constants/environments.constants";
import {
  boxesOf,
  capabilitiesOf,
  capacityOf,
  hookRequestOf,
  runnerOf,
} from "../../environments/services/runner-frames.service";
import type { RunnerEnvironment, RunnerInfo } from "../../environments/types/environments.types";

export const runnerConnectPath = "/runner/connect";
export const revokedCloseCode = 4001;

type Pending = {
  key: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnStream = {
  key: string;
  emit: (event: ProviderEvent) => void;
  finish: () => void;
  hooks?: NativeToolHooks;
  refuse?: () => void;
  started: boolean;
};

export type RemoteTurnOutcome = "ran" | "refused";

export type RemoteTurnInput = {
  turn: TurnRequest;
  botId: string;
  box: BoxSpec;
  hooks?: NativeToolHooks;
};

export type RunnerSocketData = SocketData & {
  kind: "runner";
  deviceKey: string;
  rank: number;
  deviceName: string | null;
  userId: string | null;
  owner: boolean;
};

type Connection = {
  key: string;
  socket: Socket;
  hello: Record<string, unknown>;
  connectedAt: string;
  rank: number;
  name: string | null;
  userId: string | null;
  owner: boolean;
  beat: { alive: boolean; timer: ReturnType<typeof setInterval> };
  runner: RunnerInfo | null;
  capacity: EnvironmentCapacity | null;
  boxes: BoxStatus[];
};

export type McpForwarder = (path: string, init: RequestInit) => Promise<Response>;

const connections = new Map<string, Connection>();
const lastSeen = new Map<string, string>();
const pending = new Map<string, Pending>();
const turns = new Map<string, TurnStream>();
const eventListeners = new Set<(event: { type: string; botId?: string }) => void>();
const changeListeners = new Set<(connected: boolean, key: string) => void>();
const environmentListeners = new Set<() => void>();
const mcpPathPattern = /^\/mcp\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const forwardedRequestHeaders = ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
const forwardedResponseHeaders = ["content-type", "mcp-session-id"];

const loopbackForwarder: McpForwarder = (path, init) => fetch(`http://${host}:${port}${path}`, init);
let mcpForwarder = loopbackForwarder;

export class MacRunnerUnavailable extends Error {}

export function macRunnerAuthorized(req: Req) {
  return authActive() && principalOf(req.raw) !== null;
}

async function refreshDeviceKey(apiKeyId: string) {
  try {
    await currentAuthModule()?.devices?.touchKey(apiKeyId);
  } catch {}
}

export function runnerUpgradeData(req: Req): RunnerSocketData | null {
  if (!authActive()) return null;
  const principal = principalOf(req.raw);
  if (!principal?.device) return null;
  const registered = Date.parse(principal.device.registeredAt);
  if (principal.apiKeyId) void refreshDeviceKey(principal.apiKeyId);
  return {
    kind: "runner",
    deviceKey: principal.device.id,
    rank: Number.isFinite(registered) ? registered : 0,
    deviceName: principal.device.name || null,
    userId: principal.userId,
    owner: principal.role === ownerRole,
  };
}

function isOpen(connection: Connection | undefined): connection is Connection {
  return connection !== undefined && connection.socket.readyState === socketOpen;
}

function isBoxRunner({ hello }: Connection) {
  return capabilitiesOf(hello.capabilities).includes(boxesCapability);
}

function connectionFor(key?: string) {
  if (key !== undefined) {
    const found = connections.get(key);
    return isOpen(found) ? found : null;
  }
  let best: Connection | null = null;
  for (const connection of connections.values()) {
    if (!isOpen(connection) || !connection.owner || isBoxRunner(connection)) continue;
    if (!best || connection.rank < best.rank) best = connection;
  }
  return best;
}

export function macRunnerSupports(capability: string, key?: string) {
  const connection = connectionFor(key);
  const capabilities = connection?.hello.capabilities;
  return Array.isArray(capabilities) && (capabilities as unknown[]).includes(capability);
}

export function isRunnerUpgrade(pathname: string) {
  return pathname === runnerConnectPath;
}

export function macRunnerConnected(key?: string) {
  return connectionFor(key) !== null;
}

export function macRunnerInfo() {
  const connection = connectionFor();
  return {
    connected: connection !== null,
    connectedAt: connection?.connectedAt ?? null,
    version: connection?.hello.version ?? null,
  };
}

export function macRunnerConnections() {
  return [...connections.values()].filter(isOpen).map((connection) => ({
    key: connection.key,
    name: connection.name,
    userId: connection.userId,
    connectedAt: connection.connectedAt,
    version: typeof connection.hello.version === "string" ? connection.hello.version : null,
  }));
}

export function macDeviceLastSeen(key: string) {
  return isOpen(connections.get(key)) ? new Date().toISOString() : (lastSeen.get(key) ?? null);
}

export function disconnectMacDevice(key: string, code = revokedCloseCode, reason = "revoked") {
  const connection = connections.get(key);
  if (!connection) return false;
  try {
    connection.socket.close(code, reason);
  } catch {}
  dropConnection(connection.socket);
  return true;
}

export function disconnectMacUser(userId: string) {
  let count = 0;
  for (const connection of [...connections.values()])
    if (connection.userId === userId && disconnectMacDevice(connection.key)) count++;
  return count;
}

onUserRevoked((userId) => {
  disconnectMacUser(userId);
});

export function onMacRunnerChange(listener: (connected: boolean, key: string) => void) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function onRunnerEnvironmentsChange(listener: () => void) {
  environmentListeners.add(listener);
  return () => environmentListeners.delete(listener);
}

export function runnerEnvironments(): RunnerEnvironment[] {
  return [...connections.values()]
    .filter((connection) => isOpen(connection) && connection.owner && isBoxRunner(connection))
    .map(({ key, name, hello, runner, capacity, boxes }) => ({
      key,
      name,
      capabilities: capabilitiesOf(hello.capabilities),
      runner,
      capacity,
      boxes,
    }));
}

export function useMcpForwarder(forwarder: McpForwarder | null) {
  mcpForwarder = forwarder ?? loopbackForwarder;
}

function notifyEnvironments() {
  for (const listener of environmentListeners) {
    try {
      listener();
    } catch {}
  }
}

function notifyChange(connected: boolean, key: string) {
  for (const listener of changeListeners) {
    try {
      listener(connected, key);
    } catch {}
  }
  notifyEnvironments();
}

function send(message: object, key?: string) {
  const connection = connectionFor(key);
  if (!connection) throw new MacRunnerUnavailable("O app r/bots não está conectado.");
  connection.socket.send(JSON.stringify(message));
  return connection.key;
}

function dataOf(ws: Socket): RunnerSocketData | null {
  const data = ws.data as Partial<RunnerSocketData>;
  if (typeof data.deviceKey !== "string" || !data.deviceKey) return null;
  return {
    kind: "runner",
    deviceKey: data.deviceKey,
    rank: typeof data.rank === "number" ? data.rank : Number.MAX_SAFE_INTEGER,
    deviceName: typeof data.deviceName === "string" ? data.deviceName : null,
    userId: typeof data.userId === "string" ? data.userId : null,
    owner: data.owner === true,
  };
}

function findBySocket(socket: Socket) {
  for (const connection of connections.values()) if (connection.socket === socket) return connection;
  return null;
}

function dropConnection(socket: Socket) {
  const connection = findBySocket(socket);
  if (!connection) return;
  clearInterval(connection.beat.timer);
  connections.delete(connection.key);
  lastSeen.set(connection.key, new Date().toISOString());
  for (const [id, entry] of pending) {
    if (entry.key !== connection.key) continue;
    clearTimeout(entry.timer);
    entry.reject(new MacRunnerUnavailable("O app r/bots desconectou."));
    pending.delete(id);
  }
  for (const [id, stream] of turns) {
    if (stream.key !== connection.key) continue;
    stream.emit({ type: "done", ok: false, message: "O app r/bots fechou no meio do turno." });
    stream.finish();
    turns.delete(id);
  }
  console.log(`${new Date().toISOString()} mac runner disconnected (${connection.key})`);
  notifyChange(false, connection.key);
}

function headersOf(source: unknown, allowed: string[]) {
  const headers: Record<string, string> = {};
  if (!source || typeof source !== "object") return headers;
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (allowed.includes(lower) && typeof value === "string") headers[lower] = value;
  }
  return headers;
}

async function forwardMcp(connection: Connection, message: Record<string, unknown>) {
  const id = typeof message.id === "string" ? message.id : "";
  const path = typeof message.path === "string" ? message.path : "";
  const method = typeof message.method === "string" ? message.method.toUpperCase() : "POST";
  const reply = (status: number, headers: Record<string, string>, body: string) => {
    if (connection.socket.readyState !== socketOpen) return;
    connection.socket.send(JSON.stringify({ type: "mcp.response", id, status, headers, body }));
  };
  if (!mcpPathPattern.test(path) || !["GET", "POST", "DELETE"].includes(method)) {
    reply(404, { "content-type": "application/json" }, JSON.stringify({ ok: false, error: "Rota MCP inválida." }));
    return;
  }
  try {
    const response = await mcpForwarder(path, {
      method,
      headers: headersOf(message.headers, forwardedRequestHeaders),
      ...(method === "POST" && typeof message.body === "string" ? { body: message.body } : {}),
      signal: AbortSignal.timeout(900_000),
    });
    const headers: Record<string, string> = {};
    for (const name of forwardedResponseHeaders) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    reply(response.status, headers, await response.text());
  } catch {
    reply(
      502,
      { "content-type": "application/json" },
      JSON.stringify({ ok: false, error: "O servidor não respondeu ao MCP." }),
    );
  }
}

async function gateFor(
  hooks: NativeToolHooks | undefined,
  frame: HookRequestFrame,
): Promise<NativeToolGate | undefined> {
  if (!hooks) return { allow: false, message: missingHooksMessage };
  const { phase, tool, input, toolUseId, response, failed } = frame;
  try {
    if (phase === "before") return await hooks.before(tool, input, toolUseId);
    await hooks.after(tool, input, response, toolUseId, failed === true);
    return undefined;
  } catch {
    return { allow: false, message: failedHookMessage };
  }
}

async function answerHook(connection: Connection, message: Record<string, unknown>) {
  const reply = (frame: HookResponseFrame) => {
    if (connection.socket.readyState === socketOpen) connection.socket.send(JSON.stringify(frame));
  };
  const frame = hookRequestOf(message);
  if (!frame) {
    if (typeof message.id === "string")
      reply({ type: "hook.response", id: message.id, gate: { allow: false, message: invalidHookMessage } });
    return;
  }
  const stream = turns.get(frame.turnId);
  const gate = await gateFor(stream?.key === connection.key ? stream.hooks : undefined, frame);
  reply({ type: "hook.response", id: frame.id, ...(gate ? { gate } : {}) });
}

function onTurnResponse(connection: Connection, id: string, message: Record<string, unknown>) {
  const stream = turns.get(id);
  if (stream?.key !== connection.key || message.ok !== false) return;
  turns.delete(id);
  const error = typeof message.error === "string" ? message.error : "";
  if (error === capacityRefusal && stream.refuse && !stream.started) {
    stream.refuse();
    return;
  }
  stream.emit({ type: "done", ok: false, message: error || "O ambiente recusou o turno." });
  stream.finish();
}

function onMessage(connection: Connection, raw: string) {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = typeof message.id === "string" ? message.id : "";
  if (message.type === "hello") {
    connection.hello = message;
    connection.runner = runnerOf(message.runner);
    connection.capacity = connection.runner?.capacity ?? null;
    notifyEnvironments();
    return;
  }
  if (message.type === "capacity") {
    connection.capacity = capacityOf(message.capacity) ?? connection.capacity;
    notifyEnvironments();
    return;
  }
  if (message.type === "boxes") {
    connection.boxes = boxesOf(message.boxes) ?? connection.boxes;
    notifyEnvironments();
    return;
  }
  if (message.type === "hook.request") {
    void answerHook(connection, message);
    return;
  }
  if (message.type === "mcp.request") {
    void forwardMcp(connection, message);
    return;
  }
  if (message.type === "response") {
    const entry = pending.get(id);
    if (!entry) {
      onTurnResponse(connection, id, message);
      return;
    }
    if (entry.key !== connection.key) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(message);
    return;
  }
  if (message.type === "turn.event") {
    const stream = turns.get(id);
    if (stream?.key === connection.key && message.event && typeof message.event === "object")
      stream.emit(message.event as ProviderEvent);
    return;
  }
  if (message.type === "turn.end") {
    const stream = turns.get(id);
    if (stream?.key !== connection.key) return;
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

export const runnerSocket: SocketHandler = {
  open(ws) {
    const data = dataOf(ws);
    if (!data) {
      ws.close(4003, "device required");
      return;
    }
    const previous = connections.get(data.deviceKey);
    if (previous && previous.socket !== ws && previous.userId !== data.userId) {
      ws.close(4003, "device conflict");
      return;
    }
    if (previous && previous.socket !== ws) {
      try {
        previous.socket.close(4000, "replaced");
      } catch {}
      dropConnection(previous.socket);
    }
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
    connections.set(data.deviceKey, {
      key: data.deviceKey,
      socket: ws,
      hello: {},
      connectedAt: new Date().toISOString(),
      rank: data.rank,
      name: data.deviceName,
      userId: data.userId,
      owner: data.owner,
      beat,
      runner: null,
      capacity: null,
      boxes: [],
    });
    console.log(`${new Date().toISOString()} mac runner connected (${data.deviceKey})`);
    notifyChange(true, data.deviceKey);
  },
  message(ws, message) {
    const connection = findBySocket(ws);
    if (!connection) return;
    connection.beat.alive = true;
    if (typeof message === "string") onMessage(connection, message);
  },
  pong(ws) {
    const connection = findBySocket(ws);
    if (connection) connection.beat.alive = true;
  },
  close(ws) {
    dropConnection(ws);
  },
};

function request(op: string, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, key?: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new MacRunnerUnavailable("O Mac não respondeu a tempo."));
    }, timeoutMs);
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
      const target = connectionFor(key);
      if (!target) throw new MacRunnerUnavailable("O app r/bots não está conectado.");
      pending.set(id, { key: target.key, resolve, reject, timer });
      send({ type: "request", id, op, ...payload }, target.key);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

export async function macDeviceCall(
  op: string,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
  signal?: AbortSignal,
) {
  if (!macRunnerSupports("simulators")) throw new MacRunnerUnavailable("O app do Mac ainda não controla simuladores.");
  const response = await request(op, { body }, timeoutMs, signal);
  if (response.ok === false) throw new Error(String(response.error ?? "O Mac não conseguiu."));
  return (response.result ?? {}) as Record<string, unknown>;
}

export async function macAccounts(key?: string) {
  const response = await request("accounts", {}, 90_000, undefined, key);
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

function throughProxy(turn: TurnRequest, key: string) {
  if (!turn.mcp || !macRunnerSupports("mcp-proxy", key)) return turn;
  try {
    return { ...turn, mcp: { ...turn.mcp, url: new URL(turn.mcp.url).pathname } };
  } catch {
    return turn;
  }
}

type StreamOptions = {
  target: Connection | null;
  turnId: string;
  signal: AbortSignal;
  emit: (event: ProviderEvent) => void;
  start: (target: Connection) => object;
  missing: string | null;
  hooks?: NativeToolHooks;
};

function streamTurn({ target, turnId, signal, emit, start, missing, hooks }: StreamOptions) {
  return new Promise<RemoteTurnOutcome>((resolve) => {
    let done = false;
    const onAbort = () => {
      try {
        if (target) send({ type: "turn.cancel", id: turnId }, target.key);
      } catch {}
      setTimeout(() => {
        const stream = turns.get(turnId);
        if (!stream) return;
        turns.delete(turnId);
        stream.finish();
      }, 5000).unref();
    };
    const settle = (outcome: RemoteTurnOutcome) => {
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const finish = () => {
      if (!done)
        emit({
          type: "done",
          ok: false,
          message: signal.aborted ? "cancelled" : "O Mac encerrou o turno sem resposta.",
        });
      settle("ran");
    };
    if (!target) {
      if (missing !== null) emit({ type: "done", ok: false, message: missing });
      resolve(missing === null ? "refused" : "ran");
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const stream: TurnStream = {
      key: target.key,
      emit: (event) => {
        stream.started = true;
        if (event.type === "done") done = true;
        emit(event);
      },
      finish,
      started: false,
      ...(hooks ? { hooks } : {}),
      ...(missing === null ? { refuse: () => settle("refused") } : {}),
    };
    turns.set(turnId, stream);
    send(start(target), target.key);
  });
}

export async function runMacTurn(
  turn: TurnRequest,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  key?: string,
) {
  await streamTurn({
    target: connectionFor(key),
    turnId: turn.turnId,
    signal,
    emit,
    missing: key ? "Mac desconectado." : "O app r/bots não está conectado.",
    start: (target) => ({ type: "turn.start", id: turn.turnId, turn: throughProxy(turn, target.key) }),
  });
}

export function runRemoteTurn(
  environmentId: string,
  { turn, botId, box, hooks }: RemoteTurnInput,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
) {
  const found = connectionFor(environmentId);
  const target = found && isBoxRunner(found) ? found : null;
  return streamTurn({
    target,
    turnId: turn.turnId,
    signal,
    emit,
    missing: null,
    hooks,
    start: ({ key }): RemoteTurnStart => ({
      type: "request",
      id: turn.turnId,
      op: "turn.start",
      turnId: turn.turnId,
      botId,
      request: throughProxy(turn, key),
      box,
      hooks: hooks !== undefined,
    }),
  });
}
