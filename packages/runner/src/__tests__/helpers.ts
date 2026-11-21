import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxSpec, BoxStatus, TurnRequest } from "@runelay-bots/protocol";
import { muxFrame } from "../demux";
import type { BoxExecHandle, Clock, ExecOptions, JsonRecord, TimerHandle } from "../types";

export class FakeClock implements Clock {
  private seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  now = 0;

  after(ms: number, fn: () => void): TimerHandle {
    return this.add(ms, fn, null);
  }

  every(ms: number, fn: () => void): TimerHandle {
    return this.add(ms, fn, ms);
  }

  private add(ms: number, fn: () => void, every: number | null): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn, every });
    return { cancel: () => this.timers.delete(id) };
  }

  delays() {
    return [...this.timers.values()].map(({ at }) => at - this.now);
  }

  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, { at }]) => at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.now = timer.at;
      if (timer.every === null) this.timers.delete(id);
      if (timer.every !== null) timer.at += timer.every;
      timer.fn();
    }
    this.now = target;
  }
}

export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function until(check: () => boolean, label = "condição") {
  for (let index = 0; index < 2000; index++) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error(`tempo esgotado esperando ${label}`);
}

export function turnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn-1",
    provider: "claude",
    model: "claude-haiku-5-5",
    effort: null,
    systemPrompt: "sys",
    prompt: "oi",
    resume: null,
    mcp: { url: "/mcp/bot-1/session-1", token: "tok" },
    workKey: "bot-1/conv",
    ...overrides,
  };
}

export function boxSpec(overrides: Partial<BoxSpec> = {}): BoxSpec {
  return {
    memMb: 512,
    cpus: 1,
    mounts: [{ host: "/srv/rb/work/bot-1", box: "/data/work/bot-1", readOnly: false }],
    ...overrides,
  };
}

export function boxStatus(botId: string, overrides: Partial<BoxStatus> = {}): BoxStatus {
  return {
    botId,
    state: "running",
    memMb: 100,
    startedAt: "2026-11-21T00:00:00.000Z",
    lastUsedAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

export class FakeExec implements BoxExecHandle {
  readonly written: string[] = [];
  killed = 0;
  private out: ReadableStreamDefaultController<Uint8Array> | null = null;
  private err: ReadableStreamDefaultController<Uint8Array> | null = null;
  private resolveExit: (code: number) => void = () => undefined;
  private readonly listeners: Array<(line: JsonRecord) => void> = [];
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.out = controller;
    },
  });
  readonly stderr = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.err = controller;
    },
  });
  readonly exited = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    readonly botId: string,
    readonly argv: string[],
    readonly options: ExecOptions,
  ) {}

  write(line: string) {
    this.written.push(line);
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      for (const listener of this.listeners) listener(Object.fromEntries(Object.entries(parsed)));
  }

  onWrite(listener: (line: JsonRecord) => void) {
    this.listeners.push(listener);
  }

  messages() {
    return this.written.map((line): unknown => JSON.parse(line));
  }

  emit(message: unknown) {
    this.out?.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  raw(text: string) {
    this.out?.enqueue(new TextEncoder().encode(text));
  }

  log(text: string) {
    this.err?.enqueue(new TextEncoder().encode(text));
  }

  exit(code: number) {
    this.out?.close();
    this.err?.close();
    this.resolveExit(code);
  }

  kill() {
    this.killed += 1;
    this.exit(137);
  }
}

interface ExecRecord {
  id: string;
  container: string;
  config: JsonRecord;
  exitCode: number | null;
  io: ExecIo | null;
}

export interface ExecIo {
  config: JsonRecord;
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
}

export interface Container {
  name: string;
  state: string;
  labels: Record<string, string>;
  config: JsonRecord;
  startedAt: string;
}

interface FakeRoute {
  status: number;
  body?: unknown;
  raw?: string;
}

const reasons: Record<number, string> = { 101: "UPGRADED", 200: "OK", 201: "Created", 204: "No Content" };

export class FakeDocker {
  readonly requests: Array<{ method: string; path: string; body: unknown }> = [];
  readonly containers = new Map<string, Container>();
  readonly execs = new Map<string, ExecRecord>();
  readonly overrides = new Map<string, FakeRoute>();
  runtimes: string[] = ["runc", "runsc"];
  imageLabels: Record<string, string> | null = { "rbots.providers": "claude,codex,bogus" };
  memoryUsage: number | null = 300 * 1024 * 1024;
  hijackStatus = 101;
  cgroupMax: string | null = null;
  cgroupExit = 0;
  script: (io: ExecIo) => void = (io) => io.exit(0);
  private seq = 0;
  private listener: ReturnType<typeof Bun.listen> | null = null;
  readonly socketPath: string;
  private readonly temp = tempDir("rb-docker-");

  constructor() {
    this.socketPath = join(this.temp.dir, "docker.sock");
  }

  start() {
    const fake = this;
    this.listener = Bun.listen<{
      buffer: Buffer;
      io: ExecIo | null;
      lines: string;
      onLine: Array<(line: string) => void>;
      onClose: Array<() => void>;
    }>({
      unix: this.socketPath,
      socket: {
        open(socket) {
          socket.data = { buffer: Buffer.alloc(0), io: null, lines: "", onLine: [], onClose: [] };
        },
        data(socket, chunk) {
          const state = socket.data;
          if (state.io) {
            state.lines += chunk.toString();
            let index = state.lines.indexOf("\n");
            while (index >= 0) {
              const text = state.lines.slice(0, index);
              state.lines = state.lines.slice(index + 1);
              for (const listener of state.onLine) listener(text);
              index = state.lines.indexOf("\n");
            }
            return;
          }
          state.buffer = Buffer.concat([state.buffer, chunk]);
          for (;;) {
            const end = state.buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            const head = state.buffer.subarray(0, end).toString();
            const [requestLine, ...headerLines] = head.split("\r\n");
            const length = Number(
              headerLines.find((item) => item.toLowerCase().startsWith("content-length:"))?.split(":")[1] ?? 0,
            );
            if (state.buffer.length < end + 4 + length) return;
            const bodyText = state.buffer.subarray(end + 4, end + 4 + length).toString();
            state.buffer = state.buffer.subarray(end + 4 + length);
            const [method, target] = requestLine.split(" ");
            const body: unknown = bodyText ? JSON.parse(bodyText) : null;
            fake.requests.push({ method, path: target, body });
            const hijack = fake.hijackFor(method, target, body);
            if (hijack && fake.hijackStatus === 0) {
              socket.end();
              return;
            }
            if (hijack) {
              socket.write(
                `HTTP/1.1 ${fake.hijackStatus} ${reasons[fake.hijackStatus] ?? "X"}\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n`,
              );
              if (fake.hijackStatus !== 101) {
                socket.end();
                return;
              }
              const io: ExecIo = {
                config: hijack.config,
                stdout: (text) => socket.write(muxFrame(1, new TextEncoder().encode(text))),
                stderr: (text) => socket.write(muxFrame(2, new TextEncoder().encode(text))),
                exit: (code) => {
                  hijack.exitCode = code;
                  socket.end();
                },
                onLine: (listener) => state.onLine.push(listener),
                onClose: (listener) => state.onClose.push(listener),
              };
              state.io = io;
              hijack.io = io;
              const command = hijack.config.Cmd;
              if (Array.isArray(command) && command.includes("/sys/fs/cgroup/memory.max")) {
                fake.readCgroup(hijack.container, io);
                return;
              }
              fake.script(io);
              return;
            }
            const { status, body: reply, raw } = fake.route(method, target, body);
            const text = raw ?? (reply === undefined ? "" : JSON.stringify(reply));
            socket.write(
              `HTTP/1.1 ${status} ${reasons[status] ?? "X"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
            );
          }
        },
        close(socket) {
          for (const listener of socket.data.onClose) listener();
        },
      },
    });
    return this;
  }

  stop() {
    this.listener?.stop(true);
    this.temp.remove();
  }

  addContainer(name: string, state: string, labels: Record<string, string>) {
    this.containers.set(name, { name, state, labels, config: {}, startedAt: "2026-11-21T00:00:00.000Z" });
  }

  paths() {
    return this.requests.map(({ method, path }) => `${method} ${path}`);
  }

  private readCgroup(name: string, io: ExecIo) {
    const host = this.containers.get(name)?.config.HostConfig;
    const memory = typeof host === "object" && host !== null && "Memory" in host ? host.Memory : null;
    io.stdout(`${this.cgroupMax ?? (typeof memory === "number" ? String(memory) : "max")}\n`);
    io.exit(this.cgroupExit);
  }

  private hijackFor(method: string, target: string, body: unknown) {
    const match = target.match(/^\/exec\/([^/]+)\/start$/);
    if (method !== "POST" || !match) return null;
    const detached = typeof body === "object" && body !== null && "Detach" in body && body.Detach === true;
    if (detached) return null;
    return this.execs.get(match[1]) ?? null;
  }

  private route(method: string, target: string, body: unknown): FakeRoute {
    const url = new URL(target, "http://docker");
    const override = this.overrides.get(`${method} ${url.pathname}`);
    if (override) return override;
    const path = url.pathname;
    if (method === "GET" && path === "/info")
      return { status: 200, body: { Runtimes: Object.fromEntries(this.runtimes.map((name) => [name, {}])) } };
    if (method === "GET" && path.startsWith("/images/"))
      return this.imageLabels ? { status: 200, body: { Config: { Labels: this.imageLabels } } } : { status: 404 };
    if (method === "GET" && path === "/containers/json")
      return {
        status: 200,
        body: [...this.containers.values()].map(({ labels, state }) => ({ Labels: labels, State: state })),
      };
    const container = path.match(/^\/containers\/([^/]+)(?:\/([a-z]+))?$/);
    if (method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      const config = typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {};
      const labels = config.Labels;
      this.containers.set(name, {
        name,
        state: "created",
        labels: typeof labels === "object" && labels !== null ? Object.fromEntries(Object.entries(labels)) : {},
        config,
        startedAt: "0001-01-01T00:00:00Z",
      });
      return { status: 201, body: { Id: name } };
    }
    if (container) return this.containerRoute(method, container[1], container[2] ?? "", body);
    const exec = path.match(/^\/exec\/([^/]+)\/(start|json)$/);
    if (exec) return this.execRoute(exec[1], exec[2]);
    return { status: 404, body: { message: "rota desconhecida" } };
  }

  private containerRoute(method: string, name: string, action: string, body: unknown): FakeRoute {
    const container = this.containers.get(name);
    if (!container) return { status: 404, body: { message: `No such container: ${name}` } };
    if (method === "GET" && action === "json")
      return {
        status: 200,
        body: {
          State: { Status: container.state, StartedAt: container.startedAt },
          Config: { Labels: container.labels },
          HostConfig: container.config.HostConfig ?? {},
        },
      };
    if (method === "GET" && action === "stats")
      return { status: 200, body: this.memoryUsage === null ? {} : { memory_stats: { usage: this.memoryUsage } } };
    if (method === "DELETE") {
      this.containers.delete(name);
      return { status: 204 };
    }
    if (action === "start") {
      if (container.state === "running") return { status: 304 };
      container.state = "running";
      container.startedAt = "2026-11-21T01:00:00.000Z";
      return { status: 204 };
    }
    if (action === "pause") {
      container.state = "paused";
      return { status: 204 };
    }
    if (action === "unpause") {
      container.state = "running";
      return { status: 204 };
    }
    if (action === "stop") {
      container.state = "exited";
      return { status: 204 };
    }
    const id = `exec-${++this.seq}`;
    const config = typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {};
    this.execs.set(id, { id, container: name, config, exitCode: null, io: null });
    return { status: 201, body: { Id: id } };
  }

  private execRoute(id: string, action: string): FakeRoute {
    const exec = this.execs.get(id);
    if (!exec) return { status: 404, body: { message: "no such exec" } };
    if (action === "json") return { status: 200, body: { ExitCode: exec.exitCode } };
    const command = exec.config.Cmd;
    const script = Array.isArray(command) ? String(command[2] ?? "") : "";
    const pidFile = script.match(/cat (\S+)\)/)?.[1];
    for (const other of this.execs.values()) {
      const cmd = other.config.Cmd;
      if (pidFile && Array.isArray(cmd) && cmd.includes(pidFile)) other.io?.exit(137);
    }
    return { status: 200 };
  }
}

export interface FakeServer {
  port: number;
  url: string;
  frames: JsonRecord[];
  sockets: Array<Bun.ServerWebSocket<undefined>>;
  tokens: string[];
  accept: (token: string) => number;
  onOpen: (socket: Bun.ServerWebSocket<undefined>) => void;
  waitFor(predicate: (frame: JsonRecord) => boolean, label?: string): Promise<JsonRecord>;
  send(frame: JsonRecord): void;
  stop(): void;
}

export function fakeServer(): FakeServer {
  const state: FakeServer = {
    port: 0,
    url: "",
    frames: [],
    sockets: [],
    tokens: [],
    accept: () => 101,
    onOpen: () => undefined,
    async waitFor(predicate, label = "frame") {
      await until(() => state.frames.some(predicate), label);
      const found = state.frames.find(predicate);
      if (!found) throw new Error(label);
      return found;
    },
    send(frame) {
      for (const socket of state.sockets) socket.send(JSON.stringify(frame));
    },
    stop: () => undefined,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      state.tokens.push(token);
      const verdict = state.accept(token);
      if (verdict === 101 && srv.upgrade(request, { data: undefined })) return undefined;
      return new Response("no", { status: verdict });
    },
    websocket: {
      open(socket) {
        state.sockets.push(socket);
        state.onOpen(socket);
      },
      message(_socket, message) {
        const parsed: unknown = JSON.parse(String(message));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
          state.frames.push(Object.fromEntries(Object.entries(parsed)));
      },
      close(socket) {
        state.sockets = state.sockets.filter((item) => item !== socket);
      },
    },
  });
  state.port = server.port ?? 0;
  state.url = `http://127.0.0.1:${state.port}`;
  state.stop = () => server.stop(true);
  return state;
}
