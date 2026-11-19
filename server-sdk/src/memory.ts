import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Account, runOnRunner } from "./accounts";
import type { BotDefinition } from "./bots";
import { dataDir } from "./config";
import { askJev, jevEnabled, noul } from "./jev";
import { runelayCall, runelayEnabled } from "./runelay";
import type { EventLog } from "./sessions";

export interface MemorySettings {
  recall: boolean;
  capture: boolean;
}

export const defaultMemory: MemorySettings = { recall: true, capture: true };

export interface RecallItem {
  slug: string;
  name: string;
  description: string;
}

const teamLogFile = join(dataDir, "team-log.ndjson");
const recallCharCap = 6000;

function clean(text: string) {
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

export async function recall(bot: BotDefinition, message: string): Promise<RecallItem[]> {
  if (!runelayEnabled()) return [];
  try {
    const result = await withTimeout(
      runelayCall("search_context", { query: `${message} ${bot.role}`.slice(0, 300), kind: "memory", limit: 5 }, 3000),
      3000,
    );
    if (!Array.isArray(result)) return [];
    return (result as Array<{ slug?: string; name?: string; description?: string; snippet?: string }>).slice(0, 5).map((item) => ({
      slug: String(item.slug ?? ""),
      name: clean(String(item.name ?? item.slug ?? "")),
      description: clean(String(item.description || item.snippet || "")).slice(0, 220),
    }));
  } catch {
    return [];
  }
}

export function recallBlock(items: RecallItem[]) {
  if (items.length === 0) return "";
  let block = "## O que você já sabe\nMemórias da pessoa e do time que podem ser relevantes (use se servirem, ignore se não):";
  for (const item of items) {
    const line = `\n- ${item.name}: ${item.description} (memória \`${item.slug}\`)`;
    if (block.length + line.length > recallCharCap) break;
    block += line;
  }
  return block;
}

export async function teamLogBlock(botId: string) {
  let text = "";
  try {
    text = await readFile(teamLogFile, "utf8");
  } catch {
    return "";
  }
  const today = new Date().toISOString().slice(0, 10);
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { at: string; botId: string; botName: string; summary: string };
      } catch {
        return null;
      }
    })
    .filter((item): item is { at: string; botId: string; botName: string; summary: string } => item !== null && item.botId !== botId && item.at.startsWith(today))
    .slice(-5);
  if (lines.length === 0) return "";
  return `## O que o time fez hoje\n${lines.map((item) => `- ${item.at.slice(11, 16)} ${item.botName}: ${item.summary}`).join("\n")}`;
}

async function appendTeamLog(bot: BotDefinition, summary: string) {
  await appendFile(teamLogFile, `${JSON.stringify({ at: new Date().toISOString(), botId: bot.id, botName: bot.name, summary: summary.slice(0, 240) })}\n`);
}

const secretPatterns = [
  /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
  /(senha|password|passwd|token|api[_ -]?key|secret)\s*[:=é]\s*\S+/i,
];

export function hasSecret(text: string) {
  return secretPatterns.some((pattern) => pattern.test(text));
}

export function cheapModel(account: Account, fallback: string) {
  if (account.provider === "claude") return "claude-haiku-5-5";
  if (account.provider === "cursor") return "auto";
  return fallback;
}

export async function cheapCall(account: Account, model: string, systemPrompt: string, prompt: string, workKey: string) {
  const texts: string[] = [];
  let failure: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    await runOnRunner(
      account.runner,
      { turnId: `aux-${Date.now()}`, provider: account.provider, model, effort: "low", systemPrompt, prompt, resume: null, mcp: null, workKey },
      controller.signal,
      (event) => {
        if (event.type === "text") texts.push(event.text);
        else if (event.type === "done" && !event.ok) failure = event.message ?? "falhou";
      },
    );
  } finally {
    clearTimeout(timer);
  }
  if (failure) throw new Error(failure);
  return texts.join("\n").trim();
}

function parseFacts(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { facts?: Array<{ title?: string; body?: string; tags?: string[] }>; summary?: string };
    const facts = (parsed.facts ?? [])
      .filter((fact) => fact.title && fact.body)
      .slice(0, 3)
      .map((fact) => ({ title: String(fact.title).slice(0, 120), body: String(fact.body).slice(0, 1500), tags: (fact.tags ?? []).map(String).slice(0, 5) }));
    return { facts, summary: String(parsed.summary ?? "").slice(0, 240) };
  } catch {
    return null;
  }
}

function slugify(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalized(text: string) {
  return slugify(text).replace(/-/g, " ");
}

export interface CaptureInput {
  bot: BotDefinition;
  account: Account;
  model: string;
  userText: string;
  replyText: string;
  recalled: RecallItem[];
  log: EventLog;
  turnId: string;
}

export async function capture(input: CaptureInput) {
  const { bot, userText, replyText, log, turnId } = input;
  if (!runelayEnabled() || !jevEnabled()) return;
  const exchange = `Pessoa: ${userText}\n${bot.name}: ${replyText}`.slice(0, 6000);
  let durable = 0;
  let secret = 1;
  let latencyMs = 0;
  let modelId = "";
  try {
    const judged = await askJev(
      { bot: { name: bot.name, role: bot.role }, exchange },
      {
        durable: {
          type: "noul",
          instructions:
            "Esta conversa tem algo durável que vale lembrar em conversas futuras: uma decisão, uma preferência da pessoa, um fato sobre ela, a empresa ou os projetos, ou uma tarefa recorrente?",
          criteria: { true: "Tem informação estável e útil depois desta conversa", false: "Só pergunta e resposta pontual, números do momento ou conversa casual" },
        },
        secret: { type: "noul", instructions: "A conversa contém senha, token, chave de API, número de cartão ou documento pessoal?" },
      },
    );
    durable = noul(judged, "durable") ?? 0;
    secret = noul(judged, "secret") ?? 1;
    latencyMs = judged.latencyMs;
    modelId = judged.model;
  } catch (error) {
    log.emit({
      type: "decision.made",
      data: { kind: "memory", question: "Vale lembrar?", answer: null, confidence: null, threshold: 0.6, outcome: "fallback", latencyMs: 0, model: null, reason: String(error).slice(0, 200) },
      scope: { turnId },
    });
    return;
  }
  const blocked = secret >= 0.3 || hasSecret(exchange);
  const outcome = blocked ? "skip_secret" : durable >= 0.6 ? "capture" : "skip";
  log.emit({
    type: "decision.made",
    data: { kind: "memory", question: "Vale lembrar?", answer: { durable, secret }, confidence: Math.abs(durable - 0.5) * 2, threshold: 0.6, outcome, latencyMs, model: modelId },
    scope: { turnId },
  });
  if (outcome !== "capture") return;
  const existing = input.recalled.map((item) => `- ${item.slug}: ${item.name}`).join("\n") || "(nenhuma)";
  const text = await cheapCall(
    input.account,
    cheapModel(input.account, input.model),
    "Você extrai memórias duráveis de uma conversa. Responda só com JSON válido, sem texto antes ou depois.",
    [
      `"Pessoa" é o usuário, dono do time de bots; ${bot.name} é o bot. Escreva cada fato sobre a pessoa ou o trabalho dela (ex.: "A pessoa prefere…"), nunca como se fosse do bot.`,
      "Extraia de 0 a 3 fatos atômicos e duráveis desta conversa (decisões, preferências, fatos sobre a pessoa ou projetos, tarefas recorrentes).",
      "title é uma frase curta legível em português (ex.: \"Prefere números em tabela\"), não um slug.",
      "Não repita um fato que já está nas memórias existentes sem nada novo; nesse caso devolva facts vazio.",
      "Nunca inclua senhas, tokens, chaves, cartões ou documentos.",
      "Se um fato atualiza uma memória existente, use exatamente o título dela.",
      "Formato: {\"facts\":[{\"title\":\"…\",\"body\":\"…\",\"tags\":[\"…\"]}],\"summary\":\"uma linha do que foi tratado\"}",
      "",
      `Memórias existentes:\n${existing}`,
      "",
      `Conversa:\n${exchange}`,
    ].join("\n"),
    `${bot.id}/memory`,
  );
  const parsed = parseFacts(text);
  if (!parsed) return;
  if (parsed.summary && !hasSecret(parsed.summary)) await appendTeamLog(bot, parsed.summary);
  const saved: { title: string; slug: string; updated: boolean }[] = [];
  for (const fact of parsed.facts) {
    if (hasSecret(`${fact.title} ${fact.body}`)) continue;
    const match = input.recalled.find((item) => normalized(item.name) === normalized(fact.title) || item.slug === slugify(fact.title));
    const slug = match?.slug ?? `rb-${bot.id}-${slugify(fact.title)}`;
    const tags = ["runelay-bots", bot.id, ...fact.tags];
    await runelayCall("write_memory", {
      slug,
      name: fact.title,
      description: `${fact.body.slice(0, 300)}`,
      type: "user",
      body: `${fact.body}\n\nOrigem: ${bot.name} (runelay bots), ${new Date().toISOString().slice(0, 10)}. Tags: ${tags.join(", ")}`,
    });
    saved.push({ title: fact.title, slug, updated: Boolean(match) });
  }
  if (saved.length > 0) {
    log.emit({ type: "memory.saved", data: { titles: saved.map((item) => item.title), items: saved, botId: bot.id }, scope: { turnId } });
  }
}

export async function summarizeForReset(account: Account, model: string, botName: string, previous: string, transcript: string) {
  return cheapCall(
    account,
    cheapModel(account, model),
    "Você mantém o resumo vivo de uma conversa para outro modelo continuar depois. Responda só com o resumo atualizado, em português, até 25 linhas, em tópicos curtos.",
    `${previous ? `Resumo até agora:\n${previous}\n\n` : ""}Itens novos da conversa entre a pessoa e ${botName} (cada um com o id entre colchetes):\n${transcript}\n\nAtualize o resumo juntando o anterior com os itens novos. Guarde: o que foi pedido, decisões (inclusive as antigas), resultados importantes de consultas e ferramentas com os números, arquivos e repositórios mexidos, o que ficou pendente e as preferências da pessoa. Cite o id do item quando o detalhe estiver nele.`,
    `${botName}/summary`,
  );
}
