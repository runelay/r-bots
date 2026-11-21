import { existsSync, readFileSync } from "node:fs";
import { cpus, homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { EnvironmentCapacity, EnvironmentHello } from "@runelay-bots/protocol";
import { connectUrl } from "./backoff";
import { realClock } from "./clock";
import { RunnerConnection } from "./connection";
import {
  accountRootPrefix,
  boxDefaultMemMb,
  boxMemReserveMb,
  boxPauseAfterMs,
  boxRuntimes,
  boxStopAfterMs,
  defaultBoxImage,
  defaultDockerSocket,
  forbiddenMountHosts,
  kvmPath,
  meminfoPath,
  runnerCapabilities,
  runnerConnectPath,
} from "./constants";
import { DockerSandboxProvider, detectRuntime, imageProviders } from "./docker";
import { DockerApi } from "./docker-api";
import { isRecord, stringOf } from "./json";
import { BoxLifecycle } from "./lifecycle";
import { readMeminfo } from "./meminfo";
import { TurnManager } from "./turns";
import type { Clock, RunnerEnv } from "./types";

export interface RunnerDeps {
  clock: Clock;
  meminfoPath: string;
  kvmPath: string;
  cpus: () => number;
  log: (line: string) => void;
}

const defaultDeps: RunnerDeps = {
  clock: realClock,
  meminfoPath,
  kvmPath,
  cpus: () => cpus().length,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
};

function numberOf(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listOf(value: string | undefined) {
  return (value ?? "").split(":").filter(Boolean);
}

function accountRootsOf(value: string | undefined) {
  const roots = listOf(value);
  const invalid = roots.find((root) => !isAbsolute(root) || !basename(resolve(root)).startsWith(accountRootPrefix));
  if (invalid !== undefined)
    throw new Error(`RBOTS_ACCOUNT_ROOTS só aceita pastas de conta absolutas, como ~/.claude (recebido: ${invalid}).`);
  return roots;
}

function runtimeOf(value: string | undefined) {
  if (!value) return null;
  const found = boxRuntimes.find((name) => name === value);
  if (!found) throw new Error(`RBOTS_RUNTIME inválido: ${value} (use ${boxRuntimes.join(", ")}).`);
  return found;
}

export function tokenReader({ token, tokenFile }: Pick<RunnerEnv, "token" | "tokenFile">) {
  return () => {
    if (!tokenFile) return token;
    try {
      return readFileSync(tokenFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
}

export function readEnv(env: Record<string, string | undefined>): RunnerEnv {
  const { RBOTS_URL: url, RBOTS_DEVICE_TOKEN: token, RBOTS_DEVICE_TOKEN_FILE: tokenFile } = env;
  if (!url) throw new Error("Falta RBOTS_URL.");
  if (!token && !tokenFile) throw new Error("Falta RBOTS_DEVICE_TOKEN_FILE ou RBOTS_DEVICE_TOKEN.");
  return {
    url,
    token: token || null,
    tokenFile: tokenFile || null,
    name: env.RBOTS_RUNNER_NAME || hostname(),
    workspaceRoots: listOf(env.RBOTS_WORKSPACE_ROOTS),
    accountRoots: accountRootsOf(env.RBOTS_ACCOUNT_ROOTS),
    runtime: runtimeOf(env.RBOTS_RUNTIME),
    socketPath: env.DOCKER_SOCKET || defaultDockerSocket,
    image: env.RBOX_IMAGE || defaultBoxImage,
    pauseAfterMs: numberOf(env.BOX_PAUSE_AFTER_MS, boxPauseAfterMs),
    stopAfterMs: numberOf(env.BOX_STOP_AFTER_MS, boxStopAfterMs),
    reserveMb: numberOf(env.BOX_MEM_RESERVE_MB, boxMemReserveMb),
    maxBoxes: env.RBOTS_MAX_BOXES ? numberOf(env.RBOTS_MAX_BOXES, 1) : null,
  };
}

export async function runnerVersion() {
  const pkg: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json();
  return isRecord(pkg) ? stringOf(pkg.version, "0.0.0") : "0.0.0";
}

export async function startRunner(config: RunnerEnv, overrides: Partial<RunnerDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const { clock, log } = deps;
  const { url, name, workspaceRoots, accountRoots, socketPath, image, pauseAfterMs, stopAfterMs, reserveMb } = config;
  const api = new DockerApi(socketPath);
  const kvm = existsSync(deps.kvmPath);
  const choice = await detectRuntime(api, { kvm, forced: config.runtime });
  const { runtime, engine } = choice;
  log(`caixas com o runtime ${runtime} (${engine})`);
  if (runtime === "runc") log("nem Kata nem gVisor (runsc) disponíveis: as caixas rodam com runc");
  const provider = new DockerSandboxProvider({ api, image, choice, log });
  const memory = () => readMeminfo(deps.meminfoPath);
  const outbox: { connection: RunnerConnection | null } = { connection: null };
  const send = (frame: Record<string, unknown>) => outbox.connection?.send(frame) ?? false;
  const lifecycle = new BoxLifecycle({
    provider,
    memory,
    clock,
    pauseAfterMs,
    stopAfterMs,
    reserveMb,
    onChange: (boxes) => send({ type: "boxes", boxes }),
  });
  await lifecycle.init();
  const turns = new TurnManager({
    lifecycle,
    provider,
    send,
    clock,
    workspaceRoots,
    accountRoots,
    forbiddenMounts: [...forbiddenMountHosts, homedir(), ...accountRoots.map((root) => dirname(resolve(root)))],
    log,
  });
  const capacity = async (): Promise<EnvironmentCapacity> => {
    const { totalMb, availableMb } = await memory();
    const { running, paused } = lifecycle.counts();
    return {
      cpus: deps.cpus(),
      memTotalMb: totalMb,
      memFreeMb: availableMb,
      boxesRunning: running,
      boxesPaused: paused,
      maxBoxes: config.maxBoxes ?? Math.max(1, Math.floor((totalMb - reserveMb) / boxDefaultMemMb)),
    };
  };
  const [version, providers] = await Promise.all([runnerVersion(), imageProviders(api, image)]);
  const hello = async (): Promise<EnvironmentHello> => ({
    type: "hello",
    capabilities: runnerCapabilities,
    runner: {
      version,
      name,
      kvm,
      runtime,
      providers,
      workspaceRoots,
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
    onStop: (reason) => {
      log(`runner parado: ${reason}`);
      turns.cancelAll();
      lifecycle.dispose();
      onStopped(reason);
    },
    log,
  });
  outbox.connection = connection;
  connection.start();
  return { connection, lifecycle, turns, stopped, stop: () => connection.stop() };
}
