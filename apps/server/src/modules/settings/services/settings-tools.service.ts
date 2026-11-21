import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ValidationError } from "../../../shared/errors";
import { redactText } from "../../../shared/redact";
import { type Account, listAccounts, updateAccount } from "../../accounts/services/accounts.service";
import {
  isPermissionMode,
  type PermissionMode,
  permissionLabels,
  permissionModes,
  readonlyRemoteMessage,
} from "../../approvals/services/permissions.service";
import {
  accents,
  type BotDefinition,
  type BotEngine,
  type BotSchedule,
  defaultEngine,
  efforts,
  engineOf,
  getBot,
  listBots,
  permissionOfBot,
  setArchived,
  sidebarOf,
  updateBot,
  updateSidebar,
  voiceOf,
} from "../../bots/services/bots.service";
import { allowedRepos, removeAllowedRepo } from "../../code/services/repos.service";
import {
  getCatalog,
  installCatalogItem,
  listConnections,
  reconnectSource,
  runelayEnabled,
} from "../../connectors/services/runelay.service";
import { updateConversation } from "../../conversations/services/conversations.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { type IntegrationId, integrationIds, readStored } from "../../integrations/services/integration-store.service";
import { listIntegrations } from "../../integrations/services/integrations.service";
import { createSection, listSections, sectionExists, updateSection } from "../../sections/services/sections.service";
import { resolveProject } from "../../servers/services/projects.service";
import { deleteProfile, findProfile, listProfiles, saveProfile } from "../../servers/services/servers.service";
import { usageLimits } from "../../usage/services/usage.service";
import { getSecretMeta, listSecretMeta, normalizeDomains, saveSecretMeta } from "../../vault/services/vault.service";
import { listVoices } from "../../voice/services/voice.service";
import { notificationKinds, notificationLabels, readPreferences, updatePreferences } from "./preferences.service";
import { emitSettingsChange, type SettingsArea } from "./settings-events.service";

export interface UndoStep {
  method: "PATCH" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

export interface Thumbnail {
  kind: "bot" | "provider" | "connector" | "integration";
  id: string;
}

export interface SettingsLine {
  area: SettingsArea;
  text: string;
  target: { id: string; name: string };
  thumbnail?: Thumbnail;
  undo?: UndoStep[];
  action?: { label: string; url: string };
  otherBot?: boolean;
  areas?: SettingsArea[];
}

interface Outcome {
  reply: string;
  data?: unknown;
  output?: unknown;
  line?: SettingsLine;
}

class SettingsDenied extends Error {}

const permissionRank: Record<PermissionMode, number> = { readonly: 0, edit: 1, default: 2, full: 3 };

export const settingsGuide = [
  "## Seus ajustes",
  "- Você pode mudar tudo o que a tela de Ajustes muda, direto, quando a pessoa pedir: modelo, conta, esforço e conta reserva, modo de permissão, nome, rosto e cor, fixar, seção, arquivar bot, rotinas (pausar, retomar, editar, rodar agora), perfis de servidor, repositórios liberados, descrição e sites dos segredos, contas de IA, integrações, conectores, voz e notificações. Use `settings_get` e as ferramentas `bot_update`, `bot_archive`, `section_update`, `schedule_update`, `schedule_run`, `server_profile_save`, `server_profile_delete`, `repo_remove`, `vault_update_meta`, `usage_get`, `account_update`, `integration_setup`, `connector_connect` e `preferences_set`. Nunca use o computador para mexer no app.",
  "- Antes de responder qualquer coisa sobre você (modelo, conta, modo, rotinas, perfis, repositórios, segredos, integrações, limites), chame `settings_get`. Não responda de memória.",
  "- Faça direto, sem pedir confirmação e sem repetir a mudança em texto longo: o app já mostra uma linha com Desfazer. Responda em uma frase.",
  "- Subir o modo de permissão (seu ou de outro bot) abre um card para a pessoa aprovar. Baixar roda direto.",
  "- Chave de API e segredo: você nunca vê nem recebe o valor. Integrações (ElevenLabs, Jev, runelay) só por `integration_setup`, que abre o formulário seguro no app. Para conectar um serviço na runelay, use `connector_connect`: ele mostra o botão Conectar; o login é da pessoa. Depois, confira com `settings_get`.",
  "- Se achar que outro modelo serve melhor para a tarefa, sugira em uma linha e só troque se a pessoa pedir. Se a pessoa disser que você pode trocar quando achar melhor, grave com `bot_update(autoSwitch: true)`; com isso ligado, troque sozinho e diga em uma linha.",
].join("\n");

function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text" as const, text: redactText(text) }], ...(isError ? { isError: true } : {}) };
}

function newCallId() {
  return `call_${randomBytes(9).toString("base64url")}`;
}

function scopeOf(context: ToolContext) {
  return { runId: context.runId(), turnId: context.turnId };
}

function ownerOf(context: ToolContext) {
  return context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() };
}

function messageOf(error: unknown) {
  if (error instanceof ValidationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function normalize(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function pick<T>(items: T[], ref: string, keys: (item: T) => string[]) {
  const key = normalize(ref);
  return (
    items.find((item) => keys(item).some((value) => normalize(value) === key)) ??
    items.find((item) => keys(item).some((value) => normalize(value).includes(key))) ??
    null
  );
}

export function findBot(ref: string | undefined, self: BotDefinition) {
  if (!ref?.trim()) return getBot(self.id) ?? self;
  const found = pick(listBots(true), ref, (bot) => [bot.id, bot.name]);
  if (!found) throw new Error(`Não achei o bot "${ref}".`);
  return found;
}

function accountName(account: Account | undefined, id: string) {
  return account?.name || account?.label || id;
}

function modelLabel(account: Account | undefined, model: string) {
  return account?.models.find((item) => item.id === model)?.label ?? model;
}

export function resolveAccount(accounts: Account[], ref: string) {
  const found = pick(accounts, ref, (account) => [account.id, account.name, account.label, account.autoName]);
  if (!found)
    throw new Error(
      `Não achei a conta "${ref}". Contas: ${accounts.map((account) => `${accountName(account, account.id)} (${account.id})`).join(", ")}.`,
    );
  return found;
}

export function resolveModel(account: Account | undefined, ref: string) {
  const models = account?.models ?? [];
  if (models.length === 0) return ref;
  const found = pick(models, ref, (model) => [model.id, model.label]);
  if (!found)
    throw new Error(
      `${accountName(account, account?.id ?? "")} não tem o modelo "${ref}". Modelos: ${models.map((model) => model.label).join(", ")}.`,
    );
  return found.id;
}

function scheduleView(schedule: BotSchedule) {
  return {
    name: schedule.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    description: schedule.description,
    paused: schedule.paused === true,
    prompt: schedule.prompt.length > 300 ? `${schedule.prompt.slice(0, 299)}…` : schedule.prompt,
  };
}

function conversationPermission(context: ToolContext) {
  return getStoredSession(context.sessionId)?.meta.permission ?? null;
}

async function settingsState(context: ToolContext, target: BotDefinition) {
  const [accounts, profiles, preferences, connections] = await Promise.all([
    listAccounts().catch(() => [] as Account[]),
    listProfiles().catch(() => []),
    readPreferences(),
    runelayEnabled() ? listConnections().catch(() => null) : Promise.resolve(null),
  ]);
  const engine = engineOf(target);
  const account = accounts.find((item) => item.id === engine.account);
  const fallbackAccount = engine.fallback ? accounts.find((item) => item.id === engine.fallback?.account) : undefined;
  const sidebar = sidebarOf(target);
  const self = target.id === context.bot.id;
  const sections = listSections();
  return {
    bot: {
      id: target.id,
      name: target.name,
      role: target.role,
      self,
      accent: target.accent,
      glyph: target.glyph,
      archived: Boolean(target.archivedAt),
      pinned: sidebar.pinned,
      section: sections.find((section) => section.id === sidebar.sectionId)?.name ?? null,
      engine: {
        account: engine.account,
        accountName: accountName(account, engine.account),
        model: engine.model,
        modelLabel: modelLabel(account, engine.model),
        effort: engine.effort,
        fallback: engine.fallback
          ? {
              account: engine.fallback.account,
              accountName: accountName(fallbackAccount, engine.fallback.account),
              model: engine.fallback.model,
            }
          : null,
        autoSwitch: engine.autoSwitch === true,
      },
      permission: {
        bot: permissionOfBot(target),
        ...(self ? { conversation: conversationPermission(context), effective: context.permission ?? "default" } : {}),
      },
      voice: voiceOf(target),
      schedules: target.schedules.map(scheduleView),
      instructionsChars: target.instructions.length,
    },
    accounts: accounts.map((item) => ({
      id: item.id,
      name: accountName(item, item.id),
      provider: item.provider,
      isDefault: item.isDefault,
      status: item.status,
      models: item.models.map((model) => ({ id: model.id, label: model.label })),
    })),
    sections: sections.map((section) => section.name),
    serverProfiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      path: profile.path,
      cwd: profile.cwd,
      script: profile.script,
      cmd: profile.cmd,
      port: profile.port,
    })),
    repos: allowedRepos().map((repo) => ({ name: repo.name, path: repo.path })),
    vault: listSecretMeta().map((meta) => ({
      name: meta.name,
      ref: `segredo:${meta.name}`,
      description: meta.description,
      domains: meta.domains.length ? meta.domains : "qualquer site",
    })),
    integrations: listIntegrations().map((item) => ({ id: item.id, name: item.name, status: item.status })),
    connectors: connections
      ? connections.map((item) => ({ name: item.name, label: item.label, status: item.status }))
      : null,
    preferences: {
      notifications: preferences.notifications,
      microphone: preferences.microphone ?? "padrão do sistema",
      microphones: preferences.microphones,
    },
    options: {
      accents,
      glyphs: glyphPresets,
      efforts,
      permissionModes: permissionModes.map((mode) => ({ id: mode, label: permissionLabels[mode] })),
      notifications: notificationKinds.map((kind) => ({ id: kind, label: notificationLabels[kind] })),
    },
  };
}

export type SettingsState = Awaited<ReturnType<typeof settingsState>>;

async function runSetting(
  context: ToolContext,
  name: string,
  label: string,
  input: Record<string, unknown>,
  work: (callId: string) => Promise<Outcome>,
  write = true,
) {
  const callId = newCallId();
  const log = context.log;
  context.onCallStart();
  try {
    log.emit({
      type: "call.requested",
      data: {
        callId,
        capability: { kind: "tool", name, label, surface: "settings" },
        input,
        owner: ownerOf(context),
        ...(context.origin ? { origin: { agent: context.origin } } : {}),
      },
      scope: scopeOf(context),
    });
    let outcome: Outcome;
    try {
      if (write && context.permission === "readonly") {
        context.emitDecision({
          kind: "approval",
          question: "Esta ação do bot é segura para rodar sem uma pessoa confirmar?",
          answer: null,
          confidence: null,
          threshold: null,
          outcome: "blocked",
          latencyMs: 0,
          model: null,
          reason: "Modo Somente leitura.",
          tool: name,
          callId,
        });
        throw new SettingsDenied(readonlyRemoteMessage);
      }
      outcome = await work(callId);
    } catch (error) {
      const message = messageOf(error);
      const denied = error instanceof SettingsDenied;
      log.emit({
        type: "call.settled",
        data: {
          callId,
          outcome: denied ? "rejected" : "failed",
          error: { code: denied ? "TOOL_EXECUTION_DENIED" : "TOOL_EXECUTION_FAILED", message },
        },
        scope: scopeOf(context),
      });
      context.onCallSettled(`${name} → ${denied ? "negado" : "erro"}: ${message.slice(0, 160)}`);
      return textResult(message, true);
    }
    if (outcome.line) {
      log.emit({
        type: "settings.changed",
        data: { callId, botId: context.botId, by: "bot", ...outcome.line },
        scope: { turnId: context.turnId },
      });
      emitSettingsChange(outcome.line.areas ?? [outcome.line.area]);
    }
    log.emit({
      type: "call.settled",
      data: { callId, outcome: "completed", output: outcome.output ?? { ok: true, summary: outcome.reply } },
      scope: scopeOf(context),
    });
    context.onCallSettled(`${name} → ${outcome.reply.slice(0, 200)}`);
    return textResult(outcome.data === undefined ? outcome.reply : outcome.data);
  } finally {
    context.onCallEnd();
  }
}

function startCall(context: ToolContext, callId: string, cleared?: Record<string, unknown>) {
  context.log.emit({
    type: "call.started",
    data: { callId, ...(cleared ? { clearedBy: cleared } : {}) },
    scope: scopeOf(context),
  });
}

async function askPerson(context: ToolContext, callId: string, prompt: string, reason: string) {
  context.emitDecision({
    kind: "approval",
    question: "Esta ação do bot é segura para rodar sem uma pessoa confirmar?",
    answer: null,
    confidence: null,
    threshold: null,
    outcome: "human",
    latencyMs: 0,
    model: null,
    reason,
    tool: "settings",
    callId,
  });
  if (context.isSchedule)
    throw new SettingsDenied("Ninguém está aqui para aprovar isso agora. Não tente de novo nesta rotina.");
  const { choice, interactionId } = await context.requestApproval(prompt, callId, context.origin, { reason });
  if (choice !== "approve") throw new SettingsDenied("A pessoa negou essa mudança. Não tente de novo sem ela pedir.");
  return { interactionId };
}

export const glyphPresets = [
  "auto",
  "crown",
  "visor",
  "antenna",
  ...Array.from({ length: 11 }, (_, index) => `face-${index + 1}`),
] as [string, ...string[]];

const accentField = z.enum(accents);
const modeField = z.enum(permissionModes);

export function registerSettingsTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "settings_get",
    {
      description:
        "Mostra o seu estado completo (modelo, conta, esforço, conta reserva, modo de permissão, aparência, seção, voz, rotinas) e o do time (contas de IA com modelos, seções, perfis de servidor, repositórios liberados, segredos do cofre só com nome, integrações, conectores, notificações). Limites de uso ficam no usage_get. Passe bot para ver outro bot. Chame antes de responder sobre você.",
      inputSchema: { bot: z.string().max(80).optional().describe("Nome ou id de outro bot; sem isto, você") },
    },
    (args: Record<string, unknown>) =>
      runSetting(
        context,
        "settings_get",
        "Ver os ajustes",
        args,
        async (callId) => {
          startCall(context, callId);
          const target = findBot(args.bot as string | undefined, context.bot);
          const state = await settingsState(context, target);
          return { reply: `ajustes de ${target.name}`, data: state };
        },
        false,
      ),
  );

  server.registerTool(
    "bot_update",
    {
      description:
        "Muda os ajustes de um bot (você, por padrão): nome, papel, cor, rosto, conta e modelo, esforço, conta reserva, troca automática de modelo, voz, fixar, seção e modo de permissão. Só os campos passados mudam. Roda direto; só SUBIR o modo de permissão abre card para a pessoa.",
      inputSchema: {
        bot: z.string().max(80).optional().describe("Nome ou id de outro bot; sem isto, você"),
        name: z.string().min(1).max(40).optional(),
        role: z.string().max(60).optional(),
        accent: accentField.optional().describe("Cor do personagem"),
        glyph: z
          .enum(glyphPresets)
          .optional()
          .describe("Rosto do personagem: crown (coroa), visor (viseira), antenna (antena), face-1 a face-11, ou auto"),
        account: z
          .string()
          .max(80)
          .optional()
          .describe("Conta de IA pelo nome ou id, como Claude Alex ou vps:codex"),
        model: z.string().max(100).optional().describe("Modelo pelo nome ou id, como Sonnet ou Opus"),
        effort: z.enum(["low", "medium", "high", "auto"]).optional().describe("auto volta ao padrão do modelo"),
        fallback: z
          .union([z.object({ account: z.string().max(80), model: z.string().max(100).optional() }), z.literal("off")])
          .optional()
          .describe("Conta reserva quando bater o limite; off desliga"),
        autoSwitch: z.boolean().optional().describe("true quando a pessoa deixar você trocar de modelo sozinho"),
        voice: z
          .object({
            voice: z.string().max(80).optional().describe("Nome ou id da voz da ElevenLabs"),
            speed: z.number().min(0.7).max(1.2).optional(),
            language: z.enum(["pt", "en", "es"]).optional(),
          })
          .optional(),
        pinned: z.boolean().optional(),
        section: z.string().max(40).optional().describe("Nome da seção da barra lateral; none tira da seção"),
        permission: modeField.optional(),
        permissionScope: z
          .enum(["conversation", "bot"])
          .optional()
          .describe("conversation muda só esta conversa (padrão para você); bot muda o padrão do bot"),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(
        context,
        "bot_update",
        "Mudar ajustes",
        args,
        (callId) => updateBotSettings(context, callId, args),
        !Object.keys(args).every((key) => ["bot", "permission", "permissionScope"].includes(key)),
      ),
  );

  server.registerTool(
    "bot_archive",
    {
      description:
        "Arquiva ou restaura um bot (some da barra lateral e para as rotinas; dá para restaurar). Só quando a pessoa pedir com todas as letras.",
      inputSchema: { bot: z.string().min(1).max(80), archived: z.boolean().default(true) },
    },
    (args: Record<string, unknown>) =>
      runSetting(
        context,
        "bot_archive",
        `${args.archived === false ? "Restaurar" : "Arquivar"} ${String(args.bot)}`,
        args,
        async (callId) => {
          const target = findBot(String(args.bot), context.bot);
          const archived = args.archived !== false;
          startCall(context, callId);
          await setArchived(target.id, archived);
          const text = `${archived ? "Arquivou" : "Restaurou"} ${target.name}`;
          return {
            reply: `${text}.`,
            line: {
              area: "bots",
              text,
              target: { id: target.id, name: target.name },
              thumbnail: { kind: "bot", id: target.id },
              otherBot: target.id !== context.bot.id,
              undo: [{ method: "POST", path: `/bots/${target.id}/${archived ? "unarchive" : "archive"}` }],
            },
          };
        },
      ),
  );

  server.registerTool(
    "section_update",
    {
      description: "Cria uma seção da barra lateral, ou renomeia uma existente (passe section com o nome atual).",
      inputSchema: {
        name: z.string().min(1).max(40).describe("Nome novo"),
        section: z.string().max(40).optional().describe("Seção existente para renomear"),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "section_update", `Seção ${String(args.name)}`, args, async (callId) => {
        startCall(context, callId);
        const name = String(args.name);
        if (args.section) {
          const current = pick(listSections(), String(args.section), (section) => [section.id, section.name]);
          if (!current) throw new Error(`Não achei a seção "${String(args.section)}".`);
          const previous = current.name;
          await updateSection(current.id, { name });
          const text = `Renomeou a seção ${previous} para ${name}`;
          return {
            reply: `${text}.`,
            line: {
              area: "sections",
              text,
              target: { id: current.id, name },
              undo: [{ method: "PATCH", path: `/sections/${current.id}`, body: { name: previous } }],
            },
          };
        }
        const created = await createSection({ name });
        const text = `Criou a seção ${created.name}`;
        return {
          reply: `${text}.`,
          line: {
            area: "sections",
            text,
            target: { id: created.id, name: created.name },
            undo: [{ method: "POST", path: `/sections/${created.id}/archive` }],
          },
        };
      }),
  );

  server.registerTool(
    "schedule_update",
    {
      description:
        "Muda uma rotina existente (sua, por padrão): pausa ou retoma (paused), troca o horário (cron de 5 campos), o fuso, o pedido ou a descrição, ou renomeia. Para criar use add_schedule; para apagar, remove_schedule.",
      inputSchema: {
        bot: z.string().max(80).optional(),
        name: z.string().min(1).max(40),
        paused: z.boolean().optional(),
        cron: z.string().min(1).max(100).optional(),
        timezone: z.string().max(60).optional(),
        prompt: z.string().min(1).max(20_000).optional(),
        description: z.string().max(200).optional(),
        rename: z.string().min(1).max(40).optional(),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "schedule_update", `Rotina ${String(args.name)}`, args, async (callId) => {
        const target = findBot(args.bot as string | undefined, context.bot);
        const current = pick(target.schedules, String(args.name), (item) => [item.name]);
        if (!current)
          throw new Error(
            `${target.name} não tem a rotina "${String(args.name)}". Rotinas: ${target.schedules.map((item) => item.name).join(", ") || "nenhuma"}.`,
          );
        startCall(context, callId);
        const next: BotSchedule = { ...current };
        const changes: string[] = [];
        if (args.paused !== undefined && args.paused !== (current.paused === true)) {
          if (args.paused === true) next.paused = true;
          else delete next.paused;
          changes.push(args.paused ? "Pausou" : "Retomou");
        }
        if (args.cron !== undefined && args.cron !== current.cron) {
          next.cron = String(args.cron);
          changes.push(`horário ${next.cron}`);
        }
        if (args.timezone !== undefined && args.timezone !== current.timezone) {
          next.timezone = String(args.timezone);
          changes.push(`fuso ${next.timezone}`);
        }
        if (args.prompt !== undefined && args.prompt !== current.prompt) {
          next.prompt = String(args.prompt);
          changes.push("pedido novo");
        }
        if (args.description !== undefined && args.description !== current.description) {
          next.description = String(args.description);
          changes.push("descrição nova");
        }
        if (args.rename !== undefined && args.rename !== current.name) {
          next.name = String(args.rename);
          changes.push(`renomeou para ${next.name}`);
        }
        if (changes.length === 0) return { reply: `A rotina ${current.name} já estava assim.` };
        const schedules = target.schedules.map((item) => (item.name === current.name ? next : item));
        await updateBot(target.id, { schedules });
        const [first = "", ...rest] = changes;
        const verb = first === "Pausou" || first === "Retomou";
        const text = verb
          ? `${first} a rotina ${next.name}${rest.length ? ` · ${rest.join(" · ")}` : ""}`
          : `Mudou a rotina ${current.name}: ${changes.join(" · ")}`;
        return {
          reply: `${text}.`,
          output: { ok: true, summary: text, schedule: scheduleView(next) },
          line: {
            area: "schedules",
            areas: ["schedules", "bots"],
            text,
            target: { id: target.id, name: next.name },
            thumbnail: { kind: "bot", id: target.id },
            otherBot: target.id !== context.bot.id,
            undo: [{ method: "PATCH", path: `/bots/${target.id}`, body: { schedules: target.schedules } }],
          },
        };
      }),
  );

  server.registerTool(
    "schedule_run",
    {
      description:
        "Roda agora uma rotina existente (sua, por padrão), fora do horário. O resultado chega na conversa do bot.",
      inputSchema: { bot: z.string().max(80).optional(), name: z.string().min(1).max(40) },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "schedule_run", `Rodar a rotina ${String(args.name)}`, args, async (callId) => {
        const target = findBot(args.bot as string | undefined, context.bot);
        if (target.archivedAt) throw new Error(`${target.name} está arquivado.`);
        const current = pick(target.schedules, String(args.name), (item) => [item.name]);
        if (!current) throw new Error(`${target.name} não tem a rotina "${String(args.name)}".`);
        startCall(context, callId);
        const { fire } = await import("../../schedules/services/scheduler.service");
        const started = await fire(target.id, current.name, current.prompt);
        if (!started) throw new Error("Não consegui abrir a conversa do bot.");
        const text = `Rodou agora a rotina ${current.name}`;
        return {
          reply: `${text}. O resultado chega na conversa de ${target.name}.`,
          output: { ok: true, summary: text, sessionId: started.sessionId },
          line: {
            area: "schedules",
            text,
            target: { id: target.id, name: current.name },
            thumbnail: { kind: "bot", id: target.id },
            otherBot: target.id !== context.bot.id,
          },
        };
      }),
  );

  server.registerTool(
    "server_profile_save",
    {
      description:
        "Salva (ou atualiza, pelo mesmo nome) um perfil de servidor do Rodar projeto: projeto liberado, script do package.json e porta. Perfil com comando livre (cmd) pede aprovação, como o server_start com cmd.",
      inputSchema: {
        name: z.string().min(1).max(80),
        project: z.string().max(200).optional().describe("Nome do repositório liberado"),
        path: z.string().max(500).optional().describe("Pasta do projeto, se não for pelo nome"),
        cwd: z.string().max(300).optional(),
        script: z.string().max(100).optional(),
        cmd: z.string().max(500).optional(),
        port: z.number().int().min(1024).max(65535).optional(),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "server_profile_save", `Salvar o perfil ${String(args.name)}`, args, async (callId) => {
        let path = typeof args.path === "string" ? args.path : "";
        if (!path && args.project) path = (await resolveProject({ project: String(args.project) })).repoPath;
        if (!path) throw new Error("Diga o projeto (nome do repositório liberado) ou a pasta.");
        const cmd = typeof args.cmd === "string" ? args.cmd : null;
        const cleared = cmd
          ? await askPerson(
              context,
              callId,
              `Posso salvar um perfil que roda este comando? ${cmd.slice(0, 160)}`,
              "Comando livre fora do package.json.",
            )
          : undefined;
        startCall(context, callId, cleared);
        const previous = await findProfile(String(args.name));
        const profile = await saveProfile({
          ...(previous ? { id: previous.id } : {}),
          name: args.name,
          path,
          cwd: args.cwd ?? "",
          script: args.script ?? null,
          cmd,
          port: args.port ?? null,
        });
        const text = `${previous ? "Atualizou" : "Salvou"} o perfil ${profile.name}`;
        return {
          reply: `${text}.`,
          output: { ok: true, summary: text, profile },
          line: {
            area: "servers",
            text,
            target: { id: profile.id, name: profile.name },
            undo: previous
              ? [{ method: "POST", path: "/servers/profiles", body: { ...previous } }]
              : [{ method: "DELETE", path: `/servers/profiles/${encodeURIComponent(profile.id)}` }],
          },
        };
      }),
  );

  server.registerTool(
    "server_profile_delete",
    {
      description: "Apaga um perfil de servidor salvo, pelo nome ou id.",
      inputSchema: { profile: z.string().min(1).max(80) },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "server_profile_delete", `Apagar o perfil ${String(args.profile)}`, args, async (callId) => {
        const profile = await findProfile(String(args.profile));
        if (!profile) throw new Error(`Não existe o perfil "${String(args.profile)}".`);
        startCall(context, callId);
        await deleteProfile(profile.id);
        const text = `Apagou o perfil ${profile.name}`;
        return {
          reply: `${text}.`,
          line: {
            area: "servers",
            text,
            target: { id: profile.id, name: profile.name },
            undo: [{ method: "POST", path: "/servers/profiles", body: { ...profile } }],
          },
        };
      }),
  );

  server.registerTool(
    "repo_remove",
    {
      description:
        "Tira um repositório da lista de liberados (as ferramentas de código deixam de entrar nele). Para liberar de novo, workspace_add.",
      inputSchema: { repo: z.string().min(1).max(500).describe("Nome ou caminho do repositório") },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "repo_remove", `Tirar ${String(args.repo)} dos liberados`, args, async (callId) => {
        const repo = pick(allowedRepos(), String(args.repo), (item) => [item.path, item.name]);
        if (!repo) throw new Error(`"${String(args.repo)}" não está entre os repositórios liberados.`);
        startCall(context, callId);
        await removeAllowedRepo(repo.path);
        const text = `Tirou ${repo.name} dos repositórios liberados`;
        return { reply: `${text}.`, line: { area: "repos", text, target: { id: repo.path, name: repo.name } } };
      }),
  );

  server.registerTool(
    "vault_update_meta",
    {
      description:
        "Muda a descrição ou os sites liberados de um segredo que já existe no cofre. Nunca mexe no valor. Restringir sites roda direto; liberar um site novo ou qualquer site pede aprovação.",
      inputSchema: {
        name: z.string().min(1).max(64),
        description: z.string().max(200).optional(),
        domains: z
          .array(z.string().max(253))
          .max(20)
          .optional()
          .describe("Lista completa de sites; [] = qualquer site"),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "vault_update_meta", `Ajustar o segredo ${String(args.name)}`, args, async (callId) => {
        const current = getSecretMeta(String(args.name));
        if (!current) throw new Error(`Não existe o segredo "${String(args.name)}" no cofre.`);
        const domains = args.domains === undefined ? current.domains : normalizeDomains(args.domains);
        const widened =
          args.domains !== undefined &&
          ((current.domains.length > 0 && domains.length === 0) ||
            (current.domains.length > 0 && domains.some((domain) => !current.domains.includes(domain))));
        const cleared = widened
          ? await askPerson(
              context,
              callId,
              `Posso liberar o segredo:${current.name} para ${domains.length ? domains.join(", ") : "qualquer site"}?`,
              "Liberar um segredo para um site novo passa por você.",
            )
          : undefined;
        startCall(context, callId, cleared);
        await saveSecretMeta(current.name, {
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.domains !== undefined ? { domains } : {}),
        });
        const parts = [
          ...(args.description !== undefined ? ["descrição"] : []),
          ...(args.domains !== undefined ? [`sites: ${domains.length ? domains.join(", ") : "qualquer site"}`] : []),
        ];
        const text = `Ajustou o segredo ${current.name}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
        return {
          reply: `${text}.`,
          line: {
            area: "vault",
            text,
            target: { id: current.name, name: current.name },
            undo: [
              {
                method: "PUT",
                path: `/vault/secrets/${encodeURIComponent(current.name)}`,
                body: { description: current.description, domains: current.domains },
              },
            ],
          },
        };
      }),
  );

  server.registerTool(
    "usage_get",
    {
      description: "Mostra os limites de uso de cada conta de IA (sessão de 5 h, semana) e quando renovam.",
      inputSchema: { refresh: z.boolean().optional().describe("true busca de novo agora, em vez do cache de 90 s") },
    },
    (args: Record<string, unknown>) =>
      runSetting(
        context,
        "usage_get",
        "Ver os limites de uso",
        args,
        async (callId) => {
          startCall(context, callId);
          const limits = await usageLimits(args.refresh === true);
          return {
            reply: `limites de ${limits.length} contas`,
            data: limits.map((item) => ({
              account: item.id,
              name: item.label,
              provider: item.provider,
              isDefault: item.isDefault,
              ok: item.ok,
              ...(item.error ? { error: item.error } : {}),
              windows: item.windows.map((window) => ({
                label: window.label,
                usedPercent: window.usedPercent,
                remainingPercent: window.remainingPercent,
                resetsAt: window.resetsAt,
              })),
            })),
          };
        },
        false,
      ),
  );

  server.registerTool(
    "account_update",
    {
      description: "Renomeia uma conta de IA ou marca como a padrão do provedor (Claude ou Codex).",
      inputSchema: {
        account: z.string().min(1).max(80).describe("Nome ou id da conta"),
        name: z.string().max(40).optional().describe("Nome novo; vazio volta ao automático"),
        isDefault: z.literal(true).optional(),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "account_update", `Ajustar a conta ${String(args.account)}`, args, async (callId) => {
        const accounts = await listAccounts();
        const account = resolveAccount(accounts, String(args.account));
        startCall(context, callId);
        const previousDefault = accounts.find((item) => item.provider === account.provider && item.isDefault);
        await updateAccount(account.id, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.isDefault === true ? { isDefault: true } : {}),
        });
        const shown =
          typeof args.name === "string" && args.name.trim() ? args.name.trim() : accountName(account, account.id);
        const parts = [
          ...(args.name !== undefined ? [`Renomeou a conta para ${shown}`] : []),
          ...(args.isDefault === true ? [`${shown} virou a conta padrão`] : []),
        ];
        const undo: UndoStep[] = [];
        if (args.name !== undefined)
          undo.push({ method: "PATCH", path: `/accounts/${account.id}`, body: { name: account.name || null } });
        if (args.isDefault === true && previousDefault && previousDefault.id !== account.id)
          undo.push({ method: "PATCH", path: `/accounts/${previousDefault.id}`, body: { isDefault: true } });
        const text = parts.join(" · ") || `Nada mudou em ${shown}`;
        return {
          reply: `${text}.`,
          line: {
            area: "accounts",
            areas: ["accounts", "usage", "bots"],
            text,
            target: { id: account.id, name: shown },
            thumbnail: { kind: "provider", id: account.provider },
            ...(undo.length ? { undo } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "integration_setup",
    {
      description:
        "Configura uma integração (elevenlabs, jev ou runelay) abrindo o formulário seguro no app: a pessoa cola a chave lá e o servidor confere e grava cifrado. Você nunca vê nem recebe a chave.",
      inputSchema: {
        integration: z.enum(integrationIds),
        reason: z.string().min(1).max(200).describe("Por que, em uma frase para a pessoa"),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "integration_setup", `Configurar ${String(args.integration)}`, args, async (callId) => {
        const id = String(args.integration) as IntegrationId;
        const definition = listIntegrations().find((item) => item.id === id);
        if (!definition) throw new Error(`Integração desconhecida: ${id}.`);
        if (context.isSchedule)
          throw new SettingsDenied("Ninguém está aqui para preencher o formulário agora. Avise na próxima conversa.");
        const before = readStored(id)?.validatedAt ?? null;
        const { choice, interactionId } = await context.requestApproval(
          `${context.bot.name} quer configurar ${definition.name}: ${String(args.reason)}`,
          callId,
          context.origin,
          {
            reason: String(args.reason),
            integration: {
              id,
              name: definition.name,
              description: definition.description,
              unlocks: definition.unlocks,
              keyUrl: definition.keyUrl,
              needsUrl: definition.needsUrl,
              url: definition.url,
              status: definition.status,
              path: `/integrations/${id}`,
            },
          },
        );
        if (choice !== "approve")
          throw new SettingsDenied("A pessoa preferiu não configurar agora. Não peça de novo neste turno.");
        const after = readStored(id)?.validatedAt ?? null;
        if (!after || after === before)
          throw new Error("O formulário fechou sem salvar a chave. Pergunte se a pessoa quer tentar de novo.");
        startCall(context, callId, { interactionId });
        const text = `Configurou ${definition.name}`;
        return {
          reply: `${text}. A chave foi conferida e está guardada cifrada no servidor.`,
          line: {
            area: "integrations",
            text,
            target: { id, name: definition.name },
            thumbnail: { kind: "integration", id },
          },
        };
      }),
  );

  server.registerTool(
    "connector_connect",
    {
      description:
        "Conecta um serviço novo na runelay da pessoa (Linear, GitHub, Sentry…), ou refaz o login de um que caiu. Mostra um card com o botão Conectar; o login é da pessoa. Depois confira com settings_get.",
      inputSchema: { service: z.string().min(1).max(60).describe("Nome do serviço, como sentry ou google drive") },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "connector_connect", `Conectar ${String(args.service)}`, args, async (callId) => {
        if (!runelayEnabled())
          throw new Error("A runelay não está configurada. Use integration_setup com runelay antes.");
        const catalog = await getCatalog(String(args.service));
        const items = [...catalog.featured, ...catalog.sections.flatMap((section) => section.items)];
        const item = pick(items, String(args.service), (entry) => [entry.id, entry.name, entry.sourceName ?? ""]);
        if (!item) throw new Error(`Não achei "${String(args.service)}" no catálogo da runelay.`);
        if (item.installed && item.status === "ok") {
          startCall(context, callId);
          return { reply: `${item.name} já está conectado (${item.sourceName}).` };
        }
        if (!item.installed && item.auth === "api_key")
          throw new Error(
            `${item.name} pede um token. Peça para a pessoa colar em Ajustes › Conectores; você nunca recebe o token.`,
          );
        startCall(context, callId);
        const started =
          item.installed && item.sourceName
            ? await reconnectSource(item.sourceName)
            : await installCatalogItem(item.id);
        const url = started.authorizationUrl;
        const text = url ? `Conectar ${item.name}` : `Conectou ${item.name}`;
        return {
          reply: url
            ? `Mostrei o botão Conectar para ${item.name}. Depois que a pessoa fizer o login, confira com settings_get.`
            : `${item.name} conectado (${started.sourceName}).`,
          output: { ok: true, sourceName: started.sourceName, needsLogin: Boolean(url) },
          line: {
            area: "connectors",
            text,
            target: { id: started.sourceName, name: item.name },
            thumbnail: { kind: "connector", id: item.icon ?? item.id },
            ...(url ? { action: { label: "Conectar", url } } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "preferences_set",
    {
      description:
        "Muda as preferências do app no Mac: quais notificações chegam (replies, approvals, routines, failures) e o microfone padrão (nome, ou system para o padrão do sistema).",
      inputSchema: {
        notifications: z
          .object({
            replies: z.boolean().optional(),
            approvals: z.boolean().optional(),
            routines: z.boolean().optional(),
            failures: z.boolean().optional(),
          })
          .optional(),
        microphone: z.string().max(120).optional(),
      },
    },
    (args: Record<string, unknown>) =>
      runSetting(context, "preferences_set", "Mudar as preferências do app", args, async (callId) => {
        const current = await readPreferences();
        const body: Record<string, unknown> = {};
        const parts: string[] = [];
        const notifications = (args.notifications ?? {}) as Record<string, boolean>;
        if (Object.keys(notifications).length > 0) {
          body.notifications = notifications;
          for (const [key, value] of Object.entries(notifications))
            parts.push(
              `${value ? "Ligou" : "Desligou"} ${notificationLabels[key as keyof typeof notificationLabels].toLowerCase()}`,
            );
        }
        if (typeof args.microphone === "string") {
          const wanted = args.microphone;
          const system = ["system", "sistema", "padrao", "padrão do sistema", "default"].includes(normalize(wanted));
          const found = system ? null : pick(current.microphones, wanted, (item) => [item]);
          if (!system && !found)
            throw new Error(
              `Não achei o microfone "${wanted}". Microfones do Mac: ${current.microphones.join(", ") || "o app ainda não informou"}.`,
            );
          body.microphone = found;
          parts.push(`Microfone: ${found ?? "padrão do sistema"}`);
        }
        if (parts.length === 0) throw new Error("Diga o que mudar: notifications ou microphone.");
        startCall(context, callId);
        await updatePreferences(body);
        const text = parts.join(" · ");
        return {
          reply: `${text}.`,
          line: {
            area: "preferences",
            text,
            target: { id: "preferences", name: "Preferências" },
            undo: [
              {
                method: "PATCH",
                path: "/preferences",
                body: { notifications: current.notifications, microphone: current.microphone },
              },
            ],
          },
        };
      }),
  );
}

async function updateBotSettings(
  context: ToolContext,
  callId: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const target = findBot(args.bot as string | undefined, context.bot);
  const self = target.id === context.bot.id;
  const body: Record<string, unknown> = {};
  const undoBody: Record<string, unknown> = {};
  const parts: string[] = [];
  const areas: SettingsArea[] = ["bots"];
  if (typeof args.name === "string" && args.name !== target.name) {
    body.name = args.name;
    undoBody.name = target.name;
    parts.push(`Renomeou para ${args.name}`);
  }
  if (typeof args.role === "string" && args.role !== target.role) {
    body.role = args.role;
    undoBody.role = target.role;
    parts.push(`Papel: ${args.role}`);
  }
  if (typeof args.accent === "string" && args.accent !== target.accent) {
    body.accent = args.accent;
    undoBody.accent = target.accent;
  }
  if (typeof args.glyph === "string" && args.glyph !== target.glyph) {
    body.glyph = args.glyph;
    undoBody.glyph = target.glyph;
  }
  if (body.accent !== undefined || body.glyph !== undefined) parts.push("Mudou o rosto");
  const engine: BotEngine = target.engine ?? defaultEngine();
  const engineChange: Record<string, unknown> = {};
  let accountsCache: Account[] | null = null;
  const accounts = async () => {
    accountsCache ??= await listAccounts();
    return accountsCache;
  };
  let nextAccount: Account | undefined;
  if (typeof args.account === "string" || typeof args.model === "string") {
    const all = await accounts();
    nextAccount =
      typeof args.account === "string"
        ? resolveAccount(all, args.account)
        : all.find((item) => item.id === engine.account);
    if (nextAccount && nextAccount.id !== engine.account) engineChange.account = nextAccount.id;
    if (typeof args.model === "string") {
      const model = resolveModel(nextAccount, args.model);
      if (model !== engine.model || engineChange.account) engineChange.model = model;
    }
  }
  if (typeof args.effort === "string") {
    const effort = args.effort === "auto" ? null : args.effort;
    if (effort !== engine.effort) {
      engineChange.effort = effort;
      parts.push(`Esforço: ${effort ?? "automático"}`);
    }
  }
  if (args.fallback !== undefined) {
    if (args.fallback === "off") {
      if (engine.fallback !== null) {
        engineChange.fallback = null;
        parts.push("Sem conta reserva");
      }
    } else {
      const raw = args.fallback as { account: string; model?: string };
      const all = await accounts();
      const reserve = resolveAccount(all, raw.account);
      const model = raw.model ? resolveModel(reserve, raw.model) : undefined;
      engineChange.fallback = { account: reserve.id, ...(model ? { model } : {}) };
      parts.push(`Reserva: ${accountName(reserve, reserve.id)}${model ? ` · ${modelLabel(reserve, model)}` : ""}`);
    }
  }
  if (typeof args.autoSwitch === "boolean" && args.autoSwitch !== (engine.autoSwitch === true)) {
    engineChange.autoSwitch = args.autoSwitch;
    parts.push(args.autoSwitch ? "Pode trocar de modelo quando achar melhor" : "Só troca de modelo quando pedirem");
  }
  if (engineChange.account !== undefined || engineChange.model !== undefined) {
    const label = accountName(nextAccount, String(engineChange.account ?? engine.account));
    const model = modelLabel(nextAccount, String(engineChange.model ?? engine.model));
    parts.unshift(`Trocou para ${label} · ${model}`);
    areas.push("usage");
  }
  if (Object.keys(engineChange).length > 0) {
    body.engine = engineChange;
    undoBody.engine = {
      account: engine.account,
      model: engine.model,
      effort: engine.effort,
      ...(engine.fallback === undefined ? {} : { fallback: engine.fallback }),
      autoSwitch: engine.autoSwitch === true,
    };
  }
  if (args.voice) {
    const raw = args.voice as { voice?: string; speed?: number; language?: string };
    const voice: Record<string, unknown> = {};
    const current = voiceOf(target);
    if (raw.voice) {
      const voices = await listVoices().catch(() => []);
      const found = pick(voices, raw.voice, (item) => [item.voiceId, item.name]);
      if (!found && !/^[A-Za-z0-9]{8,64}$/.test(raw.voice))
        throw new Error(
          `Não achei a voz "${raw.voice}". Vozes: ${
            voices
              .slice(0, 20)
              .map((item) => item.name)
              .join(", ") || "a ElevenLabs não respondeu"
          }.`,
        );
      voice.voiceId = found?.voiceId ?? raw.voice;
      parts.push(`Voz: ${found?.name ?? raw.voice}`);
    }
    if (raw.speed !== undefined) {
      voice.speed = raw.speed;
      parts.push(`Velocidade da voz ${raw.speed}`);
    }
    if (raw.language) {
      voice.language = raw.language;
      parts.push(`Idioma da voz ${raw.language}`);
    }
    if (Object.keys(voice).length) {
      body.voice = voice;
      undoBody.voice = current;
    }
  }
  const sidebar = sidebarOf(target);
  const sidebarBody: Record<string, unknown> = {};
  const sidebarUndo: Record<string, unknown> = {};
  if (typeof args.pinned === "boolean" && args.pinned !== sidebar.pinned) {
    sidebarBody.pinned = args.pinned;
    sidebarUndo.pinned = sidebar.pinned;
    parts.push(args.pinned ? "Fixou na barra lateral" : "Desafixou");
  }
  let createdSection: string | null = null;
  if (typeof args.section === "string") {
    const none = ["none", "nenhuma", "sem secao", ""].includes(normalize(args.section));
    let sectionId: string | null = null;
    if (!none) {
      const found = pick(listSections(), args.section, (section) => [section.id, section.name]);
      if (found) sectionId = found.id;
      else {
        const created = await createSection({ name: args.section });
        sectionId = created.id;
        createdSection = created.id;
        areas.push("sections");
      }
    }
    if (sectionId !== sidebar.sectionId) {
      sidebarBody.sectionId = sectionId;
      sidebarUndo.sectionId = sidebar.sectionId;
      parts.push(none ? "Tirou da seção" : `Moveu para a seção ${args.section}${createdSection ? " (nova)" : ""}`);
    }
  }
  let permissionUndo: UndoStep | null = null;
  let cleared: Record<string, unknown> | undefined;
  let applyPermission: (() => Promise<unknown>) | null = null;
  if (typeof args.permission === "string" && isPermissionMode(args.permission)) {
    const mode = args.permission;
    const session = args.permissionScope === "bot" || !self ? undefined : getStoredSession(context.sessionId);
    const scope = session ? "conversation" : "bot";
    const from: PermissionMode = scope === "conversation" ? (context.permission ?? "default") : permissionOfBot(target);
    if (mode !== from) {
      if (permissionRank[mode] > permissionRank[from]) {
        cleared = await askPerson(
          context,
          callId,
          `Posso subir o modo de permissão ${self ? (scope === "conversation" ? "desta conversa" : "do meu padrão") : `de ${target.name}`} de ${permissionLabels[from]} para ${permissionLabels[mode]}?`,
          "Subir o modo de permissão sempre passa por você: um texto lido numa página não pode dar mais acesso a um bot.",
        );
      }
      if (session) {
        const previous = session.meta.permission ?? null;
        applyPermission = () => updateConversation(session, { permission: mode });
        permissionUndo = {
          method: "PATCH",
          path: `/bots/${target.id}/conversations/${session.meta.sessionId}`,
          body: { permission: previous },
        };
        areas.push("conversations");
      } else {
        body.permission = mode;
        undoBody.permission = permissionOfBot(target);
      }
      parts.push(
        `Modo ${scope === "conversation" ? "desta conversa" : "padrão"}: ${permissionLabels[mode]}${permissionRank[mode] > permissionRank[from] ? " (você aprovou)" : ""}`,
      );
    }
  }
  if (parts.length === 0) {
    startCall(context, callId, cleared);
    return { reply: `Nada mudou: ${target.name} já estava assim.` };
  }
  startCall(context, callId, cleared);
  if (Object.keys(body).length) await updateBot(target.id, body);
  if (Object.keys(sidebarBody).length) await updateSidebar(target.id, sidebarBody, sectionExists);
  if (applyPermission) await applyPermission();
  const undo: UndoStep[] = [];
  if (Object.keys(undoBody).length) undo.push({ method: "PATCH", path: `/bots/${target.id}`, body: undoBody });
  if (Object.keys(sidebarUndo).length)
    undo.push({ method: "PATCH", path: `/bots/${target.id}/sidebar`, body: sidebarUndo });
  if (permissionUndo) undo.push(permissionUndo);
  const text = parts.join(" · ");
  const shownName = typeof body.name === "string" ? body.name : target.name;
  return {
    reply: `${self ? "" : `${target.name}: `}${text}.${self && (body.engine || body.permission || applyPermission) ? " Vale a partir da próxima mensagem." : ""}`,
    output: { ok: true, summary: text, bot: target.id },
    line: {
      area: "bots",
      areas,
      text: self ? text : `${target.name}: ${text}`,
      target: { id: target.id, name: shownName },
      thumbnail: { kind: "bot", id: target.id },
      otherBot: !self,
      ...(undo.length ? { undo } : {}),
    },
  };
}
