import { spyOn } from "bun:test";
import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runnerSocket } from "../src/modules/accounts/services/mac-runner.service";
import type { Socket } from "../src/shared/ws";
import type { ProcessCall, ProcessReply } from "./fake-process";
import { testDataDir } from "./helpers";

export interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

const probeFormatNames: Record<string, string> = { mov: "mov,mp4,m4a,3gp,3g2,mj2", matroska: "matroska,webm" };

export interface ProbeResult {
  format?: { duration?: string; format_name?: string };
  streams?: ProbeStream[];
}

export interface MediaToolOptions {
  probe?: ProbeResult | ((path: string) => ProbeResult | null) | null;
  pcm?: string | null;
  failOutput?: RegExp;
  pdfText?: string | null;
  outputSize?: number;
}

export function pcmSamples(levels: number[]) {
  const bytes: number[] = [];
  for (const level of levels) {
    const byte = Math.max(1, Math.min(127, Math.round(level)));
    bytes.push(byte, byte);
  }
  return Buffer.from(bytes).toString("latin1");
}

export function mediaTools(initial: MediaToolOptions = {}) {
  const options: MediaToolOptions = { ...initial };
  const calls: ProcessCall[] = [];
  const handler = (call: ProcessCall): ProcessReply | undefined => {
    calls.push(call);
    if (call.command === "ffprobe") {
      const probe = typeof options.probe === "function" ? options.probe(call.args.at(-1) ?? "") : options.probe;
      if (!probe) return { code: 1, stderr: "probe failed" };
      const demuxer = call.args[call.args.indexOf("-f") + 1] ?? "";
      const formatName = probeFormatNames[demuxer] ?? demuxer;
      return { stdout: JSON.stringify({ ...probe, format: { format_name: formatName, ...probe.format } }) };
    }
    if (call.command === "pdftotext") {
      if (options.pdfText === null || options.pdfText === undefined) return { code: 1, stderr: "pdftotext failed" };
      return { stdout: options.pdfText };
    }
    if (call.command === "ffmpeg") {
      if (call.args.includes("s16le")) {
        if (options.pcm === null || options.pcm === undefined) return { code: 1, stderr: "no audio" };
        return { stdout: options.pcm };
      }
      const out = call.args.at(-1) ?? "";
      if (options.failOutput?.test(out)) return { code: 1, stderr: "ffmpeg failed" };
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, "derived");
      if (options.outputSize) truncateSync(out, options.outputSize);
      return {};
    }
    return undefined;
  };
  return { options, calls, handler };
}

export function fastTimers(threshold = 1000) {
  const real = globalThis.setTimeout;
  const delays: number[] = [];
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const wanted = Number(ms ?? 0);
    if (wanted >= threshold) delays.push(wanted);
    return real(callback, wanted >= threshold ? 0 : wanted, ...args);
  }) as unknown as typeof setTimeout);
  return { delays, restore: () => spy.mockRestore() };
}

export function fixtureFile(relativePath: string, content: string | Buffer, size?: number) {
  const path = join(testDataDir(), "fixtures", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (size !== undefined) truncateSync(path, size);
  return path;
}

export type RunnerReply = (op: string, body: Record<string, unknown>) => Record<string, unknown>;

export function connectFakeRunner(capabilities: string[], reply: RunnerReply = () => ({ ok: true })) {
  const requests: Array<{ op: string; body: Record<string, unknown> }> = [];
  const socket = {
    readyState: 1,
    data: {
      kind: "runner",
      deviceKey: "test-mac",
      rank: 1,
      deviceName: "Mac de teste",
      userId: "test-user",
      owner: true,
    },
    send(raw: string) {
      const message = JSON.parse(raw) as { type: string; id: string; op: string; body?: Record<string, unknown> };
      if (message.type !== "request") return;
      const body = message.body ?? {};
      requests.push({ op: message.op, body });
      queueMicrotask(() =>
        runnerSocket.message(
          socket as unknown as Socket,
          JSON.stringify({ type: "response", id: message.id, ...reply(message.op, body) }),
        ),
      );
    },
    close() {},
    ping() {},
    terminate() {},
  };
  runnerSocket.open(socket as unknown as Socket);
  runnerSocket.message(socket as unknown as Socket, JSON.stringify({ type: "hello", capabilities }));
  return {
    requests,
    say(message: unknown) {
      runnerSocket.message(socket as unknown as Socket, JSON.stringify(message));
    },
    close() {
      socket.readyState = 3;
      runnerSocket.close(socket as unknown as Socket, 1000, "");
    },
  };
}
