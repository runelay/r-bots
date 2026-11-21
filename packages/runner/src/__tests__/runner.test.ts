import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
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
      url: "http://x",
      token: "t",
      tokenFile: null,
      name: hostname(),
      workspaceRoots: [],
      accountRoots: [],
      runtime: null,
      socketPath: "/var/run/docker.sock",
      image: "runelay-bots-box:latest",
      pauseAfterMs: 120_000,
      stopAfterMs: 1_800_000,
      reserveMb: 1024,
      maxBoxes: null,
    });
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
      }),
    ).toMatchObject({
      name: "vps-2",
      workspaceRoots: ["/a", "/b"],
      accountRoots: ["/home/u/.claude", "/home/u/.codex/"],
      pauseAfterMs: 10,
      stopAfterMs: 20,
      reserveMb: 30,
      maxBoxes: 4,
    });
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

  test("reads the package version", async () => {
    expect(await runnerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
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
    const runner = await startRunner(config(), {
      clock,
      meminfoPath: `${temp.dir}/meminfo`,
      kvmPath: `${temp.dir}/kvm`,
    });
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toEqual({
      type: "hello",
      capabilities: ["turns", "boxes", "mcp-proxy", "hooks"],
      runner: {
        version: await runnerVersion(),
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
    expect(clock.delays()).toEqual([5000]);
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

  test("uses gVisor when present and stop() ends the runner", async () => {
    docker.imageLabels = null;
    docker.addContainer("rbbox-old", "paused", { "rbots.bot": "old" });
    const runner = await startRunner(config({ maxBoxes: 7 }), {
      clock: new FakeClock(),
      meminfoPath: `${temp.dir}/meminfo`,
      kvmPath: `${temp.dir}/no-kvm`,
    });
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toMatchObject({
      runner: { runtime: "runsc", kvm: false, providers: [], capacity: { maxBoxes: 7, boxesPaused: 1 } },
    });
    runner.stop();
    expect(await runner.stopped).toBe("stopped");
  });
});
