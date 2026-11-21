import { afterEach, describe, expect, test } from "bun:test";
import type { NativeToolHooks, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { fakeProviders } from "../../../../test/helpers";
import { boxHello, dropAllRunners, fakeRunner, runnerDevice } from "../../../../test/runner-helpers";
import { env } from "../../../config/env";
import { accountDir, accountPath, botIdOf, refreshAccounts, runOnAccount } from "../services/accounts.service";

const account = { id: "vps:claude", provider: "claude" as const };
const hooks: NativeToolHooks = { before: async () => ({ allow: true }), after: async () => {} };

function turnRequest(turnId: string): TurnRequest {
  return {
    turnId,
    provider: "claude",
    model: "m",
    effort: null,
    systemPrompt: "",
    prompt: "oi",
    resume: null,
    mcp: { url: "http://127.0.0.1:2000/mcp/bot-r/s1", token: "tk" },
    workKey: "bot-r/s1",
    code: { cwd: "/srv/repo" },
  };
}

afterEach(() => {
  dropAllRunners();
  fakeProviders.reset();
  env.BOTS_SANDBOX = "off";
});

describe("runOnAccount placement", () => {
  test("reads the bot from the work key", () => {
    expect(botIdOf({ workKey: "b1/s1" })).toBe("b1");
    expect(botIdOf({ workKey: "" })).toBe("");
  });

  test("runs in the process while placement is local", async () => {
    const runner = fakeRunner(runnerDevice("box-1"));
    runner.say(boxHello());
    await runOnAccount(account, turnRequest("l1"), new AbortController().signal, () => {}, hooks);
    expect(fakeProviders.turns.map(({ request }) => request.turnId)).toEqual(["l1"]);
    expect(runner.sent).toEqual([]);
  });

  test("sends the turn to a runner with the box and the hooks", async () => {
    env.BOTS_SANDBOX = "docker";
    const runner = fakeRunner(runnerDevice("box-1"));
    runner.say(boxHello());
    const events: ProviderEvent[] = [];
    const finished = runOnAccount(
      account,
      turnRequest("r1"),
      new AbortController().signal,
      (e) => events.push(e),
      hooks,
    );
    const start = await runner.next("request");
    expect(start).toMatchObject({
      op: "turn.start",
      botId: "bot-r",
      hooks: true,
      request: { turnId: "r1", configDir: null, mcp: { url: "/mcp/bot-r/s1" } },
      box: { memMb: env.BOX_MEM_MB, cpus: env.BOX_CPUS },
    });
    runner.say({ type: "turn.event", id: "r1", event: { type: "done", ok: true } });
    runner.say({ type: "turn.end", id: "r1" });
    await finished;
    expect(events).toEqual([{ type: "done", ok: true }]);
    expect(fakeProviders.turns).toEqual([]);
  });

  test("gives the box the default account dir as the config dir", async () => {
    await refreshAccounts();
    const dir = accountPath(account.id);
    expect(dir).toBeTruthy();
    expect(accountDir(account.id)).toBeNull();
    env.BOTS_SANDBOX = "docker";
    const runner = fakeRunner(runnerDevice("box-1"));
    runner.say(boxHello());
    const finished = runOnAccount(account, turnRequest("r3"), new AbortController().signal, () => {}, hooks);
    const start = await runner.next("request");
    expect(start).toMatchObject({ op: "turn.start", request: { turnId: "r3", configDir: dir } });
    expect(start.box.mounts).toContainEqual(expect.objectContaining({ box: dir, readOnly: false }));
    runner.say({ type: "turn.event", id: "r3", event: { type: "done", ok: true } });
    runner.say({ type: "turn.end", id: "r3" });
    await finished;
    expect(fakeProviders.turns).toEqual([]);
  });

  test("runs locally when the runner has no room", async () => {
    env.BOTS_SANDBOX = "docker";
    const runner = fakeRunner(runnerDevice("box-1"));
    runner.say(boxHello());
    const finished = runOnAccount(account, turnRequest("r2"), new AbortController().signal, () => {}, hooks);
    await runner.next("request");
    runner.say({ type: "response", id: "r2", ok: false, error: "box.capacity" });
    await finished;
    expect(fakeProviders.turns.map(({ request, hooks: passed }) => [request.turnId, passed])).toEqual([["r2", hooks]]);
  });
});
