import { randomUUID } from "node:crypto";
import type { BoxSpec, BoxState, BoxStatus, Provider } from "@runelay-bots/protocol";
import { providers as knownProviders } from "@runelay-bots/protocol";
import {
  boxBotLabel,
  boxCacheVolume,
  boxCapAdd,
  boxDataDir,
  boxEntrypoint,
  boxExecUser,
  boxHealthcheck,
  boxImagesKept,
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
import { BoxImage } from "./image";
import { isRecord, stringMap, stringOf } from "./json";
import { bindsOf, specKey } from "./mounts";
import type {
  BoxExecHandle,
  BoxProvider,
  CleanupOptions,
  DockerProviderOptions,
  EnsureOptions,
  ExecOptions,
  RuntimeChoice,
  RuntimeRequest,
} from "./types";

const megabyte = 1024 * 1024;
const encoder = new TextEncoder();

interface Inspected {
  state: BoxState;
  startedAt: string;
  finishedAt: string;
  image: string;
  labels: Record<string, string>;
}

interface Listed {
  botId: string;
  state: string;
  imageId: string;
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
  readonly images: BoxImage;

  constructor({ api, image, registryAuth = null, choice, now = () => new Date(), log }: DockerProviderOptions) {
    this.api = api;
    this.image = image;
    this.images = new BoxImage(api, image, registryAuth, log);
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
      finishedAt: stringOf(state.FinishedAt),
      image: stringOf(body.Image),
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
      Entrypoint: boxEntrypoint,
      Cmd: [],
      WorkingDir: boxDataDir,
      Healthcheck: boxHealthcheck,
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

  async ensure(botId: string, spec: BoxSpec, { idle }: EnsureOptions = { idle: true }): Promise<BoxStatus> {
    const name = boxName(botId);
    const key = specKey(spec);
    const imageId = await this.images.ensure();
    const found = await this.inspect(name);
    const outdated = idle && found !== null && found.image !== imageId;
    if (outdated) this.log(`caixa ${botId}: criada de outra imagem, recriando com ${this.image}`);
    const stale = found !== null && (found.labels[boxSpecLabel] !== key || outdated);
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

  private async listed(): Promise<Listed[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [boxBotLabel] }));
    const { body } = await this.api.expect("GET", `/containers/json?all=true&filters=${filters}`, [200]);
    return (Array.isArray(body) ? body : [])
      .filter(isRecord)
      .map((item) => ({
        botId: stringOf(stringMap(item.Labels)[boxBotLabel]),
        state: stringOf(item.State),
        imageId: stringOf(item.ImageID),
      }))
      .filter(({ botId }) => botId !== "");
  }

  async list(): Promise<BoxStatus[]> {
    const ids = (await this.listed()).map(({ botId }) => botId);
    const statuses = await Promise.all(ids.map((botId) => this.statusOf(botId)));
    return statuses.filter((status): status is BoxStatus => status !== null);
  }

  async cleanup({ removeAfterMs, busy }: CleanupOptions) {
    const current = await this.images.current().catch(() => null);
    const removed = await this.pruneBoxes(current, removeAfterMs, busy);
    if (current) await this.pruneImages(current);
    return removed;
  }

  private async pruneBoxes(current: string | null, removeAfterMs: number, busy: (botId: string) => boolean) {
    const removed: string[] = [];
    const cutoff = this.now().getTime() - removeAfterMs;
    for (const { botId, state } of await this.listed()) {
      if (busy(botId) || stateOf(state) !== "stopped") continue;
      const found = await this.inspect(boxName(botId));
      if (!found) continue;
      const finished = Date.parse(found.finishedAt);
      const old = Number.isFinite(finished) && finished > 0 && finished < cutoff;
      const outdated = current !== null && found.image !== current;
      if (!old && !outdated) continue;
      await this.api.expect("DELETE", `/containers/${boxName(botId)}`, [204, 404]);
      this.log(`caixa ${botId} removida (${outdated ? "imagem antiga" : "parada há muito tempo"})`);
      removed.push(botId);
    }
    return removed;
  }

  private async pruneImages(current: string) {
    const { repository } = this.images.ref;
    const containers = await this.api.expect("GET", "/containers/json?all=true", [200]);
    const used = new Set(
      (Array.isArray(containers.body) ? containers.body : []).filter(isRecord).map((item) => stringOf(item.ImageID)),
    );
    const tagged = await this.imagesMatching({ reference: [repository] });
    const dangling = await this.imagesMatching({ dangling: ["true"], label: [imageProvidersLabel] });
    const stale = (id: string) => id !== current && !used.has(id);
    const targets = [
      ...tagged
        .filter(({ id }) => stale(id))
        .sort((left, right) => right.created - left.created)
        .slice(boxImagesKept)
        .flatMap(({ tags }) => tags.filter((tag) => tag.startsWith(`${repository}:`))),
      ...dangling.filter(({ id, tags }) => stale(id) && tags.length === 0).map(({ id }) => id),
    ];
    for (const target of targets) {
      const { status } = await this.api.request("DELETE", `/images/${encodeURIComponent(target)}`);
      if (status === 200) this.log(`imagem de caixa antiga removida: ${target}`);
    }
  }

  private async imagesMatching(filters: Record<string, string[]>) {
    const query = encodeURIComponent(JSON.stringify(filters));
    const { body } = await this.api.expect("GET", `/images/json?filters=${query}`, [200]);
    return (Array.isArray(body) ? body : []).filter(isRecord).map((item) => ({
      id: stringOf(item.Id),
      created: typeof item.Created === "number" ? item.Created : 0,
      tags: (Array.isArray(item.RepoTags) ? item.RepoTags : []).filter(
        (tag): tag is string => typeof tag === "string" && !tag.startsWith("<none>"),
      ),
    }));
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
