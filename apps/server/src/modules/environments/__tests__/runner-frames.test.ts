import { describe, expect, test } from "bun:test";
import type { BoxStatus } from "@runelay-bots/protocol";
import { capacity } from "../../../../test/runner-helpers";
import {
  boxesOf,
  capabilitiesOf,
  capacityOf,
  hookRequestOf,
  recordOf,
  runnerOf,
} from "../services/runner-frames.service";

const runner = {
  version: "1.0.0",
  name: "vps-2",
  kvm: true,
  runtime: "runc" as const,
  providers: ["claude", "nope", "codex"],
  workspaceRoots: ["/srv", "", 3],
  capacity: capacity(4096),
};

describe("runner frames", () => {
  test("reads records and capabilities", () => {
    expect(recordOf({ a: 1 })).toEqual({ a: 1 });
    expect(recordOf([1])).toBeNull();
    expect(recordOf(null)).toBeNull();
    expect(recordOf("x")).toBeNull();
    expect(capabilitiesOf(["boxes", "", 3, "turns"])).toEqual(["boxes", "turns"]);
    expect(capabilitiesOf("boxes")).toEqual([]);
  });

  test("accepts only a complete capacity", () => {
    expect(capacityOf(capacity(2048))).toEqual(capacity(2048));
    expect(capacityOf(null)).toBeNull();
    expect(capacityOf({ ...capacity(1), memFreeMb: -1 })).toBeNull();
    expect(capacityOf({ ...capacity(1), cpus: "4" })).toBeNull();
    expect(capacityOf({ ...capacity(1), maxBoxes: Number.NaN })).toBeNull();
  });

  test("keeps valid boxes and drops broken ones", () => {
    const box: BoxStatus = { botId: "b1", state: "paused", memMb: 512, startedAt: "a", lastUsedAt: "b" };
    expect(boxesOf([box, { ...box, state: "gone" }, "x", { ...box, botId: "" }])).toEqual([box]);
    expect(boxesOf({})).toBeNull();
  });

  test("reads the runner block of hello", () => {
    expect(runnerOf(runner)).toEqual({
      ...runner,
      providers: ["claude", "codex"],
      workspaceRoots: ["/srv"],
      capacity: capacity(4096),
    });
    expect(runnerOf(undefined)).toBeNull();
    expect(runnerOf({ ...runner, runtime: "kata" })).toBeNull();
    expect(runnerOf({ ...runner, runtime: "host" })).toMatchObject({ runtime: "host" });
    expect(runnerOf({ ...runner, kvm: "yes" })).toBeNull();
    expect(runnerOf({ ...runner, capacity: {} })).toBeNull();
    expect(runnerOf({ ...runner, providers: "claude" })).toBeNull();
    expect(runnerOf({ ...runner, workspaceRoots: "/srv" })).toBeNull();
  });

  test("reads a hook request", () => {
    const frame = { id: "h1", turnId: "t1", phase: "after", tool: "Bash", input: { a: 1 }, toolUseId: "u1" };
    expect(hookRequestOf({ ...frame, response: "ok", failed: true })).toEqual({
      type: "hook.request",
      ...frame,
      phase: "after",
      response: "ok",
      failed: true,
    });
    expect(hookRequestOf({ ...frame, phase: "before" })).toMatchObject({ phase: "before", failed: false });
    expect(hookRequestOf({ ...frame, phase: "during" })).toBeNull();
    expect(hookRequestOf({ ...frame, input: "x" })).toBeNull();
    expect(hookRequestOf({ ...frame, id: 4 })).toBeNull();
  });
});
