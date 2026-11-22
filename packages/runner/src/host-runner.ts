import { existsSync } from "node:fs";
import { cpus, homedir, userInfo } from "node:os";
import type { BoxStatus, EnvironmentCapacity, EnvironmentHello } from "@runelay-bots/protocol";
import { connectUrl } from "./backoff";
import { realClock } from "./clock";
import { RunnerConnection } from "./connection";
import { boxDefaultMemMb, hostCapabilities, meminfoPath, runnerConnectPath } from "./constants";
import { writeBeat } from "./health";
import {
  agentScript,
  hostAgentArgv,
  hostAgentEnv,
  installedProviders,
  probeHost,
  probeWarnings,
  type RunCode,
  runQuiet,
  spawnAgent,
} from "./host";
import { readMeminfo } from "./meminfo";
import { runnerVersion, tokenReader } from "./runner";
import { TurnManager } from "./turns";
import type { BoxExecHandle, Clock, ExecOptions, RunnerEnv } from "./types";

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
};

export function logLine(line: string) {
  console.log(`${new Date().toISOString()} ${line}`);
}

function idleStatus(botId: string): BoxStatus {
  const now = new Date().toISOString();
  return { botId, state: "running", memMb: 0, startedAt: now, lastUsedAt: now };
}

export async function startHostRunner(config: RunnerEnv, overrides: Partial<HostRunnerDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const { clock, log, home, exists } = deps;
  const { url, name, dataDir, reserveMb } = config;
  const probe = await probeHost(deps.run);
  for (const line of probeWarnings(probe)) log(line);
  const agent = [deps.bun, agentScript(deps.agentDir, exists, config.boxAgent ?? undefined)];
  log(
    `turnos direto na máquina como ${deps.user} (limites ${probe.scope ? "ligados" : "desligados"}, dados ${probe.bwrap ? "escondidos" : "à vista"})`,
  );
  const env = hostAgentEnv(deps.env, dataDir, exists);
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
    },
    log,
  });
  const capacity = async (): Promise<EnvironmentCapacity> => {
    const { totalMb, availableMb } = await readMeminfo(deps.meminfoPath);
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
      providers: installedProviders(deps.env.PATH ?? "", dataDir, exists),
      workspaceRoots: [],
      capacity: await capacity(),
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
