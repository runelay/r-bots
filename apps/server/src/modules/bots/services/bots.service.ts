import type { Provider } from "@runelay-bots/protocol";
import { defaultModels } from "@runelay-bots/providers";
import { Cron } from "croner";
import { model as defaultClaudeModel } from "../../../config/env";
import { ValidationError } from "../../../shared/errors";
import { isAccountId, preferredAccountId } from "../../accounts/services/accounts.service";
import { type DecisionSettings, defaultDecisions } from "../../approvals/services/decisions.service";
import { isPermissionMode, type PermissionMode } from "../../approvals/services/permissions.service";
import { defaultMemory } from "../../memory/constants/memory.constants";
import type { MemorySettings } from "../../memory/types/memory.types";
import { loadBotRows, saveBotRow } from "../repositories/bots.repository";

export const accents = [
  "white",
  "amber",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
  "grey",
] as const;
export const legacyAccents = ["electric", "royal", "sky", "indigo"] as const;

export const capabilityCatalog = [
  {
    id: "browser",
    label: "Navegador",
    description: "Abre páginas, lê, clica e preenche. Clique e preenchimento pedem aprovação.",
  },
  { id: "delegate", label: "Delegar", description: "Passa partes do trabalho para outros bots do time." },
  {
    id: "computer",
    label: "Seu Mac",
    description: "Usa o seu Mac de verdade pelo app: sites, apps, arquivos e gravação. Ações pedem aprovação.",
  },
  {
    id: "desktop",
    label: "Computador",
    description: "Um computador virtual com navegador e terminal. Digitar e usar o terminal pedem aprovação.",
  },
];

export interface BotSchedule {
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  description: string;
  paused?: boolean;
}

export interface BotCapabilities {
  browser: boolean;
  desktop?: boolean;
  computer?: boolean;
  delegate: string[];
}

export interface EngineFallback {
  account: string;
  model: string;
}

export interface BotEngine {
  account: string;
  model: string;
  effort: "low" | "medium" | "high" | null;
  fallback?: EngineFallback | null;
  autoSwitch?: boolean;
}

export const efforts = ["low", "medium", "high"] as const;

export function defaultEngine(): BotEngine {
  return { account: preferredAccountId("claude"), model: defaultClaudeModel, effort: null };
}

export function suggestedFallback(account: string): EngineFallback {
  return account.endsWith(":codex")
    ? { account: preferredAccountId("claude"), model: defaultClaudeModel }
    : { account: preferredAccountId("codex"), model: defaultModels.codex };
}

export function engineOf(bot: BotDefinition): BotEngine {
  const engine = bot.engine ?? defaultEngine();
  return { ...engine, fallback: engine.fallback === undefined ? suggestedFallback(engine.account) : engine.fallback };
}

export function decisionsOf(bot: BotDefinition): DecisionSettings {
  return { ...defaultDecisions, ...bot.decisions };
}

export interface BotConnectors {
  allowed: string[];
  memory: boolean;
}

export function memoryOf(bot: BotDefinition): MemorySettings {
  return { ...defaultMemory, ...bot.memory };
}

let knownConnectors: string[] = [];

export function setKnownConnectors(names: string[]) {
  knownConnectors = names;
}

export function connectorsOf(bot: BotDefinition): BotConnectors {
  const own = bot.connectors?.allowed ?? [];
  return { ...bot.connectors, allowed: [...new Set([...knownConnectors, ...own])], memory: true };
}

function withFullAccess(bot: BotDefinition): BotDefinition {
  bot.capabilities = { ...bot.capabilities, browser: true, computer: true };
  return bot;
}

export interface BotSidebar {
  pinned: boolean;
  sectionId: string | null;
  hidden: boolean;
}

export function sidebarOf(bot: BotDefinition): BotSidebar {
  return { pinned: false, sectionId: null, hidden: false, ...bot.sidebar };
}

export function isActive(bot: BotDefinition | undefined): bot is BotDefinition {
  return Boolean(bot && !bot.archivedAt && !bot.deletedAt);
}

export interface BotDefinition {
  engine?: BotEngine;
  decisions?: DecisionSettings;
  id: string;
  name: string;
  role: string;
  accent: string;
  glyph: string;
  instructions: string;
  capabilities: BotCapabilities;
  schedules: BotSchedule[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt?: string | null;
  connectors?: BotConnectors;
  memory?: MemorySettings;
  computer?: { allowedRoots: string[] };
  voice?: BotVoice;
  sidebar?: BotSidebar;
  permission?: PermissionMode;
}

export function permissionOfBot(bot: BotDefinition): PermissionMode {
  return bot.permission ?? "default";
}

function validatePermission(value: unknown): PermissionMode {
  if (!isPermissionMode(value)) throw new ValidationError("Use readonly, edit, default ou full.", "permission");
  return value;
}

const defaultTimezone = "America/Sao_Paulo";
const bots = new Map<string, BotDefinition>();
const listeners = new Set<() => void>();

export function onBotsChanged(listener: () => void) {
  listeners.add(listener);
}

function changed() {
  for (const listener of listeners) listener();
}

export function getBot(id: string) {
  return bots.get(id);
}

export function listBots(includeArchived = false, options: { deleted?: boolean; hidden?: boolean } = {}) {
  return [...bots.values()]
    .filter((bot) => includeArchived || !bot.archivedAt)
    .filter((bot) => options.deleted || !bot.deletedAt)
    .filter((bot) => options.hidden !== false || !sidebarOf(bot).hidden)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function loadBots() {
  for (const bot of await loadBotRows()) if (bot.id) bots.set(bot.id, withFullAccess(bot));
}

function slugify(name: string) {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "bot";
}

function uniqueId(name: string) {
  const base = slugify(name);
  if (!bots.has(base) && !["meta", "health"].includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!bots.has(candidate)) return candidate;
  }
}

function isTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function asString(value: unknown, field: string, min: number, max: number, label: string) {
  if (typeof value !== "string") throw new ValidationError(`${label} precisa ser texto.`, field);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ValidationError(`${label} não pode ficar vazio.`, field);
  if (trimmed.length > max) throw new ValidationError(`${label} pode ter no máximo ${max} caracteres.`, field);
  return trimmed;
}

function validateCapabilities(value: unknown, selfId: string | null): BotCapabilities {
  if (value === undefined || value === null) return { browser: false, delegate: [] };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Capacidades inválidas.", "capabilities");
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["browser", "desktop", "computer"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new ValidationError(`capabilities.${key} precisa ser verdadeiro ou falso.`, `capabilities.${key}`);
    }
  }
  const delegateRaw = raw.delegate ?? [];
  if (!Array.isArray(delegateRaw) || delegateRaw.some((item) => typeof item !== "string")) {
    throw new ValidationError("capabilities.delegate precisa ser uma lista de ids.", "capabilities.delegate");
  }
  const delegate = [...new Set(delegateRaw as string[])];
  for (const id of delegate) {
    if (id === selfId) throw new ValidationError("Um bot não pode delegar para ele mesmo.", "capabilities.delegate");
  }
  return { browser: true, desktop: raw.desktop === true, computer: true, delegate };
}

function validateSchedules(value: unknown): BotSchedule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError("Rotinas precisam ser uma lista.", "schedules");
  const names = new Set<string>();
  return value.map((item, index) => {
    const field = `schedules[${index}]`;
    if (!item || typeof item !== "object") throw new ValidationError("Rotina inválida.", field);
    const raw = item as Record<string, unknown>;
    const name = asString(raw.name ?? `rotina-${index + 1}`, `${field}.name`, 1, 40, "O nome da rotina");
    if (names.has(name)) throw new ValidationError("Já existe uma rotina com esse nome.", `${field}.name`);
    names.add(name);
    const cron = asString(raw.cron, `${field}.cron`, 1, 100, "O cron");
    const timezone =
      raw.timezone === undefined ? defaultTimezone : asString(raw.timezone, `${field}.timezone`, 1, 64, "O fuso");
    if (!isTimezone(timezone)) throw new ValidationError("Fuso horário desconhecido.", `${field}.timezone`);
    try {
      new Cron(cron, { timezone, paused: true }).stop();
    } catch {
      throw new ValidationError("Cron inválido.", `${field}.cron`);
    }
    const prompt = asString(raw.prompt, `${field}.prompt`, 1, 20_000, "O pedido da rotina");
    const description =
      raw.description === undefined ? "" : asString(raw.description, `${field}.description`, 0, 200, "A descrição");
    if (raw.paused !== undefined && typeof raw.paused !== "boolean")
      throw new ValidationError("paused precisa ser verdadeiro ou falso.", `${field}.paused`);
    return { name, cron, timezone, prompt, description, ...(raw.paused === true ? { paused: true } : {}) };
  });
}

function validateAccent(value: unknown) {
  if (typeof value !== "string" || ![...accents, ...legacyAccents].includes(value as never)) {
    throw new ValidationError(`Cor inválida. Use uma de: ${accents.join(", ")}.`, "accent");
  }
  return value;
}

function validateGlyph(value: unknown) {
  if (value === undefined || value === null) return "auto";
  if (typeof value !== "string" || !/^[a-z0-9-]{1,40}$/.test(value)) {
    throw new ValidationError("Ícone inválido: use até 40 caracteres de a-z, 0-9 e hífen.", "glyph");
  }
  return value;
}

const knownFields = new Set([
  "name",
  "role",
  "accent",
  "glyph",
  "instructions",
  "capabilities",
  "schedules",
  "engine",
  "decisions",
  "connectors",
  "memory",
  "computer",
  "voice",
  "permission",
]);

export const voiceLanguages = ["pt", "en", "es"] as const;

export interface BotVoice {
  voiceId: string;
  speed: number;
  language: (typeof voiceLanguages)[number];
}

export const defaultVoice: BotVoice = {
  voiceId: process.env.VOICE_DEFAULT_ID ?? "VNaz9wbhLsh3lLuHzAVP",
  speed: 1,
  language: "pt",
};

export function voiceOf(bot: BotDefinition): BotVoice {
  return { ...defaultVoice, ...bot.voice };
}

function validateVoice(value: unknown, current: BotVoice): BotVoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Voz inválida.", "voice");
  const raw = value as Record<string, unknown>;
  const next = { ...current };
  for (const [key, item] of Object.entries(raw)) {
    if (key === "voiceId") {
      if (typeof item !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(item))
        throw new ValidationError("voice.voiceId inválido.", "voice.voiceId");
      next.voiceId = item;
    } else if (key === "speed") {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0.7 || item > 1.2)
        throw new ValidationError("voice.speed vai de 0.7 a 1.2.", "voice.speed");
      next.speed = Math.round(item * 100) / 100;
    } else if (key === "language") {
      if (typeof item !== "string" || !(voiceLanguages as readonly string[]).includes(item))
        throw new ValidationError("voice.language precisa ser pt, en ou es.", "voice.language");
      next.language = item as BotVoice["language"];
    } else {
      throw new ValidationError(`Campo desconhecido: voice.${key}.`, `voice.${key}`);
    }
  }
  return next;
}

function validateComputer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("computer inválido.", "computer");
  const roots = (value as { allowedRoots?: unknown }).allowedRoots;
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    roots.length > 10 ||
    roots.some((item) => typeof item !== "string" || !/^~?\/[^\0]{0,200}$/.test(item) || item.includes(".."))
  ) {
    throw new ValidationError(
      'computer.allowedRoots precisa ser uma lista de pastas (até 10, sem "..").',
      "computer.allowedRoots",
    );
  }
  return { allowedRoots: roots as string[] };
}

function validateMemory(value: unknown, current: MemorySettings): MemorySettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Memória inválida.", "memory");
  const raw = value as Record<string, unknown>;
  const next = { ...current };
  for (const [key, item] of Object.entries(raw)) {
    if (key !== "recall" && key !== "capture")
      throw new ValidationError(`Campo desconhecido: memory.${key}.`, `memory.${key}`);
    if (typeof item !== "boolean")
      throw new ValidationError(`memory.${key} precisa ser verdadeiro ou falso.`, `memory.${key}`);
    next[key] = item;
  }
  return next;
}

function validateConnectors(value: unknown, current: BotConnectors): BotConnectors {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Conectores inválidos.", "connectors");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["allowed", "memory"].includes(key))
      throw new ValidationError(`Campo desconhecido: connectors.${key}.`, `connectors.${key}`);
  }
  const allowed = raw.allowed === undefined ? current.allowed : raw.allowed;
  if (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string" || !/^[a-z0-9_-]{1,60}$/.test(item))) {
    throw new ValidationError(
      "connectors.allowed precisa ser uma lista de nomes de conexão do runelay.",
      "connectors.allowed",
    );
  }
  const memory = raw.memory === undefined ? current.memory : raw.memory;
  if (typeof memory !== "boolean")
    throw new ValidationError("connectors.memory precisa ser verdadeiro ou falso.", "connectors.memory");
  return { allowed: [...new Set(allowed as string[])], memory };
}

function validateDecisions(value: unknown, current: DecisionSettings): DecisionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Decisões inválidas.", "decisions");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["autoApprove", "threshold"].includes(key))
      throw new ValidationError(`Campo desconhecido: decisions.${key}.`, `decisions.${key}`);
  }
  const autoApprove = raw.autoApprove === undefined ? current.autoApprove : raw.autoApprove;
  if (typeof autoApprove !== "boolean")
    throw new ValidationError("decisions.autoApprove precisa ser verdadeiro ou falso.", "decisions.autoApprove");
  const threshold = raw.threshold === undefined ? current.threshold : raw.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
    throw new ValidationError("decisions.threshold precisa ficar entre 0.5 e 1.", "decisions.threshold");
  }
  return { autoApprove, threshold };
}

function validateEngine(value: unknown, current: BotEngine): BotEngine {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Motor inválido.", "engine");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["account", "model", "effort", "fallback", "autoSwitch"].includes(key))
      throw new ValidationError(`Campo desconhecido: engine.${key}.`, `engine.${key}`);
  }
  const account = raw.account === undefined ? current.account : raw.account;
  if (typeof account !== "string" || !isAccountId(account))
    throw new ValidationError("Conta inválida. Escolha uma das contas em Ajustes › Contas de IA.", "engine.account");
  const provider = account.split(":")[1] as Provider;
  const accountChanged = account !== current.account;
  const modelRaw = raw.model ?? (accountChanged ? defaultModels[provider] : current.model);
  const model = asString(modelRaw, "engine.model", 1, 100, "O modelo");
  const effortRaw = raw.effort === undefined ? current.effort : raw.effort;
  if (effortRaw !== null && !(efforts as readonly unknown[]).includes(effortRaw)) {
    throw new ValidationError("Esforço inválido. Use low, medium ou high.", "engine.effort");
  }
  const autoSwitch = raw.autoSwitch === undefined ? current.autoSwitch : raw.autoSwitch;
  if (autoSwitch !== undefined && typeof autoSwitch !== "boolean")
    throw new ValidationError("engine.autoSwitch precisa ser verdadeiro ou falso.", "engine.autoSwitch");
  return {
    account: account as string,
    model,
    effort: (effortRaw as BotEngine["effort"]) ?? null,
    fallback: validateFallback(raw.fallback, current.fallback),
    ...(autoSwitch ? { autoSwitch: true } : {}),
  };
}

function validateFallback(
  value: unknown,
  current: EngineFallback | null | undefined,
): EngineFallback | null | undefined {
  if (value === undefined) return current;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Conta reserva inválida.", "engine.fallback");
  const raw = value as Record<string, unknown>;
  const account = raw.account;
  if (typeof account !== "string" || !isAccountId(account))
    throw new ValidationError(
      "Conta reserva inválida. Escolha uma das contas em Ajustes › Contas de IA.",
      "engine.fallback.account",
    );
  const model = asString(
    raw.model ?? defaultModels[account.split(":")[1] as Provider],
    "engine.fallback.model",
    1,
    100,
    "O modelo da reserva",
  );
  return { account: account as string, model };
}

function rejectUnknown(body: Record<string, unknown>) {
  for (const key of Object.keys(body)) {
    if (!knownFields.has(key)) throw new ValidationError(`Campo desconhecido: ${key}.`, key);
  }
}

export function deriveRole(instructions: string) {
  const plain = instructions
    .replace(/[#*_`>[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const first = plain.split(/(?<=[.!?])\s/)[0] ?? "";
  if (!first) return "";
  const role = first.replace(/[.!?]+$/, "");
  return role.length > 60 ? `${role.slice(0, 59).trimEnd()}…` : role;
}

export async function createBot(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Corpo inválido.", "body");
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw);
  const name = asString(raw.name, "name", 1, 40, "O nome");
  const id = uniqueId(name);
  const now = new Date().toISOString();
  const bot: BotDefinition = {
    id,
    name,
    role:
      raw.role === undefined || raw.role === null || (typeof raw.role === "string" && !raw.role.trim())
        ? ""
        : asString(raw.role, "role", 0, 60, "O papel"),
    accent: raw.accent === undefined ? "blue" : validateAccent(raw.accent),
    glyph: validateGlyph(raw.glyph),
    instructions:
      raw.instructions === undefined ? "" : asString(raw.instructions, "instructions", 0, 20_000, "As instruções"),
    capabilities:
      raw.capabilities === undefined || raw.capabilities === null
        ? {
            browser: true,
            computer: true,
            delegate: listBots()
              .map((item) => item.id)
              .filter((item) => item !== id),
          }
        : validateCapabilities(raw.capabilities, id),
    schedules: validateSchedules(raw.schedules),
    engine: raw.engine === undefined ? defaultEngine() : validateEngine(raw.engine, defaultEngine()),
    decisions:
      raw.decisions === undefined ? { ...defaultDecisions } : validateDecisions(raw.decisions, defaultDecisions),
    connectors:
      raw.connectors === undefined
        ? { allowed: [], memory: true }
        : validateConnectors(raw.connectors, { allowed: [], memory: true }),
    memory: raw.memory === undefined ? { ...defaultMemory } : validateMemory(raw.memory, defaultMemory),
    ...(raw.permission === undefined ? {} : { permission: validatePermission(raw.permission) }),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  if (!bot.role) bot.role = deriveRole(bot.instructions) || "Novo no time";
  bots.set(id, bot);
  await saveBotRow(bot);
  changed();
  return bot;
}

export async function updateBot(id: string, body: unknown) {
  const bot = bots.get(id);
  if (!bot) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Corpo inválido.", "body");
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw);
  const next: BotDefinition = { ...bot };
  if (raw.name !== undefined) next.name = asString(raw.name, "name", 1, 40, "O nome");
  if (raw.role !== undefined) next.role = asString(raw.role, "role", 0, 60, "O papel");
  if (raw.accent !== undefined) next.accent = validateAccent(raw.accent);
  if (raw.glyph !== undefined) next.glyph = validateGlyph(raw.glyph);
  if (raw.instructions !== undefined)
    next.instructions = asString(raw.instructions, "instructions", 0, 20_000, "As instruções");
  if (raw.capabilities !== undefined) {
    if (!raw.capabilities || typeof raw.capabilities !== "object" || Array.isArray(raw.capabilities)) {
      throw new ValidationError("Capacidades inválidas.", "capabilities");
    }
    const merged = { ...bot.capabilities, ...(raw.capabilities as object) };
    next.capabilities = validateCapabilities(merged, id);
  }
  if (raw.schedules !== undefined) next.schedules = validateSchedules(raw.schedules);
  if (raw.engine !== undefined) next.engine = validateEngine(raw.engine, bot.engine ?? defaultEngine());
  if (raw.decisions !== undefined) next.decisions = validateDecisions(raw.decisions, decisionsOf(bot));
  if (raw.connectors !== undefined) next.connectors = validateConnectors(raw.connectors, connectorsOf(bot));
  if (raw.memory !== undefined) next.memory = validateMemory(raw.memory, memoryOf(bot));
  if (raw.computer !== undefined) next.computer = validateComputer(raw.computer);
  if (raw.voice !== undefined) next.voice = validateVoice(raw.voice, voiceOf(bot));
  if (raw.permission !== undefined) next.permission = validatePermission(raw.permission);
  next.updatedAt = new Date().toISOString();
  bots.set(id, next);
  await saveBotRow(next);
  changed();
  return next;
}

export async function updateSidebar(id: string, body: unknown, sectionExists: (sectionId: string) => boolean) {
  const bot = bots.get(id);
  if (!bot) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Corpo inválido.", "body");
  const raw = body as Record<string, unknown>;
  const next = sidebarOf(bot);
  for (const key of Object.keys(raw)) {
    if (!["pinned", "sectionId", "hidden"].includes(key))
      throw new ValidationError(`Campo desconhecido: sidebar.${key}.`, key);
  }
  for (const key of ["pinned", "hidden"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") throw new ValidationError(`${key} precisa ser verdadeiro ou falso.`, key);
    next[key] = raw[key] as boolean;
  }
  if (raw.sectionId !== undefined) {
    if (raw.sectionId !== null && (typeof raw.sectionId !== "string" || !sectionExists(raw.sectionId))) {
      throw new ValidationError("Seção não encontrada.", "sectionId");
    }
    next.sectionId = raw.sectionId as string | null;
  }
  const updated = { ...bot, sidebar: next };
  bots.set(id, updated);
  await saveBotRow(updated);
  return updated;
}

export async function clearSection(sectionId: string) {
  for (const bot of bots.values()) {
    if (sidebarOf(bot).sectionId !== sectionId) continue;
    const updated = { ...bot, sidebar: { ...sidebarOf(bot), sectionId: null } };
    bots.set(bot.id, updated);
    await saveBotRow(updated);
  }
}

export async function setDeleted(id: string, deleted: boolean) {
  const bot = bots.get(id);
  if (!bot) return null;
  const next = {
    ...bot,
    deletedAt: deleted ? (bot.deletedAt ?? new Date().toISOString()) : null,
    updatedAt: new Date().toISOString(),
  };
  bots.set(id, next);
  await saveBotRow(next);
  changed();
  return next;
}

export async function setArchived(id: string, archived: boolean) {
  const bot = bots.get(id);
  if (!bot) return null;
  const next = {
    ...bot,
    archivedAt: archived ? (bot.archivedAt ?? new Date().toISOString()) : null,
    updatedAt: new Date().toISOString(),
  };
  bots.set(id, next);
  await saveBotRow(next);
  changed();
  return next;
}
