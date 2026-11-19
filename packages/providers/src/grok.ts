import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnv, findBinary, parseJson, runLines } from "./proc";
import type { ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { readUsage } from "./cursor";

const removedTools = [
  "run_terminal_cmd",
  "read_file",
  "grep",
  "list_dir",
  "search_replace",
  "write",
  "web_search",
  "web_fetch",
  "todo_write",
  "task",
  "Agent",
];

function toml(value: string) {
  return JSON.stringify(value);
}

function textOf(event: Record<string, unknown>) {
  for (const key of ["text", "delta", "content"]) {
    if (typeof event[key] === "string") return event[key] as string;
  }
  const message = event.message as { content?: unknown } | undefined;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return (message.content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }
  return "";
}

export async function runGrok(request: TurnRequest, workDir: string, signal: AbortSignal, emit: (event: ProviderEvent) => void) {
  const bin = findBinary(["grok"]);
  if (!bin) return emit({ type: "done", ok: false, message: "Grok CLI não está instalado." });
  await mkdir(join(workDir, ".grok"), { recursive: true });
  const config = request.mcp
    ? `[mcp_servers.bots]\nurl = ${toml(request.mcp.url)}\nheaders = { Authorization = ${toml(`Bearer ${request.mcp.token}`)} }\ntool_timeout_sec = 900\n`
    : "";
  await writeFile(join(workDir, ".grok", "config.toml"), config, { mode: 0o600 });
  const sessionId = request.resume ?? randomUUID();
  const args = [
    "-p",
    request.prompt,
    "--output-format",
    "streaming-json",
    "--cwd",
    workDir,
    "-m",
    request.model,
    "--system-prompt-override",
    request.systemPrompt,
    "--disallowed-tools",
    removedTools.join(","),
    "--disable-web-search",
    "--no-subagents",
    "--always-approve",
    ...(request.effort ? ["--effort", request.effort] : []),
    ...(request.resume ? ["--resume", request.resume] : ["--session-id", sessionId]),
  ];
  emit({ type: "session", id: sessionId });
  let failure: string | null = null;
  let finished = false;
  let part = 0;
  let buffer = "";
  const flush = () => {
    if (buffer.trim()) emit({ type: "text", part: `grok-${part}`, text: buffer });
    buffer = "";
    part++;
  };
  const { code, stderr } = await runLines(bin, args, { cwd: workDir, env: childEnv(), signal }, (line) => {
    const event = parseJson(line);
    if (!event) return;
    const type = String(event.type ?? "");
    if (/delta/i.test(type) && !/thinking|reasoning/i.test(type)) {
      const text = textOf(event);
      if (text) {
        buffer += text;
        emit({ type: "text.delta", part: `grok-${part}`, text });
      }
    } else if (/tool/i.test(type)) {
      flush();
    } else if (type === "assistant" || type === "message") {
      const text = textOf(event);
      if (text && !buffer) emit({ type: "text", part: `grok-${part++}`, text });
      else flush();
    } else if (type === "result" || type === "done" || type === "end") {
      finished = true;
      flush();
      const usage = readUsage(event.usage);
      if (usage) emit({ type: "usage", usage, contextTokens: null });
      if (event.is_error === true) failure = String(event.result ?? "Falha no Grok.");
    } else if (type === "error") {
      failure = String(event.message ?? event.error ?? "Falha no Grok.");
    }
  });
  flush();
  if (signal.aborted) return emit({ type: "done", ok: false, message: "cancelled" });
  if (failure || code !== 0) {
    return emit({ type: "done", ok: false, message: failure ?? (stderr.trim().split("\n").slice(-3).join(" ") || `grok saiu com código ${code}.`) });
  }
  if (!finished) emit({ type: "warning", message: "Grok terminou sem evento de resultado." });
  emit({ type: "done", ok: true });
}
