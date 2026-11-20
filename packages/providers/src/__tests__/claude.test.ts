import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  SDKMessage,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { LivePush, NativeToolHooks } from "@runelay-bots/protocol";
import { hookFailureMessage, nativeTools, privateMcpArgs, runClaude, unclearedMessage } from "../claude";
import { fakeCli, fakeSdk, type QueryParams, recorder, turnRequest } from "./fakes";

const signal = () => new AbortController().signal;

function replay(messages: unknown[], onStart?: (params: QueryParams) => Promise<void> | void) {
  fakeSdk.next(async function* (params) {
    await onStart?.(params);
    for (const message of messages) yield message as SDKMessage;
  });
}

const success = { type: "result", is_error: false, session_id: "s-final" };

function stream(event: Record<string, unknown>, parent: string | null = null) {
  return { type: "stream_event", parent_tool_use_id: parent, event };
}

describe("runClaude", () => {
  beforeEach(() => {
    fakeSdk.reset();
    fakeCli.reset();
  });

  test("chat turns map stream events, text blocks and usage", async () => {
    replay([
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "system", subtype: "status" },
      stream({ type: "message_start" }, "tool-1"),
      stream({
        type: "message_start",
        message: { id: "msg-1", usage: { input_tokens: 5, cache_read_input_tokens: 7 } },
      }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      stream({ type: "content_block_start", index: 1, content_block: { type: "thinking" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta" } }),
      stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lost" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } }),
      stream({ type: "message_stop" }),
      {
        type: "assistant",
        parent_tool_use_id: "tool-1",
        message: { id: "x", content: [{ type: "text", text: "sub" }] },
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg-1", content: [{ type: "text", text: "Hi there" }, { type: "tool_use" }, { type: "text" }] },
      },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "late" }] } },
      {
        ...success,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      },
    ]);
    const { events, emit } = recorder();
    await runClaude(turnRequest(), fakeCli.home, signal(), emit);
    expect(events[0]).toEqual({ type: "session", id: "s-1" });
    expect(events[1]).toEqual({ type: "text.delta", part: "msg-1:0", text: "Hi" });
    expect(events[2]).toEqual({ type: "text.delta", part: "msg-1:0", text: "" });
    expect(events[3]).toEqual({ type: "text", part: "msg-1:0", text: "Hi there" });
    expect(events[4]).toMatchObject({ type: "text", text: "" });
    expect((events[4] as { part: string }).part).toStartWith("msg-1:");
    expect(events[5]).toMatchObject({ type: "text", text: "late" });
    expect(events.slice(6)).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        contextTokens: 12,
      },
      { type: "session", id: "s-final" },
      { type: "done", ok: true },
    ]);
    const options = fakeSdk.calls[0].options ?? {};
    expect(fakeSdk.calls[0].prompt).toBe("hello");
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.cwd).toBe(fakeCli.home);
    expect(options.hooks).toBeUndefined();
    expect(options.resume).toBeUndefined();
    expect(options.effort).toBeUndefined();
    expect(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("runelay-bots/3.0.0");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("runs in the account directory it was given", async () => {
    replay([{ type: "result", subtype: "success", usage: {} } as unknown as SDKMessage]);
    await runClaude(
      turnRequest({ configDir: "/home/x/.claude-2" }),
      fakeCli.home,
      new AbortController().signal,
      () => {},
    );
    expect(fakeSdk.calls.at(-1)?.options?.env?.CLAUDE_CONFIG_DIR).toBe("/home/x/.claude-2");
  });

  test("message_start without id or usage falls back to a timestamp id and zero context", async () => {
    replay([
      stream({ type: "message_start", message: { usage: {} } }),
      stream({ type: "content_block_start", content_block: { type: "text" } }),
      stream({ type: "content_block_delta", delta: { type: "text_delta", text: "a" } }),
      stream({ type: "message_start" }),
      { ...success, usage: {} },
    ]);
    const { events, emit } = recorder();
    await runClaude(turnRequest(), fakeCli.home, signal(), emit);
    expect(events[0]).toMatchObject({ type: "text.delta", text: "a" });
    expect((events[0] as { part: string }).part).toMatch(/^\d+:0$/);
    expect(events[1]).toEqual({
      type: "usage",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextTokens: 0,
    });
  });

  test("failed results report errors, result text or a default", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ errors: ["a", "b"] }, "a b"],
      [{ errors: [], result: "text" }, "text"],
      [{}, "Falha no Claude."],
    ];
    for (const [extra, message] of cases) {
      replay([{ type: "result", is_error: true, ...extra }]);
      const { events, emit } = recorder();
      await runClaude(turnRequest(), fakeCli.home, signal(), emit);
      expect(events).toEqual([{ type: "done", ok: false, message }]);
    }
  });

  test("a stream without result fails, as cancelled when aborted", async () => {
    replay([]);
    const silent = recorder();
    await runClaude(turnRequest(), fakeCli.home, signal(), silent.emit);
    expect(silent.events).toEqual([{ type: "done", ok: false, message: "O modelo não respondeu." }]);

    const controller = new AbortController();
    replay([], (params) => {
      controller.abort();
      expect(params.options?.abortController?.signal.aborted).toBe(true);
    });
    const aborted = recorder();
    await runClaude(turnRequest(), fakeCli.home, controller.signal, aborted.emit);
    expect(aborted.events).toEqual([{ type: "done", ok: false, message: "cancelled" }]);
  });

  test("images become a multimodal user message", async () => {
    const image = join(fakeCli.home, "pic.png");
    await writeFile(image, "png-bytes");
    let consumed: unknown[] = [];
    replay([success], async (params) => {
      consumed = [];
      for await (const message of params.prompt as AsyncIterable<unknown>) consumed.push(message);
    });
    const { emit } = recorder();
    await runClaude(
      turnRequest({
        prompt: "",
        images: [
          { path: image, mime: "image/png", label: "first" },
          { path: join(fakeCli.home, "missing.png"), mime: "image/png", label: "gone" },
        ],
      }),
      fakeCli.home,
      signal(),
      emit,
    );
    expect(consumed).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "first" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: Buffer.from("png-bytes").toString("base64") },
            },
            { type: "text", text: "Veja os anexos." },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      },
    ]);

    replay([success], async (params) => {
      consumed = [];
      for await (const message of params.prompt as AsyncIterable<{ message: { content: unknown[] } }>)
        consumed.push(message.message.content.at(-1));
    });
    await runClaude(
      turnRequest({ prompt: "look", images: [{ path: image, mime: "image/png", label: "x" }] }),
      fakeCli.home,
      signal(),
      emit,
    );
    expect(consumed).toEqual([{ type: "text", text: "look" }]);
  });

  test("live input pushes messages into the running query and closes after the result", async () => {
    const image = join(fakeCli.home, "live.png");
    await writeFile(image, "live-bytes");
    let push: LivePush | null = null;
    const states: boolean[] = [];
    const consumed: Array<{ priority?: string; message: { content: Array<{ type: string; text?: string }> } }> = [];
    fakeSdk.next(async function* (params) {
      const input = (params.prompt as AsyncIterable<(typeof consumed)[number]>)[Symbol.asyncIterator]();
      consumed.push((await input.next()).value);
      expect(push?.({ text: "muda o título", images: [{ path: image, mime: "image/png", label: "faixa" }] })).toBe(
        true,
      );
      consumed.push((await input.next()).value);
      yield success as unknown as SDKMessage;
      expect((await input.next()).done).toBe(true);
    });
    const { emit, events } = recorder();
    await runClaude(turnRequest({ prompt: "faz a landing" }), fakeCli.home, signal(), emit, undefined, (next) => {
      states.push(next !== null);
      push = next;
    });
    expect(consumed[0].priority).toBeUndefined();
    expect(consumed[0].message.content).toEqual([{ type: "text", text: "faz a landing" }]);
    expect(consumed[1].priority).toBe("next");
    expect(consumed[1].message.content.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(consumed[1].message.content.at(-1)).toEqual({ type: "text", text: "muda o título" });
    expect(states).toEqual([true, false, false]);
    expect((push as LivePush | null)?.({ text: "tarde" }) ?? false).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
  });

  test("mcp, effort and resume are forwarded", async () => {
    replay([success]);
    const { emit } = recorder();
    await runClaude(
      turnRequest({ effort: "high", resume: "s-0", mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" } }),
      fakeCli.home,
      signal(),
      emit,
    );
    const options = fakeSdk.calls[0].options ?? {};
    expect(options.allowedTools).toEqual(["mcp__bots"]);
    expect(options.mcpServers).toEqual({
      bots: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer tok" }, timeout: 900_000 },
    });
    expect(options.effort).toBe("high");
    expect(options.resume).toBe("s-0");
  });

  test("code turns without hooks stay in chat mode", async () => {
    replay([success]);
    const { emit } = recorder();
    await runClaude(turnRequest({ code: { cwd: fakeCli.binDir } }), fakeCli.home, signal(), emit);
    const options = fakeSdk.calls[0].options ?? {};
    expect(options.tools).toEqual([]);
    expect(options.cwd).toBe(fakeCli.home);
  });

  test("code turns with hooks enable native tools and route hook calls", async () => {
    const calls: unknown[][] = [];
    const hooks: NativeToolHooks = {
      before: async (tool, input, id) => {
        calls.push(["before", tool, input, id]);
        if (tool === "Bash") return { allow: false, message: "no shell" };
        if (tool === "Edit") return { allow: true, input: { file: "safe" } };
        return { allow: true };
      },
      after: async (tool, input, response, id, failed) => {
        calls.push(["after", tool, input, response, id, failed]);
      },
    };
    replay([success]);
    const { emit } = recorder();
    await runClaude(turnRequest({ code: { cwd: fakeCli.binDir } }), fakeCli.home, signal(), emit, hooks);
    const options = fakeSdk.calls[0].options ?? {};
    expect(options.tools).toEqual(nativeTools);
    expect(options.permissionMode).toBe("default");
    expect(options.cwd).toBe(fakeCli.binDir);
    expect(await options.canUseTool?.("Read", { a: 1 }, {} as never)).toEqual({
      behavior: "deny",
      message: unclearedMessage,
    });

    const registered = options.hooks as Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    expect(registered.PreToolUse?.[0].matcher).toBe(`^(${nativeTools.join("|")}|NotebookEdit)$`);
    const pre = registered.PreToolUse?.[0].hooks[0] as HookCallback;
    const post = registered.PostToolUse?.[0].hooks[0] as HookCallback;
    expect(registered.PostToolUseFailure?.[0].hooks[0]).toBe(post);
    const context = { signal: new AbortController().signal };
    const input = (fields: Record<string, unknown>) => fields as unknown as Parameters<HookCallback>[0];

    expect(
      await pre(
        input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { c: 1 }, tool_use_id: "u1" }),
        "x",
        context,
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no shell",
      },
    });
    expect(await pre(input({ hook_event_name: "PreToolUse", tool_name: "Edit" }), "u2", context)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { file: "safe" } },
    });
    expect(await pre(input({ hook_event_name: "PreToolUse", tool_name: "Read" }), undefined, context)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(await pre(input({ hook_event_name: "Stop" }), "u", context)).toEqual({});

    expect(
      await post(
        input({
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_input: { p: 1 },
          tool_response: "ok",
          tool_use_id: "u3",
        }),
        "x",
        context,
      ),
    ).toEqual({});
    await post(input({ hook_event_name: "PostToolUse", tool_name: "Read", tool_response: "ok" }), undefined, context);
    await post(
      input({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { c: 2 },
        error: "bad",
        tool_use_id: "u4",
      }),
      "x",
      context,
    );
    await post(input({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "bad" }), "u5", context);
    await post(input({ hook_event_name: "Stop" }), "u", context);

    const permissionOptions = (id: string) => ({ toolUseID: id }) as never;
    expect(await options.canUseTool?.("Bash", { c: 1 }, permissionOptions("u1"))).toEqual({
      behavior: "deny",
      message: unclearedMessage,
    });
    expect(await options.canUseTool?.("Edit", { file: "raw" }, permissionOptions("u2"))).toEqual({
      behavior: "allow",
      updatedInput: { file: "safe" },
    });
    expect(await options.canUseTool?.("Edit", { file: "raw" }, permissionOptions("u2"))).toEqual({
      behavior: "deny",
      message: unclearedMessage,
    });

    expect(calls).toEqual([
      ["before", "Bash", { c: 1 }, "u1"],
      ["before", "Edit", {}, "u2"],
      ["before", "Read", {}, ""],
      ["after", "Read", { p: 1 }, "ok", "u3", false],
      ["after", "Read", {}, "ok", "", false],
      ["after", "Bash", { c: 2 }, "bad", "u4", true],
      ["after", "Bash", {}, "bad", "u5", true],
    ]);
  });

  test("a hook that throws denies the call and canUseTool stays closed", async () => {
    const hooks: NativeToolHooks = {
      before: async () => {
        throw new Error("boom");
      },
      after: async () => {},
    };
    replay([success]);
    const { emit } = recorder();
    await runClaude(turnRequest({ code: { cwd: fakeCli.binDir } }), fakeCli.home, signal(), emit, hooks);
    const options = fakeSdk.calls[0].options ?? {};
    const registered = options.hooks as Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    const pre = registered.PreToolUse?.[0].hooks[0] as HookCallback;
    const output = await pre(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "t1",
      } as unknown as Parameters<HookCallback>[0],
      "t1",
      { signal: new AbortController().signal },
    );
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: hookFailureMessage,
      },
    });
    expect(await options.canUseTool?.("Bash", {}, { toolUseID: "t1" } as never)).toMatchObject({ behavior: "deny" });
  });

  test("privateMcpArgs moves an inline mcp config into a private file", () => {
    expect(privateMcpArgs(["-p"], fakeCli.home)).toEqual({ args: ["-p"], file: null });
    expect(privateMcpArgs(["--mcp-config"], fakeCli.home)).toEqual({ args: ["--mcp-config"], file: null });
    expect(privateMcpArgs(["--mcp-config", "/x.json"], fakeCli.home)).toEqual({
      args: ["--mcp-config", "/x.json"],
      file: null,
    });
    const json = '{"mcpServers":{"bots":{"headers":{"Authorization":"Bearer tok"}}}}';
    const { args, file } = privateMcpArgs(["--x", "--mcp-config", json, "--y"], fakeCli.home);
    expect(file).not.toBeNull();
    expect(args).toEqual(["--x", "--mcp-config", file as string, "--y"]);
    expect(readFileSync(file as string, "utf8")).toBe(json);
    expect(statSync(file as string).mode & 0o777).toBe(0o600);
    expect(statSync(join(fakeCli.home, ".private")).mode & 0o777).toBe(0o700);
  });

  test("the spawned CLI gets the mcp config as a file that is removed on exit", async () => {
    let seen = "";
    let path = "";
    replay([success], async (params) => {
      const spawnOptions: SpawnOptions = {
        command: "sh",
        args: ["-c", 'cat "$2" >/dev/null && printf %s "$2"', "sh", "--mcp-config", '{"token":"tok"}'],
        cwd: fakeCli.home,
        env: { PATH: process.env.PATH },
        signal: new AbortController().signal,
      };
      const child = params.options?.spawnClaudeCodeProcess?.(spawnOptions) as unknown as NodeJS.EventEmitter & {
        stdout: NodeJS.ReadableStream;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
      });
      await new Promise((resolve) => child.on("close", resolve));
    });
    const { emit } = recorder();
    await runClaude(turnRequest(), fakeCli.home, signal(), emit);
    path = seen.trim();
    expect(path).toStartWith(join(fakeCli.home, ".private", "mcp-"));
    expect(existsSync(path)).toBe(false);
  });

  test("a spawn failure removes the private mcp file and rethrows", async () => {
    let failure: unknown = null;
    replay([success], async (params) => {
      try {
        params.options?.spawnClaudeCodeProcess?.({
          command: "sh",
          args: ["--mcp-config", '{"a":1}'],
          cwd: fakeCli.home,
          env: { PATH: process.env.PATH },
          signal: "not a signal" as unknown as AbortSignal,
        });
      } catch (error) {
        failure = error;
      }
    });
    const { emit } = recorder();
    await runClaude(turnRequest(), fakeCli.home, signal(), emit);
    expect(failure).not.toBeNull();
  });

  test("on linux the CLI is spawned through spawnMarked with the turn marker", async () => {
    let output = "";
    replay([success], async (params) => {
      const spawnOptions: SpawnOptions = {
        command: "sh",
        args: ["-c", 'printf "$RUNELAY_TURN"'],
        cwd: fakeCli.home,
        env: { PATH: process.env.PATH },
        signal: new AbortController().signal,
      };
      const child = params.options?.spawnClaudeCodeProcess?.(spawnOptions) as unknown as NodeJS.EventEmitter & {
        stdout: NodeJS.ReadableStream;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      await new Promise((resolve) => child.on("close", resolve));
    });
    const { emit } = recorder();
    await runClaude(turnRequest({ turnId: "turn-xyz" }), fakeCli.home, signal(), emit);
    expect(output).toBe(`rb${process.env.GATEWAY_PORT}:turn-xyz`);
  });

  test("outside linux the SDK spawns the CLI itself", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    replay([success]);
    const { emit } = recorder();
    await runClaude(turnRequest(), fakeCli.home, signal(), emit);
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(fakeSdk.calls[0].options?.spawnClaudeCodeProcess).toBeUndefined();
  });
});
