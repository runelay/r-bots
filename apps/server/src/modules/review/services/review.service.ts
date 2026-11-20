import { randomUUID } from "node:crypto";
import { readSetting, writeSetting } from "../../../db/settings";
import { offsetOf, userTimezone, zonedDay } from "../../../shared/clock";
import { ValidationError } from "../../../shared/errors";
import { type BotDefinition, getBot, listBots, sidebarOf } from "../../bots/services/bots.service";
import { createConversation, publicConversation } from "../../conversations/services/conversations.service";
import { deliver } from "../../engine/services/engine.service";
import { graphql } from "../../github/services/gh-client.service";
import { LinearError, linearTool, listProjects, listViews } from "../../linear/services/linear.service";

export const reviewScopes = ["today", "week", "custom"] as const;
export type ReviewScope = (typeof reviewScopes)[number];

export interface ReviewPreset {
  id: string;
  name: string;
  prompt: string;
  scope: ReviewScope;
  days: number;
  linear: boolean;
  github: boolean;
  botId: string | null;
}

export interface RunInput {
  presetId: string;
  botId: string | null;
  view: string | null;
  project: string | null;
}

const presetsKey = "review.presets";
const maxPresets = 20;
const maxContext = 14_000;

export function builtInPresets(): ReviewPreset[] {
  return [
    {
      id: "daily",
      name: "Daily de hoje",
      prompt:
        "Faça um resumo simples do dia para a daily, juntando o que foi feito e o que está em andamento. Três blocos curtos: feito, em andamento e bloqueios. Uma linha por item, com o id da issue ou o número do PR.",
      scope: "today",
      days: 1,
      linear: true,
      github: true,
      botId: null,
    },
    {
      id: "week",
      name: "Resumo da semana",
      prompt:
        "Faça um resumo simples da semana: o que foi entregue, o que está em andamento e o que travou. Agrupe por projeto quando ajudar e termine com os próximos passos.",
      scope: "week",
      days: 7,
      linear: true,
      github: true,
      botId: null,
    },
    {
      id: "pulls",
      name: "PRs para revisar",
      prompt:
        "Liste os PRs que esperam a minha revisão, do mais urgente ao menos urgente, com uma linha sobre o que cada um muda e o link. Depois diga quais PRs meus estão parados.",
      scope: "week",
      days: 7,
      linear: false,
      github: true,
      botId: null,
    },
  ];
}

export async function readPresets(): Promise<ReviewPreset[]> {
  const stored = await readSetting<ReviewPreset[] | null>(presetsKey, null).catch(() => null);
  return Array.isArray(stored) ? stored : builtInPresets();
}

function text(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`Preencha ${field}.`, field);
  if (value.trim().length > max) throw new ValidationError(`${field} pode ter até ${max} caracteres.`, field);
  return value.trim();
}

export function presetOf(value: unknown, index: number): ReviewPreset {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Preset inválido.", `presets.${index}`);
  const raw = value as Record<string, unknown>;
  const scope = raw.scope;
  if (!(reviewScopes as readonly unknown[]).includes(scope))
    throw new ValidationError("Use today, week ou custom.", `presets.${index}.scope`);
  const days = typeof raw.days === "number" && Number.isInteger(raw.days) ? raw.days : scope === "week" ? 7 : 1;
  if (days < 1 || days > 90) throw new ValidationError("O período vai de 1 a 90 dias.", `presets.${index}.days`);
  const botId = raw.botId === null || raw.botId === undefined || raw.botId === "" ? null : raw.botId;
  if (botId !== null && (typeof botId !== "string" || botId.length > 80))
    throw new ValidationError("Bot inválido.", `presets.${index}.botId`);
  const id = typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : randomUUID().slice(0, 8);
  const linear = raw.linear !== false;
  const github = raw.github !== false;
  if (!linear && !github) throw new ValidationError("Escolha o Linear, o GitHub ou os dois.", `presets.${index}`);
  return {
    id,
    name: text(raw.name, "o nome", 60),
    prompt: text(raw.prompt, "o pedido", 4000),
    scope: scope as ReviewScope,
    days,
    linear,
    github,
    botId: botId as string | null,
  };
}

export async function savePresets(body: unknown) {
  const raw =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).presets : null;
  if (!Array.isArray(raw)) throw new ValidationError("Mande a lista em presets.", "presets");
  if (raw.length > maxPresets) throw new ValidationError(`Até ${maxPresets} presets.`, "presets");
  const presets = raw.map(presetOf);
  const ids = new Set<string>();
  for (const preset of presets) {
    while (ids.has(preset.id)) preset.id = randomUUID().slice(0, 8);
    ids.add(preset.id);
  }
  await writeSetting(presetsKey, presets);
  return presets;
}

function usable(bot: BotDefinition | undefined): bot is BotDefinition {
  return !!bot && !bot.archivedAt && !bot.deletedAt;
}

export function defaultBot(): BotDefinition | null {
  const bots = listBots(false, { hidden: true }).filter(usable);
  return (
    bots.find((bot) => /\bboss\b/i.test(bot.name) || bot.id === "boss") ??
    bots.find((bot) => sidebarOf(bot).pinned) ??
    bots[0] ??
    null
  );
}

export interface ReviewWindow {
  since: string;
  day: string;
  label: string;
}

export async function windowOf(preset: Pick<ReviewPreset, "scope" | "days">, now = new Date()): Promise<ReviewWindow> {
  const zone = await userTimezone();
  const days = preset.scope === "today" ? 1 : preset.scope === "week" ? 7 : preset.days;
  const start = new Date(now.getTime() - (days - 1) * 86_400_000);
  const day = zonedDay(start, zone);
  const label = preset.scope === "today" ? "hoje" : days === 7 ? "últimos 7 dias" : `últimos ${days} dias`;
  return { since: `${day}T00:00:00${offsetOf(start, zone)}`, day, label };
}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function nameOf(value: unknown) {
  return typeof value === "string" ? value || null : str(record(value).name);
}

const issueFields = ["id", "title", "status", "statusType", "url", "project", "completedAt", "startedAt", "assignee"];

async function scopeArgs(view: string | null, project: string | null) {
  const args: Json = {};
  let label = "minhas issues";
  if (!view || view === "mine") args.assignee = "me";
  else {
    const separator = view.indexOf(":");
    const kind = view.slice(0, separator);
    const id = view.slice(separator + 1);
    if (!/^[\w-]+$/.test(id)) throw new ValidationError("Visão inválida.", "view");
    if (kind === "team") args.team = id;
    else if (kind === "view") args.customView = id;
    else if (kind === "project") args.project = id;
    else throw new ValidationError("Visão inválida.", "view");
    label = (await listViews().catch(() => [])).find((item) => item.id === view)?.name ?? label;
  }
  if (project && !args.project) {
    if (!/^[\w-]+$/.test(project)) throw new ValidationError("Projeto inválido.", "project");
    args.project = project;
    const name = (await listProjects().catch(() => [])).find((item) => item.id === project)?.name;
    if (name) label = `${label} · ${name}`;
  }
  return { args, label };
}

function issueLine(raw: Json) {
  const project = nameOf(raw.project);
  const assignee = nameOf(raw.assignee);
  return `- ${str(raw.id) ?? "?"} ${str(raw.title) ?? ""} · ${str(raw.status) ?? ""}${project ? ` · ${project}` : ""}${assignee ? ` · ${assignee}` : ""}`;
}

export async function linearContext(window: ReviewWindow, view: string | null, project: string | null) {
  const { args, label } = await scopeArgs(view, project);
  const [updated, started] = await Promise.all([
    linearTool("list_issues", { ...args, updatedAt: window.since, limit: 100, fields: issueFields }).then(record),
    linearTool("list_issues", { ...args, state: "started", limit: 50, fields: issueFields }).then(record),
  ]);
  const since = Date.parse(window.since);
  const recent = (Array.isArray(updated.issues) ? updated.issues : []).map(record);
  const active = (Array.isArray(started.issues) ? started.issues : []).map(record);
  const done = recent.filter((issue) => Date.parse(str(issue.completedAt) ?? "") >= since);
  const begun = recent.filter(
    (issue) => str(issue.statusType) === "started" && Date.parse(str(issue.startedAt) ?? "") >= since,
  );
  const seen = new Set([...done, ...begun].map((issue) => str(issue.id)));
  const ongoing = active.filter((issue) => !seen.has(str(issue.id)));
  for (const issue of ongoing) seen.add(str(issue.id));
  const touched = recent.filter((issue) => !seen.has(str(issue.id)));
  const section = (title: string, items: Json[]) =>
    items.length ? [`### ${title} (${items.length})`, ...items.slice(0, 40).map(issueLine)].join("\n") : "";
  return [
    `## Linear (${label})`,
    section("Concluídas no período", done),
    section("Começadas no período", begun),
    section("Em andamento agora", ongoing),
    section("Mexidas no período", touched),
    done.length + begun.length + ongoing.length + touched.length === 0 ? "Nada no período." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface RawPull {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  state?: string;
  mergedAt?: string | null;
  repository?: { nameWithOwner?: string };
}

interface RawSearch {
  issueCount?: number;
  nodes?: Array<RawPull | null>;
}

function pullLine(pull: RawPull) {
  const state =
    pull.state === "MERGED" ? "mergeado" : pull.state === "CLOSED" ? "fechado" : pull.isDraft ? "rascunho" : "aberto";
  return `- ${pull.repository?.nameWithOwner ?? "?"}#${pull.number ?? "?"} ${pull.title ?? ""} (${state}) ${pull.url ?? ""}`;
}

export async function githubContext(window: ReviewWindow) {
  const day = window.day;
  const searches = {
    opened: `is:pr author:@me created:>=${day} sort:updated-desc`,
    merged: `is:pr author:@me is:merged merged:>=${day} sort:updated-desc`,
    reviewed: `is:pr reviewed-by:@me -author:@me updated:>=${day} sort:updated-desc`,
    waiting: "is:pr is:open review-requested:@me archived:false sort:updated-desc",
    open: "is:pr is:open author:@me archived:false sort:updated-desc",
  };
  const fields = "number title url isDraft state mergedAt repository { nameWithOwner }";
  const keys = Object.keys(searches) as Array<keyof typeof searches>;
  const query = `query(${keys.map((key) => `$${key}: String!`).join(", ")}) { ${keys
    .map(
      (key) =>
        `${key}: search(type: ISSUE, query: $${key}, first: 30) { issueCount nodes { ... on PullRequest { ${fields} } } }`,
    )
    .join("\n")} }`;
  const data = await graphql<Record<keyof typeof searches, RawSearch | undefined>>(query, searches);
  const titles: Record<keyof typeof searches, string> = {
    opened: "PRs que abri no período",
    merged: "PRs meus mergeados no período",
    reviewed: "PRs que revisei no período",
    waiting: "PRs esperando a minha revisão",
    open: "PRs meus abertos agora",
  };
  const parts = keys
    .map((key) => {
      const nodes = (data[key]?.nodes ?? []).filter((node): node is RawPull => !!node?.number);
      if (!nodes.length) return "";
      return [`### ${titles[key]} (${data[key]?.issueCount ?? nodes.length})`, ...nodes.map(pullLine)].join("\n");
    })
    .filter(Boolean);
  return ["## GitHub", ...(parts.length ? parts : ["Nada no período."])].join("\n\n");
}

export function composeMessage(preset: ReviewPreset, window: ReviewWindow, sections: string[]) {
  const context = sections.join("\n\n");
  const trimmed = context.length > maxContext ? `${context.slice(0, maxContext)}\n…(cortado)` : context;
  return [
    preset.prompt,
    `Período: ${window.label} (desde ${window.day}).`,
    "Contexto juntado pelo app (títulos, ids, estados e links; sem o corpo das issues):",
    trimmed,
    "Use só o que está acima. Se precisar de detalhe, consulte o Linear ou o GitHub.",
  ].join("\n\n");
}

export async function runPreset(input: RunInput) {
  const presets = await readPresets();
  const preset = presets.find((item) => item.id === input.presetId);
  if (!preset) throw new ValidationError("Preset não encontrado.", "presetId");
  const chosen = input.botId ?? preset.botId;
  const bot = chosen ? getBot(chosen) : null;
  const target = usable(bot ?? undefined) ? (bot as BotDefinition) : defaultBot();
  if (!target) throw new ValidationError("Crie um bot para rodar o review.", "botId");
  const window = await windowOf(preset);
  const failures: string[] = [];
  const sections = await Promise.all([
    preset.linear
      ? linearContext(window, input.view, input.project).catch((error) => {
          failures.push(error instanceof LinearError ? error.message : "o Linear não respondeu");
          return "## Linear\n\nNão deu para ler o Linear agora.";
        })
      : Promise.resolve(""),
    preset.github
      ? githubContext(window).catch(() => {
          failures.push("o GitHub não respondeu");
          return "## GitHub\n\nNão deu para ler o GitHub agora.";
        })
      : Promise.resolve(""),
  ]);
  const message = composeMessage(
    preset,
    window,
    sections.filter((section) => section),
  );
  const title = `${preset.name} · ${window.day.slice(8, 10)}/${window.day.slice(5, 7)}`;
  const session = await createConversation(target.id, { title, firstMessage: message });
  const deliveryId = randomUUID();
  await deliver(session, { deliveryId, text: message, source: "chat" });
  return {
    botId: target.id,
    sessionId: session.meta.sessionId,
    title,
    warnings: failures,
    conversation: await publicConversation(session),
    sessionBasePath: `/bots/${target.id}/eve/v1`,
    deliveryId,
  };
}
