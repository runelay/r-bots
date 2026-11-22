import { describe, expect, test } from "bun:test";
import type { NativeToolHooks, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { agentDataDir, proxiedMcp, runBoxAgent } from "../box-agent";
import type { JsonRecord, RunTurnFn } from "../types";
import { FakeClock, turnRequest, until } from "./helpers";

function harness(runTurn: RunTurnFn) {
  const out: JsonRecord[] = [];
  const clock = new FakeClock();
  let input: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      input = controller;
    },
  });
  const send = (message: unknown) => input?.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  const close = () => input?.close();
  const done = runBoxAgent({
    input: stream,
    write: (text) => {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        out.push(Object.fromEntries(Object.entries(parsed)));
    },
    runTurn,
    dataDir: "/data",
    hookTimeoutMs: 30_000,
    clock,
  });
  const waitFor = async (predicate: (message: JsonRecord) => boolean, label: string) => {
    await until(() => out.some(predicate), label);
    const found = out.find(predicate);
    if (!found) throw new Error(label);
    return found;
  };
  return { out, clock, send, close, done, waitFor };
}

describe("agentDataDir", () => {
  test("uses the host data dir when the runner passes one", () => {
    expect(agentDataDir({ BOTS_DATA_DIR: "/home/u/data" }, "/data")).toBe("/home/u/data");
    expect(agentDataDir({ BOTS_DATA_DIR: " " }, "/data")).toBe("/data");
    expect(agentDataDir({}, "/data")).toBe("/data");
  });
});

describe("proxiedMcp", () => {
  test("points the MCP url at the local proxy", () => {
    expect(proxiedMcp(turnRequest(), 4000).mcp?.url).toBe("http://127.0.0.1:4000/mcp/bot-1/session-1");
    const absolute = turnRequest({ mcp: { url: "https://bots.example/mcp/a/b?x=1", token: "t" } });
    expect(proxiedMcp(absolute, 4000).mcp?.url).toBe("http://127.0.0.1:4000/mcp/a/b?x=1");
    const none = turnRequest({ mcp: null });
    expect(proxiedMcp(none, 4000)).toBe(none);
  });
});

describe("runBoxAgent", () => {
  test("runs the turn with hooks and the MCP proxy, emitting events and end", async () => {
    const seen: Array<{ request: TurnRequest; baseDir: string; hooks: NativeToolHooks | undefined }> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const results: unknown[] = [];
    const { out, send, close, done, waitFor, clock } = harness(async (request, baseDir, _signal, emit, hooks) => {
      seen.push({ request, baseDir, hooks });
      emit({ type: "session", id: "s1" });
      const url = request.mcp?.url ?? "";
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json", "x-other": "no" },
        body: '{"jsonrpc":"2.0"}',
      });
      results.push(response.status, response.headers.get("mcp-session-id"), await response.text());
      results.push(await hooks?.before("Bash", { command: "ls" }, "t1"));
      results.push(await hooks?.before("Bash", { command: "pwd" }, "t2"));
      results.push(await hooks?.before("Bash", { command: "id" }, "t3"));
      await hooks?.after("Bash", { command: "ls" }, "out", "t1", false);
      await gate;
      emit({ type: "done", ok: true });
    });
    send("garbage");
    send({ type: "start", request: { nope: true } });
    send({ type: "start", request: turnRequest(), hooks: true });
    const mcp = await waitFor(({ type }) => type === "mcp.request", "mcp.request");
    expect(mcp).toMatchObject({
      method: "POST",
      path: "/mcp/bot-1/session-1",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    });
    send({ type: "mcp.response", id: mcp.id, status: 200, headers: { "mcp-session-id": "sid" }, body: "pong" });
    const first = await waitFor(({ type, toolUseId }) => type === "hook.request" && toolUseId === "t1", "hook t1");
    expect(first).toMatchObject({ phase: "before", tool: "Bash", input: { command: "ls" } });
    send({ type: "hook.response", id: first.id, gate: { allow: true, input: { command: "ls -a" } } });
    const second = await waitFor(({ toolUseId }) => toolUseId === "t2", "hook t2");
    send({ type: "hook.response", id: second.id, gate: "nope" });
    await waitFor(({ toolUseId }) => toolUseId === "t3", "hook t3");
    clock.advance(30_000);
    const after = await waitFor(({ phase }) => phase === "after", "after");
    expect(after).toMatchObject({ response: "out", failed: false, toolUseId: "t1" });
    send({ type: "hook.response", id: after.id });
    release();
    expect(await done).toBe(0);
    close();
    expect(seen[0]?.baseDir).toBe("/data");
    expect(String(seen[0]?.request.mcp?.url)).toStartWith("http://127.0.0.1:");
    expect(results).toEqual([
      200,
      "sid",
      "pong",
      { allow: true, input: { command: "ls -a" } },
      { allow: false, message: "O servidor respondeu ao hook sem decisão." },
      { allow: false, message: "O servidor não respondeu ao hook a tempo; a ferramenta foi negada." },
    ]);
    expect(out.filter(({ type }) => type === "event").map(({ event }) => event)).toEqual([
      { type: "session", id: "s1" },
      { type: "done", ok: true },
    ]);
    expect(out.at(-1)).toEqual({ type: "end", ok: true });
  });

  test("cancel aborts the signal, pending MCP calls get 502 and no hooks are passed", async () => {
    const statuses: number[] = [];
    const hooksSeen: Array<NativeToolHooks | undefined> = [];
    const { out, send, close, done, waitFor } = harness(async (request, _dir, signal, emit, hooks) => {
      hooksSeen.push(hooks);
      const pending = fetch(request.mcp?.url ?? "", { method: "GET" });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      statuses.push((await pending).status);
      emit({ type: "done", ok: false, message: "cancelled" });
    });
    send({ type: "start", request: turnRequest() });
    await waitFor(({ type }) => type === "mcp.request", "mcp");
    send({ type: "cancel" });
    expect(await done).toBe(1);
    close();
    expect(hooksSeen).toEqual([undefined]);
    expect(statuses).toEqual([502]);
    expect(out.at(-1)).toEqual({ type: "end", ok: false });
  });

  test("a throwing provider still ends the turn", async () => {
    const harnessed = harness(async () => {
      throw new Error("cli crashed");
    });
    harnessed.send({ type: "start", request: turnRequest() });
    expect(await harnessed.done).toBe(1);
    harnessed.close();
    const thrown = harness(async () => {
      throw "plain";
    });
    thrown.send({ type: "start", request: turnRequest() });
    expect(await thrown.done).toBe(1);
    thrown.close();
    const events = (list: JsonRecord[]) => list.filter(({ type }) => type === "event").map(({ event }) => event);
    expect(events(harnessed.out)).toEqual([{ type: "done", ok: false, message: "cli crashed" }]);
    expect(events(thrown.out)).toEqual([{ type: "done", ok: false, message: "plain" }]);
  });

  test("closing stdin before start exits with 1, and a non-numeric MCP status becomes 502", async () => {
    const early = harness(async () => undefined);
    early.close();
    expect(await early.done).toBe(1);
    expect(early.out).toEqual([]);
    const statuses: number[] = [];
    const odd = harness(async (request, _dir, _signal, emit: (event: ProviderEvent) => void) => {
      statuses.push((await fetch(request.mcp?.url ?? "", { method: "DELETE" })).status);
      emit({ type: "done", ok: true });
    });
    odd.send({ type: "start", request: turnRequest() });
    const mcp = await odd.waitFor(({ type }) => type === "mcp.request", "mcp");
    odd.send({ type: "mcp.response", id: mcp.id, status: "x", body: 1 });
    expect(await odd.done).toBe(0);
    odd.close();
    expect(statuses).toEqual([502]);
  });
});
