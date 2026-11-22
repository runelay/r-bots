import { describe, expect, test } from "bun:test";
import type { BoxSpec } from "@runelay-bots/protocol";
import { BoxError } from "../lifecycle";
import { TurnManager } from "../turns";
import type { ExecOptions, JsonRecord } from "../types";
import { boxSpec, boxStatus, FakeClock, FakeExec, turnRequest, until } from "./helpers";

function setup(acquire?: (botId: string, spec: BoxSpec) => Promise<ReturnType<typeof boxStatus>>) {
  const sent: JsonRecord[] = [];
  const logs: string[] = [];
  const execs: FakeExec[] = [];
  const released: string[] = [];
  const clock = new FakeClock();
  const manager = new TurnManager({
    lifecycle: {
      acquire: acquire ?? (async (botId) => boxStatus(botId)),
      release: (botId) => released.push(botId),
    },
    provider: {
      exec(botId: string, argv: string[], options: ExecOptions) {
        const exec = new FakeExec(botId, argv, options);
        execs.push(exec);
        return exec;
      },
    },
    send: (frame) => sent.push(frame),
    clock,
    workspaceRoots: ["/srv/rb"],
    accountRoots: ["/home/u/.claude"],
    forbiddenMounts: ["/srv/rb/home"],
    log: (line) => logs.push(line),
  });
  return { sent, logs, execs, released, clock, manager };
}

function startFrame(overrides: JsonRecord = {}): JsonRecord {
  return {
    type: "request",
    id: "turn-1",
    op: "turn.start",
    turnId: "turn-1",
    botId: "bot-1",
    request: turnRequest(),
    box: boxSpec(),
    hooks: true,
    ...overrides,
  };
}

describe("TurnManager", () => {
  test("runs the box agent and relays events, hooks and MCP both ways", async () => {
    const { sent, logs, execs, released, manager } = setup();
    expect(manager.handle(startFrame())).toBe(true);
    await until(() => execs.length === 1, "exec");
    const [exec] = execs;
    expect(exec?.argv).toEqual(["bun", "/opt/rbots/box-agent.js"]);
    expect(exec?.options.cwd).toBe("/data");
    expect(exec?.messages()[0]).toEqual({ type: "start", request: turnRequest(), hooks: true });
    expect(manager.active).toBe(1);
    exec?.emit({ type: "event", event: { type: "text", part: "p", text: "oi" } });
    exec?.emit({ type: "event", event: { type: "bogus" } });
    exec?.raw("not json\n");
    exec?.log("aviso\n");
    exec?.emit({
      type: "hook.request",
      id: "h1",
      phase: "before",
      tool: "Bash",
      input: { command: "ls" },
      toolUseId: "t1",
    });
    exec?.emit({
      type: "hook.request",
      id: "h2",
      phase: "after",
      tool: "Bash",
      input: 3,
      toolUseId: "t1",
      response: "ok",
    });
    exec?.emit({
      type: "mcp.request",
      id: "m1",
      method: "POST",
      path: "/mcp/bot-1/s",
      headers: { a: "b" },
      body: "{}",
    });
    exec?.emit({ type: "mcp.request", id: "m2" });
    await until(() => sent.filter(({ type }) => type === "mcp.request").length === 2, "mcp");
    expect(sent[0]).toEqual({ type: "turn.event", id: "turn-1", event: { type: "text", part: "p", text: "oi" } });
    const [before, after] = sent.filter(({ type }) => type === "hook.request");
    expect(before).toMatchObject({
      turnId: "turn-1",
      phase: "before",
      tool: "Bash",
      input: { command: "ls" },
      toolUseId: "t1",
    });
    expect(before).not.toHaveProperty("response");
    expect(after).toMatchObject({ phase: "after", input: {}, response: "ok", failed: false });
    const [mcp, bare] = sent.filter(({ type }) => type === "mcp.request");
    expect(mcp).toMatchObject({ method: "POST", path: "/mcp/bot-1/s", headers: { a: "b" }, body: "{}" });
    expect(bare).toMatchObject({ method: "POST", path: "", headers: {}, body: "" });
    manager.handle({ type: "hook.response", id: before?.id, gate: { allow: true } });
    manager.handle({ type: "hook.response", id: before?.id, gate: { allow: false } });
    manager.handle({ type: "mcp.response", id: mcp?.id, status: 200, headers: {}, body: "r" });
    manager.handle({ type: "hook.response", id: "unknown" });
    expect(exec?.messages().slice(1)).toEqual([
      { type: "hook.response", id: "h1", gate: { allow: true } },
      { type: "mcp.response", id: "m1", status: 200, headers: {}, body: "r" },
    ]);
    exec?.emit({ type: "end", ok: true });
    exec?.exit(0);
    await until(() => released.length === 1, "release");
    expect(sent.at(-1)).toEqual({ type: "turn.end", id: "turn-1", ok: true });
    expect(logs).toEqual(["caixa bot-1: aviso"]);
    expect(manager.active).toBe(0);
    manager.handle({ type: "hook.response", id: after?.id });
    expect(manager.handle({ type: "other" })).toBe(false);
  });

  test("ends the turn as failed when the agent dies without end", async () => {
    const { sent, execs, released, manager } = setup();
    manager.handle(startFrame({ hooks: "no" }));
    await until(() => execs.length === 1, "exec");
    expect(execs[0]?.messages()[0]).toMatchObject({ hooks: false });
    execs[0]?.exit(1);
    await until(() => released.length === 1, "release");
    const message = "A caixa encerrou o turno sem resposta.";
    expect(sent).toEqual([
      { type: "turn.event", id: "turn-1", event: { type: "done", ok: false, message } },
      { type: "turn.end", id: "turn-1", ok: false, message },
    ]);
  });

  test("cancel writes cancel and kills the exec after 5 s", async () => {
    const { sent, execs, clock, released, manager } = setup();
    manager.handle(startFrame());
    await until(() => execs.length === 1, "exec");
    manager.handle({ type: "turn.cancel", id: "turn-1" });
    manager.cancel("turn-1");
    manager.cancel("ghost");
    expect(execs[0]?.messages()[1]).toEqual({ type: "cancel" });
    expect(clock.delays()).toEqual([5000]);
    clock.advance(5000);
    expect(execs[0]?.killed).toBe(1);
    await until(() => released.length === 1, "release");
    expect(sent.at(-1)).toEqual({ type: "turn.end", id: "turn-1", ok: false, message: "cancelled" });
    expect(clock.delays()).toEqual([]);
  });

  test("drops a turn cancelled while it waits for the box", async () => {
    const gates: Array<() => void> = [];
    const { sent, execs, released, manager } = setup(
      (botId) => new Promise((done) => gates.push(() => done(boxStatus(botId)))),
    );
    manager.handle(startFrame());
    manager.handle(startFrame({ id: "turn-2", turnId: "turn-2" }));
    await until(() => gates.length === 2, "waiting");
    manager.handle({ type: "turn.cancel", id: "turn-1" });
    manager.cancelAll();
    for (const open of gates) open();
    await until(() => released.length === 2, "release");
    expect(execs).toHaveLength(0);
    expect(sent).toEqual([
      { type: "response", id: "turn-1", ok: false, code: "turn.cancelled", error: "cancelled" },
      { type: "response", id: "turn-2", ok: false, code: "turn.cancelled", error: "cancelled" },
    ]);
  });

  test("cancelAll cancels every running turn", async () => {
    const { execs, manager } = setup();
    manager.handle(startFrame());
    manager.handle(startFrame({ id: "turn-2", turnId: "turn-2", botId: "bot-2" }));
    await until(() => execs.length === 2, "execs");
    manager.cancelAll();
    expect(execs.map((exec) => exec.messages().at(-1))).toEqual([{ type: "cancel" }, { type: "cancel" }]);
    for (const exec of execs) exec.exit(0);
    await until(() => manager.active === 0, "settled");
  });

  test("refuses invalid, duplicate, out-of-root and capacity-blocked turns", async () => {
    const refusals: Array<(botId: string) => Promise<never>> = [
      async () => {
        throw new BoxError("box.capacity", "sem memória");
      },
      async () => {
        throw new Error("docker down");
      },
    ];
    const { sent, execs, manager } = setup(async (botId) => {
      const next = refusals.shift();
      return next ? next(botId) : boxStatus(botId);
    });
    await manager.start(startFrame({ request: { nope: true } }));
    await manager.start(startFrame({ box: boxSpec({ mounts: [{ host: "/etc", box: "/etc", readOnly: true }] }) }));
    await manager.start(
      startFrame({ box: boxSpec({ mounts: [{ host: "/srv/rb/home", box: "/h", readOnly: true }] }) }),
    );
    await manager.start(startFrame({ box: boxSpec({ mounts: [{ host: "/home/u", box: "/h", readOnly: true }] }) }));
    const account = { host: "/home/u/.claude", box: "/home/app/.claude", readOnly: false };
    await manager.start(startFrame({ box: boxSpec({ mounts: [...boxSpec().mounts, account] }) }));
    await manager.start(startFrame());
    expect(sent).toEqual([
      { type: "response", id: "turn-1", ok: false, code: "turn.invalid", error: "Pedido de turno inválido." },
      {
        type: "response",
        id: "turn-1",
        ok: false,
        code: "box.mount",
        error: "O caminho /etc fica fora das pastas liberadas neste runner.",
      },
      {
        type: "response",
        id: "turn-1",
        ok: false,
        code: "box.mount",
        error: "O caminho /srv/rb/home fica fora das pastas liberadas neste runner.",
      },
      {
        type: "response",
        id: "turn-1",
        ok: false,
        code: "box.mount",
        error: "O caminho /home/u fica fora das pastas liberadas neste runner.",
      },
      { type: "response", id: "turn-1", ok: false, code: "box.capacity", error: "box.capacity" },
      { type: "response", id: "turn-1", ok: false, code: "box.start", error: "docker down" },
    ]);
    manager.handle(startFrame());
    await until(() => execs.length === 1, "exec");
    await manager.start(startFrame());
    expect(sent.at(-1)).toEqual({
      type: "response",
      id: "turn-1",
      ok: false,
      code: "turn.duplicate",
      error: "Esse turno já está rodando.",
    });
    execs[0]?.exit(0);
    await until(() => manager.active === 0, "settled");
  });

  test("non-Error failures become strings", async () => {
    const { sent, manager } = setup(async () => {
      throw "boom";
    });
    await manager.start(startFrame());
    expect(sent).toEqual([{ type: "response", id: "turn-1", ok: false, code: "box.start", error: "boom" }]);
  });
});
