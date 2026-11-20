import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ValidationError } from "../../../shared/errors";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface Question {
  id: string;
  title: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionRequest {
  questions: Question[];
}

export interface AnsweredQuestion {
  questionId: string;
  title: string;
  optionIds: string[];
  labels: string[];
  text?: string;
  skipped: boolean;
}

export type QuestionOutcome =
  | { status: "answered"; interactionId: string; answers: AnsweredQuestion[] }
  | { status: "skipped"; interactionId: string; answers: AnsweredQuestion[] }
  | { status: "withdrawn"; interactionId: string; reason?: string };

export const otherOptionId = "other";
const letters = ["a", "b", "c", "d"];

const optionShape = z.object({
  label: z.string().min(1).max(60).describe("Rótulo curto da opção, 1 a 6 palavras"),
  description: z.string().max(200).optional().describe("Uma frase dizendo o que essa opção muda"),
  recommended: z.boolean().optional().describe("Marque só na opção que você recomenda, e ponha ela primeiro"),
});

const questionShape = z.object({
  question: z.string().min(1).max(200).describe("A pergunta inteira, terminando com ponto de interrogação"),
  header: z.string().max(24).optional().describe("Etiqueta curta do assunto, até 24 caracteres"),
  options: z.array(optionShape).min(2).max(4).describe("2 a 4 opções. “Outra coisa” com texto livre já existe sempre"),
  multiSelect: z.boolean().optional().describe("true quando dá para escolher mais de uma opção"),
});

export const askUserShape = {
  questions: z.array(questionShape).min(1).max(4).describe("1 a 4 perguntas, mostradas uma por vez"),
};

type AskUserInput = { questions: z.infer<typeof questionShape>[] };

export function questionRequestOf(input: AskUserInput): QuestionRequest {
  return {
    questions: input.questions.map((item, index) => {
      const firstRecommended = item.options.findIndex((option) => option.recommended === true);
      return {
        id: `q${index + 1}`,
        title: item.question.trim(),
        ...(item.header?.trim() ? { header: item.header.trim() } : {}),
        multiSelect: item.multiSelect === true,
        options: item.options.map((option, optionIndex) => ({
          id: letters[optionIndex] ?? `o${optionIndex}`,
          label: option.label.trim(),
          ...(option.description?.trim() ? { description: option.description.trim() } : {}),
          ...(optionIndex === firstRecommended ? { recommended: true } : {}),
        })),
      };
    }),
  };
}

export function questionInteraction(request: QuestionRequest) {
  return {
    kind: "question",
    display: "questions",
    allowFreeform: true,
    prompt: request.questions[0]?.title ?? "",
    options: [],
    questions: request.questions,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function isQuestionAnswer(item: unknown) {
  const raw = record(item);
  return Boolean(raw && (Array.isArray(raw.questions) || raw.optionId === "skip"));
}

export function resolveAnswers(request: QuestionRequest, raw: unknown): AnsweredQuestion[] {
  const body = record(raw);
  if (!body) throw new ValidationError("Cada resposta precisa ser um objeto.", "answers");
  if (body.optionId === "skip") return request.questions.map(skippedAnswer);
  if (!Array.isArray(body.questions)) throw new ValidationError("Mande 'questions' ou optionId 'skip'.", "answers");
  const given = new Map<string, Record<string, unknown>>();
  for (const item of body.questions) {
    const entry = record(item);
    const questionId = typeof entry?.questionId === "string" ? entry.questionId : "";
    if (!entry || !request.questions.some((question) => question.id === questionId))
      throw new ValidationError(`Pergunta desconhecida: '${questionId}'.`, "answers");
    given.set(questionId, entry);
  }
  return request.questions.map((question) => {
    const entry = given.get(question.id);
    if (!entry || entry.skipped === true) return skippedAnswer(question);
    const ids = Array.isArray(entry.optionIds) ? entry.optionIds : [];
    if (ids.some((id) => typeof id !== "string"))
      throw new ValidationError("optionIds precisa ser uma lista de ids.", "answers");
    const unique = [...new Set(ids as string[])];
    const text = typeof entry.text === "string" ? entry.text.trim().slice(0, 2000) : "";
    const known = unique.filter((id) => id !== otherOptionId);
    for (const id of known)
      if (!question.options.some((option) => option.id === id))
        throw new ValidationError(`Opção desconhecida '${id}' na pergunta '${question.id}'.`, "answers");
    if (unique.includes(otherOptionId) && !text)
      throw new ValidationError("“Outra coisa” precisa de texto.", "answers");
    const chosen = text && !unique.includes(otherOptionId) ? [...unique, otherOptionId] : unique;
    if (chosen.length === 0) return skippedAnswer(question);
    if (!question.multiSelect && chosen.length > 1)
      throw new ValidationError(`A pergunta '${question.id}' aceita uma opção só.`, "answers");
    return {
      questionId: question.id,
      title: question.title,
      optionIds: chosen,
      labels: known.map((id) => question.options.find((option) => option.id === id)?.label ?? id),
      ...(text ? { text } : {}),
      skipped: false,
    };
  });
}

function skippedAnswer(question: Question): AnsweredQuestion {
  return { questionId: question.id, title: question.title, optionIds: [], labels: [], skipped: true };
}

export function answerLabel(answer: AnsweredQuestion) {
  if (answer.skipped) return "pulou";
  return [...answer.labels, ...(answer.text ? [answer.text] : [])].join(", ");
}

export function answerSummary(answers: AnsweredQuestion[]) {
  const given = answers.filter((answer) => !answer.skipped);
  if (given.length === 0) return "Pulou";
  return `Respondeu: ${given.map(answerLabel).join(" · ")}`;
}

export function questionResultText(outcome: QuestionOutcome) {
  if (outcome.status === "withdrawn")
    return "A pessoa respondeu por mensagem em vez de usar o card. Siga a mensagem dela.";
  if (outcome.status === "skipped")
    return "A pessoa pulou as perguntas. Decida com o padrão sensato e diga em uma linha qual escolheu.";
  const lines = outcome.answers.map((answer) =>
    answer.skipped
      ? `- ${answer.title} → pulou; decida com o padrão sensato e diga qual escolheu`
      : `- ${answer.title} → ${answerLabel(answer)}`,
  );
  return `Respostas da pessoa:\n${lines.join("\n")}\nSiga com isso, sem perguntar de novo.`;
}

function unattendedText(request: QuestionRequest) {
  const lines = request.questions.map((question) => {
    const pick = question.options.find((option) => option.recommended) ?? question.options[0];
    return `- ${question.title} → ninguém respondeu; siga com “${pick?.label ?? "o padrão"}”`;
  });
  return `Ninguém está presente neste turno (rotina ou agendamento), então a pergunta não bloqueia. Siga o padrão sensato e registre a dúvida no resumo final, dizendo o que escolheu:\n${lines.join("\n")}`;
}

function newCallId() {
  return `call_${randomBytes(9).toString("base64url")}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export async function runAskUser(context: ToolContext, input: AskUserInput) {
  const request = questionRequestOf(input);
  const callId = newCallId();
  const scope = { runId: context.runId(), turnId: context.turnId };
  const label = request.questions.length === 1 ? request.questions[0].title : `${request.questions.length} perguntas`;
  context.onCallStart();
  try {
    context.log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name: "ask_user", label },
        input: { questions: request.questions },
        owner: context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() },
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope,
    });
    if (context.isSchedule || !context.askUser) {
      const text = unattendedText(request);
      context.log.emit({ type: "call.started", data: { callId }, scope });
      context.log.emit({
        type: "call.settled",
        data: { callId, outcome: "completed", output: { unattended: true } },
        scope,
      });
      context.onCallSettled("ask_user → sem pessoa presente, seguiu o padrão");
      return textResult(text);
    }
    const outcome = await context.askUser(request, callId, context.origin);
    const text = questionResultText(outcome);
    context.log.emit({
      type: "call.started",
      data: { callId, clearedBy: { interactionId: outcome.interactionId } },
      scope,
    });
    context.log.emit({
      type: "call.settled",
      data: {
        callId,
        cause: { interactionId: outcome.interactionId },
        outcome: "completed",
        output: {
          status: outcome.status,
          ...(outcome.status === "withdrawn" ? {} : { answers: outcome.answers }),
        },
      },
      scope,
    });
    context.onCallSettled(`ask_user → ${outcome.status === "withdrawn" ? "respondeu por mensagem" : outcome.status}`);
    return textResult(text);
  } finally {
    context.onCallEnd();
  }
}

export function registerQuestionTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "ask_user",
    {
      description:
        "Faz à pessoa de 1 a 4 perguntas de múltipla escolha num card e espera a resposta (o turno pausa). Só para decisão que é dela e muda o que você vai fazer: escopo ambíguo, duas leituras plausíveis do pedido, preferência de produto. Nunca para pedir permissão, nem para algo que dá para descobrir no código ou nos dados, nem para escolha com padrão óbvio. Ponha a opção recomendada primeiro e marque recommended. “Outra coisa” com texto livre já existe sempre.",
      inputSchema: askUserShape,
    },
    (args: Record<string, unknown>) => runAskUser(context, args as AskUserInput),
  );
}

export const questionGuide = [
  "## Perguntas à pessoa (`ask_user`)",
  "A pessoa odeia bot que pede permissão para tudo. `ask_user` serve só para decisão que é genuinamente dela e muda o que você vai fazer: escopo ambíguo, duas leituras plausíveis do pedido, preferência de produto.",
  "- Nunca use para pedir permissão (isso é aprovação ou autonomia), nem para algo que você descobre sozinho no código, nos dados ou nas ferramentas, nem para escolha com padrão óbvio: nesse caso decida e diga em uma linha o que escolheu.",
  "- No máximo uma rodada de perguntas por tarefa, a não ser que a resposta abra uma dúvida nova e real. Junte tudo numa chamada só (até 4 perguntas).",
  "- Ponha a opção recomendada primeiro e marque `recommended`. Rótulos curtos; a descrição diz o que muda.",
  "- Se a pessoa pular, siga o padrão sensato e diga qual escolheu. Em rotina ou agendamento ninguém responde: siga o padrão e registre a dúvida no resumo.",
].join("\n");

const ordinals: Array<[RegExp, number]> = [
  [/\b(primeir[ao]|um|uma|1)\b/, 0],
  [/\b(segund[ao]|dois|duas|2)\b/, 1],
  [/\b(terceir[ao]|tres|3)\b/, 2],
  [/\b(quart[ao]|quatro|4)\b/, 3],
];

function plain(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function spokenQuestion(question: Question, index: number, total: number) {
  const intro = total > 1 ? `Pergunta ${index + 1} de ${total}. ` : "";
  const options = question.options
    .map((option) => `${option.id.toUpperCase()}, ${option.label}${option.recommended ? ", que eu recomendo" : ""}`)
    .join("; ");
  return `${intro}${question.title} ${options}. Ou fala outra coisa.`;
}

export function matchSpokenOption(question: Question, text: string): string[] {
  const value = plain(text);
  if (!value) return [];
  const letter = value.match(/^(?:(?:a|opcao|letra|alternativa)\s+)?(a|b|be|c|ce|d|de)$/)?.[1]?.charAt(0);
  if (letter && question.options.some((option) => option.id === letter)) return [letter];
  const byLabel = question.options.filter((option) => {
    const label = plain(option.label);
    return label.length > 2 && value.includes(label);
  });
  if (byLabel.length > 0) return question.multiSelect ? byLabel.map((option) => option.id) : [byLabel[0].id];
  if (value.split(" ").length <= 4) {
    const picked = ordinals.filter(([pattern]) => pattern.test(value)).map(([, index]) => question.options[index]);
    const valid = picked.filter((option): option is QuestionOption => Boolean(option));
    if (valid.length > 0) return question.multiSelect ? valid.map((option) => option.id) : [valid[0].id];
  }
  return [];
}

export function isSpokenSkip(text: string) {
  return /^(pula|pular|pode pular|tanto faz|qualquer uma|voce decide|decide voce|voce escolhe)\b/.test(plain(text));
}
