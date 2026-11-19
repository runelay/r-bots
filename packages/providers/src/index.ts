import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AccountProbe,
  ModelOption,
  NativeToolHooks,
  Provider,
  ProviderEvent,
  TurnRequest,
} from "@runelay-bots/protocol";
import { runClaude } from "./claude";
import { runCodex } from "./codex";
import { runCursor } from "./cursor";
import { runGrok } from "./grok";
import { capture, findBinary } from "./proc";

export const claudeModels: ModelOption[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Fable 5.2" },
];

export const defaultModels: Record<Provider, string> = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-5.6-sol",
  grok: "grok-4.6",
  cursor: "auto",
};

const binaries: Record<Provider, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  grok: ["grok"],
  cursor: ["cursor-agent", "agent"],
};

function clean(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

async function probeClaude(bin: string): Promise<AccountProbe> {
  const { stdout, stderr } = await capture(bin, ["auth", "status"]);
  try {
    const status = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
    if (status.loggedIn) {
      return {
        provider: "claude",
        status: "ready",
        detail: [status.email, status.subscriptionType].filter(Boolean).join(" · "),
        models: claudeModels,
      };
    }
  } catch {}
  return {
    provider: "claude",
    status: "logged_out",
    detail: clean(stderr || stdout).slice(0, 200) || "Sem login no Claude Code.",
    models: claudeModels,
  };
}

async function probeCodex(bin: string): Promise<AccountProbe> {
  const status = await capture(bin, ["login", "status"]);
  const text = clean(`${status.stdout}\n${status.stderr}`);
  let models: ModelOption[] = [{ id: defaultModels.codex, label: "GPT-5.6-Sol" }];
  const catalog = await capture(bin, ["debug", "models"]);
  try {
    const parsed = JSON.parse(catalog.stdout) as {
      models?: Array<{ slug: string; display_name?: string; visibility?: string }>;
    };
    const listed = (parsed.models ?? [])
      .filter((model) => model.visibility === "list")
      .map((model) => ({ id: model.slug, label: model.display_name ?? model.slug }));
    if (listed.length > 0) models = listed;
  } catch {}
  const ready = status.code === 0 && /logged in/i.test(text);
  return { provider: "codex", status: ready ? "ready" : "logged_out", detail: text.split("\n")[0] ?? "", models };
}

async function probeCursor(bin: string): Promise<AccountProbe> {
  const status = await capture(bin, ["status"], 60_000);
  const text =
    clean(`${status.stdout}\n${status.stderr}`) || `cursor-agent status não respondeu (código ${status.code}).`;
  const ready = /logged in/i.test(text) && !/not logged in/i.test(text);
  let models: ModelOption[] = [{ id: "auto", label: "Auto" }];
  if (ready) {
    const list = await capture(bin, ["models"], 30_000);
    const parsed = clean(list.stdout)
      .split("\n")
      .map((line) => line.match(/^([a-z0-9][\w.\-[\]=,]*)\s+-\s+(.+)$/i))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => ({ id: match[1], label: match[2].replace(/\s+/g, " ").replace(/[​]/g, "").trim() }));
    if (parsed.length > 0) models = parsed;
  }
  return {
    provider: "cursor",
    status: ready ? "ready" : "logged_out",
    detail: text.split("\n").find((line) => line.trim()) ?? "",
    models,
  };
}

async function probeGrok(bin: string): Promise<AccountProbe> {
  const list = await capture(bin, ["models"], 30_000);
  const text = clean(`${list.stdout}\n${list.stderr}`);
  const models = text
    .split("\n")
    .map((line) => line.match(/^\s*[*-]\s+([\w.-]+)/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ id: match[1], label: match[1] }));
  const loggedOut = /not authenticated|not logged in/i.test(text);
  return {
    provider: "grok",
    status: loggedOut ? "logged_out" : "ready",
    detail: loggedOut ? "Grok sem login (rode grok login no Mac)." : "",
    models: models.length > 0 ? models : [{ id: defaultModels.grok, label: defaultModels.grok }],
  };
}

export async function probe(provider: Provider): Promise<AccountProbe> {
  const bin = findBinary(binaries[provider]);
  if (!bin) return { provider, status: "missing", detail: "CLI não instalada nesta máquina.", models: [] };
  try {
    if (provider === "claude") return await probeClaude(bin);
    if (provider === "codex") return await probeCodex(bin);
    if (provider === "cursor") return await probeCursor(bin);
    return await probeGrok(bin);
  } catch (error) {
    return {
      provider,
      status: "logged_out",
      detail: String(error instanceof Error ? error.message : error).slice(0, 200),
      models: [],
    };
  }
}

export async function runTurn(
  request: TurnRequest,
  baseDir: string,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  hooks?: NativeToolHooks,
) {
  const workDir = join(baseDir, "work", request.workKey.replace(/[^\w/-]/g, "_"));
  await mkdir(workDir, { recursive: true });
  try {
    if (request.provider === "claude") return await runClaude(request, workDir, signal, emit, hooks);
    if (request.provider === "codex") return await runCodex(request, workDir, signal, emit);
    if (request.provider === "cursor") return await runCursor(request, workDir, signal, emit);
    return await runGrok({ ...request, code: null }, workDir, signal, emit);
  } catch (error) {
    emit({
      type: "done",
      ok: false,
      message: signal.aborted ? "cancelled" : String(error instanceof Error ? error.message : error),
    });
  }
}
