import { describe, expect, test } from "bun:test";
import type { BoxSpec, BoxStatus } from "@runelay-bots/protocol";
import { BoxError, BoxLifecycle } from "../lifecycle";
import type { BoxExecHandle, BoxProvider, MemInfo } from "../types";
import { boxSpec, boxStatus, FakeClock, until } from "./helpers";

class FakeProvider implements BoxProvider {
  readonly runtime = "runc";
  readonly calls: string[] = [];
  readonly states = new Map<string, BoxStatus>();
  failPause = false;
  failStop = new Set<string>();
  failList = false;

  async ensure(botId: string, spec: BoxSpec) {
    this.calls.push(`ensure ${botId} ${spec.memMb}`);
    const status = boxStatus(botId, { memMb: spec.memMb });
    this.states.set(botId, status);
    return status;
  }

  exec(): BoxExecHandle {
    throw new Error("unused");
  }

  async pause(botId: string) {
    this.calls.push(`pause ${botId}`);
    if (this.failPause) throw new Error("pause failed");
    this.set(botId, "paused");
  }

  async resume(botId: string) {
    this.calls.push(`resume ${botId}`);
  }

  async stop(botId: string) {
    this.calls.push(`stop ${botId}`);
    if (this.failStop.has(botId)) throw new Error("stop failed");
    this.set(botId, "stopped");
  }

  async list() {
    if (this.failList) throw new Error("list failed");
    return [...this.states.values()];
  }

  private set(botId: string, state: BoxStatus["state"]) {
    const current = this.states.get(botId) ?? boxStatus(botId);
    this.states.set(botId, { ...current, state });
  }
}

function setup(memory: MemInfo[] = [{ totalMb: 8000, availableMb: 6000 }]) {
  const provider = new FakeProvider();
  const clock = new FakeClock();
  const changes: BoxStatus[][] = [];
  const queue = [...memory];
  const lifecycle = new BoxLifecycle({
    provider,
    clock,
    memory: async () => (queue.length > 1 ? (queue.shift() ?? memory[0]) : (queue[0] ?? memory[0])),
    pauseAfterMs: 120_000,
    stopAfterMs: 1_800_000,
    reserveMb: 1024,
    onChange: (boxes) => changes.push(boxes),
  });
  return { provider, clock, changes, lifecycle };
}

async function settle() {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe("BoxLifecycle", () => {
  test("pauses after idle, stops after paused, and publishes each change", async () => {
    const { provider, clock, changes, lifecycle } = setup();
    const status = await lifecycle.acquire("bot-1", boxSpec());
    expect(status.state).toBe("running");
    expect(lifecycle.counts()).toEqual({ running: 1, paused: 0 });
    await until(() => changes.length === 1, "boxes");
    expect(clock.delays()).toEqual([]);
    lifecycle.release("bot-1");
    expect(clock.delays()).toEqual([120_000]);
    clock.advance(120_000);
    await until(() => changes.length === 2, "pause");
    expect(lifecycle.counts()).toEqual({ running: 0, paused: 1 });
    expect(changes[1]?.[0]?.state).toBe("paused");
    expect(clock.delays()).toEqual([1_800_000]);
    clock.advance(1_800_000);
    await until(() => changes.length === 3, "stop");
    expect(provider.calls).toEqual(["ensure bot-1 512", "pause bot-1", "stop bot-1"]);
    expect(lifecycle.counts()).toEqual({ running: 0, paused: 0 });
    lifecycle.release("ghost");
  });

  test("a new turn cancels the pending pause and reuses the warm box without the memory gate", async () => {
    const { provider, clock, lifecycle } = setup([{ totalMb: 4000, availableMb: 100 }]);
    await expect(lifecycle.acquire("bot-1", boxSpec())).rejects.toMatchObject({ code: "box.capacity" });
    provider.calls.length = 0;
    const roomy = setup();
    await roomy.lifecycle.acquire("bot-1", boxSpec());
    roomy.lifecycle.release("bot-1");
    await roomy.lifecycle.acquire("bot-1", boxSpec());
    expect(roomy.clock.delays()).toEqual([]);
    roomy.lifecycle.release("bot-1");
    roomy.lifecycle.dispose();
    expect(roomy.clock.delays()).toEqual([]);
    expect(clock.delays()).toEqual([]);
  });

  test("refuses a second spec while the box is busy", async () => {
    const { lifecycle } = setup();
    await lifecycle.acquire("bot-1", boxSpec());
    const error = await lifecycle.acquire("bot-1", boxSpec({ memMb: 900 })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BoxError);
    expect(error).toMatchObject({ code: "box.busy" });
  });

  test("stops the oldest paused box to make room, skipping ones that fail to stop", async () => {
    const { provider, clock, lifecycle } = setup([
      { totalMb: 8000, availableMb: 6000 },
      { totalMb: 8000, availableMb: 6000 },
      { totalMb: 8000, availableMb: 6000 },
      { totalMb: 8000, availableMb: 1000 },
      { totalMb: 8000, availableMb: 1200 },
      { totalMb: 8000, availableMb: 4000 },
    ]);
    for (const botId of ["old", "mid", "new"]) {
      await lifecycle.acquire(botId, boxSpec());
      lifecycle.release(botId);
      clock.advance(1);
    }
    clock.advance(120_000);
    await until(() => lifecycle.counts().paused === 3, "paused");
    provider.failStop.add("old");
    provider.calls.length = 0;
    await lifecycle.acquire("fresh", boxSpec());
    expect(provider.calls).toEqual(["stop old", "stop mid", "ensure fresh 512"]);
    expect(lifecycle.counts()).toEqual({ running: 1, paused: 2 });
  });

  test("seeds from the provider list and survives provider failures", async () => {
    const { provider, clock, changes, lifecycle } = setup();
    provider.states.set("a", boxStatus("a", { state: "running" }));
    provider.states.set("b", boxStatus("b", { state: "paused", lastUsedAt: "not a date" }));
    provider.states.set("c", boxStatus("c", { state: "stopped" }));
    await lifecycle.init();
    expect(lifecycle.counts()).toEqual({ running: 1, paused: 1 });
    expect(clock.delays().sort()).toEqual([120_000, 1_800_000]);
    provider.failPause = true;
    provider.failStop.add("b");
    clock.advance(1_800_000);
    await settle();
    expect(lifecycle.counts()).toEqual({ running: 1, paused: 1 });
    provider.failList = true;
    provider.failPause = false;
    await lifecycle.acquire("a", boxSpec());
    await settle();
    expect(changes).toEqual([]);
  });

  test("releases the slot when ensure fails", async () => {
    const { provider, clock, lifecycle } = setup();
    provider.ensure = async () => {
      throw new Error("docker down");
    };
    await expect(lifecycle.acquire("bot-1", boxSpec())).rejects.toThrow("docker down");
    expect(clock.delays()).toEqual([]);
    await expect(lifecycle.acquire("bot-1", boxSpec({ memMb: 64 }))).rejects.toThrow("docker down");
  });
});
