import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

export const markerVar = "RUNELAY_TURN";
const linux = process.platform === "linux";
const active = new Set<string>();
const scope = `rb${process.env.GATEWAY_PORT ?? "0"}`;
const inContainer = linux && existsSync("/.dockerenv");

function namespaceOf(pid: number | "self") {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
}

interface ProcInfo {
  pid: number;
  ppid: number;
  marker: string | null;
  command: string;
}

function readProc(pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    let marker: string | null = null;
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      const start = environ.indexOf(`${markerVar}=`);
      if (start !== -1) {
        const end = environ.indexOf("\0", start);
        marker = environ.slice(start + markerVar.length + 1, end === -1 ? undefined : end);
      }
    } catch {}
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    return { pid, ppid, marker, command };
  } catch {
    return null;
  }
}

export function listProcs(): ProcInfo[] {
  if (!linux) return [];
  const result: ProcInfo[] = [];
  const own = namespaceOf("self");
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (namespaceOf(pid) !== own) continue;
    const info = readProc(pid);
    if (info) result.push(info);
  }
  return result;
}

function signalAll(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

export function killPids(pids: number[], graceMs = 3000) {
  if (pids.length === 0) return;
  signalAll(pids, "SIGTERM");
  setTimeout(() => signalAll(pids, "SIGKILL"), graceMs).unref();
}

export function killMarked(marker: string, graceMs = 3000) {
  marker = marker.startsWith(`${scope}:`) ? marker : `${scope}:${marker}`;
  const pids = listProcs()
    .filter((proc) => proc.marker === marker)
    .map((proc) => proc.pid);
  killPids(pids, graceMs);
  return pids.length;
}

export function sweepOrphans(extraActive: Iterable<string> = []) {
  if (!linux) return [] as ProcInfo[];
  const keep = new Set([...active, ...extraActive]);
  const victims = listProcs().filter(
    (proc) =>
      (proc.marker?.startsWith(`${scope}:`) && !keep.has(proc.marker)) ||
      (inContainer &&
        proc.marker === null &&
        proc.ppid === 1 &&
        /claude-agent-sdk.*\/claude .*--input-format stream-json/.test(proc.command)),
  );
  killPids(victims.map((proc) => proc.pid));
  return victims;
}

export function spawnMarked(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
    marker: string;
    nice?: number;
    signal?: AbortSignal;
  },
): ChildProcess {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
  const marker = `${scope}:${options.marker}`;
  env[markerVar] = marker;
  active.add(marker);
  const wrapped = linux
    ? spawn(
        "sh",
        [
          "-c",
          `ulimit -c 0; echo 300 > /proc/self/oom_score_adj 2>/dev/null; exec nice -n ${options.nice ?? 5} "$@"`,
          "sh",
          command,
          ...args,
        ],
        {
          cwd: options.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
    : spawn(command, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  wrapped.stderr?.setEncoding("utf8");
  wrapped.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  const cleanup = () => {
    active.delete(marker);
    killMarked(marker, 1500);
  };
  options.signal?.addEventListener(
    "abort",
    () => {
      try {
        wrapped.kill("SIGTERM");
      } catch {}
      cleanup();
    },
    { once: true },
  );
  wrapped.once("exit", (code) => {
    if (code && code !== 0 && stderr.trim())
      console.warn(`claude ${marker} saiu com ${code}: ${stderr.trim().slice(-600)}`);
    cleanup();
  });
  return wrapped;
}

export function activeMarkers() {
  return [...active];
}
