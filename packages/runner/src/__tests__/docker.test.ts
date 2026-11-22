import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boxName, DockerSandboxProvider, detectRuntime, imageProviders } from "../docker";
import { DockerApi, DockerError } from "../docker-api";
import { specKey } from "../mounts";
import type { RuntimeChoice, RuntimeRequest } from "../types";
import { boxSpec, type ExecIo, FakeDocker, until } from "./helpers";

let docker: FakeDocker;
let api: DockerApi;
const fixed = () => new Date("2026-11-21T02:00:00.000Z");

beforeEach(() => {
  docker = new FakeDocker().start();
  api = new DockerApi(docker.socketPath);
});

afterEach(() => docker.stop());

async function text(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

const gvisor: RuntimeChoice = { runtime: "runsc", engine: "runsc" };
const plainRunc: RuntimeChoice = { runtime: "runc", engine: "runc" };
const auto: RuntimeRequest = { kvm: false, forced: null };

function provider(log: (line: string) => void = () => undefined) {
  return new DockerSandboxProvider({ api, image: "runelay-bots-box:latest", choice: gvisor, now: fixed, log });
}

describe("docker helpers", () => {
  test("detects gVisor and the installed providers", async () => {
    expect(await detectRuntime(api, auto)).toEqual(gvisor);
    docker.runtimes = ["runc"];
    expect(await detectRuntime(api, auto)).toEqual(plainRunc);
    docker.overrides.set("GET /info", { status: 200, body: "plain" });
    expect(await detectRuntime(api, auto)).toEqual(plainRunc);
    expect(await imageProviders(api, "runelay-bots-box:latest")).toEqual(["claude", "codex"]);
    docker.imageLabels = {};
    expect(await imageProviders(api, "img")).toEqual([]);
    docker.imageLabels = null;
    expect(await imageProviders(api, "img")).toEqual([]);
    expect(boxName("bot/1 x")).toBe("rbbox-bot_1_x");
  });

  test("prefers Kata when /dev/kvm exists, honours a forced runtime and refuses a missing one", async () => {
    docker.runtimes = ["io.containerd.runc.v2", "kata-qemu", "runc", "runsc"];
    expect(await detectRuntime(api, { kvm: true, forced: null })).toEqual({ runtime: "kata", engine: "kata-qemu" });
    expect(await detectRuntime(api, auto)).toEqual(gvisor);
    expect(await detectRuntime(api, { kvm: true, forced: "runsc" })).toEqual(gvisor);
    expect(await detectRuntime(api, { kvm: true, forced: "runc" })).toEqual(plainRunc);
    await expect(detectRuntime(api, { kvm: false, forced: "kata" })).rejects.toThrow(
      "RBOTS_RUNTIME=kata não está disponível: o Docker lista io.containerd.runc.v2, kata-qemu, runc, runsc e /dev/kvm não existe.",
    );
    docker.runtimes = [];
    await expect(detectRuntime(api, { kvm: true, forced: "runsc" })).rejects.toThrow(
      "RBOTS_RUNTIME=runsc não está disponível: o Docker lista nenhum e /dev/kvm existe.",
    );
  });

  test("raises DockerError with the engine message or a fallback", async () => {
    docker.overrides.set("GET /info", { status: 500, body: { message: "engine sad" } });
    const error = await detectRuntime(api, auto).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DockerError);
    expect(error).toMatchObject({ message: "engine sad", status: 500 });
    docker.overrides.set("GET /info", { status: 500 });
    await expect(detectRuntime(api, auto)).rejects.toThrow("GET /info: 500");
    const raw = await api.request("GET", "/nope");
    expect(raw).toEqual({ status: 404, body: { message: "rota desconhecida" } });
  });
});

describe("DockerSandboxProvider", () => {
  test("creates the box with limits, binds and no docker socket, then starts it", async () => {
    const spec = boxSpec({
      memMb: 1024,
      cpus: 1.5,
      mounts: [
        { host: "/srv/rb/.claude", box: "/home/app/.claude", readOnly: true },
        { host: "/srv/rb/work", box: "/data/work/x", readOnly: false },
      ],
    });
    const status = await provider().ensure("bot-1", spec);
    expect(status).toEqual({
      botId: "bot-1",
      state: "running",
      memMb: 300,
      startedAt: "2026-11-21T01:00:00.000Z",
      lastUsedAt: "2026-11-21T02:00:00.000Z",
    });
    const config = docker.containers.get("rbbox-bot-1")?.config;
    expect(config).toEqual({
      Image: "runelay-bots-box:latest",
      Entrypoint: ["/usr/local/bin/rbbox-init"],
      Cmd: [],
      WorkingDir: "/data",
      Healthcheck: { Test: ["NONE"] },
      Labels: { "rbots.bot": "bot-1", "rbots.spec": specKey(spec) },
      Env: ["RBOX_SANDBOX_ROOTS=/data/work/x"],
      HostConfig: {
        Runtime: "runsc",
        Memory: 1024 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024,
        NanoCpus: 1_500_000_000,
        PidsLimit: 1024,
        CapDrop: ["ALL"],
        CapAdd: ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL"],
        Binds: ["/srv/rb/.claude:/home/app/.claude:ro", "/srv/rb/work:/data/work/x", "rbbox-cache:/cache"],
        NetworkMode: "bridge",
        Init: true,
      },
    });
    expect(docker.paths()).toContain("POST /containers/rbbox-bot-1/start");
  });

  test("checks the effective memory limit after a cold start and logs any mismatch", async () => {
    const logs: string[] = [];
    const spec = boxSpec({ memMb: 512 });
    const labels = { "rbots.bot": "bot-1", "rbots.spec": specKey(spec) };
    const kata = new DockerSandboxProvider({
      api,
      image: "img",
      choice: { runtime: "kata", engine: "kata-qemu" },
      now: fixed,
      log: (line) => logs.push(line),
    });
    expect(kata.runtime).toBe("kata");
    await kata.ensure("bot-1", spec);
    expect(docker.containers.get("rbbox-bot-1")?.config.HostConfig).toMatchObject({ Runtime: "kata-qemu" });
    const reader = [...docker.execs.values()].find(({ config }) => {
      const command = config.Cmd;
      return Array.isArray(command) && command.includes("/sys/fs/cgroup/memory.max");
    });
    expect(reader?.config).toMatchObject({ User: "app", AttachStdout: true });
    expect(logs).toEqual([]);
    await kata.ensure("bot-1", spec);
    expect(logs).toEqual([]);
    const cases: Array<[string | null, number, string[]]> = [
      [
        null,
        0,
        [
          "caixa bot-1: limite de memória no Docker é desconhecido, pedido 512 MB",
          "caixa bot-1: limite de memória dentro da caixa é ilimitado, pedido 512 MB",
        ],
      ],
      [String(256 * 1024 * 1024), 0, ["caixa bot-1: limite de memória dentro da caixa é 256 MB, pedido 512 MB"]],
      ["lixo", 0, ["caixa bot-1: limite de memória dentro da caixa é lixo, pedido 512 MB"]],
      ["", 0, ["caixa bot-1: limite de memória dentro da caixa não pôde ser lido (/sys/fs/cgroup/memory.max)"]],
      [
        String(512 * 1024 * 1024),
        1,
        ["caixa bot-1: limite de memória dentro da caixa não pôde ser lido (/sys/fs/cgroup/memory.max)"],
      ],
    ];
    for (const [cgroup, exit, expected] of cases) {
      logs.length = 0;
      docker.cgroupMax = cgroup;
      docker.cgroupExit = exit;
      docker.addContainer("rbbox-bot-1", "exited", labels);
      const container = docker.containers.get("rbbox-bot-1");
      if (container && cgroup !== null) container.config = { HostConfig: { Memory: 512 * 1024 * 1024 } };
      await kata.ensure("bot-1", spec);
      expect(logs).toEqual(expected);
    }
    logs.length = 0;
    docker.cgroupMax = null;
    docker.cgroupExit = 0;
    docker.addContainer("rbbox-bot-1", "exited", labels);
    const container = docker.containers.get("rbbox-bot-1");
    if (container) container.config = { HostConfig: { Memory: 1024 * 1024 * 1024 } };
    await kata.ensure("bot-1", spec);
    expect(logs).toEqual([
      "caixa bot-1: limite de memória no Docker é 1024 MB, pedido 512 MB",
      "caixa bot-1: limite de memória dentro da caixa é 1024 MB, pedido 512 MB",
    ]);
  });

  test("reuses, unpauses, restarts or recreates an existing box", async () => {
    const box = provider();
    const spec = boxSpec();
    const labels = { "rbots.bot": "bot-1", "rbots.spec": specKey(spec) };
    docker.addContainer("rbbox-bot-1", "running", labels);
    await box.ensure("bot-1", spec);
    expect(docker.paths().filter((path) => path.startsWith("POST"))).toEqual([]);
    docker.addContainer("rbbox-bot-1", "paused", labels);
    await box.ensure("bot-1", spec);
    expect(docker.paths().at(-3)).toBe("POST /containers/rbbox-bot-1/unpause");
    docker.addContainer("rbbox-bot-1", "exited", labels);
    expect((await box.ensure("bot-1", spec)).state).toBe("running");
    docker.addContainer("rbbox-bot-1", "running", { "rbots.bot": "bot-1", "rbots.spec": "old" });
    await box.ensure("bot-1", spec);
    expect(docker.paths()).toContain("DELETE /containers/rbbox-bot-1?force=true");
    expect(docker.containers.get("rbbox-bot-1")?.labels["rbots.spec"]).toBe(specKey(spec));
  });

  test("recreates an idle box made from another image and keeps a busy one", async () => {
    const logs: string[] = [];
    const box = provider((line) => logs.push(line));
    const spec = boxSpec();
    const labels = { "rbots.bot": "bot-1", "rbots.spec": specKey(spec) };
    docker.addContainer("rbbox-bot-1", "running", labels, { image: "sha256:box-old" });
    await box.ensure("bot-1", spec, { idle: false });
    expect(docker.containers.get("rbbox-bot-1")?.image).toBe("sha256:box-old");
    expect(docker.paths().some((path) => path.startsWith("DELETE"))).toBe(false);
    await box.ensure("bot-1", spec);
    expect(docker.paths()).toContain("DELETE /containers/rbbox-bot-1?force=true");
    expect(docker.containers.get("rbbox-bot-1")).toMatchObject({ image: "sha256:box-current", state: "running" });
    expect(logs).toContain("caixa bot-1: criada de outra imagem, recriando com runelay-bots-box:latest");
  });

  test("pulls the image before creating a box when it is missing", async () => {
    docker.imageLabels = null;
    await provider().ensure("bot-1", boxSpec());
    expect(docker.paths().slice(0, 3)).toEqual([
      "GET /images/runelay-bots-box%3Alatest/json",
      "POST /images/create?fromImage=runelay-bots-box&tag=latest",
      "GET /images/runelay-bots-box%3Alatest/json",
    ]);
    expect(docker.containers.get("rbbox-bot-1")?.state).toBe("running");
  });

  test("cleanup removes stopped boxes that are old or outdated, never busy or running ones", async () => {
    const logs: string[] = [];
    const box = provider((line) => logs.push(line));
    const old = { finishedAt: "2026-11-01T00:00:00.000Z" };
    docker.addContainer("rbbox-old", "exited", { "rbots.bot": "old" }, old);
    docker.addContainer("rbbox-fresh", "exited", { "rbots.bot": "fresh" }, { finishedAt: "2026-11-21T01:00:00.000Z" });
    docker.addContainer("rbbox-never", "created", { "rbots.bot": "never" });
    docker.addContainer("rbbox-outdated", "exited", { "rbots.bot": "outdated" }, { image: "sha256:box-old" });
    docker.addContainer("rbbox-busy", "exited", { "rbots.bot": "busy" }, old);
    docker.addContainer("rbbox-live", "running", { "rbots.bot": "live" }, { ...old, image: "sha256:box-old" });
    docker.addContainer("rbbox-ghost", "exited", { "rbots.bot": "ghost" }, old);
    docker.overrides.set("GET /containers/rbbox-ghost/json", { status: 404 });
    const removed = await box.cleanup({ removeAfterMs: 24 * 60 * 60 * 1000, busy: (botId) => botId === "busy" });
    expect(removed).toEqual(["old", "outdated"]);
    expect([...docker.containers.keys()].sort()).toEqual([
      "rbbox-busy",
      "rbbox-fresh",
      "rbbox-ghost",
      "rbbox-live",
      "rbbox-never",
    ]);
    expect(logs).toEqual(["caixa old removida (parada há muito tempo)", "caixa outdated removida (imagem antiga)"]);
  });

  test("cleanup removes unused box images of the same repository and keeps the current one", async () => {
    const logs: string[] = [];
    const repo = "ghcr.io/runelay/r-bots-box";
    const box = new DockerSandboxProvider({
      api,
      image: `${repo}:0.2.0`,
      choice: gvisor,
      now: fixed,
      log: (line) => logs.push(line),
    });
    docker.addContainer("rbbox-a", "running", { "rbots.bot": "a" }, { image: "sha256:box-used" });
    docker.taggedImages = [
      { Id: "sha256:box-current", RepoTags: [`${repo}:0.2.0`, `${repo}:latest`], Created: 50 },
      { Id: "sha256:box-used", RepoTags: [`${repo}:0.1.0`], Created: 40 },
      { Id: "sha256:box-previous", RepoTags: [`${repo}:0.1.9`], Created: 30 },
      { Id: "sha256:box-before", RepoTags: [`${repo}:0.1.8`], Created: 20 },
      { Id: "sha256:box-locked", RepoTags: [`${repo}:dev`], Created: 10 },
      { Id: "sha256:box-old", RepoTags: [`${repo}:0.0.9`, "mirror.local/box:0.0.9"] },
    ];
    docker.danglingImages = [
      { Id: "sha256:dangling", RepoTags: ["<none>:<none>"] },
      { Id: "sha256:box-current", RepoTags: [] },
      { Id: "sha256:named", RepoTags: ["x:1"] },
    ];
    docker.busyImages.add(`${repo}:dev`);
    expect(await box.cleanup({ removeAfterMs: 1, busy: () => false })).toEqual([]);
    expect(docker.deletedImages).toEqual([`${repo}:0.0.9`, "sha256:dangling"]);
    expect(docker.paths()).toContain(`DELETE /images/${encodeURIComponent(`${repo}:dev`)}`);
    expect(logs).toEqual([
      `imagem de caixa antiga removida: ${repo}:0.0.9`,
      "imagem de caixa antiga removida: sha256:dangling",
    ]);
    docker.deletedImages.length = 0;
    docker.overrides.set("GET /images/json", {
      status: 200,
      body: [1, { Id: "sha256:a", Created: 3 }, { Id: "sha256:b", Created: 2 }, { Id: "sha256:odd", RepoTags: "nope" }],
    });
    docker.overrides.set("GET /containers/json", { status: 200, body: "nope" });
    await box.cleanup({ removeAfterMs: 1, busy: () => false });
    expect(docker.deletedImages).toEqual(["sha256:a", "sha256:b", "sha256:odd"]);
    docker.overrides.set("GET /images/json", { status: 200, body: "nope" });
    await box.cleanup({ removeAfterMs: 1, busy: () => false });
    docker.imageLabels = null;
    docker.overrides.delete("GET /containers/json");
    docker.addContainer("rbbox-b", "exited", { "rbots.bot": "b" }, { image: "sha256:whatever" });
    expect(await box.cleanup({ removeAfterMs: 1e15, busy: () => false })).toEqual([]);
    expect(docker.paths().filter((path) => path.startsWith("GET /images/json"))).toHaveLength(6);
    docker.overrides.set("GET /images/ghcr.io%2Frunelay%2Fr-bots-box%3A0.2.0/json", { status: 500 });
    expect(await box.cleanup({ removeAfterMs: 1e15, busy: () => false })).toEqual([]);
  });

  test("fails when the box cannot be inspected or vanishes", async () => {
    docker.overrides.set("GET /containers/rbbox-bot-1/json", { status: 500 });
    await expect(provider().ensure("bot-1", boxSpec())).rejects.toThrow("GET /containers/rbbox-bot-1/json: 500");
    docker.overrides.delete("GET /containers/rbbox-bot-1/json");
    docker.overrides.set("POST /containers/rbbox-bot-1/start", { status: 204 });
    docker.overrides.set("GET /containers/rbbox-bot-1/json", { status: 404 });
    await expect(provider().ensure("bot-1", boxSpec())).rejects.toThrow("A caixa rbbox-bot-1 sumiu.");
    expect(docker.containers.has("rbbox-bot-1")).toBe(true);
  });

  test("pauses, resumes, stops and lists boxes with memory", async () => {
    const box = provider();
    docker.addContainer("rbbox-a", "running", { "rbots.bot": "a" });
    docker.addContainer("rbbox-b", "paused", { "rbots.bot": "b" });
    docker.addContainer("rbbox-c", "exited", { "rbots.bot": "c" });
    docker.addContainer("rbbox-gone", "running", { "rbots.bot": "gone" });
    docker.overrides.set("GET /containers/rbbox-gone/json", { status: 404 });
    await box.pause("a");
    await box.resume("b");
    await box.stop("c");
    expect(docker.paths()).toEqual([
      "POST /containers/rbbox-a/pause",
      "POST /containers/rbbox-b/unpause",
      "POST /containers/rbbox-c/stop?t=10",
    ]);
    docker.memoryUsage = null;
    docker.overrides.set("GET /containers/rbbox-b/stats", { status: 500 });
    const listed = await box.list();
    expect(listed.map(({ botId, state, memMb }) => [botId, state, memMb])).toEqual([
      ["a", "paused", 0],
      ["b", "running", 0],
      ["c", "stopped", 0],
    ]);
    docker.memoryUsage = 50 * 1024 * 1024;
    docker.overrides.set("GET /containers/json", { status: 200, body: { not: "a list" } });
    expect(await box.list()).toEqual([]);
    docker.overrides.set("GET /containers/json", { status: 200, body: [1, { Labels: {} }] });
    expect(await box.list()).toEqual([]);
    docker.overrides.set("GET /containers/rbbox-a/json", { status: 200, body: { State: 1, Config: 1 } });
    docker.overrides.set("GET /containers/json", { status: 200, body: [{ Labels: { "rbots.bot": "a" } }] });
    expect(await box.list()).toEqual([
      {
        botId: "a",
        state: "stopped",
        memMb: 0,
        startedAt: "2026-11-21T02:00:00.000Z",
        lastUsedAt: "2026-11-21T02:00:00.000Z",
      },
    ]);
    const plain = new DockerSandboxProvider({ api, image: "img", choice: plainRunc, log: () => undefined });
    docker.overrides.set("GET /containers/rbbox-a/json", { status: 200, body: "x" });
    await expect(plain.list()).rejects.toThrow("GET /containers/rbbox-a/json: 200");
    const ghost = plain.exec("ghost", ["true"], { cwd: "/", env: {}, signal: new AbortController().signal });
    expect(await ghost.exited).toBe(125);
  });

  test("execs as app with a hijacked stdin and demuxed stdout and stderr", async () => {
    docker.addContainer("rbbox-bot-1", "running", { "rbots.bot": "bot-1" });
    const big = "x".repeat(8 * 1024 * 1024);
    docker.script = (io: ExecIo) => {
      io.stderr("log line\n");
      io.onLine((line) => {
        if (line.length > 1000) {
          io.stdout(`big ${line.length}\n`);
          io.exit(3);
          return;
        }
        io.stdout(`echo ${line}\n`);
      });
    };
    const handle = provider().exec("bot-1", ["bun", "/opt/rbots/box-agent.js"], {
      cwd: "/data",
      env: { A: "1" },
      signal: new AbortController().signal,
    });
    handle.write("first\n");
    const stdout = text(handle.stdout);
    const stderr = text(handle.stderr);
    await until(() => [...docker.execs.values()].some(({ io }) => io !== null), "exec io");
    handle.write(`${big}\n`);
    expect(await handle.exited).toBe(3);
    expect(await stdout).toBe(`echo first\nbig ${big.length}\n`);
    expect(await stderr).toBe("log line\n");
    const [exec] = docker.execs.values();
    expect(exec?.config).toMatchObject({
      AttachStdin: true,
      User: "app",
      WorkingDir: "/data",
      Env: ["A=1"],
    });
    const command = exec?.config.Cmd;
    expect(Array.isArray(command) && command.slice(0, 4)).toEqual(["setsid", "-w", "sh", "-c"]);
    expect(Array.isArray(command) && command.slice(-2)).toEqual(["bun", "/opt/rbots/box-agent.js"]);
  });

  test("kill runs a root kill of the process group, also from the abort signal", async () => {
    docker.addContainer("rbbox-bot-1", "running", { "rbots.bot": "bot-1" });
    const ready: Array<() => void> = [];
    docker.script = () => {
      for (const resolve of ready.splice(0)) resolve();
    };
    const box = provider();
    const opened = new Promise<void>((resolve) => ready.push(resolve));
    const handle = box.exec("bot-1", ["sleep", "100"], { cwd: "/", env: {}, signal: new AbortController().signal });
    await opened;
    handle.kill();
    handle.kill();
    expect(await handle.exited).toBe(137);
    const killer = [...docker.execs.values()].find(({ config }) => config.User === "root");
    expect(killer?.config.Cmd).toEqual([
      "sh",
      "-c",
      expect.stringMatching(/^kill -KILL -- -"\$\(cat \/tmp\/rbexec-[\w-]+\.pid\)" 2>\/dev\/null; rm -f /),
    ]);
    const controller = new AbortController();
    controller.abort();
    const early = box.exec("bot-1", ["true"], { cwd: "/", env: {}, signal: controller.signal });
    const before = docker.execs.size;
    early.write("queued\n");
    expect(await early.exited).toBe(137);
    expect([...docker.execs.values()].slice(before).map(({ config }) => config.User)).toEqual([]);
  });

  test("kill tolerates a failing kill exec", async () => {
    docker.addContainer("rbbox-bot-1", "running", { "rbots.bot": "bot-1" });
    const box = provider();
    const ready: Array<() => void> = [];
    docker.script = () => {
      for (const resolve of ready.splice(0)) resolve();
    };
    const controller = new AbortController();
    const opened = new Promise<void>((resolve) => ready.push(resolve));
    const handle = box.exec("bot-1", ["sleep", "1"], { cwd: "/", env: {}, signal: controller.signal });
    await opened;
    docker.overrides.set("POST /containers/rbbox-bot-1/exec", { status: 500 });
    controller.abort();
    expect(await handle.exited).toBe(1);
  });

  test("reports engine failures on stderr with exit 125", async () => {
    const box = provider();
    const missing = box.exec("ghost", ["true"], { cwd: "/", env: {}, signal: new AbortController().signal });
    expect(await missing.exited).toBe(125);
    expect(await text(missing.stderr)).toBe("No such container: rbbox-ghost\n");
    docker.addContainer("rbbox-bot-1", "running", { "rbots.bot": "bot-1" });
    docker.hijackStatus = 500;
    const refused = box.exec("bot-1", ["true"], { cwd: "/", env: {}, signal: new AbortController().signal });
    expect(await refused.exited).toBe(125);
    docker.hijackStatus = 0;
    const dropped = box.exec("bot-1", ["true"], { cwd: "/", env: {}, signal: new AbortController().signal });
    expect(await dropped.exited).toBe(125);
    expect(await text(dropped.stderr)).toContain("conexão fechada");
    docker.hijackStatus = 200;
    const plain = box.exec("bot-1", ["true"], { cwd: "/", env: {}, signal: new AbortController().signal });
    expect(await plain.exited).toBe(1);
    docker.hijackStatus = 101;
    docker.overrides.set("POST /containers/rbbox-bot-1/exec", { status: 201, body: "weird" });
    const odd = box.exec("bot-1", ["true"], { cwd: "/", env: {}, signal: new AbortController().signal });
    expect(await odd.exited).toBe(125);
    const offline = new DockerSandboxProvider({
      api: new DockerApi(`${docker.socketPath}.missing`),
      image: "img",
      choice: plainRunc,
      now: fixed,
      log: () => undefined,
    });
    docker.overrides.delete("POST /containers/rbbox-bot-1/exec");
    const lost = offline.exec("bot-1", ["true"], { cwd: "/", env: {}, signal: new AbortController().signal });
    expect(await lost.exited).toBe(125);
  });

  test("hijack fails when the socket does not exist", async () => {
    const offline = new DockerApi(`${docker.socketPath}.missing`);
    await expect(offline.hijack("/exec/x/start", {})).rejects.toBeDefined();
    docker.overrides.set("GET /plain", { status: 200, raw: "not json" });
    expect(await api.request("GET", "/plain")).toEqual({ status: 200, body: "not json" });
    docker.overrides.set("GET /empty", { status: 204 });
    expect(await api.request("GET", "/empty")).toEqual({ status: 204, body: null });
  });
});
