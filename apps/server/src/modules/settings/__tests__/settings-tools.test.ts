import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type ContextOptions,
  connectMcp,
  factsOfType,
  makeBot,
  newSession,
  textOf,
  toolContext,
} from "../../../../test/engine-helpers";
import { resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { resetLanguageState, setLanguagePreference } from "../../../shared/i18n";
import * as accounts from "../../accounts/services/accounts.service";
import { type BotDefinition, getBot, sidebarOf, updateBot } from "../../bots/services/bots.service";
import { addAllowedRepo, allowedRepos, loadAllowedRepos, removeAllowedRepo } from "../../code/services/repos.service";
import * as runelay from "../../connectors/services/runelay.service";
import type { StoredSession } from "../../conversations/services/sessions.service";
import * as store from "../../integrations/services/integration-store.service";
import * as scheduler from "../../schedules/services/scheduler.service";
import { createSection, listSections } from "../../sections/services/sections.service";
import * as projects from "../../servers/services/projects.service";
import * as servers from "../../servers/services/servers.service";
import * as usage from "../../usage/services/usage.service";
import { getSecretMeta, saveSecretMeta } from "../../vault/services/vault.service";
import * as voice from "../../voice/services/voice.service";
import { readPreferences, updatePreferences } from "../services/preferences.service";
import { onSettingsChange, type SettingsArea } from "../services/settings-events.service";
import {
  findBot,
  normalize,
  resolveAccount,
  resolveModel,
  type SettingsState,
} from "../services/settings-tools.service";

let server: TestServer;
let bot: BotDefinition;
let session: StoredSession;
const clients: Client[] = [];
const revokes: Array<() => unknown> = [];
const restores: Array<{ mockRestore: () => void }> = [];
const repoRoot = mkdtempSync(join(tmpdir(), "rb-settings-"));
const changes: SettingsArea[][] = [];
const stopChanges = onSettingsChange((areas) => changes.push(areas));

const claude: accounts.Account = {
  id: "vps:claude",
  runner: "vps",
  provider: "claude",
  label: "Claude Trabalho",
  name: "Claude Trabalho",
  autoName: "Claude",
  email: null,
  plan: null,
  configDir: null,
  isDefault: true,
  added: false,
  status: "ready",
  models: [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  ],
  detail: "",
  checkedAt: "",
};
const alex: accounts.Account = {
  ...claude,
  id: "claude-2:claude",
  label: "Claude Alex",
  name: "Claude Alex",
  isDefault: false,
};
const codex: accounts.Account = {
  ...claude,
  id: "vps:codex",
  provider: "codex",
  label: "Codex",
  name: "Codex",
  models: [{ id: "gpt-5.6-sol", label: "GPT 5.6" }],
};

function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const created = spyOn(target, key as never) as unknown as { mockRestore: () => void } & ReturnType<typeof spyOn>;
  restores.push(created);
  return created;
}

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  stopChanges();
  rmSync(repoRoot, { recursive: true, force: true });
  await server.close();
});

beforeEach(async () => {
  await resetData();
  bot = await makeBot({ engine: { account: "vps:claude", model: "claude-opus-5-5" } });
  session = await newSession(bot.id);
  changes.length = 0;
  spy(accounts, "listAccounts").mockResolvedValue([claude, alex, codex]);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const revoke of revokes.splice(0)) revoke();
  for (const item of restores.splice(0)) item.mockRestore();
});

async function open(options: ContextOptions = {}, target: BotDefinition = bot) {
  const harness = toolContext(target, session, options);
  revokes.push(harness.revoke);
  const client = await connectMcp(`${server.url}/mcp/${target.id}/${session.meta.sessionId}`, harness.context.token);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
    const text = textOf(result);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { text, json, isError: result.isError === true };
  };
  return { ...harness, call };
}

async function lines() {
  return (await factsOfType(session, "settings.changed")).map((fact) => fact.data);
}

describe("helpers", () => {
  test("normalize, findBot, resolveAccount and resolveModel match by name or id", async () => {
    expect(normalize("  Ação ")).toBe("acao");
    const other = await makeBot({ name: "Revisora Ágil" });
    expect(findBot(undefined, bot).id).toBe(bot.id);
    expect(findBot("revisora agil", bot).id).toBe(other.id);
    expect(findBot("revis", bot).id).toBe(other.id);
    expect(() => findBot("ninguém", bot)).toThrow('Não achei o bot "ninguém".');
    expect(resolveAccount([claude, alex], "claude alex").id).toBe("claude-2:claude");
    expect(() => resolveAccount([claude], "grok")).toThrow("Contas: Claude Trabalho (vps:claude).");
    expect(resolveModel(claude, "sonnet")).toBe("claude-sonnet-5-5");
    expect(resolveModel(undefined, "qualquer")).toBe("qualquer");
    expect(() => resolveModel(codex, "opus")).toThrow("Modelos: GPT 5.6.");
  });
});

describe("settings_get", () => {
  test("shows the bot and the workspace without secret values", async () => {
    await saveSecretMeta("github-token", { description: "Token do GitHub", domains: ["github.com"] });
    for (const repo of await loadAllowedRepos()) await removeAllowedRepo(repo.path);
    await addAllowedRepo(repoRoot, "teste", null);
    await updatePreferences({ microphones: ["MacBook Air", "USB"] });
    spy(runelay, "runelayEnabled").mockReturnValue(true);
    spy(runelay, "listConnections").mockResolvedValue([
      { name: "linear_server", label: "Linear", status: "ok" } as runelay.Connection,
    ]);
    spy(servers, "listProfiles").mockResolvedValue([
      { id: "web", name: "Web", path: repoRoot, cwd: "", script: "dev", cmd: null, port: 3000 },
    ]);
    await updateBot(bot.id, {
      schedules: [{ name: "Ronda", cron: "0 9 * * *", prompt: "x".repeat(400), paused: true }],
      engine: { fallback: { account: "claude-2:claude", model: "claude-sonnet-5-5" } },
    });
    const section = await createSection({ name: "Operação" });
    const { updateSidebar } = await import("../../bots/services/bots.service");
    await updateSidebar(bot.id, { sectionId: section.id, pinned: true }, () => true);
    const { call, settled } = await open({ permission: "edit" });
    const result = await call("settings_get");
    expect(result.isError).toBe(false);
    const state = result.json as SettingsState;
    expect(state.bot).toMatchObject({
      id: bot.id,
      self: true,
      engine: {
        accountName: "Claude Trabalho",
        modelLabel: "Opus 5.5",
        fallback: { accountName: "Claude Alex" },
        autoSwitch: false,
      },
      permission: { bot: "default", conversation: null, effective: "edit" },
      section: "Operação",
      pinned: true,
    });
    expect(state.bot.schedules[0]).toMatchObject({ name: "Ronda", paused: true });
    expect(state.bot.schedules[0].prompt).toHaveLength(300);
    expect(state.vault).toEqual([
      { name: "github-token", ref: "segredo:github-token", description: "Token do GitHub", domains: ["github.com"] },
    ]);
    expect(state.repos).toEqual([{ name: expect.any(String), path: repoRoot }]);
    expect(state.connectors).toEqual([{ name: "linear_server", label: "Linear", status: "ok" }]);
    expect(state.serverProfiles[0]).toMatchObject({ name: "Web", script: "dev" });
    expect(state.preferences).toMatchObject({
      microphone: "padrão do sistema",
      microphones: ["MacBook Air", "USB"],
      language: "system",
    });
    expect(state.options.languages).toEqual(["system", "pt-BR", "en"]);
    expect(state.accounts.map((item) => item.id)).toEqual(["vps:claude", "claude-2:claude", "vps:codex"]);
    expect(state.options.permissionModes).toHaveLength(4);
    expect(settled.at(-1)).toBe(`settings_get → ajustes de ${bot.name}`);
    expect(await lines()).toEqual([]);
  });

  test("shows another bot by name and fails for an unknown one", async () => {
    const other = await makeBot({ name: "Outra Pessoa", engine: { fallback: null } });
    const { call } = await open();
    const state = (await call("settings_get", { bot: "outra" })).json as SettingsState;
    expect(state.bot).toMatchObject({
      id: other.id,
      self: false,
      permission: { bot: "default" },
      engine: { fallback: null },
    });
    expect(state.bot.permission).not.toHaveProperty("effective");
    expect(state.connectors).toBeNull();
    const missing = await call("settings_get", { bot: "ninguém com esse nome" });
    expect(missing).toMatchObject({ isError: true, text: 'Não achei o bot "ninguém com esse nome".' });
  });
});

describe("failures", () => {
  test("settings_get survives failing sources and errors come back as tool errors", async () => {
    spy(accounts, "listAccounts").mockRejectedValue(new Error("sem contas"));
    spy(servers, "listProfiles").mockRejectedValue(new Error("sem banco"));
    spy(runelay, "runelayEnabled").mockReturnValue(true);
    spy(runelay, "listConnections").mockRejectedValue(new Error("offline"));
    spy(voice, "listVoices").mockRejectedValue(new Error("sem chave"));
    const { call, settled } = await open();
    const state = (await call("settings_get")).json as SettingsState;
    expect(state).toMatchObject({ accounts: [], serverProfiles: [], connectors: null });
    expect(state.bot.engine.accountName).toBe("vps:claude");
    const voiceless = await call("bot_update", { voice: { voice: "Bia" } });
    expect(voiceless.text).toBe('Não achei a voz "Bia". Vozes: a ElevenLabs não respondeu.');
    const blank = await call("section_update", { name: " " });
    expect(blank).toMatchObject({ isError: true, text: "O nome da seção não pode ficar vazio." });
    expect(settled.at(-1)).toBe("section_update → erro: O nome da seção não pode ficar vazio.");
  });
});

describe("bot_update", () => {
  test("switches account and model and offers undo", async () => {
    const { call, approvals } = await open();
    const result = await call("bot_update", { account: "Claude Alex", model: "sonnet" });
    expect(result.text).toBe("Trocou para Claude Alex · Sonnet 5.5. Vale a partir da próxima mensagem.");
    expect(getBot(bot.id)?.engine).toMatchObject({ account: "claude-2:claude", model: "claude-sonnet-5-5" });
    expect(approvals).toHaveLength(0);
    const [line] = await lines();
    expect(line).toMatchObject({
      area: "bots",
      areas: ["bots", "usage"],
      text: "Trocou para Claude Alex · Sonnet 5.5",
      thumbnail: { kind: "bot", id: bot.id },
      otherBot: false,
      by: "bot",
      undo: [
        {
          method: "PATCH",
          path: `/bots/${bot.id}`,
          body: {
            engine: {
              account: "vps:claude",
              model: "claude-opus-5-5",
              effort: null,
              autoSwitch: false,
            },
          },
        },
      ],
    });
    expect(changes.at(-1)).toEqual(["bots", "usage"]);
    const back = await call("bot_update", { account: "vps:claude", model: "claude-opus-5-5" });
    expect(back.text).toBe("Trocou para Claude Trabalho · Opus 5.5. Vale a partir da próxima mensagem.");
    const modelOnly = await call("bot_update", { model: "sonnet" });
    expect(modelOnly.text).toBe("Trocou para Claude Trabalho · Sonnet 5.5. Vale a partir da próxima mensagem.");
    const bad = await call("bot_update", { model: "gpt" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Modelos: Opus 5.5, Sonnet 5.5.");
  });

  test("changes effort, reserve, auto switch and voice, and says when nothing changed", async () => {
    spy(voice, "listVoices").mockResolvedValue([
      {
        voiceId: "abcdefgh1234",
        name: "Bia",
        category: "",
        language: null,
        accent: null,
        gender: null,
        description: null,
        previewUrl: null,
      },
    ]);
    const { call } = await open();
    const result = await call("bot_update", {
      effort: "high",
      fallback: { account: "codex" },
      autoSwitch: true,
      voice: { voice: "bia", speed: 1.1, language: "en" },
    });
    expect(result.text).toBe(
      "Esforço: high · Reserva: Codex · Pode trocar de modelo quando achar melhor · Voz: Bia · Velocidade da voz 1.1 · Idioma da voz en. Vale a partir da próxima mensagem.",
    );
    const updated = getBot(bot.id);
    expect(updated?.engine).toMatchObject({ effort: "high", fallback: { account: "vps:codex" }, autoSwitch: true });
    expect(updated?.voice).toMatchObject({ voiceId: "abcdefgh1234", speed: 1.1, language: "en" });
    const off = await call("bot_update", { effort: "auto", fallback: "off", autoSwitch: false });
    expect(off.text).toBe(
      "Esforço: automático · Sem conta reserva · Só troca de modelo quando pedirem. Vale a partir da próxima mensagem.",
    );
    expect(getBot(bot.id)?.engine?.autoSwitch).toBeUndefined();
    const reserve = await call("bot_update", { fallback: { account: "alex", model: "sonnet" } });
    expect(reserve.text).toBe("Reserva: Claude Alex · Sonnet 5.5. Vale a partir da próxima mensagem.");
    expect((await call("bot_update", { fallback: "off" })).text).toBe(
      "Sem conta reserva. Vale a partir da próxima mensagem.",
    );
    expect((await call("bot_update", { fallback: "off", effort: "auto" })).text).toBe(
      `Nada mudou: ${bot.name} já estava assim.`,
    );
    const missingVoice = await call("bot_update", { voice: { voice: "Zé" } });
    expect(missingVoice.text).toContain('Não achei a voz "Zé". Vozes: Bia.');
    const rawVoice = await call("bot_update", { voice: { voice: "ZZZZZZZZ9999" } });
    expect(rawVoice.text).toBe("Voz: ZZZZZZZZ9999.");
  });

  test("renames, changes the face, pins and moves another bot, creating the section", async () => {
    const other = await makeBot({ name: "Vigia" });
    const { call } = await open();
    const result = await call("bot_update", {
      bot: "vigia",
      name: "Vigia Noturno",
      role: "Ronda",
      accent: "teal",
      glyph: "visor",
      pinned: true,
      section: "Produção",
    });
    expect(result.text).toBe(
      "Vigia: Renomeou para Vigia Noturno · Papel: Ronda · Mudou o rosto · Fixou na barra lateral · Moveu para a seção Produção (nova).",
    );
    const updated = getBot(other.id);
    expect(updated).toMatchObject({ name: "Vigia Noturno", role: "Ronda", accent: "teal", glyph: "visor" });
    const section = listSections().find((item) => item.name === "Produção");
    expect(updated && sidebarOf(updated)).toMatchObject({ pinned: true, sectionId: section?.id });
    const [line] = await lines();
    expect(line).toMatchObject({
      otherBot: true,
      areas: ["bots", "sections"],
      target: { id: other.id, name: "Vigia Noturno" },
      undo: [
        {
          method: "PATCH",
          path: `/bots/${other.id}`,
          body: { name: "Vigia", role: "Tester", accent: "blue", glyph: "auto" },
        },
        { method: "PATCH", path: `/bots/${other.id}/sidebar`, body: { pinned: false, sectionId: null } },
      ],
    });
    const existing = await createSection({ name: "Time" });
    expect((await call("bot_update", { bot: other.id, section: "time", pinned: false })).text).toBe(
      "Vigia Noturno: Desafixou · Moveu para a seção time.",
    );
    expect(getBot(other.id) && sidebarOf(getBot(other.id) as BotDefinition).sectionId).toBe(existing.id);
    expect((await call("bot_update", { bot: other.id, section: "none" })).text).toBe("Vigia Noturno: Tirou da seção.");
  });

  test("lowers the permission directly and asks a person, never Jev, to raise it", async () => {
    const lower = await open({ permission: "default" });
    expect((await lower.call("bot_update", { permission: "readonly" })).text).toBe(
      "Modo desta conversa: Somente leitura. Vale a partir da próxima mensagem.",
    );
    expect(session.meta.permission).toBe("readonly");
    expect(lower.approvals).toHaveLength(0);
    expect((await lines())[0]).toMatchObject({
      areas: ["bots", "conversations"],
      undo: [
        {
          method: "PATCH",
          path: `/bots/${bot.id}/conversations/${session.meta.sessionId}`,
          body: { permission: null },
        },
      ],
    });

    const denied = await open({ permission: "readonly", approve: () => "deny" });
    const refused = await denied.call("bot_update", { permission: "full" });
    expect(refused).toMatchObject({
      isError: true,
      text: "A pessoa negou essa mudança. Não tente de novo sem ela pedir.",
    });
    expect(denied.approvals[0]?.prompt).toBe(
      "Posso subir o modo de permissão desta conversa de Somente leitura para Acesso total?",
    );
    expect(denied.decisions.at(-1)).toMatchObject({ outcome: "human", model: null });
    expect(session.meta.permission).toBe("readonly");
    const rejected = (await factsOfType(session, "call.settled")).at(-1)?.data;
    expect(rejected).toMatchObject({ outcome: "rejected", error: { code: "TOOL_EXECUTION_DENIED" } });

    const full = await open({ permission: "full" });
    const raised = await full.call("bot_update", { permission: "full", permissionScope: "bot" });
    expect(raised.text).toBe("Modo padrão: Acesso total (você aprovou). Vale a partir da próxima mensagem.");
    expect(full.approvals).toHaveLength(1);
    expect(getBot(bot.id)?.permission).toBe("full");
    expect((await factsOfType(session, "call.started")).at(-1)?.data).toMatchObject({
      clearedBy: { interactionId: "int_1" },
    });

    const other = await makeBot({ name: "Outro Bot" });
    const routine = await open({ permission: "full", isSchedule: true });
    const blocked = await routine.call("bot_update", { bot: other.id, permission: "full" });
    expect(blocked.text).toBe("Ninguém está aqui para aprovar isso agora. Não tente de novo nesta rotina.");
    expect(getBot(other.id)?.permission).toBeUndefined();
    const down = await routine.call("bot_update", { bot: other.id, permission: "edit" });
    expect(down.text).toBe("Outro Bot: Modo padrão: Editar.");
    expect(getBot(other.id)?.permission).toBe("edit");
  });

  test("reports an invalid value from the bot service", async () => {
    const { call } = await open();
    const result = await call("bot_update", { name: "x".repeat(40), bot: "nobody" });
    expect(result).toMatchObject({ isError: true, text: 'Não achei o bot "nobody".' });
  });
});

describe("read only", () => {
  test("blocks writes, keeps reads and still lets the person approve leaving read only", async () => {
    const { call, approvals, decisions } = await open({ permission: "readonly" });
    expect((await call("settings_get")).isError).toBe(false);
    const blocked = await call("bot_update", { name: "Outro nome" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("Somente leitura");
    expect(decisions.at(-1)).toMatchObject({ outcome: "blocked", tool: "bot_update" });
    expect((await call("section_update", { name: "X" })).text).toContain("Somente leitura");
    expect(getBot(bot.id)?.name).toBe(bot.name);
    expect((await call("bot_update", { permission: "edit" })).isError).toBe(false);
    expect(approvals).toHaveLength(1);
    expect(session.meta.permission).toBe("edit");
  });
});

describe("bot_archive and section_update", () => {
  test("archives and restores a bot", async () => {
    const other = await makeBot({ name: "Antigo" });
    const { call } = await open();
    expect((await call("bot_archive", { bot: "antigo" })).text).toBe("Arquivou Antigo.");
    expect(getBot(other.id)?.archivedAt).toBeTruthy();
    expect((await lines())[0]).toMatchObject({ undo: [{ method: "POST", path: `/bots/${other.id}/unarchive` }] });
    expect((await call("bot_archive", { bot: "antigo", archived: false })).text).toBe("Restaurou Antigo.");
    expect(getBot(other.id)?.archivedAt).toBeNull();
  });

  test("labels calls and writes lines in the saved language", async () => {
    await makeBot({ name: "Antigo" });
    setLanguagePreference("en");
    const { call } = await open();
    expect((await call("bot_archive", { bot: "antigo" })).text).toBe("Archived Antigo.");
    expect((await lines()).at(-1)).toMatchObject({ text: "Archived Antigo" });
    const requested = (await factsOfType(session, "call.requested")).map((fact) => fact.data);
    expect(requested.at(-1)).toMatchObject({ capability: { label: "Archive antigo" } });
    expect((await call("section_update", { name: "Clients" })).text).toBe("Created the section Clients.");
  });

  test("creates and renames a section", async () => {
    const { call } = await open();
    expect((await call("section_update", { name: "Clientes" })).text).toBe("Criou a seção Clientes.");
    const created = listSections().find((item) => item.name === "Clientes");
    expect((await lines())[0]).toMatchObject({ undo: [{ method: "POST", path: `/sections/${created?.id}/archive` }] });
    expect((await call("section_update", { section: "clientes", name: "Contas" })).text).toBe(
      "Renomeou a seção Clientes para Contas.",
    );
    expect((await lines())[1]).toMatchObject({
      undo: [{ method: "PATCH", path: `/sections/${created?.id}`, body: { name: "Clientes" } }],
    });
    expect((await call("section_update", { section: "nada", name: "X" })).text).toBe('Não achei a seção "nada".');
  });
});

describe("schedules", () => {
  beforeEach(async () => {
    await updateBot(bot.id, { schedules: [{ name: "Ronda de produção", cron: "0 9 * * *", prompt: "Confira." }] });
  });

  test("pauses, resumes, edits and renames a routine", async () => {
    const { call } = await open();
    expect((await call("schedule_update", { name: "ronda", paused: true })).text).toBe(
      "Pausou a rotina Ronda de produção.",
    );
    expect(getBot(bot.id)?.schedules[0]?.paused).toBe(true);
    expect((await lines())[0]).toMatchObject({
      areas: ["schedules", "bots"],
      undo: [
        {
          method: "PATCH",
          path: `/bots/${bot.id}`,
          body: { schedules: [expect.objectContaining({ name: "Ronda de produção" })] },
        },
      ],
    });
    expect((await call("schedule_update", { name: "ronda", paused: false, cron: "0 10 * * *" })).text).toBe(
      "Retomou a rotina Ronda de produção · horário 0 10 * * *.",
    );
    expect(getBot(bot.id)?.schedules[0]).not.toHaveProperty("paused");
    const edited = await call("schedule_update", {
      name: "ronda",
      timezone: "UTC",
      prompt: "Outra coisa.",
      description: "Diária",
      rename: "Ronda",
    });
    expect(edited.text).toBe(
      "Mudou a rotina Ronda de produção: fuso UTC · pedido novo · descrição nova · renomeou para Ronda.",
    );
    expect((await call("schedule_update", { name: "Ronda", cron: "0 10 * * *" })).text).toBe(
      "A rotina Ronda já estava assim.",
    );
    const missing = await call("schedule_update", { name: "zzz" });
    expect(missing.text).toBe(`${bot.name} não tem a rotina "zzz". Rotinas: Ronda.`);
  });

  test("runs a routine now and refuses an archived bot or a missing routine", async () => {
    const fire = spy(scheduler, "fire").mockResolvedValue({ sessionId: "wrun_x", deliveryId: "d1" });
    const { call } = await open();
    const result = await call("schedule_run", { name: "ronda" });
    expect(result.text).toBe(`Rodou agora a rotina Ronda de produção. O resultado chega na conversa de ${bot.name}.`);
    expect(fire).toHaveBeenCalledWith(bot.id, "Ronda de produção", "Confira.");
    expect((await call("schedule_run", { name: "zzz" })).text).toBe(`${bot.name} não tem a rotina "zzz".`);
    fire.mockResolvedValue(null);
    expect((await call("schedule_run", { name: "ronda" })).text).toBe("Não consegui abrir a conversa do bot.");
    const other = await makeBot({ name: "Parado" });
    await updateBot(other.id, {});
    const { setArchived } = await import("../../bots/services/bots.service");
    await setArchived(other.id, true);
    expect((await call("schedule_run", { bot: "parado", name: "x" })).text).toBe("Parado está arquivado.");
  });
});

describe("server profiles and repos", () => {
  test("saves a profile by project, asks before a free command and deletes with undo", async () => {
    spy(projects, "resolveProject").mockResolvedValue({
      name: "api",
      repoPath: repoRoot,
      path: repoRoot,
      branch: null,
      cwd: repoRoot,
    });
    const find = spy(servers, "findProfile").mockResolvedValue(null);
    const save = spy(servers, "saveProfile").mockImplementation(async (body: Record<string, unknown>) => ({
      id: "api-dev",
      name: String(body.name),
      path: String(body.path),
      cwd: "",
      script: (body.script as string) ?? null,
      cmd: (body.cmd as string) ?? null,
      port: (body.port as number) ?? null,
    }));
    const { call, approvals } = await open();
    expect(
      (await call("server_profile_save", { name: "API dev", project: "api", script: "dev", port: 8787 })).text,
    ).toContain("Salvou o perfil API dev");
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      name: "API dev",
      path: repoRoot,
      script: "dev",
      cmd: null,
      port: 8787,
    });
    expect(approvals).toHaveLength(0);
    expect((await lines())[0]).toMatchObject({ undo: [{ method: "DELETE", path: "/servers/profiles/api-dev" }] });
    const previous = { id: "api-dev", name: "API dev", path: repoRoot, cwd: "", script: "dev", cmd: null, port: 8787 };
    find.mockResolvedValue(previous);
    const updated = await call("server_profile_save", { name: "API dev", path: repoRoot, cmd: "bun run x" });
    expect(updated.text).toContain("Atualizou o perfil API dev");
    expect(approvals[0]?.prompt).toBe("Posso salvar um perfil que roda este comando? bun run x");
    expect((await lines())[1]).toMatchObject({ undo: [{ method: "POST", path: "/servers/profiles", body: previous }] });
    expect((await call("server_profile_save", { name: "X" })).text).toBe(
      "Diga o projeto (nome do repositório liberado) ou a pasta.",
    );
    const remove = spy(servers, "deleteProfile").mockResolvedValue(true);
    expect((await call("server_profile_delete", { profile: "api dev" })).text).toBe("Apagou o perfil API dev.");
    expect(remove).toHaveBeenCalledWith("api-dev");
    find.mockResolvedValue(null);
    expect((await call("server_profile_delete", { profile: "zzz" })).text).toBe('Não existe o perfil "zzz".');
  });

  test("removes an allowed repository", async () => {
    await addAllowedRepo(repoRoot, "teste", null);
    const { call } = await open();
    const name = allowedRepos().find((item) => item.path === repoRoot)?.name;
    expect((await call("repo_remove", { repo: repoRoot })).text).toBe(`Tirou ${name} dos repositórios liberados.`);
    expect(allowedRepos().some((item) => item.path === repoRoot)).toBe(false);
    expect((await call("repo_remove", { repo: "zzz" })).text).toBe('"zzz" não está entre os repositórios liberados.');
  });
});

describe("vault_update_meta", () => {
  test("restricts directly and asks before widening, never touching the value", async () => {
    await saveSecretMeta("api-key", { description: "Velha", domains: ["api.example.com"] });
    const { call, approvals } = await open({ approve: () => "deny" });
    expect((await call("vault_update_meta", { name: "api-key", description: "Nova" })).text).toBe(
      "Ajustou o segredo api-key · descrição.",
    );
    expect(getSecretMeta("api-key")?.description).toBe("Nova");
    expect((await lines())[0]).toMatchObject({
      undo: [
        { method: "PUT", path: "/vault/secrets/api-key", body: { description: "Velha", domains: ["api.example.com"] } },
      ],
    });
    const widened = await call("vault_update_meta", { name: "api-key", domains: ["evil.example.org"] });
    expect(widened.isError).toBe(true);
    expect(approvals[0]?.prompt).toBe("Posso liberar o segredo:api-key para evil.example.org?");
    expect(getSecretMeta("api-key")?.domains).toEqual(["api.example.com"]);
    expect((await call("vault_update_meta", { name: "api-key", domains: [] })).isError).toBe(true);
    expect(approvals[1]?.prompt).toBe("Posso liberar o segredo:api-key para qualquer site?");
    await saveSecretMeta("api-key", { domains: ["api.example.com", "www.example.com"] });
    expect((await call("vault_update_meta", { name: "api-key", domains: ["api.example.com"] })).text).toBe(
      "Ajustou o segredo api-key · sites: api.example.com.",
    );
    expect(approvals).toHaveLength(2);
    expect((await call("vault_update_meta", { name: "nada" })).text).toBe('Não existe o segredo "nada" no cofre.');
  });
});

describe("usage, accounts, integrations, connectors and preferences", () => {
  test("usage_get lists each account's windows", async () => {
    const limits = spy(usage, "usageLimits").mockResolvedValue([
      {
        id: "vps:claude",
        provider: "claude",
        label: "Claude Trabalho",
        email: null,
        plan: null,
        isDefault: true,
        ok: false,
        error: "sem token",
        windows: [
          {
            kind: "session",
            label: "Sessão",
            usedPercent: 40,
            remainingPercent: 60,
            resetsAt: "x",
            windowMinutes: 300,
            pacePercent: null,
          },
        ],
        failover: [],
      },
    ]);
    const { call } = await open();
    const result = await call("usage_get", { refresh: true });
    expect(limits).toHaveBeenCalledWith(true);
    expect(result.json).toEqual([
      {
        account: "vps:claude",
        name: "Claude Trabalho",
        provider: "claude",
        isDefault: true,
        ok: false,
        error: "sem token",
        windows: [{ label: "Sessão", usedPercent: 40, remainingPercent: 60, resetsAt: "x" }],
      },
    ]);
  });

  test("account_update renames and sets the default with undo", async () => {
    const update = spy(accounts, "updateAccount").mockResolvedValue([]);
    const { call } = await open();
    const result = await call("account_update", { account: "alex", name: "Pessoal", isDefault: true });
    expect(result.text).toBe("Renomeou a conta para Pessoal · Pessoal virou a conta padrão.");
    expect(update).toHaveBeenCalledWith("claude-2:claude", { name: "Pessoal", isDefault: true });
    expect((await lines())[0]).toMatchObject({
      thumbnail: { kind: "provider", id: "claude" },
      areas: ["accounts", "usage", "bots"],
      undo: [
        { method: "PATCH", path: "/accounts/claude-2:claude", body: { name: "Claude Alex" } },
        { method: "PATCH", path: "/accounts/vps:claude", body: { isDefault: true } },
      ],
    });
    expect((await call("account_update", { account: "codex" })).text).toBe("Nada mudou em Codex.");
  });

  test("integration_setup opens the secure form and only confirms a saved key", async () => {
    let saved = false;
    spy(store, "readStored").mockImplementation(() =>
      saved ? ({ validatedAt: "2026-11-20T10:00:00Z" } as never) : null,
    );
    const ok = await open({
      approve: async () => {
        saved = true;
        return "approve" as const;
      },
    });
    const result = await ok.call("integration_setup", { integration: "elevenlabs", reason: "Para a chamada de voz" });
    expect(result.text).toBe("Configurou ElevenLabs. A chave foi conferida e está guardada cifrada no servidor.");
    expect(ok.approvals[0]?.details?.integration).toMatchObject({
      id: "elevenlabs",
      name: "ElevenLabs",
      needsUrl: false,
      path: "/integrations/elevenlabs",
    });
    expect(JSON.stringify(await factsOfType(session, "call.requested"))).not.toContain('key":');
    saved = false;
    const closed = await open();
    expect((await closed.call("integration_setup", { integration: "jev", reason: "x" })).text).toBe(
      "O formulário fechou sem salvar a chave. Pergunte se a pessoa quer tentar de novo.",
    );
    const denied = await open({ approve: () => "deny" });
    expect((await denied.call("integration_setup", { integration: "jev", reason: "x" })).text).toBe(
      "A pessoa preferiu não configurar agora. Não peça de novo neste turno.",
    );
    const routine = await open({ isSchedule: true });
    expect((await routine.call("integration_setup", { integration: "jev", reason: "x" })).text).toBe(
      "Ninguém está aqui para preencher o formulário agora. Avise na próxima conversa.",
    );
  });

  test("connector_connect shows the Conectar button, reconnects or reports what it cannot do", async () => {
    const enabled = spy(runelay, "runelayEnabled").mockReturnValue(false);
    const { call } = await open();
    expect((await call("connector_connect", { service: "sentry" })).text).toBe(
      "A runelay não está configurada. Use integration_setup com runelay antes.",
    );
    enabled.mockReturnValue(true);
    const item = (overrides: Partial<runelay.CatalogItem>): runelay.CatalogItem => ({
      id: "sentry",
      name: "Sentry",
      description: "",
      icon: "sentry",
      auth: "oauth",
      tokenUrl: null,
      featured: false,
      installed: false,
      sourceName: null,
      status: null,
      ...overrides,
    });
    const catalog = spy(runelay, "getCatalog").mockResolvedValue({
      featured: [],
      sections: [{ id: "s", title: "S", items: [item({})] }],
    });
    spy(runelay, "installCatalogItem").mockResolvedValue({
      sourceName: "sentry",
      status: "needs_auth",
      error: null,
      authorizationUrl: "https://auth.example/sentry",
    });
    const result = await call("connector_connect", { service: "sentry" });
    expect(result.text).toBe(
      "Mostrei o botão Conectar para Sentry. Depois que a pessoa fizer o login, confira com settings_get.",
    );
    expect((await lines())[0]).toMatchObject({
      text: "Conectar Sentry",
      thumbnail: { kind: "connector", id: "sentry" },
      action: { label: "Conectar", url: "https://auth.example/sentry" },
    });
    catalog.mockResolvedValue({
      featured: [item({ installed: true, sourceName: "sentry", status: "ok" })],
      sections: [],
    });
    expect((await call("connector_connect", { service: "sentry" })).text).toBe("Sentry já está conectado (sentry).");
    catalog.mockResolvedValue({
      featured: [item({ installed: true, sourceName: "sentry", status: "needs_auth" })],
      sections: [],
    });
    spy(runelay, "reconnectSource").mockResolvedValue({ sourceName: "sentry", authorizationUrl: null });
    expect((await call("connector_connect", { service: "sentry" })).text).toBe("Sentry conectado (sentry).");
    catalog.mockResolvedValue({ featured: [item({ auth: "api_key" })], sections: [] });
    expect((await call("connector_connect", { service: "sentry" })).text).toContain("Sentry pede um token.");
    catalog.mockResolvedValue({ featured: [], sections: [] });
    expect((await call("connector_connect", { service: "nada" })).text).toBe(
      'Não achei "nada" no catálogo da runelay.',
    );
  });

  test("preferences_set changes notifications and the microphone with undo", async () => {
    await updatePreferences({ microphones: ["MacBook Air", "Shure MV7"] });
    const { call } = await open();
    const result = await call("preferences_set", {
      notifications: { replies: false, routines: true },
      microphone: "shure",
    });
    expect(result.text).toBe("Desligou respostas dos bots · Ligou resultados de rotinas · Microfone: Shure MV7.");
    expect(await readPreferences()).toMatchObject({
      notifications: { replies: false, routines: true },
      microphone: "Shure MV7",
    });
    expect((await lines())[0]).toMatchObject({
      area: "preferences",
      undo: [
        {
          method: "PATCH",
          path: "/preferences",
          body: { notifications: { replies: true, approvals: true, routines: true, failures: true }, microphone: null },
        },
      ],
    });
    expect((await call("preferences_set", { microphone: "sistema" })).text).toBe("Microfone: padrão do sistema.");
    expect((await readPreferences()).microphone).toBeNull();
    expect((await call("preferences_set", { microphone: "Rode" })).text).toBe(
      'Não achei o microfone "Rode". Microfones do Mac: MacBook Air, Shure MV7.',
    );
    expect((await call("preferences_set", {})).text).toBe("Diga o que mudar: notifications, microphone ou language.");
  });

  test("preferences_set changes the language and writes the line in it", async () => {
    const { call } = await open();
    expect((await call("preferences_set", { language: "en" })).text).toBe("Idioma: inglês.");
    expect((await readPreferences()).language).toBe("en");
    expect((await lines()).at(-1)).toMatchObject({
      target: { id: "preferences", name: "Preferências" },
      undo: [{ method: "PATCH", path: "/preferences", body: { language: "system" } }],
    });
    expect((await call("preferences_set", { notifications: { failures: false }, language: "system" })).text).toBe(
      "Turned off turns with errors · Language: system.",
    );
    expect((await lines()).at(-1)).toMatchObject({ target: { name: "Preferences" } });
    expect((await call("settings_get", {})).text).toContain('"language":"system"');
    await updatePreferences({ language: "system" });
    resetLanguageState();
  });
});
