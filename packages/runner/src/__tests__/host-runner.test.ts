import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { checkHealth } from "../health";
import { logLine, memoryOf, startHostRunner } from "../host-runner";
import { readEnv, runnerVersion } from "../runner";
import type { ExecOptions, GitResult, RunnerEnv } from "../types";
import { boxSpec, FakeClock, FakeExec, type FakeServer, fakeServer, tempDir, turnRequest, until } from "./helpers";

const agentSource = `
const reader = Bun.stdin.stream().getReader();
let text = "";
while (!text.includes("\\n")) {
  const { value, done } = await reader.read();
  if (done) break;
  text += new TextDecoder().decode(value);
}
const start = JSON.parse(text.split("\\n")[0]);
const writer = Bun.stdout.writer();
const out = (message) => writer.write(JSON.stringify(message) + "\\n");
console.error("agent up");
out({ type: "event", event: { type: "text", part: "a", text: [process.env.BOTS_DATA_DIR, process.cwd(), start.request.turnId].join("|") } });
out({ type: "event", event: { type: "done", ok: true } });
out({ type: "end", ok: true });
await writer.flush();
process.exit(0);
`;

describe("logLine", () => {
  test("prefixes the line with the time", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    logLine("oi");
    expect(log.mock.calls[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* oi$/);
    log.mockRestore();
  });
});

describe("startHostRunner", () => {
  let server: FakeServer;
  let temp: ReturnType<typeof tempDir>;

  beforeEach(async () => {
    server = fakeServer();
    temp = tempDir("rb-host-runner-");
    await Bun.write(`${temp.dir}/meminfo`, "MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\n");
    await Bun.write(`${temp.dir}/agent.ts`, agentSource);
  });

  afterEach(() => {
    server.stop();
    temp.remove();
  });

  function config(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
    return {
      ...readEnv({ RBOTS_URL: server.url, RBOTS_DEVICE_TOKEN: "rbk_device", RBOTS_PROVIDER: "host" }),
      name: "vps",
      dataDir: `${temp.dir}/data`,
      boxAgent: `${temp.dir}/agent.ts`,
      healthFile: `${temp.dir}/health`,
      ...overrides,
    };
  }

  test("announces host, runs the agent directly as this user and reports capacity", async () => {
    const clock = new FakeClock();
    const logs: string[] = [];
    const runs: string[][] = [];
    const runner = await startHostRunner(config(), {
      clock,
      meminfoPath: `${temp.dir}/meminfo`,
      home: temp.dir,
      user: "dono",
      env: { PATH: `${temp.dir}/bin:${process.env.PATH ?? ""}` },
      run: async (argv) => {
        runs.push(argv);
        return 1;
      },
      log: (line) => logs.push(line),
    });
    expect(runner.probe).toEqual({ scope: false, bwrap: false });
    expect(logs.filter((line) => line.startsWith("aviso:"))).toHaveLength(2);
    expect(logs).toContain("turnos direto na máquina como dono (limites desligados, dados à vista)");
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toEqual({
      type: "hello",
      capabilities: ["turns", "host", "mcp-proxy", "hooks"],
      runner: {
        version: runnerVersion(),
        name: "vps",
        kvm: false,
        runtime: "host",
        providers: expect.any(Array),
        workspaceRoots: [],
        capacity: {
          cpus: expect.any(Number),
          memTotalMb: 8192,
          memFreeMb: 6144,
          boxesRunning: 0,
          boxesPaused: 0,
          maxBoxes: 3,
        },
        environment: "vps",
      },
    });
    await until(() => checkHealth(`${temp.dir}/health`).ok, "heartbeat");
    server.send({
      type: "request",
      id: "turn-1",
      op: "turn.start",
      turnId: "turn-1",
      botId: "bot-1",
      request: turnRequest(),
      box: boxSpec({ mounts: [] }),
      hooks: false,
    });
    await server.waitFor(({ type }) => type === "turn.end", "turn.end");
    expect(server.frames.filter(({ type }) => type === "turn.event" || type === "turn.end")).toEqual([
      {
        type: "turn.event",
        id: "turn-1",
        event: { type: "text", part: "a", text: `${temp.dir}/data|${temp.dir}|turn-1` },
      },
      { type: "turn.event", id: "turn-1", event: { type: "done", ok: true } },
      { type: "turn.end", id: "turn-1", ok: true },
    ]);
    await until(() => logs.includes("caixa bot-1: agent up"), "agent log");
    await until(() => runner.turns.active === 0, "turn settled");
    clock.advance(15_000);
    const frame = await server.waitFor(({ type }) => type === "capacity", "capacity");
    expect(frame).toMatchObject({ capacity: { boxesRunning: 0, maxBoxes: 3 } });
    server.sockets[0]?.close(4001, "revoked");
    expect(await runner.stopped).toBe("revoked");
    expect(logs).toContain("runner parado: revoked");
  });

  test("wraps the agent with the scope and bwrap when the probe passes", async () => {
    const spawned: string[][] = [];
    const runner = await startHostRunner(config({ maxBoxes: 2, boxAgent: null }), {
      clock: new FakeClock(),
      meminfoPath: `${temp.dir}/meminfo`,
      home: temp.dir,
      agentDir: "/opt/rbots/runner",
      bun: "/usr/bin/bun",
      exists: (path) => path === `${temp.dir}/data` || path === "/opt/rbots/runner/box-agent.js",
      run: async () => 0,
      spawn: (argv, options) => {
        spawned.push(argv);
        const exec = new FakeExec("bot-1", argv, options);
        queueMicrotask(() => exec.exit(1));
        return exec;
      },
      log: () => undefined,
    });
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toMatchObject({ runner: { providers: [], capacity: { maxBoxes: 2 } } });
    server.send({
      type: "request",
      id: "turn-2",
      op: "turn.start",
      turnId: "turn-2",
      botId: "bot-1",
      request: turnRequest({ turnId: "turn-2" }),
      box: boxSpec({ mounts: [] }),
      hooks: false,
    });
    await until(() => spawned.length === 1, "spawn");
    const [argv = []] = spawned;
    expect(argv.slice(0, 3)).toEqual(["systemd-run", "--user", "--scope"]);
    expect(argv).toContain("bwrap");
    expect(argv).toContain(`${temp.dir}/data`);
    expect(argv.slice(-2)).toEqual(["/usr/bin/bun", "/opt/rbots/runner/box-agent.js"]);
    runner.stop();
    expect(await runner.stopped).toBe("stopped");
  });
});

describe("memoryOf", () => {
  test("reads /proc/meminfo when it exists and the OS counters otherwise", async () => {
    const temp = tempDir("rb-mem-");
    await Bun.write(`${temp.dir}/meminfo`, "MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\n");
    expect(await memoryOf(`${temp.dir}/meminfo`)).toEqual({ totalMb: 2048, availableMb: 1024 });
    const os = await memoryOf(`${temp.dir}/none`);
    expect(os.totalMb).toBeGreaterThan(0);
    expect(os.availableMb).toBeGreaterThan(0);
    temp.remove();
  });
});

describe("startHostRunner on the Mac", () => {
  let server: FakeServer;
  let temp: ReturnType<typeof tempDir>;

  beforeEach(() => {
    server = fakeServer();
    temp = tempDir("rb-mac-runner-");
  });

  afterEach(() => {
    server.stop();
    temp.remove();
  });

  test("skips systemd and bwrap, prepares the worktree, runs as the Mac user and sends the work back", async () => {
    const logs: string[] = [];
    const gitCalls: string[][] = [];
    const ghSeen: Array<string | null> = [];
    const execs: FakeExec[] = [];
    let login = '{"loggedIn":true}';
    const workspaces = `${temp.dir}/workspaces`;
    const bin = `${temp.dir}/bin`;
    const exists = (path: string) =>
      path === `${bin}/gh` || path === `${temp.dir}/.local/bin/claude` || existsSync(path);
    const runner = await startHostRunner(
      {
        ...readEnv({
          RBOTS_URL: server.url,
          RBOTS_DEVICE_TOKEN: "rbk_device",
          RBOTS_PROVIDER: "host",
          RBOTS_ENVIRONMENT: "mac",
          RBOTS_WORKSPACES_DIR: workspaces,
        }),
        name: "Mac do dono",
        healthFile: `${temp.dir}/health`,
      },
      {
        clock: new FakeClock(),
        home: temp.dir,
        user: "dono",
        env: { PATH: bin },
        exists,
        run: async () => {
          throw new Error("sem probe no Mac");
        },
        memory: async () => ({ totalMb: 16_384, availableMb: 8192 }),
        capture: async () => ({ code: 0, stdout: login, stderr: "" }),
        gitRunner: (gh) => {
          ghSeen.push(gh);
          return async (args): Promise<GitResult> => {
            gitCalls.push(args);
            return { code: 0, stdout: args[0] === "commit-tree" ? "mac1" : "", stderr: "" };
          };
        },
        spawn: (argv: string[], options: ExecOptions) => {
          const exec = new FakeExec("bot-1", argv, options);
          execs.push(exec);
          return exec;
        },
        log: (line) => logs.push(line),
      },
    );
    expect(runner.probe).toEqual({ scope: false, bwrap: false });
    expect(logs).toEqual([`Este Mac: turnos direto como dono, sem systemd e sem bwrap (worktrees em ${workspaces})`]);
    expect(ghSeen).toEqual([`${bin}/gh`]);
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toMatchObject({
      runner: { name: "Mac do dono", environment: "mac", providers: ["claude"], capacity: { memFreeMb: 8192 } },
    });
    const sync = {
      repo: "acme/app",
      cloneUrl: "https://github.com/acme/app.git",
      name: "app",
      branch: "feat/x",
      ref: "refs/rbots/sync/feat/x",
      commit: "vps1",
      cwd: "/srv/worktrees/app/app-bot-x",
    };
    const start = (turnId: string, code: string | null, extra: Record<string, unknown> = {}) =>
      server.send({
        type: "request",
        id: turnId,
        op: "turn.start",
        turnId,
        botId: "bot-1",
        request: turnRequest({ turnId, configDir: "/home/vps/.claude", ...(code ? { code: { cwd: code } } : {}) }),
        box: boxSpec({ mounts: [] }),
        hooks: true,
        ...extra,
      });
    start("t1", sync.cwd, { sync });
    await until(() => execs.length === 1, "exec");
    const [exec] = execs;
    expect(exec?.options.cwd).toBe(temp.dir);
    expect(exec?.options.env).toMatchObject({
      HOME: temp.dir,
      CLAUDE_CODE_EXECUTABLE: `${temp.dir}/.local/bin/claude`,
      BOTS_DATA_DIR: `${temp.dir}/data`,
    });
    expect(exec?.argv[0]).not.toBe("systemd-run");
    const local = `${workspaces}/.worktrees/app/feat-x`;
    expect(exec?.messages()[0]).toMatchObject({ request: { code: { cwd: local }, configDir: null } });
    expect(gitCalls[0]).toEqual(["clone", "--quiet", "--no-checkout", sync.cloneUrl, `${workspaces}/app`]);
    exec?.emit({ type: "end", ok: true });
    exec?.exit(0);
    const end = await server.waitFor(({ type, id }) => type === "turn.end" && id === "t1", "turn.end");
    expect(end).toEqual({ type: "turn.end", id: "t1", ok: true, sync: { ref: sync.ref, commit: "mac1" } });
    expect(gitCalls.at(-1)).toEqual(["push", "--no-verify", "--quiet", "--force", "origin", `mac1:${sync.ref}`]);
    start("t2", "/srv/worktrees/.bots/bot-1");
    await until(() => execs.length === 2, "exec 2");
    expect(execs[1]?.messages()[0]).toMatchObject({ request: { code: { cwd: `${workspaces}/.homes/bot-1` } } });
    expect(existsSync(`${workspaces}/.homes/bot-1`)).toBe(true);
    execs[1]?.exit(0);
    start("t3", null);
    await until(() => execs.length === 3, "exec 3");
    expect(execs[2]?.messages()[0]).toMatchObject({ request: { configDir: null } });
    execs[2]?.exit(0);
    login = '{"loggedIn":false}';
    start("t4", null, { request: turnRequest({ turnId: "t4", provider: "codex" }) });
    await until(() => execs.length === 4, "exec 4");
    execs[3]?.exit(0);
    runner.stop();
    expect(await runner.stopped).toBe("stopped");
  });

  test("refuses Claude turns when the Mac CLI is missing", async () => {
    const runner = await startHostRunner(
      {
        ...readEnv({
          RBOTS_URL: server.url,
          RBOTS_DEVICE_TOKEN: "rbk_device",
          RBOTS_PROVIDER: "host",
          RBOTS_ENVIRONMENT: "mac",
          RBOTS_WORKSPACES_DIR: `${temp.dir}/w`,
          RBOTS_CLAUDE_BIN: `${temp.dir}/claude`,
        }),
        healthFile: `${temp.dir}/health`,
      },
      {
        clock: new FakeClock(),
        home: temp.dir,
        env: { PATH: "" },
        exists: () => false,
        memory: async () => ({ totalMb: 8192, availableMb: 4096 }),
        capture: async () => ({ code: 0, stdout: '{"loggedIn":false}', stderr: "" }),
        log: () => undefined,
      },
    );
    await server.waitFor(({ type }) => type === "hello", "hello");
    server.send({
      type: "request",
      id: "t1",
      op: "turn.start",
      turnId: "t1",
      botId: "bot-1",
      request: turnRequest({ turnId: "t1" }),
      box: boxSpec({ mounts: [] }),
      hooks: false,
    });
    const refusal = await server.waitFor(({ type }) => type === "response", "refusal");
    expect(refusal).toMatchObject({
      ok: false,
      code: "turn.prepare",
      error: expect.stringContaining("não está instalado"),
    });
    runner.stop();
    await runner.stopped;
  });
});
