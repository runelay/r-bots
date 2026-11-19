import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnv, findBinary, parseJson, runLines } from "./proc";
import type { ProviderEvent, TurnRequest, Usage } from "@runelay-bots/protocol";

function number(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") return value;
  }
  return 0;
}

export function readUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const usage = {
    inputTokens: number(source, "inputTokens", "input_tokens", "prompt_tokens"),
    outputTokens: number(source, "outputTokens", "output_tokens", "completion_tokens"),
    cacheReadTokens: number(source, "cacheReadTokens", "cache_read_input_tokens", "cached_input_tokens", "cacheReadInputTokens"),
    cacheWriteTokens: number(source, "cacheWriteTokens", "cache_creation_input_tokens", "cacheCreationInputTokens"),
  };
  return Object.values(usage).some((value) => value > 0) ? usage : null;
}

export function withInstructions(request: TurnRequest) {
  if (request.resume) return request.prompt;
  return `<instructions>\n${request.systemPrompt}\n</instructions>\n\n${request.prompt}`;
}

export async function runCursor(request: TurnRequest, workDir: string, signal: AbortSignal, emit: (event: ProviderEvent) => void) {
  const bin = findBinary(["cursor-agent", "agent"]);
  if (!bin) return emit({ type: "done", ok: false, message: "cursor-agent não está instalado." });
  await mkdir(join(workDir, ".cursor"), { recursive: true });
  const servers = request.mcp
    ? { bots: { url: request.mcp.url, headers: { Authorization: `Bearer ${request.mcp.token}` } } }
    : {};
  await writeFile(join(workDir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--approve-mcps",
    "--sandbox",
    "enabled",
    "--workspace",
    workDir,
    "--model",
    request.model,
    ...(request.resume ? ["--resume", request.resume] : []),
    withInstructions(request),
  ];
  let failure: string | null = null;
  let finished = false;
  let index = 0;
  const { code, stderr } = await runLines(bin, args, { cwd: workDir, env: childEnv(), signal }, (line) => {
    const event = parseJson(line);
    if (!event) return;
    const type = String(event.type ?? "");
    if (typeof event.session_id === "string" && (type === "system" || type === "result")) emit({ type: "session", id: event.session_id });
    if (type === "assistant") {
      const content = ((event.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? []);
      const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      if (text.trim()) emit({ type: "text", part: `cursor-${index++}`, text });
    } else if (type === "result") {
      finished = true;
      const usage = readUsage(event.usage);
      if (usage) emit({ type: "usage", usage, contextTokens: null });
      if (event.is_error === true || event.subtype === "error") failure = String(event.result ?? event.error ?? "Falha no Cursor.");
    } else if (type === "error") {
      failure = String(event.message ?? event.error ?? "Falha no Cursor.");
    }
  });
  if (signal.aborted) return emit({ type: "done", ok: false, message: "cancelled" });
  if (failure || code !== 0 || !finished) {
    return emit({ type: "done", ok: false, message: failure ?? (stderr.trim().split("\n").slice(-3).join(" ") || `cursor-agent saiu com código ${code}.`) });
  }
  emit({ type: "done", ok: true });
}
