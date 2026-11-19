import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readUsage, runCursor, withInstructions } from "../cursor";
import { fakeCli, recorder, turnRequest } from "./fakes";

const signal = () => new AbortController().signal;

describe("cursor helpers", () => {
  test("readUsage accepts the known key spellings and ignores empty usage", () => {
    expect(readUsage(null)).toBeNull();
    expect(readUsage("x")).toBeNull();
    expect(readUsage({ inputTokens: 0, junk: 3 })).toBeNull();
    expect(
      readUsage({ input_tokens: 1, completion_tokens: 2, cached_input_tokens: 3, cacheCreationInputTokens: 4 }),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    expect(readUsage({ prompt_tokens: "9", outputTokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("withInstructions wraps the system prompt only on fresh sessions", () => {
    expect(withInstructions(turnRequest())).toBe("<instructions>\nbe brief\n</instructions>\n\nhello");
    expect(withInstructions(turnRequest({ resume: "s1" }))).toBe("hello");
  });
});

describe("runCursor", () => {
  beforeEach(() => {
    fakeCli.reset();
    fakeCli.install("cursor-agent");
  });

  test("reports a missing CLI", async () => {
    const exists = spyOn(fs, "existsSync").mockReturnValue(false);
    const { events, emit } = recorder();
    await runCursor(turnRequest({ provider: "cursor" }), fakeCli.home, signal(), emit);
    exists.mockRestore();
    expect(events).toEqual([{ type: "done", ok: false, message: "cursor-agent não está instalado." }]);
  });

  test("falls back to the agent binary name", async () => {
    fakeCli.remove("cursor-agent");
    fakeCli.install("agent");
    fakeCli.lines("agent", [{ type: "result" }]);
    const { events, emit } = recorder();
    await runCursor(turnRequest({ provider: "cursor" }), fakeCli.home, signal(), emit);
    expect(events).toEqual([{ type: "done", ok: true }]);
  });

  test("writes the mcp config, passes flags and streams text, session and usage", async () => {
    fakeCli.reply("cursor-agent", {
      stdout: [
        "garbage",
        JSON.stringify({ type: "system", session_id: "cs-1" }),
        JSON.stringify({
          type: "assistant",
          session_id: "ignored",
          message: { content: [{ type: "text", text: "Hel" }, { type: "tool_use" }, { type: "text", text: "lo" }] },
        }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "  " }] } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text" }, { type: "text", text: "again" }] },
        }),
        JSON.stringify({ type: "assistant" }),
        JSON.stringify({ type: "result", session_id: "cs-1", usage: { input_tokens: 7 } }),
      ].join("\n"),
    });
    const { events, emit } = recorder();
    await runCursor(
      turnRequest({ provider: "cursor", resume: "cs-0", mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" } }),
      fakeCli.home,
      signal(),
      emit,
    );
    expect(events).toEqual([
      { type: "session", id: "cs-1" },
      { type: "text", part: "cursor-0", text: "Hello" },
      { type: "text", part: "cursor-1", text: "again" },
      { type: "session", id: "cs-1" },
      {
        type: "usage",
        usage: { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextTokens: null,
      },
      { type: "done", ok: true },
    ]);
    const config = JSON.parse(await readFile(join(fakeCli.home, ".cursor", "mcp.json"), "utf8"));
    expect(config).toEqual({
      mcpServers: { bots: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer tok" } } },
    });
    const args = fakeCli.args("cursor-agent");
    expect(args[args.indexOf("--workspace") + 1]).toBe(fakeCli.home);
    expect(args[args.indexOf("--model") + 1]).toBe("model-x");
    expect(args[args.indexOf("--resume") + 1]).toBe("cs-0");
    expect(args.at(-1)).toBe("hello");
  });

  test("an empty mcp config is written when there is no mcp target", async () => {
    fakeCli.lines("cursor-agent", [{ type: "result" }]);
    const { emit } = recorder();
    await runCursor(turnRequest({ provider: "cursor" }), fakeCli.home, signal(), emit);
    const config = JSON.parse(await readFile(join(fakeCli.home, ".cursor", "mcp.json"), "utf8"));
    expect(config).toEqual({ mcpServers: {} });
    expect(fakeCli.args("cursor-agent")).not.toContain("--resume");
  });

  test("error results and error events fail the turn", async () => {
    const cases: Array<[unknown[], string]> = [
      [[{ type: "result", is_error: true, result: "bad" }], "bad"],
      [[{ type: "result", subtype: "error", error: "worse" }], "worse"],
      [[{ type: "result", is_error: true }], "Falha no Cursor."],
      [[{ type: "error", message: "m" }], "m"],
      [[{ type: "error", error: "e" }], "e"],
      [[{ type: "error" }], "Falha no Cursor."],
    ];
    for (const [lines, message] of cases) {
      fakeCli.lines("cursor-agent", lines);
      const { events, emit } = recorder();
      await runCursor(turnRequest({ provider: "cursor" }), fakeCli.home, signal(), emit);
      expect(events.at(-1)).toEqual({ type: "done", ok: false, message });
    }
  });

  test("non-zero exit or missing result fails with stderr or the exit code", async () => {
    fakeCli.lines("cursor-agent", [{ type: "result" }], 2, "oops\n");
    const failed = recorder();
    await runCursor(turnRequest({ provider: "cursor" }), fakeCli.home, signal(), failed.emit);
    expect(failed.events.at(-1)).toEqual({ type: "done", ok: false, message: "oops" });

    fakeCli.lines("cursor-agent", []);
    const unfinished = recorder();
    await runCursor(turnRequest({ provider: "cursor" }), fakeCli.home, signal(), unfinished.emit);
    expect(unfinished.events.at(-1)).toEqual({ type: "done", ok: false, message: "cursor-agent saiu com código 0." });
  });

  test("an aborted turn reports cancelled", async () => {
    fakeCli.lines("cursor-agent", [{ type: "result" }]);
    const controller = new AbortController();
    controller.abort();
    const { events, emit } = recorder();
    await runCursor(turnRequest({ provider: "cursor" }), fakeCli.home, controller.signal, emit);
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: "cancelled" });
  });
});
