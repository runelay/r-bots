import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { runCodex } from "../codex";
import { fakeCli, recorder, turnRequest } from "./fakes";

const signal = () => new AbortController().signal;

describe("runCodex", () => {
  beforeEach(() => {
    fakeCli.reset();
    fakeCli.install("codex");
  });

  test("reports a missing CLI", async () => {
    const exists = spyOn(fs, "existsSync").mockReturnValue(false);
    const { events, emit } = recorder();
    await runCodex(turnRequest({ provider: "codex" }), fakeCli.home, signal(), emit);
    exists.mockRestore();
    expect(events).toEqual([{ type: "done", ok: false, message: "Codex CLI não está instalado." }]);
  });

  test("builds a read-only chat invocation and streams events", async () => {
    fakeCli.reply("codex", {
      stdout: [
        "not json",
        JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
        JSON.stringify({ type: "thread.started", thread_id: 5 }),
        JSON.stringify({ type: "item.started", item: { id: "m0", type: "agent_message", text: "partial" } }),
        JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Hi" } }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "No id" } }),
        JSON.stringify({ type: "item.completed", item: { id: "m2", type: "agent_message" } }),
        JSON.stringify({ type: "item.completed" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
        }),
      ].join("\n"),
    });
    const { events, emit } = recorder();
    await runCodex(turnRequest({ provider: "codex", prompt: "do it" }), fakeCli.home, signal(), emit);
    expect(events[0]).toEqual({ type: "session", id: "th-1" });
    expect(events[1]).toEqual({ type: "text", part: "m1", text: "Hi" });
    expect(events[2]).toMatchObject({ type: "text", text: "No id" });
    expect(events.slice(3)).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 },
        contextTokens: null,
      },
      { type: "done", ok: true },
    ]);
    const args = fakeCli.args("codex");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args[args.indexOf("-C") + 1]).toBe(fakeCli.home);
    expect(args).toContain('developer_instructions="be brief"');
    expect(args).toContain("shell_tool");
    expect(args).not.toContain("resume");
    expect(args.some((arg) => arg.startsWith("model_reasoning_effort"))).toBe(false);
    expect(args.at(-1)).toBe("-");
    expect(fakeCli.stdin("codex")).toBe("do it");
    expect(fakeCli.env("codex").some((line) => line.startsWith("RUNELAY_MCP_TOKEN="))).toBe(false);
  });

  test("code turns get a writable sandbox, mcp, effort, resume and tool events", async () => {
    fakeCli.reply("codex", {
      stdout: [
        { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } },
        {
          type: "item.completed",
          item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a\nb", exit_code: 0 },
        },
        { type: "item.started", item: { type: "command_execution" } },
        { type: "item.completed", item: { type: "command_execution", exit_code: 2 } },
        { type: "item.completed", item: { type: "command_execution" } },
        { type: "item.started", item: { id: "f0", type: "file_change" } },
        {
          type: "item.completed",
          item: { id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "add" }, {}], status: "completed" },
        },
        { type: "item.completed", item: { type: "file_change", status: "failed" } },
        { type: "turn.completed" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    });
    const { events, emit } = recorder();
    await runCodex(
      turnRequest({
        provider: "codex",
        effort: "high",
        resume: "th-9",
        mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
        code: { cwd: fakeCli.binDir },
      }),
      fakeCli.home,
      signal(),
      emit,
    );
    const tools = events.filter((event) => event.type === "tool");
    expect(tools[0]).toEqual({ type: "tool", id: "c1", name: "Bash", phase: "start", input: { command: "ls" } });
    expect(tools[1]).toEqual({
      type: "tool",
      id: "c1",
      name: "Bash",
      phase: "end",
      input: { command: "ls" },
      output: { output: "a\nb", exitCode: 0 },
      ok: true,
    });
    expect(tools[2]).toMatchObject({ phase: "start", input: { command: "" } });
    expect(tools[3]).toMatchObject({ phase: "end", ok: false, output: { output: "", exitCode: 2 } });
    expect(tools[4]).toMatchObject({ phase: "end", ok: true, output: { exitCode: null } });
    expect(tools[5]).toEqual({ type: "tool", id: "f1", name: "Edit", phase: "start", input: { files: ["a.ts", ""] } });
    expect(tools[6]).toMatchObject({ id: "f1", phase: "end", output: { status: "completed" }, ok: true });
    expect(tools[8]).toMatchObject({ name: "Edit", phase: "end", output: { status: "failed" }, ok: false });
    expect(events.at(-2)).toMatchObject({ type: "usage", usage: { inputTokens: 0, cacheReadTokens: 0 } });
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
    const args = fakeCli.args("codex");
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(args[args.indexOf("-C") + 1]).toBe(fakeCli.binDir);
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('mcp_servers.bots.url="http://127.0.0.1:1/mcp"');
    expect(args).not.toContain("shell_tool");
    expect(args.slice(-3)).toEqual(["resume", "th-9", "-"]);
    expect(fakeCli.env("codex")).toContain("RUNELAY_MCP_TOKEN=tok");
    expect(fakeCli.env("codex").some((line) => line.startsWith("CODEX_HOME="))).toBe(false);
  });

  test("runs in the account directory it was given", async () => {
    fakeCli.lines("codex", [{ type: "turn.completed", usage: {} }]);
    await runCodex(
      turnRequest({ provider: "codex", configDir: "/home/x/.codex-work" }),
      fakeCli.home,
      new AbortController().signal,
      () => {},
    );
    expect(fakeCli.env("codex")).toContain("CODEX_HOME=/home/x/.codex-work");
  });

  test("read-only code turns stay in the read-only sandbox", async () => {
    fakeCli.lines("codex", [{ type: "turn.completed", usage: {} }]);
    const { events, emit } = recorder();
    await runCodex(
      turnRequest({ provider: "codex", code: { cwd: fakeCli.binDir, readOnly: true } }),
      fakeCli.home,
      signal(),
      emit,
    );
    const args = fakeCli.args("codex");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
  });

  test("turn.failed and error events fail the turn with their message", async () => {
    fakeCli.lines("codex", [{ type: "turn.completed" }, { type: "turn.failed", error: { message: "quota" } }]);
    const first = recorder();
    await runCodex(turnRequest({ provider: "codex" }), fakeCli.home, signal(), first.emit);
    expect(first.events.at(-1)).toEqual({ type: "done", ok: false, message: "quota" });

    fakeCli.lines("codex", [{ type: "turn.failed" }]);
    const second = recorder();
    await runCodex(turnRequest({ provider: "codex" }), fakeCli.home, signal(), second.emit);
    expect(second.events.at(-1)).toEqual({ type: "done", ok: false, message: "Falha no Codex." });

    fakeCli.lines("codex", [{ type: "error", message: "boom" }]);
    const third = recorder();
    await runCodex(turnRequest({ provider: "codex" }), fakeCli.home, signal(), third.emit);
    expect(third.events.at(-1)).toEqual({ type: "done", ok: false, message: "boom" });

    fakeCli.lines("codex", [{ type: "error" }]);
    const fourth = recorder();
    await runCodex(turnRequest({ provider: "codex" }), fakeCli.home, signal(), fourth.emit);
    expect(fourth.events.at(-1)).toEqual({ type: "done", ok: false, message: "Falha no Codex." });
  });

  test("a non-zero exit or missing completion fails with stderr or the exit code", async () => {
    fakeCli.lines("codex", [], 4, "l1\nl2\nl3\nl4\n");
    const withStderr = recorder();
    await runCodex(turnRequest({ provider: "codex" }), fakeCli.home, signal(), withStderr.emit);
    expect(withStderr.events.at(-1)).toEqual({ type: "done", ok: false, message: "l2 l3 l4" });

    fakeCli.lines("codex", [], 0);
    const unfinished = recorder();
    await runCodex(turnRequest({ provider: "codex" }), fakeCli.home, signal(), unfinished.emit);
    expect(unfinished.events.at(-1)).toEqual({ type: "done", ok: false, message: "Codex saiu com código 0." });
  });

  test("an aborted turn reports cancelled", async () => {
    fakeCli.lines("codex", [{ type: "turn.completed" }]);
    const controller = new AbortController();
    controller.abort();
    const { events, emit } = recorder();
    await runCodex(turnRequest({ provider: "codex", prompt: "" }), fakeCli.home, controller.signal, emit);
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: "cancelled" });
  });
});
