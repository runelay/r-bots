import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { childEnv } from "@runelay-bots/providers/proc";
import { codeDataDir, insideWorkspace, type WorkspaceState, waitForInstall } from "./workspace.service";

export interface DevServer {
  id: string;
  workspaceId: string;
  workspacePath: string;
  command: string;
  cwd: string;
  port: number;
  url: string;
  startedAt: string;
  status: "starting" | "running" | "exited" | "stopped";
  exitCode: number | null;
  logFile: string;
  previewToken: string;
  child: ChildProcess | null;
  tail: string[];
}

const servers = new Map<string, DevServer>();
const portBase = Number(process.env.DEV_PORT_BASE ?? 5310);
const portLimit = portBase + 400;
const reserved = new Set<number>();

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

async function freePort(preferred?: number) {
  if (preferred && !reserved.has(preferred) && (await portFree(preferred))) return preferred;
  for (let port = portBase; port < portLimit; port++) {
    if (reserved.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error("Não achei porta livre para o servidor.");
}

function withPort(command: string, port: number) {
  if (/\{port\}/.test(command)) return command.replace(/\{port\}/g, String(port));
  if (/\$PORT\b|--port\b|\s-p\s+\d|PORT=/.test(command)) return command;
  if (/^(npm)\s+run\s+[\w:.-]+/.test(command.trim())) return `${command} -- --port ${port}`;
  if (/^(npm\s+start)\b/.test(command.trim())) return `${command} -- --port ${port}`;
  if (/^(pnpm|yarn|bun)\s+(run\s+)?[\w:.-]+/.test(command.trim()) || /\b(vite|next|astro|wrangler)\b/.test(command))
    return `${command} --port ${port}`;
  return command;
}

function publicServer(server: DevServer) {
  return {
    id: server.id,
    workspaceId: server.workspaceId,
    command: server.command,
    port: server.port,
    url: server.url,
    previewPath: `/preview/${server.workspaceId}/${server.port}/?t=${server.previewToken}`,
    status: server.status,
    exitCode: server.exitCode,
    startedAt: server.startedAt,
  };
}

export type PublicDevServer = ReturnType<typeof publicServer>;

export function devServersOf(workspace: WorkspaceState) {
  return [...servers.values()]
    .filter(
      (server) =>
        server.workspacePath === workspace.path && (server.status === "running" || server.status === "starting"),
    )
    .map(publicServer);
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

function pushTail(server: DevServer, chunk: string) {
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    server.tail.push(line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""));
  }
  if (server.tail.length > 400) server.tail.splice(0, server.tail.length - 400);
}

export async function startDevServer(
  workspace: WorkspaceState,
  input: { cmd: string; port?: number; cwd?: string },
  onExit: (server: PublicDevServer) => void,
) {
  const command = input.cmd.trim();
  if (!command) throw new Error("Diga o comando, por exemplo npm run dev.");
  const cwd = resolve(workspace.path, input.cwd ?? ".");
  if (!insideWorkspace(workspace, cwd)) throw new Error("A pasta do servidor precisa ficar dentro da tarefa.");
  await waitForInstall(workspace);
  const port = await freePort(input.port);
  reserved.add(port);
  const finalCommand = withPort(command, port);
  const id = `dev_${randomBytes(5).toString("hex")}`;
  const logDir = join(codeDataDir, workspace.id, "dev");
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `${port}.log`);
  const out: WriteStream = createWriteStream(logFile, { flags: "a" });
  out.write(`\n$ ${finalCommand}\n`);
  const child = spawn("bash", ["-lc", finalCommand], {
    cwd,
    env: childEnv({
      PORT: String(port),
      HOST: "127.0.0.1",
      BROWSER: "none",
      FORCE_COLOR: "0",
      CI: "",
      NODE_ENV: "development",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const server: DevServer = {
    id,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    command: finalCommand,
    cwd,
    port,
    url: `http://localhost:${port}`,
    startedAt: new Date().toISOString(),
    status: "starting",
    exitCode: null,
    logFile,
    previewToken: randomBytes(18).toString("base64url"),
    child,
    tail: [],
  };
  servers.set(id, server);
  const onData = (data: Buffer) => {
    const text = data.toString("utf8");
    out.write(text);
    pushTail(server, text);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("close", (code) => {
    out.end();
    reserved.delete(port);
    if (server.status !== "stopped") server.status = "exited";
    server.exitCode = code;
    server.child = null;
    onExit(publicServer(server));
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.status === "exited") break;
    if (await portOpen(port)) {
      server.status = "running";
      break;
    }
    await new Promise((done) => setTimeout(done, 700));
  }
  if (server.status === "starting") server.status = "running";
  return { ...publicServer(server), logs: server.tail.slice(-25).join("\n") };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
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
  const child = server.child;
  killGroup(child, "SIGTERM");
  const stopped = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      done(true);
    });
  });
  if (!stopped) killGroup(child, "SIGKILL");
  return publicServer(server);
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

export async function devServerLogs(workspace: WorkspaceState, port: number | undefined, lines: number) {
  const list = serversOf(workspace, port).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const server = list[0];
  if (!server) throw new Error("Nenhum servidor desta tarefa ainda.");
  let text = server.tail.slice(-lines).join("\n");
  if (!text) text = (await readFile(server.logFile, "utf8").catch(() => "")).split("\n").slice(-lines).join("\n");
  return { ...publicServer(server), logs: text.slice(-20_000) };
}

export function stopAllDevServers() {
  for (const server of servers.values()) if (server.child) killGroup(server.child, "SIGTERM");
}
