import { ValidationError } from "../../../shared/errors";
import { listConnections, runelayCall, runelayEnabled } from "../../connectors/services/runelay.service";
import { linkForIssue, type PullLink, pullsByLinearKey } from "../../github/services/github.service";
import { linearText } from "../constants/linear-messages.constants";

export class LinearError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ViewKind = "mine" | "team" | "view" | "project";

export interface TeamRef {
  id: string;
  key: string;
  name: string;
}

export interface LinearView {
  id: string;
  name: string;
  kind: ViewKind;
  description: string | null;
  team: TeamRef | null;
  url: string | null;
  icon: string | null;
  color: string | null;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface LinearProject {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  url: string | null;
  summary: string | null;
  state: string | null;
  stateType: string | null;
}

export interface LinearUser {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface LinearState {
  id: string;
  name: string;
  type: string;
}

export interface BoardColumn {
  key: string;
  name: string;
  type: string;
  count: number;
}

export interface LinearCard {
  id: string;
  uuid: string;
  title: string;
  priority: number;
  priorityName: string;
  estimate: number | null;
  url: string;
  branch: string | null;
  updatedAt: string;
  state: string;
  stateType: string;
  column: string;
  labels: string[];
  assignee: string | null;
  teamId: string | null;
  team: string | null;
  parentId: string | null;
  project: string | null;
  pr: PullLink | null;
}

export interface Board {
  view: LinearView;
  label: string | null;
  project: string | null;
  columns: BoardColumn[];
  issues: LinearCard[];
  nextCursor: string | null;
  searchable: boolean;
  fetchedAt: string;
}

export interface LinearComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  quotedText: string | null;
}

export interface LinearAttachment {
  title: string;
  subtitle: string | null;
  url: string;
}

export interface IssueDetail extends LinearCard {
  description: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  dueDate: string | null;
  createdBy: string | null;
  comments: LinearComment[];
  children: LinearCard[];
  attachments: LinearAttachment[];
  states: LinearState[];
}

type Json = Record<string, unknown>;

const cardFields = [
  "id",
  "uuid",
  "title",
  "priority",
  "estimate",
  "url",
  "gitBranchName",
  "updatedAt",
  "status",
  "statusType",
  "labels",
  "assignee",
  "teamId",
  "team",
  "parentId",
  "project",
];
const pageSize = 100;
const boardTtlMs = 20_000;
const statesTtlMs = 10 * 60_000;
const viewsTtlMs = 5 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
let sourceName: string | null = null;

export function clearLinearCache() {
  cache.clear();
  sourceName = null;
}

function cached<T>(key: string, ttlMs: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  return load().then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

const notConnected = "Conecte o Linear em Conectores para ver suas issues aqui.";

async function source() {
  if (sourceName) return sourceName;
  if (!runelayEnabled()) throw new LinearError(503, notConnected);
  const connections = await listConnections().catch(() => []);
  const linear = connections.find((item) => /linear/i.test(item.name));
  if (!linear) throw new LinearError(503, notConnected);
  if (linear.status !== "ok")
    throw new LinearError(503, "O Linear pediu para entrar de novo. Reconecte em Conectores.");
  sourceName = linear.name;
  return sourceName;
}

async function call(tool: string, args: Json): Promise<unknown> {
  const name = `${await source()}.${tool}`;
  try {
    return await runelayCall("call_tool", { name, args });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|não encontr|entity/i.test(message)) throw new LinearError(404, linearText("notFound"));
    throw new LinearError(502, linearText("noAnswer", { reason: message }).slice(0, 300));
  }
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nameOf(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  return str(record(value).name);
}

function teamOf(value: unknown): TeamRef | null {
  const raw = record(value);
  const id = str(raw.id);
  if (!id) return null;
  return { id, key: str(raw.key) ?? "", name: str(raw.name) ?? str(raw.displayName) ?? "" };
}

export function linearTool(tool: string, args: Json) {
  return call(tool, args);
}

export function teamIcon(value: unknown) {
  return str(record(value).icon);
}

async function pages(tool: string, args: Json, key: string, max = 5, limit = 100) {
  const items: Json[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < max; page++) {
    const reply = record(await call(tool, { ...args, limit, ...(cursor ? { cursor } : {}) }));
    items.push(...list(reply[key]));
    cursor = reply.hasNextPage === true ? str(reply.cursor) : null;
    if (!cursor) break;
  }
  return items;
}

export function projectOf(raw: Json): LinearProject | null {
  const id = str(raw.uuid) ?? str(raw.id);
  if (!id) return null;
  const status = record(raw.status);
  return {
    id,
    name: str(raw.name) ?? "Projeto",
    icon: str(raw.icon),
    color: str(raw.color),
    url: str(raw.url),
    summary: str(raw.summary),
    state: str(status.name),
    stateType: str(status.type),
  };
}

export function listProjects(refresh = false): Promise<LinearProject[]> {
  return cached("projects", viewsTtlMs, refresh, async () => {
    const raw = await pages("list_projects", {}, "projects", 6, 50);
    return raw
      .map(projectOf)
      .filter((project): project is LinearProject => project !== null)
      .filter((project) => !["completed", "canceled"].includes(project.stateType ?? ""));
  });
}

export function listLabels(refresh = false): Promise<LinearLabel[]> {
  return cached("labels", viewsTtlMs, refresh, async () => {
    const raw = await pages("list_issue_labels", {}, "labels", 6, 250);
    const seen = new Set<string>();
    const labels: LinearLabel[] = [];
    for (const item of raw) {
      const id = str(item.id);
      const name = str(item.name);
      if (!id || !name || item.retiredAt || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      labels.push({ id, name, color: str(item.color) });
    }
    return labels.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  });
}

export function listUsers(refresh = false): Promise<LinearUser[]> {
  return cached("users", statesTtlMs, refresh, async () => {
    const raw = await pages("list_users", {}, "users", 6, 250);
    return raw
      .filter((item) => str(item.id) && item.isActive !== false)
      .map((item) => ({
        id: str(item.id) ?? "",
        name: str(item.name) ?? str(item.displayName) ?? "",
        displayName: str(item.displayName),
        email: str(item.email),
        avatarUrl: str(item.avatarUrl),
      }));
  });
}

export function listViews(refresh = false): Promise<LinearView[]> {
  return cached("views", viewsTtlMs, refresh, async () => {
    const [teams, views, projects] = await Promise.all([
      pages("list_teams", {}, "teams"),
      pages("list_custom_views", { type: "Issue" }, "customViews"),
      listProjects(refresh).catch(() => [] as LinearProject[]),
    ]);
    return [
      {
        id: "mine",
        name: linearText("myIssues"),
        kind: "mine" as const,
        description: null,
        team: null,
        url: null,
        icon: null,
        color: null,
      },
      ...teams
        .map((raw) => ({ team: teamOf(raw), icon: teamIcon(raw), color: str(raw.color) }))
        .filter((item): item is { team: TeamRef; icon: string | null; color: string | null } => item.team !== null)
        .map(({ team, icon, color }) => ({
          id: `team:${team.id}`,
          name: team.name,
          kind: "team" as const,
          description: null,
          team,
          url: null,
          icon,
          color,
        })),
      ...views
        .filter((view) => str(view.id))
        .map((view) => ({
          id: `view:${str(view.id)}`,
          name: str(view.name) ?? linearText("view"),
          kind: "view" as const,
          description: str(view.description),
          team: teamOf(view.team),
          url: str(view.url),
          icon: str(view.icon),
          color: str(view.color),
        })),
      ...projects.map((project) => ({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project" as const,
        description: project.summary,
        team: null,
        url: project.url,
        icon: project.icon,
        color: project.color,
      })),
    ];
  });
}

const typeRank: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

export function stageWeight(name: string) {
  const lowered = name.toLowerCase();
  if (/progress|andamento|doing|fazendo/.test(lowered)) return 0;
  if (/corre[cç][aã]o|fix/.test(lowered)) return 2;
  if (/review|revis/.test(lowered)) return 1;
  if (/test|qa/.test(lowered)) return 3;
  if (/deploy|release/.test(lowered)) return 4;
  if (/aguard|wait|block|bloq|pausa/.test(lowered)) return 5;
  return 2.5;
}

export function columnKey(type: string, name: string) {
  return `${type}:${name}`;
}

export function sortStates<T extends { name: string; type: string }>(states: T[]) {
  return [...states].sort(
    (a, b) =>
      (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9) ||
      (a.type === "started" ? stageWeight(a.name) - stageWeight(b.name) : 0),
  );
}

export function teamStates(teamId: string, refresh = false): Promise<LinearState[]> {
  return cached(`states:${teamId}`, statesTtlMs, refresh, async () => {
    const raw = await call("list_issue_statuses", { team: teamId });
    const items = Array.isArray(raw) ? list(raw) : list(record(raw).statuses);
    return sortStates(
      items
        .map((item) => ({ id: str(item.id) ?? "", name: str(item.name) ?? "", type: str(item.type) ?? "backlog" }))
        .filter((item) => item.id && item.name),
    );
  });
}

function customBlock(tag: string, inner: string) {
  let attrs: Json = {};
  try {
    attrs = record(record(JSON.parse(inner)).attrs);
  } catch {
    const plain = inner.replace(/<[^>]+>/g, "").trim();
    return plain && !plain.startsWith("{") ? plain : "";
  }
  const src = str(attrs.src);
  const title = (str(attrs.title) ?? str(attrs.alt) ?? str(attrs.label) ?? "").replace(/[[\]]/g, "");
  if (
    src &&
    (tag === "image" || /\.(png|jpe?g|gif|webp|heic)(\?|$)/i.test(src) || /image/i.test(str(attrs.type) ?? ""))
  )
    return `\n\n![${title || "imagem"}](${src})\n\n`;
  const href = src ?? str(attrs.href) ?? str(attrs.url);
  if (href) return `[${title || tag}](${href})`;
  return title;
}

export function cleanDescription(text: string) {
  return text
    .replace(/<linear-([\w-]+)>([\s\S]*?)<\/linear-\1>/gi, (_match, tag: string, inner: string) =>
      customBlock(tag.toLowerCase(), inner.trim()),
    )
    .replace(/<[a-z][\w-]*\s[^>]*?label="([^"]*)"[^>]*?href="([^"]*)"[^>]*?\/>/gi, "[$1]($2)")
    .replace(/<[a-z][\w-]*\s[^>]*?href="([^"]*)"[^>]*?label="([^"]*)"[^>]*?\/>/gi, "[$2]($1)")
    .replace(/<[a-z][\w-]*-[\w-]*\s[^>]*\/>/gi, "")
    .trim();
}

export function cardOf(raw: Json, links: Map<string, PullLink>): LinearCard {
  const id = str(raw.id) ?? "";
  const state = str(raw.status) ?? "";
  const stateType = str(raw.statusType) ?? "backlog";
  const priority = record(raw.priority);
  return {
    id,
    uuid: str(raw.uuid) ?? id,
    title: str(raw.title) ?? "",
    priority: num(priority.value) ?? num(raw.priority) ?? 0,
    priorityName: str(priority.name) ?? "Sem prioridade",
    estimate: num(raw.estimate),
    url: str(raw.url) ?? "",
    branch: str(raw.gitBranchName),
    updatedAt: str(raw.updatedAt) ?? "",
    state,
    stateType,
    column: columnKey(stateType, state),
    labels: Array.isArray(raw.labels) ? raw.labels.map(nameOf).filter((label): label is string => label !== null) : [],
    assignee: nameOf(raw.assignee),
    teamId: str(raw.teamId),
    team: nameOf(raw.team),
    parentId: str(raw.parentId),
    project: nameOf(raw.project),
    pr: links.get(id.toUpperCase()) ?? null,
  };
}

async function linkMap() {
  return pullsByLinearKey().catch(() => new Map<string, PullLink>());
}

export interface BoardInput {
  view: string;
  cursor: string | null;
  query: string;
  refresh: boolean;
  label?: string | null;
  project?: string | null;
}

const filterPattern = /^[\p{L}\p{N}_ .:/&()+#-]{1,80}$/u;

export function parseFilterValue(value: string | null | undefined, field: string) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (!filterPattern.test(trimmed)) throw new ValidationError(linearText("filterInvalid"), field);
  return trimmed;
}

async function resolveView(id: string): Promise<LinearView> {
  if (id === "mine") return (await listViews())[0];
  const found = (await listViews()).find((view) => view.id === id);
  if (found) return found;
  if (/^(team|view|project):[\w-]+$/.test(id)) {
    const [kind] = id.split(":");
    return {
      id,
      name: linearText(kind === "team" ? "team" : kind === "project" ? "project" : "view"),
      kind: kind as ViewKind,
      description: null,
      team: null,
      url: null,
      icon: null,
      color: null,
    };
  }
  throw new ValidationError(linearText("viewInvalid"), "view");
}

export function board(input: BoardInput): Promise<Board> {
  const label = input.label ?? null;
  const project = input.project ?? null;
  const key = `board:${input.view}:${input.query}:${label ?? ""}:${project ?? ""}:${input.cursor ?? ""}`;
  return cached(key, boardTtlMs, input.refresh, async () => {
    const view = await resolveView(input.view);
    const raw = view.id.slice(view.id.indexOf(":") + 1);
    const searchable = view.kind !== "view";
    if (input.query && !searchable) throw new ValidationError(linearText("searchInView"), "q");
    const args: Json = { limit: pageSize, fields: cardFields, orderBy: "updatedAt" };
    if (view.kind === "mine") args.assignee = "me";
    if (view.kind === "team") args.team = raw;
    if (view.kind === "view") args.customView = raw;
    if (view.kind === "project") args.project = raw;
    else if (project) args.project = project;
    if (label) args.label = label;
    if (input.query) args.query = input.query;
    if (input.cursor) args.cursor = input.cursor;
    const [reply, links] = await Promise.all([call("list_issues", args).then(record), linkMap()]);
    const issues = list(reply.issues).map((item) => cardOf(item, links));
    const teamIds = new Set(issues.map((issue) => issue.teamId).filter((id): id is string => id !== null));
    if (view.kind === "team") teamIds.add(raw);
    const stateLists = await Promise.all([...teamIds].map((id) => teamStates(id).catch(() => [])));
    const columns = new Map<string, BoardColumn>();
    for (const state of sortStates(stateLists.flat())) {
      const key = columnKey(state.type, state.name);
      if (!columns.has(key)) columns.set(key, { key, name: state.name, type: state.type, count: 0 });
    }
    for (const issue of issues) {
      const column = columns.get(issue.column);
      if (column) column.count++;
      else columns.set(issue.column, { key: issue.column, name: issue.state, type: issue.stateType, count: 1 });
    }
    const presentTypes = new Set(issues.map((issue) => issue.stateType));
    const ordered = sortStates([...columns.values()]).filter(
      (column) =>
        column.count > 0 ||
        (!["canceled", "duplicate"].includes(column.type) && (view.kind !== "view" || presentTypes.has(column.type))),
    );
    return {
      view,
      label,
      project: view.kind === "project" ? null : project,
      columns: ordered,
      issues,
      nextCursor: reply.hasNextPage === true ? str(reply.cursor) : null,
      searchable,
      fetchedAt: new Date().toISOString(),
    };
  });
}

const identifierPattern = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$|^[0-9a-f-]{36}$/;

export function parseIssueId(value: string | undefined) {
  if (!value || !identifierPattern.test(value)) throw new ValidationError(linearText("issueInvalid"), "id");
  return value;
}

async function rawIssue(id: string) {
  const issue = record(await call("get_issue", { id }));
  if (!str(issue.id)) throw new LinearError(404, linearText("issueMissing"));
  return issue;
}

export async function issueDetail(id: string): Promise<IssueDetail> {
  const [issue, comments, children] = await Promise.all([
    rawIssue(id),
    call("list_comments", { issueId: id, limit: 100, orderBy: "createdAt" }).then(record),
    call("list_issues", { parentId: id, limit: 50, fields: cardFields }).then(record),
  ]);
  const links = await linkMap();
  const card = cardOf(issue, links);
  const pr = card.pr ?? (await linkForIssue(card.id, card.branch));
  const states = card.teamId ? await teamStates(card.teamId).catch(() => []) : [];
  return {
    ...card,
    pr,
    description: cleanDescription(str(issue.description) ?? ""),
    createdAt: str(issue.createdAt),
    startedAt: str(issue.startedAt),
    completedAt: str(issue.completedAt),
    dueDate: str(issue.dueDate),
    createdBy: nameOf(issue.createdBy),
    comments: list(comments.comments)
      .map((comment) => ({
        id: str(comment.id) ?? "",
        author: nameOf(comment.author) ?? linearText("someone"),
        body: cleanDescription(str(comment.body) ?? ""),
        createdAt: str(comment.createdAt) ?? "",
        parentId: str(comment.parentId),
        quotedText: str(comment.quotedText),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    children: list(children.issues).map((child) => cardOf(child, links)),
    attachments: list(issue.attachments)
      .filter((item) => str(item.url))
      .map((item) => ({ title: str(item.title) ?? "Link", subtitle: str(item.subtitle), url: str(item.url) ?? "" })),
    states,
  };
}

async function save(args: Json) {
  await call("save_issue", args);
  for (const key of [...cache.keys()]) if (key.startsWith("board:")) cache.delete(key);
}

export function targetState(states: LinearState[], column: string) {
  const separator = column.indexOf(":");
  const type = separator > 0 ? column.slice(0, separator) : "";
  const name = separator > 0 ? column.slice(separator + 1) : column;
  return (
    states.find((state) => state.id === column) ??
    states.find((state) => state.name === name && (!type || state.type === type)) ??
    states.find((state) => state.name.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

export async function moveIssue(id: string, column: string) {
  if (!column) throw new ValidationError(linearText("pickColumn"), "column");
  const issue = await rawIssue(id);
  const teamId = str(issue.teamId);
  if (!teamId) throw new LinearError(422, linearText("noTeam"));
  const state = targetState(await teamStates(teamId), column);
  if (!state) throw new ValidationError(linearText("statusMissing"), "column");
  await save({ id, state: state.id });
  return { id, state: state.name, stateType: state.type, column: columnKey(state.type, state.name) };
}

export async function assignToMe(id: string) {
  await save({ id, assignee: "me" });
  return { id, assigned: true };
}

export function startedState(states: LinearState[]) {
  const started = states.filter((state) => state.type === "started");
  return [...started].sort((a, b) => stageWeight(a.name) - stageWeight(b.name))[0] ?? null;
}

export async function startIssue(id: string) {
  const issue = await rawIssue(id);
  const teamId = str(issue.teamId);
  if (!teamId) throw new LinearError(422, linearText("noTeam"));
  const state = startedState(await teamStates(teamId));
  if (!state) throw new LinearError(422, linearText("noStartedStatus"));
  await save({ id, state: state.id, ...(str(issue.assigneeId) ? {} : { assignee: "me" }) });
  return {
    id,
    state: state.name,
    stateType: state.type,
    column: columnKey(state.type, state.name),
    branch: str(issue.gitBranchName),
  };
}

export async function linearSummary(refresh = false) {
  return cached("summary", boardTtlMs, refresh, async () => {
    const reply = record(
      await call("list_issues", { assignee: "me", state: "started", limit: pageSize, fields: ["id"] }),
    );
    return { started: list(reply.issues).length, more: reply.hasNextPage === true };
  });
}
