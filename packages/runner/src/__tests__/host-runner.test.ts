import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkHealth } from "../health";
import { startHostRunner } from "../host-runner";
import { readEnv, runnerVersion } from "../runner";
import type { RunnerEnv } from "../types";
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
