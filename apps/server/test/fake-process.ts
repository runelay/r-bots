import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";

export interface ProcessReply {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: NodeJS.ErrnoException;
  hang?: boolean;
}

export interface ProcessCall {
  kind: "spawn" | "execFile" | "Bun.spawn";
  command: string;
  args: string[];
  options: Record<string, unknown>;
  child: FakeChild;
}

export type ProcessHandler = (call: ProcessCall) => ProcessReply | undefined;

let nextPid = 900_000;

export class FakeChild extends EventEmitter {
  readonly pid = nextPid++;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly signals: string[] = [];
  private input = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.input += chunk.toString();
    });
  }

  get written() {
    return this.input;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM") {
    this.signals.push(String(signal));
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.finish({ signal: typeof signal === "string" ? signal : "SIGTERM" });
    return true;
  }

  finish(result: { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string } = {}) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (result.stdout) this.stdout.write(result.stdout);
    if (result.stderr) this.stderr.write(result.stderr);
    this.stdout.end();
    this.stderr.end();
    if (result.signal) this.signalCode = result.signal;
    else this.exitCode = result.code ?? 0;
    queueMicrotask(() => {
      this.emit("exit", this.exitCode, this.signalCode);
      this.emit("close", this.exitCode, this.signalCode);
    });
  }

  unref() {
    return this;
  }

  ref() {
    return this;
  }
}

function subprocessOf(child: FakeChild) {
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code: number | null) => resolve(code ?? 1));
  });
  return {
    pid: child.pid,
    stdin: {
      write: (chunk: string | Uint8Array) => {
        child.stdin.write(chunk);
        return chunk.length;
      },
      flush: () => 0,
      end: () => {
        child.stdin.end();
        return 0;
      },
    },
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    get killed() {
      return child.killed;
    },
    kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
    ref: () => undefined,
    unref: () => undefined,
    child,
  };
}

type Callback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

function splitArgs(rest: unknown[]) {
  const args = Array.isArray(rest[0]) ? (rest.shift() as string[]) : [];
  const callback = typeof rest.at(-1) === "function" ? (rest.pop() as Callback) : null;
  const options = (rest[0] && typeof rest[0] === "object" ? rest[0] : {}) as Record<string, unknown>;
  return { args, options, callback };
}

function missing(command: string): ProcessReply {
  const error = Object.assign(new Error(`fake process: no handler for ${command}`), { code: "ENOENT" });
  return { error, code: 127 };
}

export function fakeProcesses(handler: ProcessHandler) {
  const calls: ProcessCall[] = [];
  const run = (kind: ProcessCall["kind"], command: string, rest: unknown[]) => {
    const { args, options, callback } = splitArgs([...rest]);
    const child = new FakeChild();
    const call: ProcessCall = { kind, command, args, options, child };
    calls.push(call);
    const reply = handler(call) ?? missing(command);
    if (callback) {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const failed =
          reply.error ??
          (code === 0
            ? null
            : (Object.assign(new Error(`exit ${code ?? signal}`), {
                code: code ?? undefined,
                killed: signal !== null,
                signal,
              }) as unknown as NodeJS.ErrnoException));
        callback(failed, stdout, stderr);
      });
    }
    if (reply.error && !callback) queueMicrotask(() => child.emit("error", reply.error));
    if (!reply.hang)
      child.finish({ code: reply.code ?? (reply.error ? 1 : 0), stdout: reply.stdout, stderr: reply.stderr });
    return child;
  };
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, ...rest: unknown[]) =>
    run("spawn", command, rest)) as unknown as typeof childProcess.spawn);
  const execFile = spyOn(childProcess, "execFile").mockImplementation(((command: string, ...rest: unknown[]) =>
    run("execFile", command, rest)) as unknown as typeof childProcess.execFile);
  const bunSpawn = spyOn(Bun, "spawn").mockImplementation(((first: string[] | { cmd: string[] }, second?: unknown) => {
    const [command, ...args] = Array.isArray(first) ? first : first.cmd;
    const options = (Array.isArray(first) ? (second ?? {}) : first) as Record<string, unknown>;
    const child = run("Bun.spawn", command, [args, options]);
    const stdin = options.stdin;
    if (typeof stdin === "string" || stdin instanceof Uint8Array) child.stdin.end(stdin);
    const signal = options.signal as AbortSignal | undefined;
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    if (signal?.aborted) child.kill("SIGTERM");
    return subprocessOf(child);
  }) as unknown as typeof Bun.spawn);
  const fake = {
    calls,
    restore() {
      spawn.mockRestore();
      execFile.mockRestore();
      bunSpawn.mockRestore();
      active.delete(fake);
    },
  };
  active.add(fake);
  return fake;
}

const active = new Set<{ restore(): void }>();

export function restoreProcessFakes() {
  for (const fake of [...active]) fake.restore();
}
