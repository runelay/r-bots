import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { checkHealth } from "../health";
import { readEnv, runnerVersion, startRunner, tokenReader } from "../runner";
import type { RunnerEnv } from "../types";
import { boxSpec, FakeClock, FakeDocker, type FakeServer, fakeServer, tempDir, turnRequest, until } from "./helpers";

describe("readEnv", () => {
  test("requires url and token and applies defaults", () => {
    expect(() => readEnv({})).toThrow("Falta RBOTS_URL.");
    expect(() => readEnv({ RBOTS_URL: "http://x" })).toThrow("Falta RBOTS_DEVICE_TOKEN_FILE ou RBOTS_DEVICE_TOKEN.");
    expect(() => readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", RBOTS_RUNTIME: "lxc" })).toThrow(
      "RBOTS_RUNTIME inválido: lxc (use kata, runsc, runc).",
    );
    expect(() => readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", RBOTS_ACCOUNT_ROOTS: "/home/u" })).toThrow(
      "RBOTS_ACCOUNT_ROOTS só aceita pastas de conta absolutas, como ~/.claude (recebido: /home/u).",
    );
    expect(() => readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", RBOTS_ACCOUNT_ROOTS: ".claude" })).toThrow(
      "(recebido: .claude)",
    );
    expect(readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN_FILE: "/run/t", RBOTS_RUNTIME: "kata" })).toMatchObject({
      token: null,
      tokenFile: "/run/t",
      runtime: "kata",
    });
    expect(readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", BOX_PAUSE_AFTER_MS: "nope" })).toEqual({
      provider: "docker",
      dataDir: join(homedir(), ".local", "share", "runelay-bots"),
      boxAgent: null,
      url: "http://x",
      token: "t",
      tokenFile: null,
      name: hostname(),
      workspaceRoots: [],
      accountRoots: [],
      runtime: null,
      socketPath: "/var/run/docker.sock",
      image: "ghcr.io/runelay/r-bots:dev",
      pauseAfterMs: 120_000,
      stopAfterMs: 1_800_000,
      reserveMb: 1024,
      maxBoxes: null,
      registry: { user: null, token: null },
      removeAfterMs: 604_800_000,
      healthFile: "/tmp/rbots-runner.health",
      environment: "vps",
      workspacesDir: join(homedir(), "runelay-bots", "workspaces"),
      claudeBin: null,
    });
    expect(() => readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", RBOTS_ENVIRONMENT: "lua" })).toThrow(
      "RBOTS_ENVIRONMENT inválido: lua (use vps, mac).",
    );
    expect(
      readEnv({
        RBOTS_URL: "http://x",
        RBOTS_DEVICE_TOKEN: "t",
        RBOTS_ENVIRONMENT: "mac",
        HOME: "/Users/dono",
        RBOTS_CLAUDE_BIN: "/opt/claude",
      }),
    ).toMatchObject({
      environment: "mac",
      workspacesDir: "/Users/dono/runelay-bots/workspaces",
      dataDir: "/Users/dono/runelay-bots/data",
      claudeBin: "/opt/claude",
    });
    expect(
      readEnv({
        RBOTS_URL: "http://x",
        RBOTS_DEVICE_TOKEN: "t",
        RBOTS_ENVIRONMENT: "mac",
        RBOTS_WORKSPACES_DIR: "/w/workspaces",
        BOTS_DATA_DIR: "/d",
      }),
    ).toMatchObject({ workspacesDir: "/w/workspaces", dataDir: "/d" });
    expect(
      readEnv({
        RBOTS_URL: "http://x",
        RBOTS_DEVICE_TOKEN: "t",
        RBOTS_RUNNER_NAME: "vps-2",
        RBOTS_WORKSPACE_ROOTS: "/a::/b",
        RBOTS_ACCOUNT_ROOTS: "/home/u/.claude:/home/u/.codex/",
        DOCKER_SOCKET: "/tmp/d.sock",
        RBOX_IMAGE: "box:1",
        BOX_PAUSE_AFTER_MS: "10",
        BOX_STOP_AFTER_MS: "20",
        BOX_MEM_RESERVE_MB: "30",
        RBOTS_MAX_BOXES: "4",
        RBOTS_REGISTRY_USER: "octo",
        RBOTS_REGISTRY_TOKEN: "ghp_x",
        BOX_REMOVE_AFTER_MS: "40",
        RBOTS_HEALTH_FILE: "/tmp/h",
      }),
    ).toMatchObject({
      registry: { user: "octo", token: "ghp_x" },
      removeAfterMs: 40,
      healthFile: "/tmp/h",
      name: "vps-2",
      workspaceRoots: ["/a", "/b"],
      accountRoots: ["/home/u/.claude", "/home/u/.codex/"],
      pauseAfterMs: 10,
      stopAfterMs: 20,
      reserveMb: 30,
      maxBoxes: 4,
    });
    expect(() => readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", RBOTS_PROVIDER: "vm" })).toThrow(
      "RBOTS_PROVIDER inválido: vm (use docker, host).",
    );
    expect(
      readEnv({
        RBOTS_URL: "http://x",
        RBOTS_DEVICE_TOKEN: "t",
        RBOTS_PROVIDER: "host",
        BOTS_DATA_DIR: "/srv/data",
        RBOTS_BOX_AGENT: "/opt/agent.js",
      }),
    ).toMatchObject({ provider: "host", dataDir: "/srv/data", boxAgent: "/opt/agent.js" });
    expect(readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", RBOTS_VERSION: "0.3.1" }).image).toBe(
      "ghcr.io/runelay/r-bots:0.3.1",
    );
    expect(
      readEnv({ RBOTS_URL: "http://x", RBOTS_DEVICE_TOKEN: "t", RBOTS_VERSION: "0.3.1", RBOX_IMAGE: "box:1" }).image,
    ).toBe("box:1");
  });

  test("reads the token from the env or from a file that may not exist yet", async () => {
    const temp = tempDir("rb-token-");
    const file = `${temp.dir}/box-runner.token`;
    expect(tokenReader({ token: "env", tokenFile: null })()).toBe("env");
    const read = tokenReader({ token: "env", tokenFile: file });
    expect(read()).toBeNull();
    await Bun.write(file, "\n");
    expect(read()).toBeNull();
    await Bun.write(file, "rbk_one\n");
    expect(read()).toBe("rbk_one");
    await Bun.write(file, "rbk_two");
    expect(read()).toBe("rbk_two");
    temp.remove();
  });

  test("reads the package version", () => {
    expect(runnerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("startRunner", () => {
  let docker: FakeDocker;
  let server: FakeServer;
  let temp: ReturnType<typeof tempDir>;

  beforeEach(async () => {
    docker = new FakeDocker().start();
    server = fakeServer();
    temp = tempDir("rb-runner-");
    await Bun.write(`${temp.dir}/meminfo`, "MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\n");
    await Bun.write(`${temp.dir}/kvm`, "");
  });

  afterEach(() => {
    server.stop();
    docker.stop();
    temp.remove();
  });

  function config(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
    return {
      provider: "docker",
      dataDir: temp.dir,
      boxAgent: null,
      url: server.url,
      token: "rbk_device",
      tokenFile: null,
      name: "vps-test",
      workspaceRoots: ["/srv/rb"],
      accountRoots: [],
      runtime: null,
      socketPath: docker.socketPath,
      image: "runelay-bots-box:latest",
      pauseAfterMs: 120_000,
      stopAfterMs: 1_800_000,
      reserveMb: 1024,
      maxBoxes: null,
      registry: { user: null, token: null },
      removeAfterMs: 604_800_000,
      healthFile: `${temp.dir}/health`,
      environment: "vps",
      workspacesDir: `${temp.dir}/workspaces`,
      claudeBin: null,
      ...overrides,
    };
  }

  test("announces itself, runs a turn in a box, reports boxes and capacity, and stops on revoke", async () => {
    const clock = new FakeClock();
    docker.runtimes = ["runc"];
    docker.script = (io) => {
      io.onLine((line) => {
        const message: unknown = JSON.parse(line);
        if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "start") return;
        io.stdout(`${JSON.stringify({ type: "event", event: { type: "text", part: "a", text: "olá" } })}\n`);
        io.stdout(`${JSON.stringify({ type: "event", event: { type: "done", ok: true } })}\n`);
        io.stdout(`${JSON.stringify({ type: "end", ok: true })}\n`);
        io.exit(0);
      });
    };
    expect(checkHealth(`${temp.dir}/health`).ok).toBe(false);
    const runner = await startRunner(config(), {
      clock,
      meminfoPath: `${temp.dir}/meminfo`,
      kvmPath: `${temp.dir}/kvm`,
    });
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    await until(() => checkHealth(`${temp.dir}/health`).ok, "heartbeat");
    expect(hello).toEqual({
      type: "hello",
      capabilities: ["turns", "boxes", "mcp-proxy", "hooks"],
      runner: {
        version: runnerVersion(),
        name: "vps-test",
        kvm: true,
        runtime: "runc",
        providers: ["claude", "codex"],
        workspaceRoots: ["/srv/rb"],
        capacity: {
          cpus: expect.any(Number),
          memTotalMb: 8192,
          memFreeMb: 6144,
          boxesRunning: 0,
          boxesPaused: 0,
          maxBoxes: 3,
        },
      },
    });
    server.send({
      type: "request",
      id: "turn-1",
      op: "turn.start",
      turnId: "turn-1",
      botId: "bot-1",
      request: turnRequest(),
      box: boxSpec(),
      hooks: false,
    });
    await server.waitFor(({ type }) => type === "turn.end", "turn.end");
    expect(server.frames.filter(({ type }) => type === "turn.event" || type === "turn.end")).toEqual([
      { type: "turn.event", id: "turn-1", event: { type: "text", part: "a", text: "olá" } },
      { type: "turn.event", id: "turn-1", event: { type: "done", ok: true } },
      { type: "turn.end", id: "turn-1", ok: true },
    ]);
    const boxes = await server.waitFor(({ type }) => type === "boxes", "boxes");
    expect(boxes).toMatchObject({ type: "boxes", boxes: [{ botId: "bot-1", state: "running", memMb: 300 }] });
    await until(() => runner.turns.active === 0, "turn settled");
    clock.advance(15_000);
    const frame = await server.waitFor(({ type }) => type === "capacity", "capacity");
    expect(frame).toMatchObject({ capacity: { boxesRunning: 1, boxesPaused: 0 } });
    server.sockets[0]?.close(4001, "revoked");
    expect(await runner.stopped).toBe("revoked");
  });

  test("prefers Kata with /dev/kvm, waits for the token file and refuses a forced runtime that is missing", async () => {
    const clock = new FakeClock();
    const logs: string[] = [];
    const tokenFile = `${temp.dir}/runner/box-runner.token`;
    docker.runtimes = ["runc", "runsc", "kata"];
    const roots = { workspaceRoots: ["/srv/rb", "/home/u"], accountRoots: ["/home/u/.claude"] };
    const runner = await startRunner(config({ token: null, tokenFile, ...roots }), {
      clock,
      meminfoPath: `${temp.dir}/meminfo`,
      kvmPath: `${temp.dir}/kvm`,
      log: (line) => logs.push(line),
    });
    expect(server.tokens).toEqual([]);
    expect(clock.delays()).toEqual([21_600_000, 5000]);
    await Bun.write(tokenFile, "rbk_file\n");
    clock.advance(5000);
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toMatchObject({ runner: { runtime: "kata", kvm: true, workspaceRoots: ["/srv/rb", "/home/u"] } });
    expect(server.tokens).toEqual(["rbk_file"]);
    expect(logs).toContain("caixas com o runtime kata (kata)");
    server.send({
      type: "request",
      id: "turn-home",
      op: "turn.start",
      turnId: "turn-home",
      botId: "bot-1",
      request: turnRequest({ turnId: "turn-home" }),
      box: boxSpec({ mounts: [{ host: "/home/u", box: "/h", readOnly: true }] }),
      hooks: false,
    });
    expect(await server.waitFor(({ id }) => id === "turn-home", "refusal")).toMatchObject({ code: "box.mount" });
    runner.stop();
    expect(await runner.stopped).toBe("stopped");
    docker.runtimes = ["runc"];
    await expect(
      startRunner(config({ runtime: "runsc" }), {
        clock: new FakeClock(),
        meminfoPath: `${temp.dir}/meminfo`,
        kvmPath: `${temp.dir}/kvm`,
        log: () => undefined,
      }),
    ).rejects.toThrow("RBOTS_RUNTIME=runsc não está disponível");
  });

  test("uses gVisor when present, pulls a missing box image at boot and stop() ends the runner", async () => {
    docker.imageLabels = null;
    docker.addContainer("rbbox-old", "paused", { "rbots.bot": "old" });
    const logs: string[] = [];
    const runner = await startRunner(config({ maxBoxes: 7, image: "ghcr.io/runelay/r-bots-box:0.2.0" }), {
      clock: new FakeClock(),
      meminfoPath: `${temp.dir}/meminfo`,
      kvmPath: `${temp.dir}/no-kvm`,
      log: (line) => logs.push(line),
    });
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toMatchObject({
      runner: { runtime: "runsc", kvm: false, providers: [], capacity: { maxBoxes: 7, boxesPaused: 1 } },
    });
    expect(docker.paths()).toContain("POST /images/create?fromImage=ghcr.io%2Frunelay%2Fr-bots-box&tag=0.2.0");
    expect(logs).toContain("imagem da caixa ghcr.io/runelay/r-bots-box:0.2.0 pronta (sha256:box-current)");
    runner.stop();
    expect(await runner.stopped).toBe("stopped");
  });

  test("keeps running when the image cannot be pulled, fails turns clearly and sweeps old boxes on a timer", async () => {
    const clock = new FakeClock();
    const logs: string[] = [];
    docker.imageLabels = null;
    docker.pullStatus = 404;
    docker.addContainer("rbbox-gone", "exited", { "rbots.bot": "gone" }, { finishedAt: "2026-01-01T00:00:00.000Z" });
    const runner = await startRunner(config({ registry: { user: null, token: "ghp_secret" } }), {
      clock,
      meminfoPath: `${temp.dir}/meminfo`,
      kvmPath: `${temp.dir}/kvm`,
      log: (line) => logs.push(line),
    });
    expect(logs).toContain(
      "Não consegui baixar a imagem da caixa runelay-bots-box:latest: pull access denied for box. Confira se RBOTS_REGISTRY_TOKEN pode ler pacotes desse registry.",
    );
    expect(docker.containers.has("rbbox-gone")).toBe(false);
    expect(logs).toContain("caixa gone removida (parada há muito tempo)");
    const pull = docker.requests.find(({ path }) => path.startsWith("/images/create"));
    const auth = JSON.parse(Buffer.from(pull?.headers["x-registry-auth"] ?? "", "base64url").toString());
    expect(auth).toEqual({ username: "rbots", password: "ghp_secret", serveraddress: "docker.io" });
    await server.waitFor(({ type }) => type === "hello", "hello");
    server.send({
      type: "request",
      id: "turn-1",
      op: "turn.start",
      turnId: "turn-1",
      botId: "bot-1",
      request: turnRequest(),
      box: boxSpec(),
      hooks: false,
    });
    const refusal = await server.waitFor(({ id }) => id === "turn-1", "refusal");
    expect(refusal).toMatchObject({ ok: false, code: "box.start" });
    expect(String(refusal.error)).toContain("Não consegui baixar a imagem da caixa runelay-bots-box:latest");
    docker.pullStatus = 200;
    docker.overrides.set("GET /containers/json", { status: 500, body: { message: "engine down" } });
    clock.advance(6 * 60 * 60 * 1000);
    await until(() => logs.some((line) => line.startsWith("limpeza")), "cleanup failure");
    expect(logs).toContain("limpeza das caixas falhou: engine down");
    docker.overrides.delete("GET /containers/json");
    docker.imageLabels = {};
    docker.addContainer("rbbox-stale", "exited", { "rbots.bot": "stale" }, { image: "sha256:box-old" });
    clock.advance(6 * 60 * 60 * 1000);
    await until(() => !docker.containers.has("rbbox-stale"), "outdated box removed");
    runner.stop();
    expect(await runner.stopped).toBe("stopped");
  });
});
