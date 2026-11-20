import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type HookCallback,
  type HookJSONOutput,
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { LiveInbox, LiveMessage, NativeToolHooks, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { accountEnv, childEnv } from "./proc";
import { spawnMarked } from "./proc-tree";

export function contextBudgetEnv(env: Record<string, string | undefined> = Bun.env) {
  return {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: env.BOTS_COMPACT_WINDOW ?? "200000",
    BASH_MAX_OUTPUT_LENGTH: env.BOTS_BASH_OUTPUT_CHARS ?? "12000",
    MAX_MCP_OUTPUT_TOKENS: env.BOTS_MCP_OUTPUT_TOKENS ?? "10000",
  };
}

export const nativeTools = ["Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "Bash", "TodoWrite"];

export const hookFailureMessage = "A checagem de segurança desta ferramenta falhou; a chamada foi negada.";
export const unclearedMessage = "Esta chamada não passou pela checagem de segurança e foi negada.";

type Cleared = Map<string, Record<string, unknown>>;

function codeHooks(hooks: NativeToolHooks, cleared: Cleared) {
  const matcher = `^(${nativeTools.join("|")}|NotebookEdit)$`;
  const pre: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const id = input.tool_use_id ?? toolUseId ?? "";
    const original = (input.tool_input ?? {}) as Record<string, unknown>;
    let gate: Awaited<ReturnType<NativeToolHooks["before"]>>;
    try {
      gate = await hooks.before(input.tool_name, original, id);
    } catch {
      gate = { allow: false, message: hookFailureMessage };
    }
    if (gate.allow && id) cleared.set(id, gate.input ?? original);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: gate.allow ? "allow" : "deny",
        ...(gate.message ? { permissionDecisionReason: gate.message } : {}),
        ...(gate.input ? { updatedInput: gate.input } : {}),
      },
    } as HookJSONOutput;
  };
  const post: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name === "PostToolUse") {
      await hooks.after(
        input.tool_name,
        (input.tool_input ?? {}) as Record<string, unknown>,
        input.tool_response,
        input.tool_use_id ?? toolUseId ?? "",
        false,
      );
    } else if (input.hook_event_name === "PostToolUseFailure") {
      await hooks.after(
        input.tool_name,
        (input.tool_input ?? {}) as Record<string, unknown>,
        input.error,
        input.tool_use_id ?? toolUseId ?? "",
        true,
      );
    }
    return {};
  };
  return {
    PreToolUse: [{ matcher, timeout: 900, hooks: [pre] }],
    PostToolUse: [{ matcher, timeout: 120, hooks: [post] }],
    PostToolUseFailure: [{ matcher, timeout: 120, hooks: [post] }],
  };
}

export function canUseFrom(cleared: Cleared) {
  return async (_name: string, _input: Record<string, unknown>, options: { toolUseID?: string }) => {
    const id = options.toolUseID ?? "";
    const recorded = id ? cleared.get(id) : undefined;
    if (!recorded) return { behavior: "deny" as const, message: unclearedMessage };
    cleared.delete(id);
    return { behavior: "allow" as const, updatedInput: recorded };
  };
}

export function privateMcpArgs(args: string[], workDir: string) {
  const at = args.indexOf("--mcp-config");
  if (at === -1 || at + 1 >= args.length) return { args, file: null };
  const value = args[at + 1];
  if (!value.trimStart().startsWith("{")) return { args, file: null };
  const dir = join(workDir, ".private");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `mcp-${randomBytes(9).toString("hex")}.json`);
  writeFileSync(file, value, { mode: 0o600 });
  const next = [...args];
  next[at + 1] = file;
  return { args: next, file };
}

async function userMessage(
  text: string,
  images: LiveMessage["images"] = [],
  priority?: "next",
): Promise<SDKUserMessage> {
  const content: Array<Record<string, unknown>> = [];
  for (const image of images) {
    const data = await readFile(image.path).catch(() => null);
    if (!data) continue;
    content.push({ type: "text", text: image.label });
    content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: data.toString("base64") } });
  }
  content.push({ type: "text", text: text || "Veja os anexos." });
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
    ...(priority ? { priority } : {}),
  } as unknown as SDKUserMessage;
}

export function liveInput(first: Promise<SDKUserMessage>) {
  const pending: Promise<SDKUserMessage>[] = [first];
  let wake: (() => void) | null = null;
  let closed = false;
  const messages = (async function* () {
    for (;;) {
      const next = pending.shift();
      if (next) {
        const message = await next.catch(() => null);
        if (message) yield message;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  })();
  const nudge = () => (wake as (() => void) | null)?.();
  return {
    messages,
    push(message: Promise<SDKUserMessage>) {
      if (closed) return false;
      pending.push(message);
      nudge();
      return true;
    },
    close() {
      closed = true;
      nudge();
    },
  };
}

function promptWithImages(request: TurnRequest): string | AsyncIterable<SDKUserMessage> {
  if (!request.images?.length) return request.prompt;
  return (async function* () {
    yield await userMessage(request.prompt, request.images);
  })();
}

export async function runClaude(
  request: TurnRequest,
  workDir: string,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  hooks?: NativeToolHooks,
  inbox?: LiveInbox,
) {
  const code = request.code && hooks ? request.code : null;
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const partsByMessage = new Map<string, string[]>();
  const partByIndex = new Map<string, string>();
  let currentMessage = "";
  let contextTokens: number | null = null;
  let result: Extract<SDKMessage, { type: "result" }> | null = null;
  const cleared: Cleared = new Map();
  const env = childEnv({
    ...accountEnv("claude", request.configDir),
    CLAUDE_AGENT_SDK_CLIENT_APP: "runelay-bots/3.0.0",
    MCP_TOOL_TIMEOUT: "900000",
    ...contextBudgetEnv(),
  });

  const live = inbox ? liveInput(userMessage(request.prompt, request.images)) : null;
  const closeLive = () => {
    if (!live) return;
    live.close();
    inbox?.(null);
  };
  signal.addEventListener("abort", closeLive, { once: true });
  if (live && inbox && !signal.aborted)
    inbox((message) => live.push(Promise.resolve(message).then((item) => userMessage(item.text, item.images, "next"))));
  let totals: Record<string, number> | null = null;

  const stream = query({
    prompt: live ? live.messages : promptWithImages(request),
    options: {
      model: request.model,
      ...(request.effort ? { effort: request.effort as "low" | "medium" | "high" } : {}),
      systemPrompt: request.systemPrompt,
      tools: code ? nativeTools : [],
      allowedTools: request.mcp ? ["mcp__bots"] : [],
      ...(code && hooks
        ? {
            hooks: codeHooks(hooks, cleared),
            canUseTool: canUseFrom(cleared),
          }
        : {}),
      mcpServers: request.mcp
        ? {
            bots: {
              type: "http",
              url: request.mcp.url,
              headers: { Authorization: `Bearer ${request.mcp.token}` },
              timeout: 900_000,
            },
          }
        : {},
      permissionMode: code ? "default" : "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      cwd: code ? code.cwd : workDir,
      includePartialMessages: true,
      abortController,
      env,
      ...(Bun.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: Bun.env.CLAUDE_CODE_EXECUTABLE } : {}),
      ...(process.platform === "linux"
        ? {
            spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
              const { args, file } = privateMcpArgs(spawnOptions.args, workDir);
              const forget = () => {
                if (file) rmSync(file, { force: true });
              };
              try {
                const child = spawnMarked(spawnOptions.command, args, {
                  cwd: spawnOptions.cwd,
                  env: spawnOptions.env,
                  marker: request.turnId,
                  signal: spawnOptions.signal,
                });
                child.once("exit", forget);
                child.once("error", forget);
                return child as unknown as SpawnedProcess;
              } catch (error) {
                forget();
                throw error;
              }
            },
          }
        : {}),
      ...(request.resume ? { resume: request.resume, ...(request.fork ? { forkSession: true } : {}) } : {}),
    },
  });

  try {
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        emit({ type: "session", id: message.session_id });
        continue;
      }
      if (message.type === "result") {
        result = message;
        const usage = (message as { usage?: Record<string, number> }).usage;
        if (usage) {
          const sum: Record<string, number> = totals ?? {};
          for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
            sum[key] = (sum[key] ?? 0) + (usage[key] ?? 0);
          totals = sum;
        }
        closeLive();
        continue;
      }
      if (message.type === "stream_event") {
        if (message.parent_tool_use_id) continue;
        const event = message.event as {
          type: string;
          index?: number;
          message?: { id?: string; usage?: Record<string, number> };
          content_block?: { type: string };
          delta?: { type: string; text?: string };
        };
        if (event.type === "message_start") {
          currentMessage = event.message?.id ?? String(Date.now());
          const usage = event.message?.usage;
          if (usage) {
            contextTokens =
              (usage.input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0);
          }
        } else if (event.type === "content_block_start" && event.content_block?.type === "text") {
          const part = `${currentMessage}:${event.index ?? 0}`;
          partByIndex.set(`${currentMessage}:${event.index ?? 0}`, part);
          const queue = partsByMessage.get(currentMessage) ?? [];
          queue.push(part);
          partsByMessage.set(currentMessage, queue);
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const part = partByIndex.get(`${currentMessage}:${event.index ?? 0}`);
          if (part) emit({ type: "text.delta", part, text: event.delta.text ?? "" });
        }
        continue;
      }
      if (message.type === "assistant" && !message.parent_tool_use_id) {
        const id = message.message.id ?? currentMessage;
        for (const block of message.message.content as Array<{ type: string; text?: string }>) {
          if (block.type !== "text") continue;
          const queue = partsByMessage.get(id) ?? [];
          const part = queue.shift() ?? `${id}:${Math.random().toString(36).slice(2, 8)}`;
          emit({ type: "text", part, text: block.text ?? "" });
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", closeLive);
    closeLive();
  }

  const final = result as (Extract<SDKMessage, { type: "result" }> & { errors?: string[]; result?: string }) | null;
  const spent = totals as Record<string, number> | null;
  if (spent) {
    emit({
      type: "usage",
      usage: {
        inputTokens: spent.input_tokens ?? 0,
        outputTokens: spent.output_tokens ?? 0,
        cacheReadTokens: spent.cache_read_input_tokens ?? 0,
        cacheWriteTokens: spent.cache_creation_input_tokens ?? 0,
      },
      contextTokens,
    });
  }
  if (final?.session_id) emit({ type: "session", id: final.session_id });
  if (!final)
    return emit({ type: "done", ok: false, message: signal.aborted ? "cancelled" : "O modelo não respondeu." });
  if (final.is_error)
    return emit({
      type: "done",
      ok: false,
      message: final.errors?.join(" ") || String(final.result ?? "Falha no Claude."),
    });
  emit({ type: "done", ok: true });
}
