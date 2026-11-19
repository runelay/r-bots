import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { activeMarkers, killMarked, killPids, listProcs, markerVar, spawnMarked, sweepOrphans } from "../proc-tree";

const containerSpecifier = "../proc-tree.ts?container";
const darwinSpecifier = "../proc-tree.ts?darwin";
const scope = `rb${process.env.GATEWAY_PORT}`;

interface FakeProc {
  ppid: number;
  cmdline: string;
  environ?: string | null;
  stat?: boolean;
  ns?: string | null;
}

const realReadFileSync = fs.readFileSync;
const realReadlinkSync = fs.readlinkSync;
const realReaddirSync = fs.readdirSync;

function fakeProcFs(table: Record<number, FakeProc>) {
  const entry = (path: string) => table[Number(path.split("/")[2])];
  spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) =>
    String(path) === "/proc"
      ? ["self", "net", String(process.pid), ...Object.keys(table)]
      : (realReaddirSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.readdirSync);
  spyOn(fs, "readlinkSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    const text = String(path);
    if (text === "/proc/self/ns/pid") return "pid:[1]";
    if (!text.startsWith("/proc/")) return (realReadlinkSync as (...args: unknown[]) => unknown)(path, ...rest);
    const proc = entry(text);
    if (!proc || proc.ns === null) throw new Error("ENOENT");
    return proc.ns ?? "pid:[1]";
  }) as typeof fs.readlinkSync);
  spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const text = String(path);
    if (!text.startsWith("/proc/")) return (realReadFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    const pid = Number(text.split("/")[2]);
    const proc = entry(text);
    if (text.endsWith("/stat")) {
      if (!proc || proc.stat === false) throw new Error("ENOENT");
      return `${pid} (some (odd) name) S ${proc.ppid} 1 1 0`;
    }
    if (text.endsWith("/environ")) {
      if (proc.environ === null || proc.environ === undefined) throw new Error("EACCES");
      return proc.environ;
    }
    return proc.cmdline;
  }) as typeof fs.readFileSync);
}

function exited(child: ChildProcess) {
  return new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
  });
}

describe("proc-tree", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  test("listProcs reads pid, parent, marker and command from /proc", () => {
    fakeProcFs({
      101: { ppid: 1, cmdline: "node\0server.js\0", environ: `A=1\0${markerVar}=${scope}:t1\0B=2\0` },
      102: { ppid: 101, cmdline: "tail\0", environ: `${markerVar}=${scope}:t2` },
      103: { ppid: 101, cmdline: "secret\0", environ: null },
      104: { ppid: 1, cmdline: "other-ns", ns: "pid:[9]" },
      105: { ppid: 1, cmdline: "gone-ns", ns: null },
      106: { ppid: 1, cmdline: "gone", stat: false },
    });
    expect(listProcs()).toEqual([
      { pid: 101, ppid: 1, marker: `${scope}:t1`, command: "node server.js" },
      { pid: 102, ppid: 101, marker: `${scope}:t2`, command: "tail" },
      { pid: 103, ppid: 101, marker: null, command: "secret" },
    ]);
  });

  test("killMarked signals matching processes and escalates after the grace period", () => {
    jest.useFakeTimers();
    fakeProcFs({
      201: { ppid: 1, cmdline: "a", environ: `${markerVar}=${scope}:turn` },
      202: { ppid: 1, cmdline: "b", environ: `${markerVar}=${scope}:other` },
      203: { ppid: 1, cmdline: "c", environ: `${markerVar}=${scope}:turn` },
    });
    const sent: Array<[number, string]> = [];
    spyOn(process, "kill").mockImplementation(((pid: number, signal: string) => {
      sent.push([pid, signal]);
      if (pid === 203) throw new Error("ESRCH");
      return true;
    }) as typeof process.kill);
    expect(killMarked("turn", 50)).toBe(2);
    expect(sent).toEqual([
      [201, "SIGTERM"],
      [203, "SIGTERM"],
    ]);
    jest.advanceTimersByTime(50);
    expect(sent.slice(2)).toEqual([
      [201, "SIGKILL"],
      [203, "SIGKILL"],
    ]);
    expect(killMarked(`${scope}:other`)).toBe(1);
  });

  test("killPids ignores an empty list", () => {
    const kill = spyOn(process, "kill");
    killPids([]);
    expect(kill).not.toHaveBeenCalled();
  });

  test("sweepOrphans kills scoped markers that are not active", () => {
    fakeProcFs({
      301: { ppid: 1, cmdline: "orphan", environ: `${markerVar}=${scope}:dead` },
      302: { ppid: 1, cmdline: "kept", environ: `${markerVar}=${scope}:alive` },
      303: { ppid: 1, cmdline: "foreign", environ: `${markerVar}=rbother:dead` },
      304: { ppid: 1, cmdline: "node_modules/@anthropic-ai/claude-agent-sdk/x/claude --input-format stream-json" },
    });
    const kill = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const victims = sweepOrphans([`${scope}:alive`]);
    expect(victims.map((proc) => proc.pid)).toEqual([301]);
    expect(kill).toHaveBeenCalledWith(301, "SIGTERM");
  });

  test("sweepOrphans in a container also kills unmarked SDK processes adopted by init", async () => {
    spyOn(fs, "existsSync").mockImplementation((path: fs.PathLike) => String(path) === "/.dockerenv");
    const containerTree = (await import(containerSpecifier)) as typeof import("../proc-tree");
    fakeProcFs({
      401: { ppid: 1, cmdline: "node_modules/@anthropic-ai/claude-agent-sdk/x/claude --input-format stream-json" },
      402: { ppid: 77, cmdline: "node_modules/@anthropic-ai/claude-agent-sdk/x/claude --input-format stream-json" },
      403: { ppid: 1, cmdline: "bash" },
    });
    spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    expect(containerTree.sweepOrphans().map((proc: { pid: number }) => proc.pid)).toEqual([401]);
  });

  test("outside linux there is no process table and children spawn directly", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const darwinTree = (await import(darwinSpecifier)) as typeof import("../proc-tree");
    expect(darwinTree.listProcs()).toEqual([]);
    expect(darwinTree.sweepOrphans()).toEqual([]);
    const child = darwinTree.spawnMarked("sh", ["-c", `printf "$${markerVar}"`], { env: {}, marker: "direct" });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    expect(darwinTree.activeMarkers()).toContain(`${scope}:direct`);
    expect(await exited(child)).toBe(0);
    expect(out).toBe(`${scope}:direct`);
    expect(darwinTree.activeMarkers()).not.toContain(`${scope}:direct`);
  });

  test("spawnMarked tags the real child, tracks it and killMarked stops it", async () => {
    const child = spawnMarked("sleep", ["30"], {
      cwd: "/",
      env: { PATH: process.env.PATH, UNSET: undefined },
      marker: "real",
      nice: 1,
    });
    const marker = `${scope}:real`;
    expect(activeMarkers()).toContain(marker);
    const found = listProcs().find((proc) => proc.pid === child.pid);
    expect(found?.marker).toBe(marker);
    expect(found?.command).toBe("sleep 30");
    expect(killMarked("real", 0)).toBe(1);
    await exited(child);
    expect(activeMarkers()).not.toContain(marker);
  });

  test("spawnMarked stops the child when the signal aborts", async () => {
    const controller = new AbortController();
    const child = spawnMarked("sleep", ["30"], {
      env: { PATH: process.env.PATH },
      marker: "abort",
      signal: controller.signal,
    });
    controller.abort();
    await exited(child);
    expect(child.signalCode).toBe("SIGTERM");
    expect(activeMarkers()).not.toContain(`${scope}:abort`);
  });

  test("spawnMarked swallows kill errors on abort", async () => {
    const controller = new AbortController();
    const child = spawnMarked("true", [], {
      env: { PATH: process.env.PATH },
      marker: "kill-error",
      signal: controller.signal,
    });
    await exited(child);
    spyOn(child, "kill").mockImplementation(() => {
      throw new Error("gone");
    });
    expect(() => controller.abort()).not.toThrow();
  });

  test("spawnMarked warns with stderr when the child fails", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = spawnMarked("sh", ["-c", "echo boom >&2; exit 3"], {
      env: { PATH: process.env.PATH },
      marker: "fail",
    });
    expect(await exited(failing)).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("boom");
    const quiet = spawnMarked("sh", ["-c", "exit 4"], { env: { PATH: process.env.PATH }, marker: "quiet" });
    expect(await exited(quiet)).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
