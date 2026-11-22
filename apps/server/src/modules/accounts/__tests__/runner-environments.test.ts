import { afterEach, describe, expect, jest, test } from "bun:test";
import type { BoxSpec, BoxStatus, NativeToolHooks, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import {
  boxHello,
  capacity,
  dropAllRunners,
  fakeRunner,
  hostHello,
  runnerDevice,
} from "../../../../test/runner-helpers";
import {
  hostRunnerKey,
  macRunnerConnected,
  macRunnerInfo,
  type RemoteTurnInput,
  runnerEnvironments,
  runRemoteTurn,
} from "../services/mac-runner.service";

const box: BoxSpec = { memMb: 2048, cpus: 1, mounts: [] };

function turn(turnId: string): TurnRequest {
  return {
    turnId,
    provider: "claude",
    mcp: { url: "http://127.0.0.1:2000/mcp/b1/s1", token: "tk" },
    workKey: "b1/s1",
  } as unknown as TurnRequest;
}

function remote(turnId: string, hooks?: NativeToolHooks): RemoteTurnInput {
  return { turn: turn(turnId), botId: "b1", box, ...(hooks ? { hooks } : {}) };
}

function boxRunner(key = "box-1") {
  const runner = fakeRunner(runnerDevice(key));
  runner.say(boxHello());
  return runner;
}

afterEach(() => {
  dropAllRunners();
  jest.useRealTimers();
});

describe("box runners in the hub", () => {
  test("never serve the Mac operations", () => {
    boxRunner();
    expect(macRunnerConnected()).toBe(false);
    expect(macRunnerInfo().connected).toBe(false);
    expect(macRunnerConnected("box-1")).toBe(true);
    const mac = fakeRunner(runnerDevice("mac-1", 5));
    mac.say({ type: "hello", version: "9", capabilities: ["computer"] });
    expect(macRunnerInfo()).toMatchObject({ connected: true, version: "9" });
  });

  test("host runners stay out of the Mac operations and are the server's own runner", async () => {
    expect(hostRunnerKey()).toBeNull();
    const host = fakeRunner(runnerDevice("host-1"));
    host.say(hostHello());
    expect(macRunnerConnected()).toBe(false);
    expect(runnerEnvironments().map(({ key }) => key)).toEqual(["host-1"]);
    expect(hostRunnerKey()).toBe("host-1");
    const mac = fakeRunner(runnerDevice("mac-1", 5));
    mac.say({ type: "hello", version: "9", capabilities: ["computer", "host"] });
    expect(hostRunnerKey()).toBe("host-1");
    expect(await runRemoteTurn("mac-1", remote("m0"), new AbortController().signal, () => {})).toBe("refused");
    const events: ProviderEvent[] = [];
    const finished = runRemoteTurn("host-1", remote("h1"), new AbortController().signal, (e) => events.push(e));
    expect(await host.next("request")).toMatchObject({ op: "turn.start", turnId: "h1" });
    host.say({ type: "turn.event", id: "h1", event: { type: "done", ok: true } });
    host.say({ type: "turn.end", id: "h1" });
    expect(await finished).toBe("ran");
    expect(events).toEqual([{ type: "done", ok: true }]);
  });

  test("track capacity and boxes, keeping the last good value", () => {
    const runner = boxRunner();
    expect(runnerEnvironments()[0]?.capacity).toEqual(capacity(8192));
    runner.say({ type: "capacity", capacity: capacity(1000) });
    runner.say({ type: "capacity", capacity: { memFreeMb: "x" } });
    const status: BoxStatus = { botId: "b1", state: "running", memMb: 900, startedAt: "s", lastUsedAt: "l" };
    runner.say({ type: "boxes", boxes: [status] });
    runner.say({ type: "boxes", boxes: "broken" });
    expect(runnerEnvironments()).toEqual([
      {
        key: "box-1",
        name: "Máquina box-1",
        capabilities: ["turns", "boxes", "mcp-proxy", "hooks"],
        runner: expect.objectContaining({ name: "vps-2", runtime: "runsc" }),
        capacity: capacity(1000),
        boxes: [status],
      },
    ]);
    runner.say({ type: "hello", capabilities: ["boxes"] });
    expect(runnerEnvironments()[0]).toMatchObject({ runner: null, capacity: null });
  });
});

describe("runRemoteTurn", () => {
  test("refuses when the environment is missing or is not a box runner", async () => {
    const events: ProviderEvent[] = [];
    expect(await runRemoteTurn("ghost", remote("r0"), new AbortController().signal, (e) => events.push(e))).toBe(
      "refused",
    );
    const mac = fakeRunner(runnerDevice("mac-1"));
    mac.say({ type: "hello", capabilities: ["computer"] });
    expect(await runRemoteTurn("mac-1", remote("r1"), new AbortController().signal, (e) => events.push(e))).toBe(
      "refused",
    );
    expect(events).toEqual([]);
    expect(mac.sent).toEqual([]);
  });

  test("sends turn.start with the box and streams until turn.end", async () => {
    const runner = boxRunner();
    const events: ProviderEvent[] = [];
    const finished = runRemoteTurn("box-1", remote("r2"), new AbortController().signal, (e) => events.push(e));
    expect(await runner.next("request")).toEqual({
      type: "request",
      id: "r2",
      op: "turn.start",
      turnId: "r2",
      botId: "b1",
      request: { ...turn("r2"), mcp: { url: "/mcp/b1/s1", token: "tk" } },
      box,
      hooks: false,
    });
    runner.say({ type: "response", id: "r2", ok: true });
    runner.say({ type: "turn.event", id: "r2", event: { type: "text", part: "p", text: "oi" } });
    runner.say({ type: "turn.event", id: "r2", event: { type: "done", ok: true } });
    runner.say({ type: "turn.end", id: "r2" });
    expect(await finished).toBe("ran");
    expect(events).toEqual([
      { type: "text", part: "p", text: "oi" },
      { type: "done", ok: true },
    ]);
  });

  test("gives the turn back on box.capacity before it starts", async () => {
    const runner = boxRunner();
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const finished = runRemoteTurn("box-1", remote("r3"), controller.signal, (e) => events.push(e));
    await runner.next("request");
    runner.say({ type: "response", id: "r3", ok: false, error: "box.capacity" });
    expect(await finished).toBe("refused");
    controller.abort();
    expect(runner.sent).toEqual([]);
    expect(events).toEqual([]);
  });

  test("fails the turn on any other refusal or a late capacity error", async () => {
    const runner = boxRunner();
    const failed: ProviderEvent[] = [];
    const first = runRemoteTurn("box-1", remote("r4"), new AbortController().signal, (e) => failed.push(e));
    await runner.next("request");
    runner.say({ type: "response", id: "r4", ok: false, error: "docker down" });
    expect(await first).toBe("ran");
    expect(failed).toEqual([{ type: "done", ok: false, message: "docker down" }]);
    const late: ProviderEvent[] = [];
    const second = runRemoteTurn("box-1", remote("r5"), new AbortController().signal, (e) => late.push(e));
    await runner.next("request");
    runner.say({ type: "turn.event", id: "r5", event: { type: "text", part: "p", text: "x" } });
    runner.say({ type: "response", id: "r5", ok: false, error: "box.capacity" });
    expect(await second).toBe("ran");
    expect(late.at(-1)).toEqual({ type: "done", ok: false, message: "box.capacity" });
    const blank: ProviderEvent[] = [];
    const third = runRemoteTurn("box-1", remote("r6"), new AbortController().signal, (e) => blank.push(e));
    await runner.next("request");
    runner.say({ type: "response", id: "r6", ok: false });
    expect(await third).toBe("ran");
    expect(blank).toEqual([{ type: "done", ok: false, message: "O ambiente recusou o turno." }]);
    const other = fakeRunner(runnerDevice("box-2"));
    other.say(boxHello());
    const fourth = runRemoteTurn("box-1", remote("r7"), new AbortController().signal, () => {});
    await runner.next("request");
    other.say({ type: "response", id: "r7", ok: false, error: "box.capacity" });
    runner.say({ type: "turn.end", id: "r7" });
    expect(await fourth).toBe("ran");
  });

  test("cancels on abort and closes after the grace period", async () => {
    jest.useFakeTimers();
    const runner = boxRunner();
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const finished = runRemoteTurn("box-1", remote("r8"), controller.signal, (e) => events.push(e));
    controller.abort();
    expect(runner.sent.map(({ type }) => type)).toEqual(["request", "turn.cancel"]);
    expect(runner.sent[1]).toEqual({ type: "turn.cancel", id: "r8" });
    jest.advanceTimersByTime(5000);
    expect(await finished).toBe("ran");
    expect(events).toEqual([{ type: "done", ok: false, message: "cancelled" }]);
  });
});

describe("hooks over the connection", () => {
  test("runs before and after on the turn hooks", async () => {
    const runner = boxRunner();
    const seen: unknown[] = [];
    const hooks: NativeToolHooks = {
      before: async (tool, input, toolUseId) => {
        seen.push(["before", tool, input, toolUseId]);
        return { allow: true, input: { command: "safe" } };
      },
      after: async (tool, input, response, toolUseId, failed) => {
        seen.push(["after", tool, input, response, toolUseId, failed]);
      },
    };
    const finished = runRemoteTurn("box-1", remote("h1", hooks), new AbortController().signal, () => {});
    expect((await runner.next("request")).hooks).toBe(true);
    const ask = { type: "hook.request", turnId: "h1", tool: "Bash", input: { command: "ls" }, toolUseId: "u1" };
    runner.say({ ...ask, id: "q1", phase: "before" });
    expect(await runner.next("hook.response")).toEqual({
      type: "hook.response",
      id: "q1",
      gate: { allow: true, input: { command: "safe" } },
    });
    runner.say({ ...ask, id: "q2", phase: "after", response: "out", failed: true });
    expect(await runner.next("hook.response")).toEqual({ type: "hook.response", id: "q2" });
    expect(seen).toEqual([
      ["before", "Bash", { command: "ls" }, "u1"],
      ["after", "Bash", { command: "ls" }, "out", "u1", true],
    ]);
    runner.say({ type: "turn.end", id: "h1" });
    await finished;
  });

  test("denies without hooks, on a failing hook and on a bad request", async () => {
    const runner = boxRunner();
    const ask = { type: "hook.request", tool: "Bash", input: {}, toolUseId: "u1", phase: "before" };
    runner.say({ ...ask, id: "q3", turnId: "unknown" });
    expect(await runner.next("hook.response")).toEqual({
      type: "hook.response",
      id: "q3",
      gate: { allow: false, message: "O servidor não tem hooks para este turno." },
    });
    const broken: NativeToolHooks = {
      before: async () => {
        throw new Error("boom");
      },
      after: async () => {},
    };
    const finished = runRemoteTurn("box-1", remote("h2", broken), new AbortController().signal, () => {});
    await runner.next("request");
    runner.say({ ...ask, id: "q4", turnId: "h2" });
    expect(await runner.next("hook.response")).toEqual({
      type: "hook.response",
      id: "q4",
      gate: { allow: false, message: "O hook do servidor falhou." },
    });
    runner.say({ type: "hook.request", id: "q5", phase: "x" });
    expect(await runner.next("hook.response")).toEqual({
      type: "hook.response",
      id: "q5",
      gate: { allow: false, message: "Pedido de hook inválido." },
    });
    runner.say({ type: "hook.request", phase: "x" });
    runner.ws.readyState = 3;
    runner.say({ ...ask, id: "q6", turnId: "h2" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.sent.filter(({ type }) => type === "hook.response")).toEqual([]);
    runner.ws.readyState = 1;
    runner.say({ type: "turn.end", id: "h2" });
    await finished;
  });
});
