import { askJev, graded, jevEnabled, jevModel, noul } from "./jev.service";

export interface DecisionSettings {
  autoApprove: boolean;
  threshold: number;
}

export const defaultDecisions: DecisionSettings = { autoApprove: true, threshold: 0.7 };

export interface DecisionRecord {
  kind: "approval" | "progress" | "triage" | "route";
  question: string;
  answer: Record<string, unknown> | null;
  confidence: number | null;
  threshold: number | null;
  outcome: string;
  latencyMs: number;
  model: string | null;
  costUsd?: number;
  reason?: string;
  tool?: string;
  callId?: string;
}

const sensitiveField =
  /(senha|password|passwd|cart[aã]o|\bcard\b|cvv|cvc|cpf|cnpj|\bpix\b|token|secret|segredo|\bpin\b)/i;
const dangerousAction =
  /(enviar|submit|send|pagar|\bpay\b|pagamento|payment|excluir|exclus[aã]o|delete|apagar|remover|remove|confirmar|confirm|comprar|\bbuy\b|finalizar|checkout|assinar|subscribe|transferir|transfer|sacar|withdraw|cancelar|desativar|deactivate|publicar|publish)/i;
const cardLike = /\b(?:\d[ -]?){13,19}\b/;
const cpfLike = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
const cnpjLike = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/;

export function hardHumanReason(tool: string, input: Record<string, unknown>, element: string) {
  if (tool === "browser_fill") {
    const value = String(input.text ?? "");
    if (sensitiveField.test(element)) return "Campo sensível (senha, cartão, documento ou token).";
    if (cardLike.test(value) || cpfLike.test(value) || cnpjLike.test(value))
      return "O valor parece cartão, CPF ou CNPJ.";
    if (/\n|\r/.test(value)) return "O preenchimento envia o formulário.";
    if (dangerousAction.test(element)) return "O campo dispara envio, pagamento ou exclusão.";
  }
  if (tool === "browser_click" && dangerousAction.test(element))
    return "O clique envia, paga, confirma ou exclui algo.";
  return null;
}

function fallback(
  kind: DecisionRecord["kind"],
  question: string,
  threshold: number | null,
  started: number,
  error: unknown,
  extra: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    kind,
    question,
    answer: null,
    confidence: null,
    threshold,
    outcome: "fallback",
    latencyMs: Date.now() - started,
    model: null,
    reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    ...extra,
    ...(kind === "route" ? { outcome: "fallback" } : {}),
  };
}

const approvalQuestion = "Esta ação do bot é segura para rodar sem uma pessoa confirmar?";

export interface ApprovalState {
  botName: string;
  botRole: string;
  request: string;
  tool: string;
  input: Record<string, unknown>;
  page: { url: string; title: string } | null;
  element: string;
}

export async function decideApproval(
  state: ApprovalState,
  settings: DecisionSettings,
  callId: string,
): Promise<DecisionRecord> {
  const started = Date.now();
  const base = { tool: state.tool, callId };
  const hard = hardHumanReason(state.tool, state.input, state.element);
  if (hard) {
    return {
      kind: "approval",
      question: approvalQuestion,
      answer: null,
      confidence: null,
      threshold: settings.threshold,
      outcome: "human",
      latencyMs: 0,
      model: null,
      reason: hard,
      ...base,
    };
  }
  if (!jevEnabled()) return fallback("approval", approvalQuestion, settings.threshold, started, "Jev desligado.", base);
  try {
    const result = await askJev(
      {
        bot: { name: state.botName, role: state.botRole },
        user_request: state.request,
        action: { tool: state.tool, arguments: state.input },
        page: state.page,
        target_element: state.element || null,
      },
      {
        risk: {
          type: "score",
          instructions: "Quão arriscada é esta ação do bot, considerando o que ela faz no sistema ou na página?",
          criteria: [
            "Só navega ou lê: abre um link, vai para outra página, expande conteúdo. Nada muda em nenhum sistema.",
            "Muda algo pequeno e reversível, como digitar numa busca ou num filtro.",
            "Envia dados, muda configurações ou cria algo num sistema.",
            "Destrutiva, financeira, irreversível ou expõe dado pessoal.",
          ],
        },
        needs_human: {
          type: "noul",
          instructions: "Uma pessoa cuidadosa iria querer confirmar esta ação antes de ela acontecer?",
        },
        aligned: { type: "noul", instructions: "A ação ajuda a cumprir o pedido da pessoa?" },
      },
    );
    const risk = graded(result, "risk");
    const needsHuman = noul(result, "needs_human") ?? 1;
    const aligned = noul(result, "aligned") ?? 0;
    const confidence = risk?.confidence ?? 0;
    const riskScore = risk?.score ?? 3;
    const low = aligned >= 0.5 && (riskScore < 1.5 || (riskScore < 2 && needsHuman < 0.5));
    const outcome = settings.autoApprove && low && confidence >= settings.threshold ? "auto_approved" : "human";
    return {
      kind: "approval",
      question: approvalQuestion,
      answer: { risk: riskScore, riskProbabilities: risk?.probabilities ?? null, needsHuman, aligned },
      confidence,
      threshold: settings.threshold,
      outcome,
      latencyMs: result.latencyMs,
      model: result.model,
      costUsd: result.costUsd,
      ...base,
    };
  } catch (error) {
    return fallback("approval", approvalQuestion, settings.threshold, started, error, base);
  }
}

const progressQuestion = "O agente ainda está avançando em direção ao pedido?";
const progressConfidence = 0.8;

export async function decideProgress(request: string, calls: string[]): Promise<DecisionRecord> {
  const started = Date.now();
  if (!jevEnabled()) return fallback("progress", progressQuestion, progressConfidence, started, "Jev desligado.");
  try {
    const result = await askJev(
      { user_request: request, recent_tool_calls: calls },
      {
        progress: {
          type: "score",
          instructions: "Quanto essas chamadas de ferramenta estão aproximando o agente de cumprir o pedido?",
          criteria: [
            "Andando em círculos: repete as mesmas ações, recebe os mesmos erros ou faz coisas sem relação com o pedido.",
            "Algum progresso, mas incerto.",
            "Progresso claro: cada chamada traz informação nova e útil para o pedido.",
          ],
        },
        stuck: { type: "noul", instructions: "O agente parece travado, sem chegar mais perto do pedido?" },
      },
    );
    const progress = graded(result, "progress");
    const stuck = noul(result, "stuck") ?? 0;
    const confidence = progress?.confidence ?? 0;
    const score = progress?.score ?? 2;
    const outcome = score < 0.7 && confidence >= progressConfidence && stuck >= 0.8 ? "stop" : "continue";
    return {
      kind: "progress",
      question: progressQuestion,
      answer: { progress: score, stuck },
      confidence,
      threshold: progressConfidence,
      outcome,
      latencyMs: result.latencyMs,
      model: result.model,
      costUsd: result.costUsd,
    };
  } catch (error) {
    return fallback("progress", progressQuestion, progressConfidence, started, error);
  }
}

const triageQuestion = "O resultado desta rotina traz algo que a pessoa deveria olhar agora?";

const unchangedOpening =
  /^(tudo (normal|igual|certo|ok|tranquilo|em ordem)|nada (de )?novo|nada mudou|sem (novidade|mudanca|alteracao)|nenhuma (novidade|mudanca|alteracao)|igual a (ronda|rodada) anterior)/;
const unchangedPhrase =
  /(igual (a|ao) (da )?(ronda|rodada|checagem|execucao) anterior|sem nada novo|nada novo desde|sem novidade|sem mudanca)/;
const caveat = /\b(exceto|mas|porem|so que|novo problema|piorou)\b/;

function plain(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[*`]/g, "")
    .replace(/[#>|]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function unchangedRoutine(reply: string, previous: string | null = null) {
  const text = plain(reply);
  if (!text) return true;
  if (previous && plain(previous) === text) return true;
  const first = (text.split(/(?<=[.!?])\s|\n/)[0] ?? text).trim();
  if (caveat.test(first)) return false;
  return unchangedOpening.test(first) || unchangedPhrase.test(first);
}

export async function decideTriage(
  botRole: string,
  scheduleName: string,
  schedulePrompt: string,
  reply: string,
  previous: string | null = null,
): Promise<DecisionRecord> {
  const started = Date.now();
  if (unchangedRoutine(reply, previous))
    return {
      kind: "triage",
      question: triageQuestion,
      answer: null,
      confidence: 1,
      threshold: 0.5,
      outcome: "quiet",
      latencyMs: Date.now() - started,
      model: null,
      reason: "A rotina disse que nada mudou.",
    };
  if (!jevEnabled()) return fallback("triage", triageQuestion, 0.5, started, "Jev desligado.");
  try {
    const result = await askJev(
      {
        bot_role: botRole,
        routine: { name: scheduleName, instructions: schedulePrompt },
        previous_result: previous,
        result: reply,
      },
      {
        attention: {
          type: "noul",
          instructions:
            "O resultado traz algo NOVO que a pessoa deveria olhar agora: um problema, uma anomalia, um número fora do normal ou uma decisão pendente que não estava no resultado anterior?",
          criteria: {
            true: "Aponta um problema, anomalia ou risco novo, ou que piorou desde o resultado anterior",
            false:
              "Diz que está tudo normal, que nada mudou, ou repete o mesmo problema do resultado anterior sem piora",
          },
        },
      },
    );
    const attention = noul(result, "attention") ?? 1;
    return {
      kind: "triage",
      question: triageQuestion,
      answer: { noul: attention },
      confidence: Math.abs(attention - 0.5) * 2,
      threshold: 0.5,
      outcome: attention >= 0.5 ? "notify" : "quiet",
      latencyMs: result.latencyMs,
      model: result.model,
      costUsd: result.costUsd,
    };
  } catch (error) {
    return fallback("triage", triageQuestion, 0.5, started, error);
  }
}

const routeQuestion = "Quem do grupo deve responder a esta mensagem?";

export async function decideRoute(
  groupName: string,
  members: { id: string; name: string; role: string }[],
  recent: string,
  message: string,
): Promise<DecisionRecord> {
  const started = Date.now();
  if (!jevEnabled())
    return fallback("route", routeQuestion, 0.5, started, "Jev desligado.", {
      answer: { choice: members[0]?.id ?? null },
    });
  try {
    const result = await askJev(
      {
        group: groupName,
        members: members.map((member) => ({ id: member.id, name: member.name, role: member.role })),
        recent_conversation: recent || null,
        new_message: message,
      },
      {
        route: {
          type: "choice",
          instructions:
            "Qual membro do grupo, pelo papel dele, é o mais indicado para responder à nova mensagem da pessoa?",
          criteria: Object.fromEntries(
            members.map((member) => [member.id, `${member.name}: ${member.role || "sem papel definido"}`]),
          ),
        },
      },
    );
    const route = graded(result, "route");
    const choice =
      route?.choice && members.some((member) => member.id === route.choice) ? route.choice : (members[0]?.id ?? null);
    return {
      kind: "route",
      question: routeQuestion,
      answer: { choice, probabilities: route?.probabilities ?? null },
      confidence: route?.confidence ?? null,
      threshold: 0.5,
      outcome: choice ?? "none",
      latencyMs: result.latencyMs,
      model: result.model,
      costUsd: result.costUsd,
    };
  } catch (error) {
    return fallback("route", routeQuestion, 0.5, started, error, {
      answer: { choice: members[0]?.id ?? null },
      outcome: members[0]?.id ?? "none",
    });
  }
}

export { jevModel };
