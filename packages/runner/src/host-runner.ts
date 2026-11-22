import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { cpus, freemem, homedir, totalmem, userInfo } from "node:os";
import type { BoxStatus, EnvironmentCapacity, EnvironmentHello, TurnRequest } from "@runelay-bots/protocol";
import { connectUrl } from "./backoff";
import { realClock } from "./clock";
import { RunnerConnection } from "./connection";
import { boxDefaultMemMb, hostCapabilities, macBootLine, meminfoPath, runnerConnectPath } from "./constants";
import { isWorkspaceSync } from "./guards";
import { writeBeat } from "./health";
import {
  agentScript,
  findOnPath,
  hostAgentArgv,
  hostAgentEnv,
  installedProviders,
  probeHost,
  probeWarnings,
  type RunCode,
  runQuiet,
  spawnAgent,
} from "./host";
import {
  type Capture,
  captureProcess,
  checkoutSync,
  claudeGate,
  findClaude,
  gitRunner,
  homeDirOf,
  macPath,
  macRequest,
  pushSync,
} from "./mac";
import { readMeminfo } from "./meminfo";
import { runnerVersion, tokenReader } from "./runner";
import { TurnManager } from "./turns";
import type { BoxExecHandle, Clock, ExecOptions, GitRun, JsonRecord, MemInfo, PreparedTurn, RunnerEnv } from "./types";

export interface HostRunnerDeps {
  clock: Clock;
  meminfoPath: string;
  cpus: () => number;
  home: string;
  user: string;
  env: Record<string, string | undefined>;
  agentDir: string;
  bun: string;
  exists: (path: string) => boolean;
  run: RunCode;
  spawn: (argv: string[], options: ExecOptions) => BoxExecHandle;
  log: (line: string) => void;
  memory: (path: string) => Promise<MemInfo>;
  capture: Capture;
  gitRunner: (gh: string | null, env: Record<string, string>) => GitRun;
}

const defaultDeps: HostRunnerDeps = {
  clock: realClock,
  meminfoPath,
  cpus: () => cpus().length,
  home: homedir(),
  user: userInfo().username,
  env: process.env,
  agentDir: import.meta.dir,
  bun: process.execPath,
  exists: existsSync,
  run: runQuiet,
  spawn: spawnAgent,
  log: logLine,
  memory: memoryOf,
  capture: captureProcess,
  gitRunner,
};

export async function memoryOf(path: string): Promise<MemInfo> {
  if (existsSync(path)) return readMeminfo(path);
  return { totalMb: Math.floor(totalmem() / 1048576), availableMb: Math.floor(freemem() / 1048576) };
}

export function logLine(line: string) {
  console.log(`${new Date().toISOString()} ${line}`);
}

function idleStatus(botId: string): BoxStatus {
  const now = new Date().toISOString();
  return { botId, state: "running", memMb: 0, startedAt: now, lastUsedAt: now };
}

export function macPrepare(
  config: Pick<RunnerEnv, "workspacesDir">,
  git: GitRun,
  checkClaude: () => Promise<void>,
  exists: (path: string) => boolean,
) {
  return async (request: TurnRequest, frame: JsonRecord): Promise<PreparedTurn> => {
    if (request.provider === "claude") await checkClaude();
    const sync = isWorkspaceSync(frame.sync) ? frame.sync : null;
    const remote = sync?.cwd ?? request.code?.cwd ?? null;
    let local: string | null = null;
    if (sync) local = await checkoutSync(git, config.workspacesDir, sync, exists);
    else if (remote) {
      local = homeDirOf(config.workspacesDir, remote);
      await mkdir(local, { recursive: true });
    }
    const paths = local && remote ? { local, remote } : null;
    return {
      request: macRequest(request, paths, exists),
      paths,
      sync: sync && local ? () => pushSync(git, local, sync) : null,
    };
  };
}

function macAgentEnv(base: Record<string, string | undefined>, home: string, dataDir: string) {
  const env = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return { ...env, HOME: home, PATH: macPath(env.PATH, home), BOTS_DATA_DIR: dataDir };
}

export async function startHostRunner(config: RunnerEnv, overrides: Partial<HostRunnerDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const { clock, log, home, exists } = deps;
  const { url, name, dataDir, reserveMb } = config;
  const mac = config.environment === "mac";
  const probe = mac ? { scope: false, bwrap: false } : await probeHost(deps.run);
  for (const line of mac ? [] : probeWarnings(probe)) log(line);
  const agent = [deps.bun, agentScript(deps.agentDir, exists, config.boxAgent ?? undefined)];
  log(
    mac
      ? `${macBootLine} ${deps.user}, sem systemd e sem bwrap (worktrees em ${config.workspacesDir})`
      : `turnos direto na máquina como ${deps.user} (limites ${probe.scope ? "ligados" : "desligados"}, dados ${probe.bwrap ? "escondidos" : "à vista"})`,
  );
  const baseEnv = mac ? macAgentEnv(deps.env, home, dataDir) : deps.env;
  const claude = mac ? findClaude(config.claudeBin, baseEnv.PATH ?? "", home, exists) : null;
  const env = hostAgentEnv(mac && claude ? { ...baseEnv, CLAUDE_CODE_EXECUTABLE: claude } : baseEnv, dataDir, exists);
  const gh = mac ? findOnPath(["gh"], env.PATH ?? "", exists) : null;
  const git = deps.gitRunner(gh, env);
  const prepare = mac ? macPrepare(config, git, claudeGate(claude, env, deps.capture), exists) : undefined;
  const outbox: { connection: RunnerConnection | null } = { connection: null };
  const send = (frame: Record<string, unknown>) => outbox.connection?.send(frame) ?? false;
  const turns = new TurnManager({
    lifecycle: { acquire: async (botId) => idleStatus(botId), release: () => undefined },
    provider: { exec: (_botId, argv, options) => deps.spawn(argv, options) },
    send,
    clock,
    workspaceRoots: [],
    accountRoots: [],
    forbiddenMounts: [],
    agent: {
      argv: (botId, request, box) => hostAgentArgv({ home, dataDir, agent, probe, exists }, botId, request, box),
      cwd: home,
      env,
      ...(prepare ? { prepare } : {}),
    },
    log,
  });
  const capacity = async (): Promise<EnvironmentCapacity> => {
    const { totalMb, availableMb } = await deps.memory(deps.meminfoPath);
    return {
      cpus: deps.cpus(),
      memTotalMb: totalMb,
      memFreeMb: availableMb,
      boxesRunning: turns.active,
      boxesPaused: 0,
      maxBoxes: config.maxBoxes ?? Math.max(1, Math.floor((totalMb - reserveMb) / boxDefaultMemMb)),
    };
  };
  const hello = async (): Promise<EnvironmentHello> => ({
    type: "hello",
    capabilities: hostCapabilities,
    runner: {
      version: runnerVersion(),
      name,
      kvm: false,
      runtime: "host",
      providers: installedProviders(env.PATH ?? "", dataDir, exists),
      workspaceRoots: [],
      capacity: await capacity(),
      environment: config.environment,
    },
  });
  const { promise: stopped, resolve: onStopped } = Promise.withResolvers<string>();
  const connection = new RunnerConnection({
    url: connectUrl(url, runnerConnectPath),
    token: tokenReader(config),
    clock,
    hello,
    capacity,
    onFrame: (frame) => void turns.handle(frame),
    onClose: () => turns.cancelAll(),
    onBeat: () => writeBeat(config.healthFile),
    onStop: (reason) => {
      log(`runner parado: ${reason}`);
      turns.cancelAll();
      onStopped(reason);
    },
    log,
  });
  outbox.connection = connection;
  connection.start();
  return { connection, turns, probe, stopped, stop: () => connection.stop() };
}
