import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { managedBinary } from "./managed";
import { accountEnv, childEnv, findBinary, parseJson, runLines } from "./proc";

const disabledFeatures = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "multi_agent",
  "tool_suggest",
  "skill_search",
  "sleep_tool",
];

const imageGuide =
  "## Imagens\nVocê gera e edita imagens com a ferramenta nativa `image_gen`, sem chave de API e sem shell. Quando a sua resposta termina, o servidor copia cada imagem gerada para a pasta de saída do bot como `outbox/imagens/imagem-<8 primeiros caracteres do arquivo>.png` e anexa na conversa. Se outro bot pediu, ele recebe os arquivos junto com a sua resposta. O caminho em `generated_images` que a ferramenta devolve é temporário e ninguém mais consegue abrir: nunca cite esse caminho nem `$CODEX_HOME`. Fale das imagens pelo nome do anexo (`imagem-xxxxxxxx.png`). Não use `send_file` para elas e não diga que não consegue gerar imagens.\n\nPeça 1024 px ou mais. Ícone, sticker, logo ou recorte de produto que precisa de fundo transparente: não use a transparência nativa do `image_gen` (sai serrilhada, com halo branco e pontos soltos). Gere o objeto inteiro, centralizado e com folga sobre um fundo liso e sólido que contraste com ele (cinza claro para objeto escuro ou colorido; verde puro ou azul-escuro para objeto branco ou claro), sem sombra no chão nem degradê. Em seguida chame `image_cutout` com o caminho que o `image_gen` devolveu (só nessa chamada ele pode ir como argumento) e apresente o `imagem-xxxxxxxx-recorte.png` como entrega final.";

const imageFile = /\.(png|jpe?g|webp|gif)$/i;

function toml(value: string) {
  return JSON.stringify(value);
}

export function codexHome(configDir: string | null | undefined) {
  return configDir || process.env.CODEX_HOME || join(homedir(), ".codex");
}

export async function generatedImages(home: string, threadId: string, since: number) {
  const dir = join(home, "generated_images", threadId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: Array<{ path: string; at: number }> = [];
  for (const name of names) {
    if (!imageFile.test(name)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.mtimeMs >= since) found.push({ path, at: info.mtimeMs });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.path);
}

export async function runCodex(
  request: TurnRequest,
  workDir: string,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
) {
  const bin = managedBinary("codex") ?? findBinary(["codex"]);
  if (!bin) return emit({ type: "done", ok: false, message: "Codex CLI não está instalado." });
  const code = request.code ?? null;
  const disabled =
    code && request.nativeShell === true
      ? disabledFeatures.filter((feature) => feature !== "shell_tool" && feature !== "unified_exec")
      : disabledFeatures;
  const options = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    code && !code.readOnly ? "workspace-write" : "read-only",
    "-C",
    code ? code.cwd : workDir,
    "-m",
    request.model,
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "allow_login_shell=false",
    "-c",
    'shell_environment_policy.inherit="core"',
    "-c",
    `developer_instructions=${toml(`${request.systemPrompt}\n\n${imageGuide}`)}`,
    ...(request.effort ? ["-c", `model_reasoning_effort=${toml(request.effort)}`] : []),
    ...disabled.flatMap((feature) => ["--disable", feature]),
  ];
  if (request.mcp) {
    options.push(
      "-c",
      `mcp_servers.bots.url=${toml(request.mcp.url)}`,
      "-c",
      'mcp_servers.bots.bearer_token_env_var="RUNELAY_MCP_TOKEN"',
      "-c",
      "mcp_servers.bots.tool_timeout_sec=900",
      "-c",
      'mcp_servers.bots.default_tools_approval_mode="approve"',
    );
  }
  const args = ["exec", ...options, ...(request.resume ? ["resume", request.resume] : []), "-"];
  const env = childEnv({
    ...accountEnv("codex", request.configDir),
    ...(request.mcp ? { RUNELAY_MCP_TOKEN: request.mcp.token } : {}),
  });
  let failure: string | null = null;
  let finished = false;
  let threadId = request.resume ?? null;
  const startedAt = Date.now() - 1000;
  const { code: exitCode, stderr } = await runLines(
    bin,
    args,
    { cwd: code ? code.cwd : workDir, env, signal, stdin: request.prompt },
    (line) => {
      const event = parseJson(line);
      if (!event) return;
      const type = String(event.type ?? "");
      if (type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
        emit({ type: "session", id: event.thread_id });
      } else if (type === "item.started" || type === "item.completed") {
        const item = event.item as
          | {
              id?: string;
              type?: string;
              text?: string;
              command?: string;
              aggregated_output?: string;
              exit_code?: number;
              changes?: Array<{ path?: string; kind?: string }>;
              status?: string;
            }
          | undefined;
        if (type === "item.completed" && item?.type === "agent_message" && item.text)
          emit({ type: "text", part: item.id ?? String(Date.now()), text: item.text });
        if (item?.type === "command_execution") {
          const id = item.id ?? String(Date.now());
          if (type === "item.started")
            emit({ type: "tool", id, name: "Bash", phase: "start", input: { command: item.command ?? "" } });
          else
            emit({
              type: "tool",
              id,
              name: "Bash",
              phase: "end",
              input: { command: item.command ?? "" },
              output: { output: String(item.aggregated_output ?? "").slice(-4000), exitCode: item.exit_code ?? null },
              ok: (item.exit_code ?? 0) === 0,
            });
        } else if (item?.type === "file_change" && type === "item.completed") {
          const id = item.id ?? String(Date.now());
          const input = { files: (item.changes ?? []).map((change) => change.path ?? "") };
          emit({ type: "tool", id, name: "Edit", phase: "start", input });
          emit({
            type: "tool",
            id,
            name: "Edit",
            phase: "end",
            input,
            output: { status: item.status ?? "completed" },
            ok: item.status !== "failed",
          });
        }
      } else if (type === "turn.completed") {
        finished = true;
        const usage = (event.usage ?? {}) as Record<string, number>;
        const cached = usage.cached_input_tokens ?? 0;
        emit({
          type: "usage",
          usage: {
            inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          },
          contextTokens: null,
        });
      } else if (type === "turn.failed") {
        failure = String((event.error as { message?: string } | undefined)?.message ?? "Falha no Codex.");
      } else if (type === "error") {
        failure = String(event.message ?? "Falha no Codex.");
      }
    },
  );
  if (signal.aborted) return emit({ type: "done", ok: false, message: "cancelled" });
  if (threadId) {
    for (const path of await generatedImages(codexHome(request.configDir), threadId, startedAt))
      emit({ type: "image", path });
  }
  if (failure || exitCode !== 0 || !finished) {
    return emit({
      type: "done",
      ok: false,
      message: failure ?? (stderr.trim().split("\n").slice(-3).join(" ") || `Codex saiu com código ${exitCode}.`),
    });
  }
  emit({ type: "done", ok: true });
}
