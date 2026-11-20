import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { disallowedTools, runGrok } from "../grok";
import { fakeCli, recorder, turnRequest } from "./fakes";

const signal = () => new AbortController().signal;

async function run(lines: unknown[], overrides = {}, code = 0, stderr = "") {
  fakeCli.lines("grok", lines, code, stderr);
  const { events, emit } = recorder();
  await runGrok(turnRequest({ provider: "grok", ...overrides }), fakeCli.home, signal(), emit);
  return events;
}

describe("runGrok", () => {
  beforeEach(() => {
    fakeCli.reset();
    fakeCli.install("grok");
  });

  test("reports a missing CLI", async () => {
    const exists = spyOn(fs, "existsSync").mockReturnValue(false);
    const { events, emit } = recorder();
    await runGrok(turnRequest({ provider: "grok" }), fakeCli.home, signal(), emit);
    exists.mockRestore();
    expect(events).toEqual([{ type: "done", ok: false, message: "Grok CLI não está instalado." }]);
  });

  test("starts a new session with flags, writes the mcp config and streams deltas", async () => {
    const events = await run(
      [
        { type: "text_delta", text: "Hel" },
        { type: "content.delta", delta: "lo" },
        { type: "thinking_delta", text: "hmm" },
        { type: "delta", content: "" },
        { type: "tool_call" },
        { type: "message.delta", message: { content: "Next" } },
        { type: "delta", message: { content: [{ type: "text", text: "!" }, { type: "image" }, { type: "text" }] } },
        { type: "delta", message: { content: 3 } },
        "plain",
        { type: "assistant", text: "ignored because buffered" },
        { type: "message", message: { content: "Whole" } },
        { type: "message" },
        { type: "result", usage: { output_tokens: 2 } },
      ],
      { effort: "low", mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" } },
    );
    const session = events[0];
    expect(session.type).toBe("session");
    expect(events.slice(1)).toEqual([
      { type: "text.delta", part: "grok-0", text: "Hel" },
      { type: "text.delta", part: "grok-0", text: "lo" },
      { type: "text", part: "grok-0", text: "Hello" },
      { type: "text.delta", part: "grok-1", text: "Next" },
      { type: "text.delta", part: "grok-1", text: "!" },
      { type: "text", part: "grok-1", text: "Next!" },
      { type: "text", part: "grok-2", text: "Whole" },
      {
        type: "usage",
        usage: { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextTokens: null,
      },
      { type: "done", ok: true },
    ]);
    const args = fakeCli.args("grok");
    expect(args[args.indexOf("--session-id") + 1]).toBe((session as { id: string }).id);
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    expect(args[args.indexOf("--system-prompt-override") + 1]).toBe("be brief");
    expect(args[args.indexOf("-p") + 1]).toBe("hello");
    const config = await readFile(join(fakeCli.home, ".grok", "config.toml"), "utf8");
    expect(config).toContain('url = "http://127.0.0.1:1/mcp"');
    expect(config).toContain('Authorization = "Bearer tok"');
    const disallowed = args[args.indexOf("--disallowed-tools") + 1].split(",");
    expect(disallowed).toContain("run_terminal_cmd");
    expect(disallowed).toContain("bash");
    expect(disallowed).toContain("str_replace_editor");
    expect(fs.statSync(join(fakeCli.home, ".grok")).mode & 0o777).toBe(0o700);
  });

  test("native shell turns keep only the base deny list", async () => {
    await run([{ type: "done" }], { nativeShell: true });
    const args = fakeCli.args("grok");
    expect(args[args.indexOf("--disallowed-tools") + 1]).toBe(disallowedTools(true).join(","));
    expect(disallowedTools(true)).not.toContain("bash");
  });

  test("resumes an existing session without mcp config", async () => {
    const events = await run([{ type: "done" }], { resume: "g-1" });
    expect(events).toEqual([
      { type: "session", id: "g-1" },
      { type: "done", ok: true },
    ]);
    const args = fakeCli.args("grok");
    expect(args[args.indexOf("--resume") + 1]).toBe("g-1");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--effort");
    expect(await readFile(join(fakeCli.home, ".grok", "config.toml"), "utf8")).toBe("");
  });

  test("warns when the stream ends without a result", async () => {
    const events = await run([]);
    expect(events.slice(1)).toEqual([
      { type: "warning", message: "Grok terminou sem evento de resultado." },
      { type: "done", ok: true },
    ]);
  });

  test("error results, error events and exit codes fail the turn", async () => {
    expect((await run([{ type: "result", is_error: true, result: "bad" }])).at(-1)).toEqual({
      type: "done",
      ok: false,
      message: "bad",
    });
    expect((await run([{ type: "end", is_error: true }])).at(-1)).toMatchObject({ message: "Falha no Grok." });
    expect((await run([{ type: "error", message: "m" }])).at(-1)).toMatchObject({ message: "m" });
    expect((await run([{ type: "error", error: "e" }])).at(-1)).toMatchObject({ message: "e" });
    expect((await run([{ type: "error" }])).at(-1)).toMatchObject({ message: "Falha no Grok." });
    expect((await run([], {}, 3, "a\nb\n")).at(-1)).toMatchObject({ ok: false, message: "a b" });
    expect((await run([], {}, 3)).at(-1)).toMatchObject({ ok: false, message: "grok saiu com código 3." });
  });

  test("an aborted turn reports cancelled", async () => {
    fakeCli.lines("grok", [{ type: "result" }]);
    const controller = new AbortController();
    controller.abort();
    const { events, emit } = recorder();
    await runGrok(turnRequest({ provider: "grok" }), fakeCli.home, controller.signal, emit);
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: "cancelled" });
  });
});
