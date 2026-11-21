import { randomUUID } from "node:crypto";
import type { BoxSpec, BoxState, BoxStatus, Provider } from "@runelay-bots/protocol";
import { providers as knownProviders } from "@runelay-bots/protocol";
import {
  boxBotLabel,
  boxCacheVolume,
  boxCapAdd,
  boxExecUser,
  boxKillUser,
  boxNamePrefix,
  boxPidDir,
  boxPidsLimit,
  boxSandboxRootsEnv,
  boxSpecLabel,
  cgroupMemoryMaxPath,
  imageProvidersLabel,
  kataRuntimePrefix,
} from "./constants";
import { DockerDemuxer } from "./demux";
import { type DockerApi, DockerError, type Hijacked } from "./docker-api";
import { isRecord, stringMap, stringOf } from "./json";
import { bindsOf, specKey } from "./mounts";
import type {
  BoxExecHandle,
  BoxProvider,
  DockerProviderOptions,
  ExecOptions,
  RuntimeChoice,
  RuntimeRequest,
} from "./types";

const megabyte = 1024 * 1024;
const encoder = new TextEncoder();

interface Inspected {
  state: BoxState;
  startedAt: string;
  labels: Record<string, string>;
}

export function boxName(botId: string) {
  return `${boxNamePrefix}${botId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function stateOf(status: string): BoxState {
  if (status === "running") return "running";
  if (status === "paused") return "paused";
  return "stopped";
}

function sizeOf(bytes: number) {
  return `${Math.round(bytes / megabyte)} MB`;
}

export async function detectRuntime(api: DockerApi, { kvm, forced }: RuntimeRequest): Promise<RuntimeChoice> {
  const { body } = await api.expect("GET", "/info", [200]);
  const names = isRecord(body) && isRecord(body.Runtimes) ? Object.keys(body.Runtimes) : [];
  const kata = names.find((name) => name.startsWith(kataRuntimePrefix));
  const kataChoices: RuntimeChoice[] = kvm && kata ? [{ runtime: "kata", engine: kata }] : [];
  const gvisorChoices: RuntimeChoice[] = names.includes("runsc") ? [{ runtime: "runsc", engine: "runsc" }] : [];
  const runc: RuntimeChoice = { runtime: "runc", engine: "runc" };
  const available = [...kataChoices, ...gvisorChoices, runc];
  if (!forced) return available[0] ?? runc;
  const found = available.find(({ runtime }) => runtime === forced);
  if (found) return found;
  const listed = names.join(", ") || "nenhum";
  throw new Error(
    `RBOTS_RUNTIME=${forced} não está disponível: o Docker lista ${listed} e /dev/kvm ${kvm ? "existe" : "não existe"}.`,
  );
}

export async function imageProviders(api: DockerApi, image: string): Promise<Provider[]> {
  const { status, body } = await api.request("GET", `/images/${encodeURIComponent(image)}/json`);
  if (status !== 200 || !isRecord(body) || !isRecord(body.Config)) return [];
  const labels = stringMap(body.Config.Labels);
  const listed = stringOf(labels[imageProvidersLabel])
    .split(",")
    .map((item) => item.trim());
  return knownProviders.filter((name) => listed.includes(name));
}

export class DockerSandboxProvider implements BoxProvider {
  private readonly lastUsed = new Map<string, string>();
  private readonly api: DockerApi;
  private readonly image: string;
  private readonly engine: string;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  readonly runtime: RuntimeChoice["runtime"];

  constructor({ api, image, choice, now = () => new Date(), log }: DockerProviderOptions) {
    this.api = api;
    this.image = image;
    this.runtime = choice.runtime;
    this.engine = choice.engine;
    this.now = now;
    this.log = log;
  }

  private async inspect(name: string): Promise<Inspected | null> {
    const { status, body } = await this.api.request("GET", `/containers/${name}/json`);
    if (status === 404) return null;
    if (status !== 200 || !isRecord(body)) throw new DockerError(`GET /containers/${name}/json: ${status}`, status);
    const state = isRecord(body.State) ? body.State : {};
    const config = isRecord(body.Config) ? body.Config : {};
    return {
      state: stateOf(stringOf(state.Status)),
      startedAt: stringOf(state.StartedAt, this.now().toISOString()),
      labels: stringMap(config.Labels),
    };
  }

  private async memoryOf(name: string) {
    const { status, body } = await this.api.request("GET", `/containers/${name}/stats?stream=false`);
    if (status !== 200 || !isRecord(body) || !isRecord(body.memory_stats)) return 0;
    const { usage } = body.memory_stats;
    return typeof usage === "number" ? Math.round(usage / megabyte) : 0;
  }

  private async statusOf(botId: string): Promise<BoxStatus | null> {
    const name = boxName(botId);
    const found = await this.inspect(name);
    if (!found) return null;
    const { state, startedAt } = found;
    return {
      botId,
      state,
      memMb: state === "stopped" ? 0 : await this.memoryOf(name),
      startedAt,
      lastUsedAt: this.lastUsed.get(botId) ?? startedAt,
    };
  }

  private async create(botId: string, spec: BoxSpec, key: string) {
    const { memMb, cpus, mounts } = spec;
    const writable = mounts.filter(({ readOnly }) => !readOnly).map(({ box }) => box);
    await this.api.expect("POST", `/containers/create?name=${boxName(botId)}`, [201], {
      Image: this.image,
      Labels: { [boxBotLabel]: botId, [boxSpecLabel]: key },
      Env: [`${boxSandboxRootsEnv}=${writable.join(":")}`],
      HostConfig: {
        Runtime: this.engine,
        Memory: memMb * megabyte,
        MemorySwap: memMb * megabyte,
        NanoCpus: Math.round(cpus * 1e9),
        PidsLimit: boxPidsLimit,
        CapDrop: ["ALL"],
        CapAdd: boxCapAdd,
        Binds: [...bindsOf(mounts), boxCacheVolume],
        NetworkMode: "bridge",
        Init: true,
      },
    });
  }

  async ensure(botId: string, spec: BoxSpec): Promise<BoxStatus> {
    const name = boxName(botId);
    const key = specKey(spec);
    const found = await this.inspect(name);
    const stale = found !== null && found.labels[boxSpecLabel] !== key;
    if (stale) await this.api.expect("DELETE", `/containers/${name}?force=true`, [204, 404]);
    const current = stale ? null : found;
    if (!current) await this.create(botId, spec, key);
    if (current?.state === "paused") await this.resume(botId);
    const cold = current?.state !== "running" && current?.state !== "paused";
    if (cold) await this.api.expect("POST", `/containers/${name}/start`, [204, 304]);
    if (cold) await this.verifyMemory(botId, spec.memMb);
    this.lastUsed.set(botId, this.now().toISOString());
    const status = await this.statusOf(botId);
    if (!status) throw new DockerError(`A caixa ${name} sumiu.`, 404);
    return status;
  }

  private async verifyMemory(botId: string, memMb: number) {
    const expected = memMb * megabyte;
    const prefix = `caixa ${botId}: limite de memória`;
    const { body } = await this.api.request("GET", `/containers/${boxName(botId)}/json`);
    const engine = isRecord(body) && isRecord(body.HostConfig) ? body.HostConfig.Memory : null;
    const engineLabel = typeof engine === "number" ? sizeOf(engine) : "desconhecido";
    if (engine !== expected) this.log(`${prefix} no Docker é ${engineLabel}, pedido ${sizeOf(expected)}`);
    const inside = await this.readInBox(botId, ["cat", cgroupMemoryMaxPath]);
    if (inside === null) {
      this.log(`${prefix} dentro da caixa não pôde ser lido (${cgroupMemoryMaxPath})`);
      return;
    }
    const value = Number(inside);
    if (value === expected) return;
    const label = Number.isFinite(value) ? sizeOf(value) : inside;
    this.log(`${prefix} dentro da caixa é ${inside === "max" ? "ilimitado" : label}, pedido ${sizeOf(expected)}`);
  }

  private async readInBox(botId: string, argv: string[]) {
    const { signal } = new AbortController();
    const { stdout, stderr, exited } = this.exec(botId, argv, { cwd: "/", env: {}, signal });
    const [out, , code] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), exited]);
    const value = out.trim();
    return code === 0 && value ? value : null;
  }

  async pause(botId: string) {
    await this.api.expect("POST", `/containers/${boxName(botId)}/pause`, [204]);
  }

  async resume(botId: string) {
    await this.api.expect("POST", `/containers/${boxName(botId)}/unpause`, [204]);
  }

  async stop(botId: string) {
    await this.api.expect("POST", `/containers/${boxName(botId)}/stop?t=10`, [204, 304]);
  }

  async list(): Promise<BoxStatus[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [boxBotLabel] }));
    const { body } = await this.api.expect("GET", `/containers/json?all=true&filters=${filters}`, [200]);
    const ids = (Array.isArray(body) ? body : [])
      .map((item) => (isRecord(item) ? stringOf(stringMap(item.Labels)[boxBotLabel]) : ""))
      .filter(Boolean);
    const statuses = await Promise.all(ids.map((botId) => this.statusOf(botId)));
    return statuses.filter((status): status is BoxStatus => status !== null);
  }

  private async killGroup(name: string, pidFile: string) {
    try {
      const { body } = await this.api.expect("POST", `/containers/${name}/exec`, [201], {
        User: boxKillUser,
        Cmd: ["sh", "-c", `kill -KILL -- -"$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}`],
      });
      const id = isRecord(body) ? stringOf(body.Id) : "";
      await this.api.expect("POST", `/exec/${id}/start`, [200], { Detach: true, Tty: false });
    } catch {}
  }

  exec(botId: string, argv: string[], { cwd, env, signal }: ExecOptions): BoxExecHandle {
    const name = boxName(botId);
    const pidFile = `${boxPidDir}/rbexec-${randomUUID()}.pid`;
    const command = ["setsid", "-w", "sh", "-c", 'echo $$ > "$0"; exec "$@"', pidFile, ...argv];
    const controllers: Partial<Record<"stdout" | "stderr", ReadableStreamDefaultController<Uint8Array>>> = {};
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllers.stdout = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllers.stderr = controller;
      },
    });
    const queued: string[] = [];
    let link: Hijacked | null = null;
    let killing: Promise<void> | null = null;
    let started = false;
    this.lastUsed.set(botId, this.now().toISOString());
    const kill = () => {
      if (killing) return;
      killing = started ? this.killGroup(name, pidFile).finally(() => link?.end()) : Promise.resolve();
    };
    if (signal.aborted) kill();
    const run = async () => {
      if (killing) return 137;
      started = true;
      const { body } = await this.api.expect("POST", `/containers/${name}/exec`, [201], {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: boxExecUser,
        WorkingDir: cwd,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        Cmd: command,
      });
      const id = isRecord(body) ? stringOf(body.Id) : "";
      const opened = await this.api.hijack(`/exec/${id}/start`, { Detach: false, Tty: false });
      link = opened;
      for (const item of queued.splice(0)) opened.write(item);
      if (killing) void this.killGroup(name, pidFile).finally(() => opened.end());
      const demuxer = new DockerDemuxer((kind, chunk) => controllers[kind]?.enqueue(chunk));
      for await (const chunk of opened.stream) demuxer.push(chunk);
      const inspected = await this.api.expect("GET", `/exec/${id}/json`, [200]);
      const code = isRecord(inspected.body) ? inspected.body.ExitCode : null;
      return typeof code === "number" ? code : 1;
    };
    const exited = run()
      .catch((error: unknown) => {
        controllers.stderr?.enqueue(encoder.encode(`${error instanceof Error ? error.message : String(error)}\n`));
        return 125;
      })
      .finally(() => {
        controllers.stdout?.close();
        controllers.stderr?.close();
        signal.removeEventListener("abort", kill);
      });
    signal.addEventListener("abort", kill, { once: true });
    return {
      stdout,
      stderr,
      exited,
      kill,
      write(data: string) {
        if (link) {
          link.write(data);
          return;
        }
        queued.push(data);
      },
    };
  }
}
