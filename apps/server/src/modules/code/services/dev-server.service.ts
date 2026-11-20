import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { childEnv } from "@runelay-bots/providers/proc";
import type { Subprocess } from "bun";
import { env } from "../../../config/env";
import { redactText } from "../../../shared/redact";
import { hostHome } from "./repos.service";
import { killSandboxed, sandboxArgv, sandboxMarker, sandboxMode, sandboxProblem } from "./sandbox.service";
import { codeDataDir, type WorkspaceState, waitForInstall } from "./workspace.service";

export type ServerStatus = "starting" | "running" | "exited" | "stopped";

export interface ServerTarget {
  key: string;
  kind: "workspace" | "project";
  path: string;
  name: string;
  branch: string | null;
}

export interface LaunchInput {
  cmd: string;
  port?: number;
  cwd?: string;
  env?: Record<string, string>;
  envKeys?: string[];
  secrets?: string[];
  tool?: string | null;
  script?: string | null;
  profileId?: string | null;
  startedBy?: "bot" | "user";
  botId?: string | null;
  sessionId?: string | null;
  before?: () => Promise<unknown>;
}

export interface DevServer {
  id: string;
  workspaceId: string;
  workspacePath: string;
  target: ServerTarget;
  input: LaunchInput;
  baseCommand: string;
  command: string;
  cwd: string;
  port: number;
  url: string;
  tool: string;
  startedAt: string;
  endedAt: string | null;
  status: ServerStatus;
  exitCode: number | null;
  logFile: string;
  previewToken: string;
  child: Subprocess<"ignore", "pipe", "pipe"> | null;
  done: Promise<void>;
  tail: string[];
  raw: string[];
  onExit: (server: PublicDevServer) => void;
  marker: string | null;
  expiry: ReturnType<typeof setTimeout> | null;
}

type ChangeListener = (server: PublicDevServer, removed: boolean) => void;
type LogListener = (lines: string[]) => void;

export const devLimits = {
  perWorkspace: Number(process.env.CODE_DEV_SERVER_MAX ?? 3),
  maxMinutes: Number(process.env.CODE_DEV_SERVER_MAX_MIN ?? 240),
};

const servers = new Map<string, DevServer>();
const changeListeners = new Set<ChangeListener>();
const logListeners = new Map<string, Set<LogListener>>();
const portBase = env.DEV_PORT_BASE;
const portLimit = portBase + 400;
const reserved = new Set<number>();
const rawLimit = 2000;
const stoppedTtlMs = 10 * 60_000;

function portFree(port: number) {
  return new Promise<boolean>((done) => {
    const server = net.createServer();
    server.once("error", () => done(false));
    server.listen({ port, host: "0.0.0.0" }, () => server.close(() => done(true)));
  });
}

async function portOpen(port: number) {
  return (await probe(port, "127.0.0.1")) || (await probe(port, "::1"));
}

function probe(port: number, host: string) {
  return new Promise<boolean>((done) => {
    const socket = net.connect({ port, host });
    const finish = (value: boolean) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function usable(port: number) {
  return (await portFree(port)) && !(await portOpen(port));
}

async function freePort(preferred?: number) {
  if (preferred && !reserved.has(preferred) && (await usable(preferred))) return preferred;
  for (let port = portBase; port < portLimit; port++) {
    if (reserved.has(port)) continue;
    if (await usable(port)) return port;
  }
  throw new Error("Não achei porta livre para o servidor.");
}

function localFlags(command: string, tool: string) {
  if (tool === "wrangler" && !/--ip\b/.test(command)) return " --ip 127.0.0.1";
  if (tool === "next" && !/--hostname\b|\s-H\s/.test(command)) return " --hostname 127.0.0.1";
  if (tool === "expo" && !/--localhost\b|--lan\b|--tunnel\b|--host\b/.test(command)) return " --localhost";
  return "";
}

function withPort(command: string, port: number, tool = toolOf(command)) {
  const local = localFlags(command, tool);
  if (/\{port\}/.test(command)) return command.replace(/\{port\}/g, String(port)) + local;
  if (/\$PORT\b|--port\b|\s-p\s+\d|PORT=/.test(command)) return command + local;
  const trimmed = command.trim();
  if (/^npm\s+(run\s+[\w:.-]+|start)\s+(.*\s)?--(\s|$)/.test(trimmed)) return `${command} --port ${port}${local}`;
  if (/^npm\s+(run\s+[\w:.-]+|start)\b/.test(trimmed)) return `${command} -- --port ${port}${local}`;
  if (/^(pnpm|yarn|bun)\s+(run\s+)?[\w:.-]+/.test(trimmed) || /\b(vite|next|astro|wrangler|expo)\b/.test(command))
    return `${command} --port ${port}${local}`;
  return command + local;
}

const tools: Array<[RegExp, string]> = [
  [/\bexpo\b|\breact-native\b/, "expo"],
  [/\bwrangler\b/, "wrangler"],
  [/\bvite\b/, "vite"],
  [/\bnext\b/, "next"],
  [/\bastro\b/, "astro"],
  [/\bremix\b/, "remix"],
  [/\bnuxt\b/, "nuxt"],
  [/\bstorybook\b/, "storybook"],
  [/\bbun\b/, "bun"],
  [/\bdeno\b/, "deno"],
  [/\bpython3?\b|\buvicorn\b|\bflask\b|\bdjango\b/, "python"],
  [/\bcargo\b/, "rust"],
  [/\bgo\s+run\b/, "go"],
  [/\b(node|npm|pnpm|yarn|npx|tsx)\b/, "node"],
];

export function toolOf(...texts: Array<string | null | undefined>) {
  for (const text of texts) {
    if (!text) continue;
    for (const [pattern, name] of tools) if (pattern.test(text)) return name;
  }
  return "process";
}

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const publicBind =
  /(--host(name)?|--ip|--bind|-H|-b)(=|\s+)(0\.0\.0\.0|::|\[::\]|\*)(\s|$)|\bHOST=(0\.0\.0\.0|::)|--host(\s*$|\s+-)/;

export function withHost(command: string) {
  if (publicBind.test(command))
    throw new Error("O servidor de desenvolvimento só pode ouvir em 127.0.0.1. Tire o --host 0.0.0.0 do comando.");
  if (/(--host(name)?|--ip|--bind|\s-H)(=|\s)/.test(command)) return command;
  if (/\b(vite|astro)\b/.test(command)) return `${command} --host 127.0.0.1`;
  if (/\bnext\b/.test(command)) return `${command} -H 127.0.0.1`;
  if (/\bwrangler\b/.test(command)) return `${command} --ip 127.0.0.1`;
  return command;
}

function publicServer(server: DevServer) {
  return {
    id: server.id,
    workspaceId: server.workspaceId,
    kind: server.target.kind,
    name: server.target.name,
    branch: server.target.branch,
    path: server.target.path,
    cwd: relative(server.target.path, server.cwd),
    command: server.command,
    tool: server.tool,
    script: server.input.script ?? null,
    profileId: server.input.profileId ?? null,
    startedBy: server.input.startedBy ?? "bot",
    botId: server.input.botId ?? null,
    sessionId: server.input.sessionId ?? null,
    envKeys: server.input.envKeys ?? [],
    port: server.port,
    url: server.url,
    previewPath: `/preview/${server.workspaceId}/${server.port}/?t=${server.previewToken}`,
    status: server.status,
    exitCode: server.exitCode,
    startedAt: server.startedAt,
    endedAt: server.endedAt,
  };
}

export type PublicDevServer = ReturnType<typeof publicServer>;

function notify(server: DevServer, removed = false) {
  const view = publicServer(server);
  for (const listener of changeListeners) listener(view, removed);
}

export function onServerChange(listener: ChangeListener) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function onServerLog(id: string, listener: LogListener) {
  let set = logListeners.get(id);
  if (!set) {
    set = new Set();
    logListeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) logListeners.delete(id);
  };
}

export function devServersOf(workspace: WorkspaceState) {
  return [...servers.values()]
    .filter(
      (server) =>
        server.workspacePath === workspace.path && (server.status === "running" || server.status === "starting"),
    )
    .map(publicServer);
}

function prune() {
  const now = Date.now();
  for (const server of servers.values()) {
    if (server.status !== "stopped" || !server.endedAt) continue;
    if (now - Date.parse(server.endedAt) > stoppedTtlMs) {
      servers.delete(server.id);
      notify(server, true);
    }
  }
}

export function listServers() {
  prune();
  return [...servers.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(publicServer);
}

export function getServer(id: string) {
  return servers.get(id) ?? null;
}

export function viewServer(server: DevServer) {
  return publicServer(server);
}

export function previewTarget(workspaceId: string, port: number) {
  const server = [...servers.values()].find(
    (item) => item.workspaceId === workspaceId && item.port === port && item.status === "running",
  );
  return server ? { port: server.port, token: server.previewToken } : null;
}

export function findPreviewByToken(token: string) {
  const server = [...servers.values()].find((item) => item.previewToken === token && item.status === "running");
  return server ? { port: server.port, workspaceId: server.workspaceId, token: server.previewToken } : null;
}

export function portOwner(port: number) {
  return (
    [...servers.values()].find(
      (item) => item.port === port && (item.status === "running" || item.status === "starting"),
    ) ?? null
  );
}

function hideSecrets(server: DevServer, text: string) {
  let out = redactText(text);
  for (const secret of server.input.secrets ?? []) if (out.includes(secret)) out = out.split(secret).join("••••");
  return out;
}

function pushLines(server: DevServer, chunk: string) {
  const lines = hideSecrets(server, chunk)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return;
  for (const line of lines) {
    server.raw.push(line);
    server.tail.push(line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""));
  }
  if (server.tail.length > 400) server.tail.splice(0, server.tail.length - 400);
  if (server.raw.length > rawLimit) server.raw.splice(0, server.raw.length - rawLimit);
  for (const listener of logListeners.get(server.id) ?? []) listener(lines);
}

function sandboxed(server: DevServer) {
  return server.target.kind === "workspace" && sandboxMode() === "uid";
}

function expires(server: DevServer) {
  return server.target.kind === "workspace" || server.input.startedBy === "bot";
}

function armExpiry(server: DevServer) {
  disarmExpiry(server);
  if (!expires(server)) return;
  server.expiry = setTimeout(() => void stopDevServer(server), devLimits.maxMinutes * 60_000);
  server.expiry.unref();
}

function disarmExpiry(server: DevServer) {
  if (server.expiry) clearTimeout(server.expiry);
  server.expiry = null;
}

function spawnInto(server: DevServer, out: WriteStream) {
  out.write(`\n$ ${server.command}\n`);
  const env = childEnv({
    ...(server.input.env ?? {}),
    ...(server.target.kind === "project" ? { XDG_CONFIG_HOME: join(hostHome, ".config") } : {}),
    PORT: String(server.port),
    HOST: "127.0.0.1",
    BROWSER: "none",
    FORCE_COLOR: server.target.kind === "project" ? "1" : "0",
    NODE_ENV: "development",
  });
  delete env.NAPI_RS_NATIVE_LIBRARY_PATH;
  if (!server.input.env?.CI) delete env.CI;
  server.marker = sandboxed(server) ? sandboxMarker("dev", server.id) : null;
  const argv = server.marker
    ? sandboxArgv({
        cwd: server.cwd,
        command: server.command,
        marker: server.marker,
        timeoutSec: devLimits.maxMinutes * 60 + 60,
        env: {
          PORT: String(server.port),
          HOST: "127.0.0.1",
          BROWSER: "none",
          FORCE_COLOR: "0",
          NODE_ENV: "development",
        },
      })
    : ["bash", "-lc", server.command];
  const child = Bun.spawn(argv, {
    cwd: server.cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  server.child = child;
  const onData = (data: Buffer) => {
    const text = data.toString("utf8");
    out.write(hideSecrets(server, text));
    pushLines(server, text);
  };
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    try {
      for await (const chunk of stream) onData(Buffer.from(chunk));
    } catch {}
  };
  armExpiry(server);
  server.done = Promise.all([pump(child.stdout), pump(child.stderr), child.exited]).then(() => {
    out.end();
    reserved.delete(server.port);
    disarmExpiry(server);
    if (server.status !== "stopped") server.status = "exited";
    server.exitCode = child.exitCode;
    server.endedAt = new Date().toISOString();
    server.child = null;
    notify(server);
    server.onExit(publicServer(server));
  });
}

export function wildcardListeners(text: string) {
  const ports = new Set<number>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== "0A") continue;
    const [address, port] = fields[1].split(":");
    if (/^0+$/.test(address)) ports.add(Number.parseInt(port, 16));
  }
  return ports;
}

export async function listensEverywhere(port: number) {
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (wildcardListeners(text).has(port)) return true;
  }
  return false;
}

async function guardExposure(server: DevServer) {
  if (server.target.kind !== "project" || !(await listensEverywhere(server.port))) return;
  pushLines(
    server,
    `r/bots: parei o servidor porque ele abriu a porta ${server.port} para todas as redes. Rode com --host 127.0.0.1 (ou o equivalente da ferramenta).`,
  );
  await stopDevServer(server);
  server.status = "exited";
  notify(server);
}

async function waitReady(server: DevServer, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.status !== "starting") break;
    if (await portOpen(server.port)) {
      server.status = "running";
      notify(server);
      break;
    }
    await new Promise((done) => setTimeout(done, 700));
  }
  if (server.status === "starting") {
    server.status = "running";
    notify(server);
  }
  if (server.status === "running") await guardExposure(server);
  return { ...publicServer(server), logs: server.tail.slice(-25).join("\n") };
}

async function openLog(server: DevServer) {
  const logDir = join(codeDataDir, server.workspaceId, "dev");
  await mkdir(logDir, { recursive: true });
  server.logFile = join(logDir, `${server.port}.log`);
  return createWriteStream(server.logFile, { flags: "a" });
}

export async function launchServer(
  target: ServerTarget,
  input: LaunchInput,
  onExit: (server: PublicDevServer) => void = () => undefined,
) {
  const command = input.cmd.trim();
  if (!command) throw new Error("Diga o comando, por exemplo npm run dev.");
  const cwd = resolve(target.path, input.cwd ?? ".");
  if (!within(target.path, cwd))
    throw new Error(
      target.kind === "workspace"
        ? "A pasta do servidor precisa ficar dentro da tarefa."
        : "A pasta do servidor precisa ficar dentro do projeto.",
    );
  if (target.kind === "workspace") {
    const problem = await sandboxProblem();
    if (problem) throw new Error(problem);
    const running = [...servers.values()].filter(
      (item) => item.workspacePath === target.path && (item.status === "running" || item.status === "starting"),
    ).length;
    if (running >= devLimits.perWorkspace)
      throw new Error(
        `Já há ${devLimits.perWorkspace} servidores rodando nesta tarefa. Pare um com dev_server_stop antes de subir outro.`,
      );
  }
  const hosted = withHost(command);
  if (input.before) await input.before();
  const port = await freePort(input.port);
  reserved.add(port);
  const server: DevServer = {
    id: `dev_${randomBytes(5).toString("hex")}`,
    workspaceId: target.key,
    workspacePath: target.path,
    target,
    input: { ...input, cmd: command },
    baseCommand: hosted,
    command: withPort(hosted, port, input.tool ?? toolOf(command)),
    cwd,
    port,
    url: `http://localhost:${port}`,
    tool: input.tool ?? toolOf(command),
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "starting",
    exitCode: null,
    logFile: "",
    previewToken: randomBytes(18).toString("base64url"),
    child: null,
    done: Promise.resolve(),
    tail: [],
    raw: [],
    onExit,
    marker: null,
    expiry: null,
  };
  const out = await openLog(server);
  servers.set(server.id, server);
  spawnInto(server, out);
  notify(server);
  return { server, ready: waitReady(server) };
}

export async function startDevServer(
  workspace: WorkspaceState,
  input: { cmd: string; port?: number; cwd?: string },
  onExit: (server: PublicDevServer) => void,
) {
  const target: ServerTarget = {
    key: workspace.id,
    kind: "workspace",
    path: workspace.path,
    name: workspace.repoName,
    branch: workspace.branch,
  };
  const { ready } = await launchServer(target, { ...input, before: () => waitForInstall(workspace) }, onExit);
  return ready;
}

function killGroup(child: Subprocess, signal: NodeJS.Signals) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export async function stopDevServer(server: DevServer) {
  if (!server.child) return publicServer(server);
  server.status = "stopped";
  disarmExpiry(server);
  const child = server.child;
  if (server.marker) await killSandboxed(server.marker);
  killGroup(child, "SIGTERM");
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
  if (!stopped) killGroup(child, "SIGKILL");
  return publicServer(server);
}

export async function restartServer(server: DevServer) {
  if (server.child) {
    await stopDevServer(server);
    await server.done;
  }
  const port = await freePort(server.port);
  reserved.add(port);
  server.port = port;
  server.command = withPort(server.baseCommand, port, server.tool);
  server.url = `http://localhost:${port}`;
  server.status = "starting";
  server.exitCode = null;
  server.endedAt = null;
  server.startedAt = new Date().toISOString();
  server.previewToken = randomBytes(18).toString("base64url");
  const out = await openLog(server);
  spawnInto(server, out);
  notify(server);
  return { server, ready: waitReady(server) };
}

export function forgetServer(server: DevServer) {
  if (server.child) return false;
  servers.delete(server.id);
  notify(server, true);
  return true;
}

export function serversOf(workspace: WorkspaceState, port?: number) {
  return [...servers.values()].filter(
    (server) => server.workspacePath === workspace.path && (port === undefined || server.port === port),
  );
}

export async function stopDevServers(workspace: WorkspaceState, port?: number) {
  const targets = serversOf(workspace, port).filter((server) => server.child);
  return Promise.all(targets.map(stopDevServer));
}

export function rawLines(server: DevServer, lines: number, query?: string) {
  const needle = query?.trim().toLowerCase();
  const source = needle
    ? server.raw.filter((line) =>
        line
          .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
          .toLowerCase()
          .includes(needle),
      )
    : server.raw;
  return source.slice(-lines);
}

export async function devServerLogs(workspace: WorkspaceState, port: number | undefined, lines: number) {
  const list = serversOf(workspace, port).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const server = list[0];
  if (!server) throw new Error("Nenhum servidor desta tarefa ainda.");
  return serverLogs(server, lines);
}

export async function serverLogs(server: DevServer, lines: number, query?: string) {
  let text = query
    ? rawLines(server, lines, query)
        .map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""))
        .join("\n")
    : server.tail.slice(-lines).join("\n");
  if (!text && !query)
    text = (await readFile(server.logFile, "utf8").catch(() => "")).split("\n").slice(-lines).join("\n");
  return { ...publicServer(server), logs: text.slice(-20_000) };
}

export function stopAllDevServers() {
  for (const server of servers.values()) {
    if (!server.child) continue;
    if (server.marker) void killSandboxed(server.marker);
    killGroup(server.child, "SIGTERM");
  }
}
