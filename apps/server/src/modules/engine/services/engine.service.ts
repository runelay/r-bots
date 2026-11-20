import { randomBytes, randomUUID } from "node:crypto";
import type { Provider, ProviderEvent, Usage } from "@runelay-bots/protocol";
import { emptyUsage } from "@runelay-bots/protocol";
import {
  type Account,
  findAccount,
  mcpBaseFor,
  runnerTarget,
  runOnRunner,
} from "../../accounts/services/accounts.service";
import {
  formatReset,
  isLimitError,
  isLimitReply,
  type LimitState,
  limitOf,
  markLimited,
  providerName,
} from "../../accounts/services/limits.service";
import {
  type DecisionRecord,
  decideProgress,
  decideRoute,
  decideTriage,
} from "../../approvals/services/decisions.service";
import { askedDelivery, type DeliveryAsk, noDeliveryAsk } from "../../approvals/services/delivery-intent.service";
import {
  effectivePermission,
  type PermissionMode,
  permissionGuide,
} from "../../approvals/services/permissions.service";
import { artifactGuide } from "../../artifacts/services/artifacts.service";
import { blocksEditNote, blocksGuide } from "../../blocks/services/block-tools.service";
import {
  type BotDefinition,
  connectorsOf,
  decisionsOf,
  engineOf,
  getBot,
  isActive,
  listBots,
  memoryOf,
  suggestedFallback,
} from "../../bots/services/bots.service";
import { startLiveView } from "../../browser/services/browser.service";
import { canvasEditNote, canvasGuide } from "../../canvas/services/canvas.service";
import { touchWorktree } from "../../code/repositories/code.repository";
import { mentionedRepo, openTaskWorkspace } from "../../code/services/actions.service";
import { codeModeSupported } from "../../code/services/code-tools.service";
import { devServersOf } from "../../code/services/dev-server.service";
import { nativeHooks } from "../../code/services/hooks.service";
import { CodeLive } from "../../code/services/live-diff.service";
import {
  activeWorkspace,
  cachedRepoNames,
  createCheckpoint,
  snapshotChanges,
  type WorkspaceState,
} from "../../code/services/workspace.service";
import { watchComputerEvents } from "../../computer/services/computer.service";
import { autoTitle, createConversation } from "../../conversations/services/conversations.service";
import { handoffBlock, refreshSummary } from "../../conversations/services/handoff.service";
import type { EventLog, Fact, StoredSession } from "../../conversations/services/sessions.service";
import { titleFrom } from "../../conversations/services/sessions.service";
import { recordThreadMessage } from "../../conversations/services/threads.service";
import { activeMembers, getGroup, mentionedMembers } from "../../groups/services/groups.service";
import { queueCapture } from "../../memory/services/capture-jobs.service";
import { type RecallItem, recall, recallBlock, teamLogBlock } from "../../memory/services/memory.service";
import { type LoadedSkill, skillsBlock } from "../../skills/services/skills.service";
import {
  attachmentsTitle,
  type PreparedImage,
  prepareAttachments,
  publicUpload,
  type UploadMeta,
  uploadGuide,
} from "../../uploads/services/uploads.service";
import { vaultGuide } from "../../vault/services/vault-tools.service";
import { type ApprovalDetails, toolsFor } from "./bot-tools.service";
import { type ApprovalResult, newToken, registerContext, type ToolContext } from "./mcp-gateway.service";
import { acquireTurnSlot, maxTurns, type SlotPriority, type TurnSlot } from "./turn-slots.service";

export interface DelegationResult {
  outcome: "completed" | "failed" | "cancelled";
  reply: string;
  error?: string;
}

export interface DelegationHooks {
  onStart: (turnId: string) => void;
  onAwaiting: (waiting: boolean) => void;
  finish: (result: DelegationResult) => void;
}

export interface DelegationSource {
  botId: string;
  name: string;
  role: string;
  sessionId: string;
  callId: string;
}

export interface Delivery {
  deliveryId: string;
  text: string;
  source: "chat" | "schedule" | "delegate";
  from?: DelegationSource;
  delegation?: DelegationHooks;
  scheduleId?: string;
  voice?: boolean;
  skills?: LoadedSkill[];
  attachments?: UploadMeta[];
  asked?: DeliveryAsk;
}

export type RunStatus = "working" | "awaiting" | "idle";

export interface StatusEvent {
  botId: string;
  status: RunStatus | "queued";
  sessionId?: string;
}

const sessionStatus = new Map<string, { botId: string; status: RunStatus }>();
const statusListeners = new Set<(event: StatusEvent) => void>();

export function botStatus(botId: string): RunStatus {
  let result: RunStatus = "idle";
  for (const item of sessionStatus.values()) {
    if (item.botId !== botId) continue;
    if (item.status === "awaiting") return "awaiting";
    if (item.status === "working") result = "working";
  }
  return result;
}

export function botStatuses() {
  const result: Record<string, RunStatus> = {};
  for (const item of sessionStatus.values()) result[item.botId] = botStatus(item.botId);
  return result;
}

export function onStatus(listener: (event: StatusEvent) => void) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function conversationStatus(sessionId: string): RunStatus | "queued" {
  const current = sessionStatus.get(sessionId)?.status;
  if (current) return current;
  const runtime = runtimes.get(sessionId);
  if (runtime && !runtime.turn && runtime.queue.length > 0) return "queued";
  return (turnQueue?.queued(sessionId) ?? 0) > 0 ? "queued" : "idle";
}

export function sessionStatuses() {
  const result: Record<string, { botId: string; status: RunStatus }> = {};
  for (const [sessionId, item] of sessionStatus) result[sessionId] = { ...item };
  return result;
}

function setStatus(sessionId: string, botId: string, status: RunStatus) {
  const before = botStatus(botId);
  const previous = sessionStatus.get(sessionId)?.status ?? "idle";
  if (status === "idle") sessionStatus.delete(sessionId);
  else sessionStatus.set(sessionId, { botId, status });
  if (previous !== status) for (const listener of statusListeners) listener({ botId, sessionId, status });
  const after = botStatus(botId);
  if (after === before) return;
  for (const listener of statusListeners) listener({ botId, status: after });
}

interface PendingInteraction {
  resolve: (optionId: "approve" | "deny", always?: boolean) => void;
}

interface Turn {
  turnId: string;
  deliveryId: string;
  abort: AbortController;
  interactions: Map<string, PendingInteraction>;
  cancelled: boolean;
  request: string;
  asked: DeliveryAsk;
  calls: string[];
  guardBusy: boolean;
  guardStop: boolean;
  cancelReason?: string;
  delegation?: DelegationHooks;
  owner: { sessionId: string; botId: string };
  steer?: Delivery[];
  stopRun?: () => void;
  slot?: TurnSlot;
  priority: SlotPriority;
}

interface Runtime {
  queue: Delivery[];
  turn: Turn | null;
}

const runtimes = new Map<string, Runtime>();
const contextLimit = Number(process.env.BOTS_CONTEXT_LIMIT ?? 120_000);
const summaryChars = 600;
const voiceNote =
  "A pessoa está falando com você por chamada de voz. Uma voz rápida já confirmou o pedido e vai resumir a sua resposta em fala. Responda curto, sem tabelas nem listas longas, com o resultado primeiro.";

const footer = [
  "",
  "---",
  "Responda sempre em português do Brasil, curto e direto.",
  "Você não tem acesso a arquivos, terminal ou internet além das ferramentas do servidor MCP `bots`.",
].join("\n");
const codeFooter = ["", "---", "Responda sempre em português do Brasil, curto e direto."].join("\n");

interface CodePrompt {
  workspace: WorkspaceState | null;
  supported: boolean;
}

function codeGuide() {
  const repos = cachedRepoNames();
  return [
    "## Código",
    "Você pode codar nos repositórios que a pessoa liberou, na VPS. Quando o pedido envolver código de um repositório, chame `workspace_open` com o repositório e uma frase curta da tarefa: isso cria uma worktree e uma branch feat/<tarefa> só desta conversa e liga as ferramentas de código. Se não for óbvio qual repositório, procure na memória o que cada um é e, na dúvida, pergunte antes.",
    repos.length > 0 ? `Repositórios liberados: ${repos.join(", ")}.` : "Nenhum repositório liberado ainda.",
    "Se a pessoa pedir para trabalhar num repositório fora dessa lista, pergunte o caminho se precisar e chame `workspace_add(path, reason)`: abre um card para ela liberar. Fora dos repositórios liberados, as ferramentas de código e arquivo recusam. Ao conhecer um repositório, grave com `memory_write` o que ele é (o que faz, stack, quando usar), se a memória ainda não disser.",
    "Você tem autonomia: não peça permissão para commit, push, PR, testes, build, instalar dependência ou tarefas no Linear. Faça direto. Só pede aprovação a lista dura: push --force, push ou merge direto em main/master/develop, gh pr merge, deploy, migration ou escrita em banco de produção, apagar dados fora da worktree, dinheiro (pagamento, estorno) e mensagem para pessoas de fora (e-mail, Slack, WhatsApp). Se a pessoa pedir push, dê push; se já houver PR, o push atualiza o PR. Nunca diga que não pode dar push ou abrir PR. Uma negação antiga não vale para o próximo pedido.",
  ]
    .filter(Boolean)
    .join("\n");
}

function workspaceGuide(code: CodePrompt) {
  const workspace = code.workspace;
  if (!workspace) return "";
  if (!code.supported) {
    return `## Repositório aberto\nEsta conversa tem o repositório ${workspace.repoName} aberto (branch ${workspace.branch}), mas o modelo atual não edita código na VPS. Diga em uma linha para a pessoa escolher um modelo Claude ou Codex da VPS no seletor de modelo.`;
  }
  const install =
    workspace.install.status === "running"
      ? `instalando em segundo plano (${workspace.install.command}); dev_server_start espera terminar`
      : workspace.install.status === "failed"
        ? `a instalação falhou (${(workspace.install.error ?? "").slice(0, 200)})`
        : workspace.install.status === "done"
          ? "instaladas"
          : "sem lockfile ou já presentes";
  const servers = devServersOf(workspace);
  return [
    "## Repositório aberto",
    `Repositório ${workspace.repoName}. Worktree ${workspace.path} (é o seu diretório de trabalho), branch ${workspace.branch}, a partir de ${workspace.base}. Dependências: ${install}.`,
    servers.length > 0
      ? `Servidores no ar: ${servers.map((server) => `${server.url} (${server.command})`).join("; ")}.`
      : "",
    "- Você tem autonomia: Read, Edit, Write, Bash, testes, build, dev server, instalar dependência, commit, push da branch da tarefa, abrir ou atualizar PR (gh pr create/edit/comment) e tarefas no Linear rodam direto, sem card. Não peça permissão para isso. Só a lista dura pede aprovação: push --force, push ou merge direto em main/master/develop, gh pr merge, deploy, migration ou escrita em banco de produção, apagar dados fora da worktree, dinheiro (pagamento, estorno) e mensagem para pessoas de fora (e-mail, Slack, WhatsApp).",
    "- Para subir o app, use `dev_server_start` (nunca & no Bash) e teste no seu navegador com `browser_open` na url que ele devolver; confira com `browser_screenshot` e clique quando precisar.",
    "- Rode só os testes, lint ou build da parte que mudou.",
    "- .git, .claude, .env* e a configuração dos bots são protegidos: não tente escrever neles.",
    '- Commits por módulo ou feature no Bash (`git add <arquivos>` + `git commit -m`), em conventional commits em inglês, curtos e sem assinatura de IA (nada de Co-Authored-By). `workspace_deliver` faz um commit só com tudo o que estiver pendente: use para um único módulo ou com action pr para push e PR depois dos commits. Base do PR: a que a pessoa pedir; se ela não disser, a base de onde a branch saiu de verdade (compare `git rev-list --left-right --count HEAD...origin/main` e `HEAD...origin/develop` e fique com a mais próxima), nunca develop por padrão. PR para a main é permitido; só o merge passa pela pessoa. Se a pessoa pedir push, dê push (`git push -u origin <branch da tarefa>` ou workspace_deliver action push); se a branch já tem PR, o push atualiza o PR e você nunca abre outro. "Só push" nunca vira PR novo. Nunca diga que não pode dar push. Uma negação antiga não vale para o próximo pedido.',
    "- No fim, diga em uma ou duas linhas o que mudou e como conferir.",
  ]
    .filter(Boolean)
    .join("\n");
}

function clip(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function newBotPrompt(bot: BotDefinition) {
  return [
    `Você é ${bot.name}, um bot novo no time da pessoa e ainda sem função definida.`,
    "Na primeira conversa, apresente-se em uma frase curta e pergunte o que você deve fazer.",
    "Quando a pessoa explicar, configure-se com as ferramentas do servidor MCP `bots`: `set_role` com um papel curto, `update_instructions` (mode replace) com instruções claras em markdown, e `add_schedule` se o trabalho precisar de rotina. Você já tem acesso a tudo: navegador, o Mac da pessoa, banco em leitura, todos os conectores e os outros bots. Nunca peça acesso.",
    "Depois de se configurar, confirme em uma linha o que passou a fazer.",
  ].join("\n");
}

function systemPromptFor(
  bot: BotDefinition,
  delegates: BotDefinition[],
  isNew: boolean,
  code: CodePrompt | null = null,
  permission: PermissionMode = "default",
) {
  const parts = [bot.instructions.trim() || newBotPrompt(bot)];
  const tools = toolsFor(bot).map((tool) => tool.name);
  if (tools.length > 0) parts.push("", `Ferramentas disponíveis (servidor MCP \`bots\`): ${tools.join(", ")}.`);
  if (delegates.length > 0) {
    parts.push(
      "",
      "## Delegação",
      "Use a ferramenta `delegate` do servidor MCP `bots` para passar tarefas ao time. O pedido entra na conversa do bot, ele trabalha lá e a resposta final volta para você. O bot só vê a mensagem que você mandar, então mande o pedido completo.",
      ...delegates.map((target) => `- \`${target.id}\`: ${target.name}, ${target.role}`),
    );
  }
  const connectors = connectorsOf(bot);
  if (connectors.allowed.length > 0) {
    parts.push(
      "",
      `Serviços conectados liberados (runelay): ${connectors.allowed.join(", ")}. Use \`connector_search\` para achar a ferramenta e \`connector_call\` para chamar. Leitura e escrita comuns (criar, atualizar) rodam direto; só mensagem para fora e ação destrutiva ou financeira pedem aprovação. Memória você salva direto, sem pedir.`,
    );
  }
  if (connectors.memory)
    parts.push(
      "",
      "Você pode consultar as memórias e skills da pessoa com `memory_search`, `memory_read` e `skill_read`.",
    );
  if (bot.capabilities.computer) {
    parts.push(
      "",
      "## Uso do Mac da pessoa",
      "Você opera o Mac real da pessoa pelas ferramentas computer_*, files_*, shell_run e record_*.",
      "- Prefira `computer_ui_tree` e clique por `elementId`, ou `computer_applescript` para Mail, Finder e Safari. Use pixels (`computer_screenshot` + x,y) só quando não houver outro jeito.",
      "- Antes de qualquer coisa irreversível (enviar, apagar, comprar, mover muitos arquivos), pergunte à pessoa em uma linha.",
      "- Arquivos só nas pastas permitidas; escrita e comandos só em ~/runelay-bots-workspace. Nunca use sudo.",
      "- Se a ferramenta disser COMPUTER_UNAVAILABLE, avise que o app runelay bots precisa estar aberto no Mac.",
    );
  }
  parts.push("", artifactGuide);
  parts.push("", codeGuide());
  const openGuide = code ? workspaceGuide(code) : "";
  if (openGuide) parts.push("", openGuide);
  parts.push("", permissionGuide(permission));
  parts.push("", canvasGuide);
  parts.push("", blocksGuide);
  parts.push("", uploadGuide);
  parts.push("", vaultGuide);
  parts.push(
    "",
    "## Autoconfiguração",
    "Você pode se configurar com as ferramentas do servidor MCP `bots`: `set_role`, `update_instructions`, `add_schedule` (converta o pedido em cron), e `remove_schedule`. Use quando a pessoa pedir algo recorrente ou uma mudança no seu jeito de trabalhar. Para criar um bot novo no time, use `create_bot`; para criar um grupo de bots, use `create_group`; para adicionar, tirar ou renomear num grupo existente, use `update_group` (nunca crie outro grupo para isso); `archive_group` arquiva, mas só quando a pessoa pedir com todas as letras. Nunca arquive, apague ou desfaça nada por iniciativa própria, nem para “arrumar”: confira o estado atual com as ferramentas antes de mexer, sua memória da conversa pode estar velha. Faça direto, sem pedir confirmação nem delegar. Nunca use o computador (cliques na tela) para mexer no próprio app runelay bots: tudo dele tem ferramenta. Delegar para outro bot também não pede permissão: faça. Você já tem acesso a tudo (navegador, o Mac da pessoa, banco em leitura, todos os conectores e os outros bots): nunca peça acesso nem diga que não tem.",
  );
  if (isNew) {
    parts.push(
      "",
      "Você acabou de ser criado. Se a pessoa pedir algo recorrente ou que precisa de uma capacidade que você não tem, configure-se com essas ferramentas.",
    );
  }
  return `${parts.join("\n")}\n${code?.workspace && code.supported ? codeFooter : footer}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requestText(delivery: Delivery) {
  let text = delivery.text;
  for (const skill of delivery.skills ?? []) {
    for (const name of [skill.name, skill.slug])
      text = text.replace(new RegExp(`(^|\\s)/${escapeRegExp(name)}(?=\\s|$)`, "gi"), "$1");
  }
  text = text.replace(/[ \t]{2,}/g, " ").trim();
  if (text) return text;
  if (delivery.skills?.length)
    return `Faça o que ${delivery.skills.length === 1 ? "a skill anexada pede" : "as skills anexadas pedem"}, nesta ordem: ${delivery.skills.map((skill) => skill.name).join(", ")}.`;
  return "";
}

function skillPrompt(delivery: Delivery, canReadFiles: boolean) {
  if (!delivery.skills?.length) return "";
  const names = delivery.skills.map((skill) => `“${skill.name}”`).join(" e ");
  return `A pessoa anexou ${delivery.skills.length === 1 ? "a skill" : "as skills"} ${names} a esta mensagem. Skill anexada não é comando de barra: é um procedimento escrito. Siga cada uma inteira, na ordem, neste turno. Se alguma coisa dela não der para fazer aqui, diga qual passo ficou de fora e por quê.\n\n${skillsBlock(delivery.skills, canReadFiles)}`;
}

function deliveryNote(delivery: Delivery) {
  const asked = deliveryAskOf(delivery);
  if (!asked.commit) return "";
  const parts = [
    `A pessoa pediu ${asked.pr ? "commit, push e PR" : asked.push ? "push (e commit do que estiver pendente)" : "o commit"} nesta mensagem. Faça direto, sem perguntar.`,
    asked.push && !asked.pr
      ? "Ela pediu push, não PR: use `git push -u origin <branch da tarefa>` ou workspace_deliver action push. Se a branch já tem PR, esse push atualiza o PR. Não abra PR novo."
      : "",
    'Commits: agrupe as mudanças por módulo ou feature e faça um commit por grupo no Bash (`git add <arquivos do grupo>` e depois `git commit -m "tipo(escopo): assunto"`). Conventional commits em inglês, assunto curto no imperativo, no máximo 2 linhas, sem Co-Authored-By nem Generated with. Nunca junte tudo num commit genérico.',
    "workspace_deliver commita num commit só tudo o que ainda estiver pendente: use só para o que sobrar de um mesmo módulo, ou com action pr depois dos commits para push e PR.",
  ];
  if (asked.pr)
    parts.push(
      "PR: `git push -u origin <branch>` e confira os PRs da branch com `gh pr list --head <branch> --state all`. Se houver PR aberto, o push já o atualiza. Se houver PR mergeado ou fechado, diga isso à pessoa (número, estado e link) em vez de dizer que não há PR. Sem nenhum PR, `gh pr create --base <base> --title ... --body ...` (ou workspace_deliver action pr), com a base que a pessoa pediu ou a de onde a branch saiu. Título e corpo sem assinatura de IA.",
    );
  return parts.filter(Boolean).join("\n");
}

function deliveryAskOf(delivery: Delivery) {
  if (delivery.source === "schedule") return noDeliveryAsk;
  if (delivery.source === "delegate") return delivery.asked ?? noDeliveryAsk;
  return askedDelivery(delivery.text, delivery.skills ?? []);
}

function promptFor(session: StoredSession, delivery: Delivery, carry: string, memoryCanRead = false) {
  const meta = session.meta;
  if (delivery.source === "schedule") {
    const previous = meta.scheduleSummaries?.[delivery.scheduleId ?? ""];
    if (!previous) return delivery.text;
    return `Resumo da última rodada desta rotina, para continuidade:\n${previous}\n\n---\n\n${delivery.text}`;
  }
  const blocks: string[] = [];
  const text = requestText(delivery);
  const asked = deliveryNote(delivery);
  const request =
    delivery.source === "delegate" && delivery.from
      ? `${delivery.from.name} (${delivery.from.role || "bot do time"}), outro bot do time, te passou esta tarefa:\n${text}\n\nFaça o trabalho aqui na sua conversa e termine com o resultado em poucas linhas: sua resposta final volta para ${delivery.from.name}.${asked ? `\n\n${asked}` : ""}`
      : [skillPrompt(delivery, memoryCanRead), asked, text].filter(Boolean).join("\n\n---\n\n");
  if (carry) blocks.push(carry);
  if (meta.pendingNotes && meta.pendingNotes.length > 0) {
    blocks.push(`Rotinas que rodaram desde a última mensagem:\n${meta.pendingNotes.join("\n")}`);
  }
  if (blocks.length === 0) return request;
  return `${blocks.join("\n\n")}\n\n---\n\n${request}`;
}

function runtimeOf(sessionId: string) {
  let runtime = runtimes.get(sessionId);
  if (!runtime) {
    runtime = { queue: [], turn: null };
    runtimes.set(sessionId, runtime);
  }
  return runtime;
}

export function isRunning(sessionId: string) {
  return runtimes.get(sessionId)?.turn != null;
}

const draining = new Set<string>();

export function sessionBusy(sessionId: string) {
  return draining.has(sessionId) || isRunning(sessionId) || (runtimes.get(sessionId)?.queue.length ?? 0) > 0;
}

export function isBusy(sessionId: string) {
  return sessionBusy(sessionId) || (turnQueue?.queued(sessionId) ?? 0) > 0;
}

export interface TurnQueue {
  enqueue: (session: StoredSession, delivery: Delivery) => Promise<void>;
  cancelSession: (sessionId: string) => Promise<void>;
  withdraw: (hooks: DelegationHooks) => Promise<boolean>;
  queued: (sessionId: string) => number;
}

let turnQueue: TurnQueue | null = null;
const completions = new Map<string, () => void>();

export function useTurnQueue(queue: TurnQueue | null) {
  turnQueue = queue;
}

function settleCompletion(deliveryId: string) {
  completions.get(deliveryId)?.();
  completions.delete(deliveryId);
}

function steerPausedTurn(session: StoredSession, runtime: Runtime, delivery: Delivery) {
  const turn = runtime.turn;
  if (!turn?.stopRun || turn.interactions.size === 0 || session.meta.kind === "group") return false;
  if (
    delivery.source !== "chat" ||
    delivery.voice ||
    delivery.skills?.length ||
    delivery.attachments?.length ||
    !delivery.text.trim()
  )
    return false;
  const scope = { turnId: turn.turnId };
  turn.steer ??= [];
  turn.steer.push(delivery);
  session.log.emit(
    {
      type: "delivery.admitted",
      data: {
        deliveryId: delivery.deliveryId,
        principal: { id: "anonymous", type: "anonymous" },
        source: { channel: "channel:eve" },
      },
    },
    {
      type: "delivery.consumed",
      data: {
        deliveryId: delivery.deliveryId,
        parts: [{ kind: "text", text: delivery.text }],
        turnId: turn.turnId,
        source: "chat",
        steer: true,
      },
      scope,
    },
  );
  void recordThreadMessage(session.meta.botId, session.meta.sessionId, {
    role: "user",
    text: titleFrom(delivery.text),
    at: new Date().toISOString(),
  }).catch(() => undefined);
  turn.stopRun();
  for (const [interactionId, pending] of [...turn.interactions]) {
    turn.interactions.delete(interactionId);
    session.log.emit({
      type: "interaction.settled",
      data: { interactionId, outcome: "withdrawn", reason: "message" },
      scope,
    });
    pending.resolve("deny");
  }
  return true;
}

function deliverInProcess(session: StoredSession, runtime: Runtime, delivery: Delivery) {
  runtime.queue.push(delivery);
  if (!runtime.turn && !draining.has(session.meta.sessionId)) void drain(session, runtime);
}

export async function deliver(session: StoredSession, delivery: Delivery) {
  const runtime = runtimeOf(session.meta.sessionId);
  if (steerPausedTurn(session, runtime, delivery)) return;
  if (!turnQueue || delivery.voice) return deliverInProcess(session, runtime, delivery);
  await turnQueue.enqueue(session, delivery).catch((error) => {
    console.warn(`fila indisponível, turno roda direto: ${error instanceof Error ? error.message : String(error)}`);
    deliverInProcess(session, runtime, delivery);
  });
}

export function runDelivery(session: StoredSession, delivery: Delivery) {
  const done = new Promise<void>((resolve) => completions.set(delivery.deliveryId, resolve));
  deliverInProcess(session, runtimeOf(session.meta.sessionId), delivery);
  return done;
}

const maxGroupTurns = 4;

function taggedLog(log: EventLog, botId: string): EventLog {
  const tag = (fact: Fact): Fact => ({ ...fact, data: { ...fact.data, botId } });
  return {
    lines: () => log.lines(),
    get size() {
      return log.size;
    },
    slice: (start: number, end?: number) => log.slice(start, end),
    rows: (start: number, end: number) => log.rows(start, end),
    emit: (...facts: Fact[]) => log.emit(...facts.map(tag)),
    progress: (fact: Fact) => log.progress(tag(fact)),
    subscribe: (listener: (line: string) => void) => log.subscribe(listener),
    load: () => log.load(),
    flush: () => log.flush(),
  } as unknown as EventLog;
}

async function groupTranscript(session: StoredSession, limit: number) {
  const items: string[] = [];
  for (const line of await session.log.lines()) {
    try {
      for (const fact of JSON.parse(line).facts as Fact[]) {
        if (fact.type === "delivery.consumed") {
          const parts = fact.data.parts as Array<{ text?: string }>;
          items.push(`Pessoa: ${clip(parts.map((part) => part.text ?? "").join(" "), 300)}`);
        } else if (fact.type === "content.completed" && fact.data.phase === "reply") {
          const speaker = getBot(String(fact.data.botId ?? ""))?.name ?? "Bot";
          items.push(`${speaker}: ${clip(String(fact.data.value ?? ""), 400)}`);
        }
      }
    } catch {}
  }
  return items.slice(-limit).join("\n");
}

async function runGroup(session: StoredSession, runtime: Runtime, delivery: Delivery) {
  const group = getGroup(session.meta.botId);
  if (!group || group.archivedAt) return;
  const members = activeMembers(group);
  if (members.length === 0) return;
  const before = await groupTranscript(session, 12);
  const mentioned = mentionedMembers(delivery.text, members);
  const queue: { bot: BotDefinition; note: string | null }[] = [];
  if (mentioned.length > 0) {
    for (const id of mentioned) queue.push({ bot: members.find((member) => member.id === id)!, note: null });
  } else {
    const decision = await decideRoute(
      group.name,
      members.map((member) => ({ id: member.id, name: member.name, role: member.role })),
      before,
      delivery.text,
    );
    session.log.emit({ type: "decision.made", data: { ...decision, groupId: group.id } });
    const choice = String((decision.answer as { choice?: string } | null)?.choice ?? members[0].id);
    queue.push({ bot: members.find((member) => member.id === choice) ?? members[0], note: null });
  }
  let turns = 0;
  let first = true;
  while (queue.length > 0 && turns < maxGroupTurns) {
    const next = queue.shift()!;
    turns++;
    let handoff: { botId: string; note: string } | null = null;
    const roster = members
      .map((member) => `- ${member.name} (\`${member.id}\`): ${member.role || "sem papel"}`)
      .join("\n");
    const prompt = [
      `Você está no grupo "${group.name}" com estes bots:`,
      roster,
      "",
      "Conversa recente:",
      (await groupTranscript(session, 12)) || "(início do grupo)",
      "",
      next.note ? `${next.note}` : "",
      `Mensagem da pessoa: ${requestText(delivery)}`,
      skillPrompt(delivery, connectorsOf(next.bot).memory),
      deliveryNote(delivery),
      "",
      "Responda como você mesmo, curto. Se outro bot do grupo for mais indicado para continuar, use a ferramenta `handoff` com o id dele e uma nota.",
    ]
      .filter((line) => line !== "")
      .join("\n");
    await runTurn(session, runtime, delivery, {
      bot: next.bot,
      log: taggedLog(session.log, next.bot.id),
      prompt,
      first,
      members,
      onHandoff: (botId, note) => {
        handoff = { botId, note };
      },
    });
    first = false;
    const passed = handoff as { botId: string; note: string } | null;
    if (passed) {
      const target = members.find((member) => member.id === passed.botId);
      if (target)
        queue.push({ bot: target, note: `${next.bot.name} passou a vez para você com esta nota: ${passed.note}` });
    }
  }
}

async function drain(session: StoredSession, runtime: Runtime) {
  draining.add(session.meta.sessionId);
  try {
    while (runtime.queue.length > 0) {
      const delivery = runtime.queue.shift()!;
      try {
        if (session.meta.kind === "group") await runGroup(session, runtime, delivery);
        else await runTurn(session, runtime, delivery);
      } catch (error) {
        console.error("turn crashed", session.meta.sessionId, error);
        delivery.delegation?.finish({
          outcome: "failed",
          reply: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (runtime.queue.length === 0) setStatus(session.meta.sessionId, session.meta.botId, "idle");
      settleCompletion(delivery.deliveryId);
    }
  } finally {
    draining.delete(session.meta.sessionId);
  }
}

export function answer(
  session: StoredSession,
  deliveryId: string,
  interactionId: string,
  optionId: "approve" | "deny" | "approve_always",
) {
  const turn = runtimes.get(session.meta.sessionId)?.turn;
  const pending = turn?.interactions.get(interactionId);
  if (!turn || !pending) return false;
  turn.interactions.delete(interactionId);
  turn.deliveryId = deliveryId;
  const responseId = `response_${deliveryId}_0`;
  const scope = { turnId: turn.turnId };
  session.log.emit(
    { type: "response.submitted", data: { deliveryId, interactionId, responseId, value: { optionId } }, scope },
    { type: "response.settled", data: { outcome: "applied", responseId }, scope },
    {
      type: "interaction.settled",
      data: {
        cause: { responseId },
        interactionId,
        outcome: optionId === "deny" ? "declined" : "accepted",
        response: { optionId },
      },
      scope,
    },
  );
  pending.resolve(optionId === "deny" ? "deny" : "approve", optionId === "approve_always");
  return true;
}

export function cancel(session: StoredSession) {
  const runtime = runtimes.get(session.meta.sessionId);
  for (const dropped of runtime?.queue.splice(0) ?? []) {
    dropped.delegation?.finish({ outcome: "cancelled", reply: "" });
    settleCompletion(dropped.deliveryId);
  }
  void turnQueue?.cancelSession(session.meta.sessionId);
  const turn = runtime?.turn;
  if (!turn) return false;
  turn.cancelled = true;
  turn.abort.abort();
  return true;
}

function delegatesOf(bot: BotDefinition) {
  return listBots().filter((target) => target.id !== bot.id && isActive(target));
}

function addUsage(total: Usage, usage: Usage) {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
}

function unavailableMessage(accountId: string, account: Account | undefined) {
  if (!account) return `A conta ${accountId} não existe.`;
  const reason = { offline: "está fora do ar", logged_out: "está sem login", missing: "não está instalada", ready: "" }[
    account.status
  ];
  return `A conta ${account.label} ${reason}. ${account.detail}`.trim();
}

export interface GroupTurn {
  bot: BotDefinition;
  log: EventLog;
  prompt: string;
  first: boolean;
  members: BotDefinition[];
  onHandoff: (botId: string, note: string) => void;
}

interface ProviderRun {
  extraSystem: string;
  log: EventLog;
  group: GroupTurn | null;
  account: Account;
  provider: Provider;
  model: string;
  effort: string | null;
  bot: BotDefinition;
  session: StoredSession;
  turn: Turn;
  prompt: string;
  images?: PreparedImage[];
  resume: string | null;
  origin: string | null;
  ownerCallId: string | null;
  isSchedule: boolean;
  onEvent: (event: ProviderEvent) => void;
  runIdRef: () => string;
  onCallStart: () => void;
  onCallEnd: () => void;
  usage: Usage;
  request: string;
  codeRun?: { workspace: WorkspaceState; live: CodeLive } | null;
  onEndRun?: () => void;
}

function emitDecision(log: EventLog, turn: Turn, record: DecisionRecord) {
  log.emit({ type: "decision.made", data: { ...record }, scope: { turnId: turn.turnId } });
}

function onToolSettled(log: EventLog, turn: Turn, summary: string) {
  turn.calls.push(summary);
  if (turn.calls.length % 4 !== 0 || turn.guardBusy || turn.guardStop || turn.abort.signal.aborted) return;
  turn.guardBusy = true;
  void decideProgress(turn.request, turn.calls.slice(-8))
    .then((record) => {
      emitDecision(log, turn, record);
      if (record.outcome === "stop" && !turn.abort.signal.aborted) {
        turn.guardStop = true;
        turn.abort.abort();
      }
    })
    .finally(() => {
      turn.guardBusy = false;
    });
}

async function executeProvider(run: ProviderRun) {
  const { session, turn } = run;
  const log = run.log;
  const codeWorkspace = run.codeRun && run.ownerCallId === null ? run.codeRun.workspace : null;
  const coding = Boolean(codeWorkspace && codeModeSupported(run.provider, run.account.runner));
  const bot =
    coding && !run.bot.capabilities.browser
      ? { ...run.bot, capabilities: { ...run.bot.capabilities, browser: true } }
      : run.bot;
  const delegates = delegatesOf(bot);
  const tools = toolsFor(bot);
  const token = newToken();
  const permission = effectivePermission(session.meta.permission, run.bot.permission);
  const needsMcp = true;
  const runAbort = new AbortController();
  const forwardAbort = () => runAbort.abort();
  turn.abort.signal.addEventListener("abort", forwardAbort, { once: true });
  const stopRun =
    run.ownerCallId === null && run.onEndRun
      ? () => {
          run.onEndRun?.();
          runAbort.abort();
        }
      : undefined;
  if (stopRun) turn.stopRun = stopRun;
  const context: ToolContext = {
    token,
    botId: bot.id,
    sessionId: session.meta.sessionId,
    log,
    turnId: turn.turnId,
    runId: run.runIdRef,
    tools,
    delegates,
    origin: run.origin,
    ownerCallId: run.ownerCallId,
    isSchedule: run.isSchedule,
    signal: turn.abort.signal,
    onCallStart: run.onCallStart,
    onCallEnd: run.onCallEnd,
    requestApproval: (prompt, callId, origin, details) => requestApproval(log, turn, prompt, callId, origin, details),
    delegate: (targetId, message, callId) => delegateTo(run, targetId, message, callId),
    bot,
    request: run.request,
    asked: turn.asked,
    decisions: decisionsOf(bot),
    emitDecision: (record) => emitDecision(log, turn, record),
    onCallSettled: (summary) => onToolSettled(log, turn, summary),
    groupMembers:
      run.group && run.ownerCallId === null ? run.group.members.filter((member) => member.id !== bot.id) : [],
    onHandoff: (botId, note) => run.group?.onHandoff(botId, note),
    provider: run.provider,
    runner: run.account.runner,
    permission,
    ...(run.onEndRun && run.ownerCallId === null
      ? {
          endRun: () => {
            run.onEndRun?.();
            setTimeout(() => runAbort.abort(), 300);
          },
        }
      : {}),
    cancelTurn: (reason) => {
      if (turn.abort.signal.aborted) return;
      turn.cancelled = true;
      turn.cancelReason = reason;
      turn.abort.abort();
    },
  };
  if (run.ownerCallId === null && run.account.runner !== "mac" && !turn.slot) {
    let queued = false;
    const scope = { turnId: turn.turnId };
    turn.slot = await acquireTurnSlot(turn.priority, turn.abort.signal, (position) => {
      queued = true;
      log.emit({ type: "turn.queued", data: { turnId: turn.turnId, position, limit: maxTurns }, scope });
    });
    if (queued) log.emit({ type: "turn.dequeued", data: { turnId: turn.turnId }, scope });
  }
  const revoke = needsMcp ? registerContext(context) : () => false;
  try {
    await runOnRunner(
      runnerTarget(run.account),
      {
        turnId: `${turn.turnId}-${randomBytes(4).toString("hex")}`,
        provider: run.provider,
        model: run.model,
        effort: run.effort,
        systemPrompt: [
          systemPromptFor(
            bot,
            delegates,
            run.ownerCallId === null && session.meta.turnCount <= 1 && session.meta.kind === "thread",
            codeWorkspace ? { workspace: codeWorkspace, supported: coding } : null,
            permission,
          ),
          run.extraSystem,
        ]
          .filter(Boolean)
          .join("\n\n"),
        prompt: run.prompt,
        ...(run.images?.length ? { images: run.images } : {}),
        resume: run.resume,
        mcp: needsMcp ? { url: `${mcpBaseFor()}/mcp/${bot.id}/${session.meta.sessionId}`, token } : null,
        workKey: `${bot.id}/${run.ownerCallId ? "delegate" : session.meta.sessionId}`,
        code:
          coding && codeWorkspace
            ? { cwd: codeWorkspace.path, ...(permission === "readonly" ? { readOnly: true } : {}) }
            : null,
      },
      runAbort.signal,
      run.onEvent,
      coding && codeWorkspace && run.provider === "claude" && run.codeRun
        ? nativeHooks(context, codeWorkspace, run.codeRun.live)
        : undefined,
    );
  } finally {
    turn.abort.signal.removeEventListener("abort", forwardAbort);
    if (stopRun && turn.stopRun === stopRun) turn.stopRun = undefined;
    revoke();
  }
}

function requestApproval(
  log: EventLog,
  turn: Turn,
  prompt: string,
  callId: string,
  origin: string | null,
  details?: ApprovalDetails,
) {
  const interactionId = randomBytes(12).toString("base64url").slice(0, 16);
  const scope = { turnId: turn.turnId };
  return new Promise<ApprovalResult>((resolve) => {
    turn.interactions.set(interactionId, {
      resolve: (choice, always) => {
        if (turn.interactions.size === 0) {
          turn.slot?.resume();
          turn.delegation?.onAwaiting(false);
          setStatus(turn.owner.sessionId, turn.owner.botId, "working");
        }
        resolve({ choice, interactionId, ...(always ? { always: true } : {}) });
      },
    });
    log.emit(
      {
        type: "interaction.opened",
        data: {
          interactionId,
          request: {
            allowFreeform: false,
            display: details?.secret ? "secret_form" : "confirmation",
            kind: details?.secret ? "secret" : "approval",
            options: details?.secret
              ? [
                  { id: "approve", label: "Salvar" },
                  { id: "deny", label: "Agora não" },
                ]
              : [
                  { id: "approve", label: "Aprovar" },
                  ...(details?.grant ? [{ id: "approve_always", label: "Sempre neste repositório" }] : []),
                  { id: "deny", label: "Negar" },
                ],
            ...(details?.secret ? { secret: details.secret } : {}),
            prompt,
            ...(details?.grant ? { grant: details.grant } : {}),
            ...(details?.target ? { target: details.target } : {}),
            ...(details?.previewImage ? { previewImage: details.previewImage } : {}),
            ...(details?.reason ? { reason: details.reason } : {}),
          },
          subject: { callId },
          ...(origin ? { origin: { agent: origin } } : {}),
        },
        scope,
      },
      { type: "turn.paused", data: { awaiting: [{ interactionId }], turnId: turn.turnId }, scope },
      {
        type: "delivery.settled",
        data: { deliveryId: turn.deliveryId, outcome: "awaiting-input", turnId: turn.turnId },
      },
    );
    turn.delegation?.onAwaiting(true);
    turn.slot?.suspend();
    setStatus(turn.owner.sessionId, turn.owner.botId, "awaiting");
    turn.abort.signal.addEventListener(
      "abort",
      () => {
        if (!turn.interactions.delete(interactionId)) return;
        log.emit({ type: "interaction.settled", data: { interactionId, outcome: "withdrawn" }, scope });
        resolve({ choice: "deny", interactionId });
      },
      { once: true },
    );
  });
}

const waits: { from: string; to: string }[] = [];

function waitsOn(start: string, goal: string) {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of waits) if (edge.from === current) stack.push(edge.to);
  }
  return false;
}

function withdrawDelivery(session: StoredSession, hooks: DelegationHooks, reason: string) {
  const runtime = runtimes.get(session.meta.sessionId);
  if (!runtime) return;
  const index = runtime.queue.findIndex((item) => item.delegation === hooks);
  if (index >= 0) {
    const [dropped] = runtime.queue.splice(index, 1);
    hooks.finish({ outcome: "cancelled", reply: "" });
    settleCompletion(dropped.deliveryId);
    return;
  }
  const turn = runtime.turn;
  if (turn && turn.delegation === hooks && !turn.abort.signal.aborted) {
    turn.cancelled = true;
    turn.cancelReason = reason;
    turn.abort.abort();
    return;
  }
  void turnQueue?.withdraw(hooks);
}

async function delegateTo(parent: ProviderRun, targetId: string, message: string, callId: string) {
  const target = getBot(targetId);
  if (!target || !isActive(target)) throw new Error(`O bot ${targetId} não está disponível.`);
  if (waitsOn(target.id, parent.bot.id))
    throw new Error(`${target.name} está esperando uma resposta sua agora. Resolva você mesmo, sem delegar de volta.`);
  const engine = engineOf(target);
  const account = await findAccount(engine.account);
  if (account?.status !== "ready") throw new Error(unavailableMessage(engine.account, account));
  const deliveryId = randomUUID();
  const session = await createConversation(target.id, {
    title: autoTitle(`${parent.bot.name} pediu: ${message}`),
    permission: effectivePermission(parent.session.meta.permission, parent.bot.permission),
    delegatedBy: { botId: parent.bot.id, name: parent.bot.name, sessionId: parent.session.meta.sessionId, callId },
  });
  const scope = { runId: parent.runIdRef(), turnId: parent.turn.turnId };
  let turnId: string | null = null;
  const update = (status: string, extra: Record<string, unknown> = {}) =>
    parent.log.emit({
      type: "delegation.updated",
      data: {
        callId,
        botId: target.id,
        sessionId: session.meta.sessionId,
        deliveryId,
        status,
        ...(turnId ? { turnId } : {}),
        ...extra,
      },
      scope,
    });
  const edge = { from: parent.bot.id, to: target.id };
  waits.push(edge);
  parent.turn.slot?.suspend();
  let detach: () => void = () => undefined;
  try {
    const result = await new Promise<DelegationResult>((resolve) => {
      const hooks: DelegationHooks = {
        onStart: (id) => {
          turnId = id;
          update("working");
        },
        onAwaiting: (waiting) => update(waiting ? "awaiting" : "working"),
        finish: resolve,
      };
      const onAbort = () => withdrawDelivery(session, hooks, `${parent.bot.name} cancelou o pedido.`);
      if (parent.turn.abort.signal.aborted) {
        resolve({ outcome: "cancelled", reply: "" });
        return;
      }
      parent.turn.abort.signal.addEventListener("abort", onAbort, { once: true });
      detach = () => parent.turn.abort.signal.removeEventListener("abort", onAbort);
      update(isBusy(session.meta.sessionId) ? "queued" : "starting");
      void deliver(session, {
        deliveryId,
        text: message,
        source: "delegate",
        asked: parent.turn.asked,
        from: {
          botId: parent.bot.id,
          name: parent.bot.name,
          role: parent.bot.role,
          sessionId: parent.session.meta.sessionId,
          callId,
        },
        delegation: hooks,
      });
    });
    if (result.outcome === "completed") {
      const reply = result.reply.trim() || `${target.name} terminou sem responder.`;
      update("completed", { summary: clip(reply, 280) });
      return reply;
    }
    if (result.outcome === "failed") {
      update("failed", { error: result.error ?? "Falha no bot delegado." });
      throw new Error(`${target.name} falhou: ${result.error ?? "erro desconhecido"}`);
    }
    update("cancelled");
    throw new Error(parent.turn.abort.signal.aborted ? "Pedido cancelado." : `${target.name} parou antes de terminar.`);
  } finally {
    detach();
    parent.turn.slot?.resume();
    waits.splice(waits.indexOf(edge), 1);
  }
}

async function runTurn(session: StoredSession, runtime: Runtime, delivery: Delivery, group: GroupTurn | null = null) {
  const bot = group ? group.bot : getBot(session.meta.botId);
  const log = group ? group.log : session.log;
  const showDelivery = !group || group.first;
  const meta = session.meta;
  const turnId = `turn_${meta.turnCount++}`;
  const turnScope = { turnId };
  const turn: Turn = {
    turnId,
    deliveryId: delivery.deliveryId,
    abort: new AbortController(),
    interactions: new Map(),
    cancelled: false,
    request: delivery.text,
    asked: deliveryAskOf(delivery),
    calls: [],
    guardBusy: false,
    guardStop: false,
    ...(delivery.delegation ? { delegation: delivery.delegation } : {}),
    owner: { sessionId: session.meta.sessionId, botId: session.meta.botId },
    priority: delivery.voice
      ? "voice"
      : delivery.source === "delegate"
        ? "delegate"
        : delivery.source === "schedule"
          ? "schedule"
          : "chat",
  };
  runtime.turn = turn;
  setStatus(session.meta.sessionId, session.meta.botId, "working");
  const from = delivery.source === "delegate" ? delivery.from : undefined;
  let result: DelegationResult = { outcome: "failed", reply: "", error: "O turno não terminou." };
  const isSchedule = delivery.source === "schedule";
  const now = () => new Date().toISOString();
  let stopLive: () => void = () => undefined;

  if (showDelivery)
    session.log.emit({
      type: "delivery.admitted",
      data: {
        deliveryId: delivery.deliveryId,
        principal: { id: "anonymous", type: "anonymous" },
        source: isSchedule
          ? { channel: "channel:schedule", scheduleId: delivery.scheduleId }
          : from
            ? { channel: "channel:delegate", botId: from.botId, sessionId: from.sessionId, callId: from.callId }
            : { channel: "channel:eve" },
      },
    });
  log.emit({
    type: "turn.started",
    data: {
      cause: { deliveryId: delivery.deliveryId },
      follows: null,
      turnId,
      ...(from ? { delegatedBy: from.botId } : {}),
    },
    scope: turnScope,
  });
  delivery.delegation?.onStart(turnId);
  if (showDelivery)
    session.log.emit({
      type: "delivery.consumed",
      data: {
        deliveryId: delivery.deliveryId,
        parts: [{ kind: "text", text: delivery.text }],
        turnId,
        source: delivery.source,
        ...(from
          ? { from: { botId: from.botId, name: from.name, sessionId: from.sessionId, callId: from.callId } }
          : {}),
        ...(delivery.scheduleId ? { scheduleId: delivery.scheduleId } : {}),
        ...(delivery.voice ? { voice: true } : {}),
        ...(delivery.skills?.length
          ? { skills: delivery.skills.map((skill) => ({ slug: skill.slug, name: skill.name })) }
          : {}),
        ...(delivery.attachments?.length
          ? { attachments: delivery.attachments.map((item) => publicUpload(session.meta.botId, item)) }
          : {}),
      },
      scope: turnScope,
    });
  const shownText = delivery.text.trim() || attachmentsTitle(delivery.attachments ?? []);
  if (!meta.title) meta.title = titleFrom(shownText);
  if (from && (meta.kind === "thread" || meta.kind === "conversation")) {
    await recordThreadMessage(
      meta.botId,
      meta.sessionId,
      { role: "bot", text: titleFrom(`${from.name} pediu: ${shownText}`), at: now(), botId: from.botId },
      true,
    );
  } else if (
    !isSchedule &&
    (meta.kind === "thread" || meta.kind === "group" || meta.kind === "conversation") &&
    showDelivery
  ) {
    await recordThreadMessage(meta.botId, meta.sessionId, { role: "user", text: titleFrom(shownText), at: now() });
  }

  const settle = (outcome: string, extra: Record<string, unknown> = {}) => {
    const error = (extra.error as { message?: string } | undefined)?.message;
    result = {
      outcome: outcome === "completed" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed",
      reply: result.reply,
      ...(error ? { error } : {}),
    };
    log.emit({ type: "turn.settled", data: { outcome, turnId, ...extra }, scope: turnScope });
    log.emit({ type: "delivery.settled", data: { deliveryId: turn.deliveryId, outcome: "handled", turnId } });
  };

  try {
    if (!bot) {
      settle("failed", { error: { code: "BOT_NOT_FOUND", message: "Esse bot não existe mais." } });
      return;
    }
    const engine = engineOf(bot);
    const found = await findAccount(engine.account);
    if (found?.status !== "ready") {
      settle("failed", {
        error: { code: "ACCOUNT_UNAVAILABLE", id: randomUUID(), message: unavailableMessage(engine.account, found) },
      });
      return;
    }
    let account: Account = found;
    let model = engine.model;
    let effort = engine.effort;
    let limitFailure = null as { state: LimitState; from: Account } | null;
    const backupFor = async (from: string) => {
      const target = engine.fallback;
      if (!target || target.account === from) return null;
      const backup = await findAccount(target.account);
      return backup && backup.status === "ready" && !limitOf(backup.id)
        ? { account: backup, model: target.model }
        : null;
    };
    const nameOf = (item: Account, other: Account) =>
      item.provider === other.provider
        ? `${providerName(item.provider)} (${item.runner === "mac" ? "Mac" : "VPS"})`
        : providerName(item.provider);
    const failOver = (from: Account, to: Account, state: LimitState) => {
      const line = `Limite do ${nameOf(from, to)} acabou · continuei com ${nameOf(to, from)}`;
      if (meta.failover?.from !== from.id || meta.failover?.to !== to.id) {
        log.emit({
          type: "account.failover",
          data: {
            from: from.id,
            to: to.id,
            fromModel: from.id === engine.account ? engine.model : model,
            toModel: to.id === engine.fallback?.account ? engine.fallback.model : model,
            reason: `Limite do ${providerName(from.provider)}`,
            until: state.known ? state.until.toISOString() : null,
            line,
          },
          scope: turnScope,
        });
      }
      meta.failover = {
        from: from.id,
        to: to.id,
        since: meta.failover?.from === from.id ? meta.failover.since : now(),
        until: state.known ? state.until.toISOString() : null,
      };
    };
    const earlyLimit = limitOf(account.id);
    if (earlyLimit && !group) {
      const backup = await backupFor(account.id);
      if (backup) {
        failOver(account, backup.account, earlyLimit);
        account = backup.account;
        model = backup.model;
        effort = null;
      }
    }

    let codeWorkspace = null as WorkspaceState | null;
    let codeLive = null as CodeLive | null;
    if (!isSchedule) {
      const names = listBots(true).flatMap((item) => [item.id, item.name]);
      const mentioned = await mentionedRepo(delivery.text, names).catch(() => null);
      if (mentioned && activeWorkspace(session)?.repo !== mentioned.path) {
        await openTaskWorkspace(session, bot.id, mentioned.path, delivery.text).catch((error) =>
          log.emit({
            type: "code.workspace",
            data: {
              action: "failed",
              repo: mentioned.name,
              error: error instanceof Error ? error.message : String(error),
            },
            scope: turnScope,
          }),
        );
      }
    }
    const opened = activeWorkspace(session);
    if (opened) {
      await createCheckpoint(session, opened, turnId).catch((error) => console.warn("checkpoint failed", error));
      codeLive = new CodeLive(
        log,
        turnId,
        opened,
        await snapshotChanges(opened).catch(() => new Map<string, string | null>()),
      );
      void touchWorktree(opened.id);
      codeWorkspace = opened;
    }
    const keyFor = (workspace: WorkspaceState | null) =>
      workspace && codeModeSupported(account.provider, account.runner) ? `${account.id}@${workspace.id}` : account.id;
    let sessionKey = keyFor(codeWorkspace);
    let switching = false;

    let runId = "";
    let pendingTexts: { partId: string; value: string }[] = [];
    const partIds = new Map<string, string>();
    let partCounter = 0;
    const replyParts: string[] = [];
    const replyTexts: string[] = [];
    const usage = emptyUsage();
    let usageSeen = false;
    let contextTokens: number | null = null;
    let providerSession: string | null = null;
    let failure = null as string | null;
    let needsRun = true;

    const startRun = () => {
      runId = `run_${meta.runCount++}`;
      partCounter = 0;
      partIds.clear();
      needsRun = false;
      log.emit({
        type: "model.started",
        data: {
          attempt: 0,
          modelId: model,
          runId,
          account: { id: account.id, provider: account.provider, runner: account.runner, label: account.label },
        },
        scope: { runId, turnId },
      });
    };
    const partFor = (key: string) => {
      if (needsRun) startRun();
      let partId = partIds.get(key);
      if (!partId) {
        partId = `${runId}.${partCounter++}`;
        partIds.set(key, partId);
      }
      return partId;
    };
    const flush = (phase: "narration" | "reply") => {
      for (const part of pendingTexts) {
        if (!part.value.trim()) continue;
        log.emit({
          type: "content.completed",
          data: {
            kind: "text",
            partId: part.partId,
            phase,
            runId,
            value: part.value,
            ...(delivery.voice && phase === "reply" ? { voice: true } : {}),
          },
          scope: { runId, turnId },
        });
        if (phase === "reply") {
          replyParts.push(part.partId);
          replyTexts.push(part.value);
        }
      }
      pendingTexts = [];
    };

    const resume = isSchedule || group ? null : (meta.providerSessions?.[sessionKey] ?? null);
    const memorySettings = memoryOf(bot);
    let recalled: RecallItem[] = [];
    let extraSystem = "";
    if (!isSchedule && memorySettings.recall) {
      const [items, team] = await Promise.all([recall(bot, delivery.text || shownText), teamLogBlock(bot.id)]);
      recalled = items;
      extraSystem = [recallBlock(items), team].filter(Boolean).join("\n\n");
      if (items.length > 0)
        log.emit({
          type: "memory.recalled",
          data: { slugs: items.map((item) => item.slug), titles: items.map((item) => item.name) },
          scope: turnScope,
        });
    }
    if (!isSchedule && !group) {
      const canvasNote = await canvasEditNote(bot.id).catch(() => "");
      if (canvasNote) extraSystem = [extraSystem, canvasNote].filter(Boolean).join("\n\n");
      const blocksNote = await blocksEditNote(bot.id).catch(() => "");
      if (blocksNote) extraSystem = [extraSystem, blocksNote].filter(Boolean).join("\n\n");
    }
    if (delivery.voice) extraSystem = [extraSystem, voiceNote].filter(Boolean).join("\n\n");
    const liveBots = [bot, ...delegatesOf(bot)]
      .filter((item) => item.capabilities.browser || (item.id === bot.id && activeWorkspace(session)))
      .map((item) => item.id);
    stopLive = startLiveView(liveBots);
    if (bot.capabilities.computer) {
      const stopWatch = watchComputerEvents((event) => {
        if (event.botId && event.botId !== bot.id) return;
        if (turn.abort.signal.aborted) return;
        turn.cancelled = true;
        turn.cancelReason = event.type === "stop" ? "A pessoa apertou Parar." : "Você assumiu o computador.";
        turn.abort.abort();
      });
      const previous = stopLive;
      stopLive = () => {
        previous();
        stopWatch();
      };
    }
    startRun();
    let attachmentText = "";
    let attachmentImages: PreparedImage[] = [];
    if (delivery.attachments?.length && !group) {
      log.emit({ type: "attachments.preparing", data: { count: delivery.attachments.length }, scope: turnScope });
      const prepared = await prepareAttachments(
        bot.id,
        delivery.attachments,
        account.provider === "claude" && account.runner !== "mac",
      );
      attachmentText = prepared.text;
      attachmentImages = prepared.images;
    }
    const runProvider = (prompt: string, resumeFrom: string | null, images: PreparedImage[] = []) =>
      executeProvider({
        account,
        images,
        provider: account.provider,
        model,
        effort,
        bot,
        session,
        turn,
        prompt,
        extraSystem,
        log,
        group,
        resume: resumeFrom,
        codeRun: codeWorkspace && codeLive ? { workspace: codeWorkspace, live: codeLive } : null,
        onEndRun: () => {
          switching = true;
        },
        origin: null,
        ownerCallId: null,
        isSchedule,
        usage,
        request: delivery.text,
        runIdRef: () => runId,
        onCallStart: () => {
          flush("narration");
          if (needsRun) startRun();
        },
        onCallEnd: () => {
          needsRun = true;
        },
        onEvent: (event) => {
          if (event.type === "session") providerSession = event.id;
          else if ((event.type === "text" || event.type === "text.delta") && turn.steer?.length) return;
          else if (event.type === "text.delta") {
            log.progress({
              type: "content.delta",
              data: { delta: event.text, kind: "text", partId: partFor(event.part) },
              scope: { runId, turnId },
            });
          } else if (event.type === "text") {
            pendingTexts.push({ partId: partFor(event.part), value: event.text });
          } else if (event.type === "usage") {
            usageSeen = true;
            addUsage(usage, event.usage);
            if (event.contextTokens !== null) contextTokens = event.contextTokens;
          } else if (event.type === "tool") {
            const callId = `ext_${event.id}`;
            if (event.phase === "start") {
              flush("narration");
              if (needsRun) startRun();
              const input = event.input ?? {};
              const label =
                event.name === "Bash"
                  ? `Rodar ${String(input.command ?? "")
                      .replace(/\s+/g, " ")
                      .slice(0, 70)}`
                  : `Editar ${((input.files as string[] | undefined) ?? []).map((file) => file.split("/").pop()).join(", ")}`;
              log.emit({
                type: "call.requested",
                data: {
                  callId,
                  capability: { kind: "tool", name: event.name, label, surface: "code" },
                  input,
                  owner: { runId },
                },
                scope: { runId, turnId },
              });
              log.emit({ type: "call.started", data: { callId }, scope: { runId, turnId } });
            } else {
              log.emit({
                type: "call.settled",
                data: {
                  callId,
                  outcome: event.ok === false ? "failed" : "completed",
                  output: event.output ?? null,
                  ...(event.ok === false
                    ? { error: { code: "TOOL_EXECUTION_FAILED", message: "O comando falhou." } }
                    : {}),
                },
                scope: { runId, turnId },
              });
              turn.calls.push(`${event.name}(${JSON.stringify(event.input ?? {}).slice(0, 120)})`);
              needsRun = true;
              void codeLive?.scan(callId, "tool");
            }
          } else if (event.type === "warning") {
            console.warn(`provider warning ${account.id}: ${event.message}`);
          } else if (event.type === "done" && !event.ok) {
            if (!switching) failure = event.message ?? "Falha no provedor.";
          }
        },
      });
    const skillNames = (delivery.skills ?? []).map((skill) => skill.name);
    const withAttachments = (prompt: string) =>
      attachmentText ? `${prompt}${delivery.text.trim() ? "\n\n" : ""}${attachmentText}` : prompt;
    const carry =
      group || isSchedule
        ? ""
        : await handoffBlock(session, { key: sessionKey, currentTurnId: turnId, skills: skillNames });
    const previous = meta.lastEngine;
    if (
      carry &&
      previous &&
      meta.failover?.from !== account.id &&
      (previous.account !== account.id || previous.model !== model)
    ) {
      log.emit({
        type: "context.handoff",
        data: { from: previous.account, fromModel: previous.model, to: account.id, toModel: model },
        scope: turnScope,
      });
    }
    const basePrompt = group ? group.prompt : promptFor(session, delivery, carry, connectorsOf(bot).memory);
    await runProvider(withAttachments(basePrompt), resume, attachmentImages);
    const limitText =
      failure ??
      (replyTexts.length === 0 && turn.calls.length === 0
        ? pendingTexts
            .map((part) => part.value)
            .join(" ")
            .trim()
        : "");
    if (
      !group &&
      !turn.cancelled &&
      !turn.abort.signal.aborted &&
      limitText &&
      (failure ? isLimitError(failure) : isLimitReply(limitText))
    ) {
      const state = markLimited(account.id, limitText, account.runner === "mac" ? "America/Sao_Paulo" : undefined);
      const backup = await backupFor(account.id);
      if (backup) {
        const from = account;
        pendingTexts = [];
        failure = null;
        failOver(from, backup.account, state);
        account = backup.account;
        model = backup.model;
        effort = null;
        sessionKey = keyFor(codeWorkspace);
        providerSession = null;
        needsRun = true;
        const handoff = isSchedule
          ? ""
          : await handoffBlock(session, {
              key: sessionKey,
              currentTurnId: turnId,
              skills: skillNames,
              reason: `o limite do ${providerName(from.provider)} acabou no meio deste pedido; refaça o pedido em curso sem repetir o que já foi feito`,
            });
        const retryPrompt = promptFor(session, delivery, handoff, connectorsOf(bot).memory);
        await runProvider(
          withAttachments(retryPrompt),
          isSchedule ? null : (meta.providerSessions?.[sessionKey] ?? null),
          account.provider === "claude" && account.runner !== "mac" ? attachmentImages : [],
        );
      } else {
        pendingTexts = [];
        failure = limitText;
        limitFailure = { state, from: account };
      }
    }
    for (let switches = 0; switches < 2; switches++) {
      if (turn.cancelled || failure || turn.guardStop || turn.abort.signal.aborted) break;
      const next = activeWorkspace(session);
      if (!next || next.id === codeWorkspace?.id || !codeModeSupported(account.provider, account.runner)) break;
      flush("narration");
      switching = false;
      await createCheckpoint(session, next, turnId).catch((error) => console.warn("checkpoint failed", error));
      if (codeLive) await codeLive.scan(null, "sweep");
      codeLive = new CodeLive(
        log,
        turnId,
        next,
        await snapshotChanges(next).catch(() => new Map<string, string | null>()),
      );
      codeWorkspace = next;
      sessionKey = keyFor(next);
      providerSession = null;
      needsRun = true;
      const carry = await handoffBlock(session, {
        key: sessionKey,
        currentTurnId: turnId,
        skills: skillNames,
        full: true,
      });
      await runProvider(
        `${carry ? `${carry}\n\n---\n\n` : ""}O repositório ${next.repoName} está aberto na worktree ${next.path} (branch ${next.branch}), que é o seu diretório de trabalho. Continue agora o pedido da pessoa com as ferramentas de código:\n${delivery.text}`,
        null,
      );
    }
    for (let steers = 0; steers < 5 && turn.steer?.length; steers++) {
      if (turn.cancelled || failure || turn.guardStop || turn.abort.signal.aborted) break;
      const note = turn.steer
        .splice(0)
        .map((item) => item.text.trim())
        .join("\n\n");
      const prompt = `A pessoa respondeu por mensagem enquanto seu pedido de aprovação estava aberto. O pedido foi fechado e a ação não rodou. Siga a partir desta mensagem, numa resposta só:\n${note}`;
      pendingTexts = [];
      switching = false;
      needsRun = true;
      const from = group || isSchedule ? null : (providerSession ?? meta.providerSessions?.[sessionKey] ?? null);
      await runProvider(prompt, from);
      if (failure && from && !turn.cancelled) {
        failure = null;
        needsRun = true;
        const carry = await handoffBlock(session, {
          key: sessionKey,
          currentTurnId: turnId,
          skills: skillNames,
          full: true,
        });
        await runProvider(`${carry ? `${carry}\n\n---\n\n` : ""}${prompt}`, null);
      }
    }
    if (codeLive) await codeLive.scan(null, "sweep");

    flush("reply");
    if (usageSeen || usage.inputTokens + usage.outputTokens > 0) {
      log.emit({
        type: "usage.recorded",
        data: { kind: "model", owner: { runId }, usage, account: account.id },
        scope: { runId, turnId },
      });
    }
    if (!isSchedule && !group && providerSession) {
      meta.providerSessions = { ...meta.providerSessions, [sessionKey]: providerSession };
      meta.providerSynced = { ...meta.providerSynced, [sessionKey]: turnId };
    }
    if (turn.guardStop && !turn.cancelled) {
      const tried = turn.calls
        .slice(-6)
        .map((call) => `- ${clip(call, 200)}`)
        .join("\n");
      const value = `Parei aqui porque não estava avançando no seu pedido e não quis gastar sua assinatura à toa.\n\nO que tentei:\n${tried}\n\nMe diga como seguir ou reformule o pedido.`;
      const partId = `${runId}.guard`;
      log.emit({
        type: "content.completed",
        data: { kind: "text", partId, phase: "reply", runId, value },
        scope: { runId, turnId },
      });
      replyParts.push(partId);
      replyTexts.push(value);
      failure = null;
    }
    const replyText = replyTexts.join("\n").trim();
    if (turn.cancelled) {
      settle("cancelled", turn.cancelReason ? { reason: turn.cancelReason } : {});
    } else if (limitFailure) {
      const { state, from } = limitFailure;
      const suggestion = engine.fallback ?? suggestedFallback(from.id);
      const target = suggestion.account !== from.id ? await findAccount(suggestion.account) : undefined;
      const usable = target && target.status === "ready" && !limitOf(target.id) ? target : null;
      const message = `O limite do ${providerName(from.provider)} acabou${state.known ? `, volta ${formatReset(state.until)}` : ""}.${usable ? ` Quer que eu continue com o ${nameOf(usable, from)}?` : ""}`;
      settle("failed", {
        error: {
          code: "ACCOUNT_LIMIT",
          id: randomUUID(),
          message,
          detail: state.message.slice(0, 500),
          until: state.known ? state.until.toISOString() : null,
          ...(usable ? { suggest: { account: usable.id, model: suggestion.model, label: nameOf(usable, from) } } : {}),
        },
      });
    } else if (failure) {
      if (!isSchedule && resume && !replyText) {
        meta.providerSessions = { ...meta.providerSessions };
        delete meta.providerSessions[sessionKey];
      }
      settle("failed", {
        error: { code: "MODEL_CALL_FAILED", id: randomUUID(), message: String(failure).slice(0, 2000) },
      });
    } else {
      if (!isSchedule && !group && memorySettings.capture && replyText) {
        void queueCapture({
          bot,
          account,
          model,
          userText: delivery.text,
          replyText,
          recalled,
          log,
          turnId,
          sessionId: session.meta.sessionId,
        }).catch((error) => console.warn("memory capture failed", error instanceof Error ? error.message : error));
      }
      let quiet = false;
      if (isSchedule && replyText) {
        const schedule = bot.schedules.find((item) => item.name === delivery.scheduleId);
        const triage = await decideTriage(
          bot.role,
          delivery.scheduleId ?? "rotina",
          schedule?.prompt ?? delivery.text,
          replyText,
        );
        emitDecision(log, turn, triage);
        quiet = triage.outcome === "quiet";
      }
      result.reply = replyText;
      settle("completed", {
        reply: replyParts,
        ...(quiet ? { quiet: true } : {}),
        ...(turn.guardStop ? { stoppedBy: "progress_guard" } : {}),
      });
      if ((meta.kind === "thread" || meta.kind === "group" || meta.kind === "conversation") && replyText) {
        await recordThreadMessage(
          meta.botId,
          meta.sessionId,
          {
            role: "bot",
            text: titleFrom(group ? `${bot.name}: ${replyText}` : replyText),
            at: now(),
            ...(group ? { botId: bot.id } : {}),
          },
          quiet,
        );
      }
      if (isSchedule && replyText) {
        const name = delivery.scheduleId ?? "rotina";
        meta.scheduleSummaries = { ...meta.scheduleSummaries, [name]: clip(replyText, summaryChars) };
        meta.pendingNotes = [...(meta.pendingNotes ?? []), `- ${name} (${now()}): ${clip(replyText, 300)}`].slice(-5);
      }
      if (!isSchedule && !group) {
        meta.pendingNotes = [];
        meta.carryOver = null;
        meta.contextTokens = contextTokens ?? undefined;
        const overflow = contextTokens !== null && contextTokens > contextLimit;
        if (overflow) {
          meta.providerSessions = { ...meta.providerSessions };
          delete meta.providerSessions[sessionKey];
        }
        if (meta.failover && meta.failover.from === account.id) {
          log.emit({
            type: "account.restored",
            data: {
              account: account.id,
              from: meta.failover.to,
              fromModel: meta.lastEngine?.account === meta.failover.to ? meta.lastEngine.model : null,
              toModel: model,
              reason: "Limite liberado",
              line: `Voltei para o ${providerName(account.provider)}`,
            },
            scope: turnScope,
          });
          delete meta.failover;
        }
        meta.lastEngine = { account: account.id, model };
        void refreshSummary(session, account, model, bot.name, overflow).catch((error) =>
          console.warn("summary failed", error instanceof Error ? error.message : error),
        );
      }
    }
  } catch (error) {
    for (const pending of turn.interactions.values()) pending.resolve("deny");
    if (turn.cancelled) settle("cancelled");
    else
      settle("failed", {
        error: {
          code: "MODEL_CALL_FAILED",
          id: randomUUID(),
          message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        },
      });
  } finally {
    turn.slot?.release();
    stopLive();
    runtime.turn = null;
    delivery.delegation?.finish(result);
    await session.save();
  }
}
