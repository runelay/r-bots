import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import {
  type ContextOptions,
  connectMcp,
  factsOf,
  factsOfType,
  fakeJev,
  makeBot,
  newSession,
  stopJev,
  textOf,
  toolContext,
} from "../../../../test/engine-helpers";
import { fakeRunelay, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { must } from "../../../../test/must";
import { ValidationError } from "../../../shared/errors";
import * as bots from "../../bots/services/bots.service";
import { type BotDefinition, getBot } from "../../bots/services/bots.service";
import * as actions from "../../code/services/actions.service";
import * as computer from "../../computer/services/computer.service";
import { ComputerError } from "../../computer/services/computer.service";
import * as runelay from "../../connectors/services/runelay.service";
import { getStoredSession, type StoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import * as groups from "../../groups/services/groups.service";
import { createGroup, getGroup, listGroups } from "../../groups/services/groups.service";
import type { BotTool } from "../services/bot-tools.service";
import { buildServer, findToolContext } from "../services/mcp-gateway.service";

let server: TestServer;
let bot: BotDefinition;
let session: StoredSession;
const clients: Client[] = [];
const revokes: Array<() => unknown> = [];
const spies: Array<{ mockRestore: () => void }> = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
  bot = await makeBot();
  session = await newSession(bot.id);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const revoke of revokes.splice(0)) revoke();
  for (const spy of spies.splice(0)) spy.mockRestore();
  stopJev();
});

async function open(options: ContextOptions = {}, target: BotDefinition = bot) {
  const harness = toolContext(target, session, options);
  revokes.push(harness.revoke);
  const client = await connectMcp(harness.url(server.url), harness.context.token);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
    return { ...result, text: textOf(result), isError: result.isError === true };
  };
  return { ...harness, client, call };
}

async function settledOf(callIndex = -1) {
  return (await factsOfType(session, "call.settled")).at(callIndex)?.data;
}

async function startedOf(callIndex = -1) {
  return (await factsOfType(session, "call.started")).at(callIndex)?.data;
}

function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const created = spyOn(target, key as never) as unknown as { mockRestore: () => void };
  spies.push(created);
  return created as unknown as ReturnType<typeof spyOn>;
}

function approvalJev(risk: number, confidence = 0.95) {
  return fakeJev(() => ({
    answers: {
      risk: { type: "score", score: risk, confidence, probabilities: {} },
      needs_human: { type: "noul", noul: 0.1 },
      aligned: { type: "noul", noul: 0.9 },
    },
  }));
}

describe("MCP route", () => {
  test("rejects unknown tokens, the wrong bot or session and non-POST methods", async () => {
    const harness = toolContext(bot, session);
    revokes.push(harness.revoke);
    const url = harness.url(server.url);
    const post = (target: string, token: string, body = "{}") =>
      fetch(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
      });
    expect((await post(url, "nope")).status).toBe(401);
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect((await post(`${server.url}/mcp/other/${session.meta.sessionId}`, harness.context.token)).status).toBe(401);
    expect((await post(`${server.url}/mcp/${bot.id}/wrun_other`, harness.context.token)).status).toBe(401);
    const get = await fetch(url, { headers: { authorization: `Bearer ${harness.context.token}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const broken = await post(url, harness.context.token, "{not json");
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: -32700 } });
    expect(findToolContext(harness.context.token)).toBe(harness.context);
    harness.revoke();
    expect(findToolContext(harness.context.token)).toBeUndefined();
  });

  test("lists the built-in tools for the bot", async () => {
    const { client } = await open();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "set_role",
      "update_instructions",
      "add_schedule",
      "create_bot",
      "create_group",
      "thread_read",
      "thread_side",
      "thread_create",
      "thread_list",
    ])
      expect(names).toContain(name);
    expect(names).not.toContain("handoff");
    expect(names).not.toContain("delegate");
    expect(names).not.toContain("computer_click");
  });
});

describe("self configuration", () => {
  test("set_role and update_instructions apply right away, without a card", async () => {
    const { call, settled, calls, approvals } = await open({ origin: "Ana", ownerCallId: "call_parent" });
    const role = await call("set_role", { text: "Analista" });
    expect(role.text).toBe('Papel: "Tester" → "Analista". Vale a partir da próxima mensagem.');
    expect(getBot(bot.id)?.role).toBe("Analista");
    const requested = (await factsOfType(session, "call.requested"))[0].data;
    expect(requested).toMatchObject({ owner: { callId: "call_parent" }, origin: { agent: "Ana" } });
    expect((await factsOfType(session, "bot.updated"))[0].data).toMatchObject({
      botId: bot.id,
      by: "bot",
      fields: ["role"],
    });
    await call("update_instructions", { markdown: "Responda em tabela." });
    expect(getBot(bot.id)?.instructions).toBe("Você testa.\n\nResponda em tabela.");
    const replaced = await call("update_instructions", { markdown: "Só isso.", mode: "replace" });
    expect(replaced.text).toContain("Instruções substituídas");
    expect(getBot(bot.id)?.instructions).toBe("Só isso.");
    expect(approvals).toHaveLength(0);
    expect(settled).toHaveLength(3);
    expect(calls()).toBe(3);
  });

  test("self configuration runs in edit, default and full access and is blocked in read only", async () => {
    for (const permission of ["edit", "default", "full"] as const) {
      const mode = await open({ approve: () => "deny", permission });
      expect((await mode.call("set_role", { text: permission })).isError).toBe(false);
      expect(mode.approvals).toHaveLength(0);
    }
    expect(getBot(bot.id)?.role).toBe("full");
    const readonly = await open({ permission: "readonly" });
    for (const [name, args] of [
      ["set_role", { text: "y" }],
      ["update_instructions", { markdown: "z", mode: "replace" }],
      ["add_schedule", { name: "x", cron: "0 9 * * *", prompt: "p" }],
    ] as const) {
      const result = await readonly.call(name, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Somente leitura");
    }
    expect(readonly.approvals).toHaveLength(0);
    expect(readonly.decisions.map((item) => item.outcome)).toEqual(["blocked", "blocked", "blocked"]);
    expect(getBot(bot.id)?.role).toBe("full");
  });

  test("a bot that no longer exists cannot change itself", async () => {
    const ghost = { ...bot, id: "ghost-bot" };
    const { call } = await open({}, ghost);
    const result = await call("set_role", { text: "x" });
    expect(result).toMatchObject({ isError: true, text: "Esse bot não existe mais." });
  });

  test("add_schedule and remove_schedule run right away in the default mode, without Jev or a card", async () => {
    const { call, approvals, decisions } = await open({ approve: () => "deny" });
    expect((await call("add_schedule", { name: "a", cron: "0 9 * * *", prompt: "p" })).isError).toBe(false);
    expect((await call("remove_schedule", { name: "a" })).isError).toBe(false);
    expect(approvals).toHaveLength(0);
    expect(decisions).toHaveLength(0);
    expect(getBot(bot.id)?.schedules).toEqual([]);
  });

  test("add_schedule creates or replaces a routine right away in full access", async () => {
    const { call, approvals } = await open({ permission: "full" });
    const created = await call("add_schedule", { name: "diaria", cron: "0 9 * * 1-5", prompt: "resuma" });
    expect(created.text).toContain('Rotina "diaria" criada: 0 9 * * 1-5 (America/Sao_Paulo).');
    expect(approvals).toHaveLength(0);
    expect(getBot(bot.id)?.schedules.map((item) => item.name)).toEqual(["diaria"]);
    const replaced = await call("add_schedule", {
      name: "diaria",
      cron: "0 10 * * *",
      timezone: "UTC",
      prompt: "de novo",
      description: "d",
    });
    expect(replaced.isError).toBe(false);
    expect(getBot(bot.id)?.schedules).toEqual([
      { name: "diaria", cron: "0 10 * * *", timezone: "UTC", prompt: "de novo", description: "d" },
    ]);
  });

  test("add_schedule refuses an invalid cron", async () => {
    const invalid = await open({ permission: "full" });
    const broken = await invalid.call("add_schedule", { name: "x", cron: "nunca", prompt: "p" });
    expect(broken).toMatchObject({ isError: true, text: "Cron inválido. (schedules[0].cron)" });
    expect(await settledOf()).toMatchObject({ outcome: "failed" });
    expect(invalid.approvals).toHaveLength(0);
  });

  test("remove_schedule removes an existing routine and fails for unknown ones", async () => {
    await bots.updateBot(bot.id, { schedules: [{ name: "r1", cron: "0 9 * * *", prompt: "p" }] });
    const { call } = await open({ permission: "full" });
    const missing = await call("remove_schedule", { name: "nope" });
    expect(missing).toMatchObject({ isError: true, text: 'Não existe rotina "nope".' });
    expect(await settledOf()).toMatchObject({ outcome: "failed" });
    expect((await call("remove_schedule", { name: "r1" })).text).toContain('Rotina "r1" removida.');
    expect(getBot(bot.id)?.schedules).toEqual([]);
  });

  test("request_connector and request_capability always go through a person", async () => {
    const { call, decisions } = await open();
    const granted = await call("request_connector", { name: "linear_server", reason: "issues" });
    expect(granted.text).toContain("Conexão linear_server liberada.");
    expect(decisions[0]).toMatchObject({ outcome: "human", tool: "request_connector" });
    const again = await call("request_connector", { name: "linear_server", reason: "issues" });
    expect(again).toMatchObject({ isError: true, text: "Já tenho acesso a linear_server." });
    const current = must(getBot(bot.id));
    current.capabilities = { ...current.capabilities, browser: false };
    expect((await call("request_capability", { name: "browser", reason: "ver" })).text).toContain(
      "Capacidade navegador liberada.",
    );
    expect((await call("request_capability", { name: "browser", reason: "ver" })).text).toBe("Já tenho navegador.");
  });

  test("reports failures from saving the bot", async () => {
    const update = spy(bots, "updateBot");
    update.mockRejectedValueOnce(new Error("disco cheio"));
    update.mockRejectedValueOnce("texto");
    update.mockRejectedValueOnce(new ValidationError("Papel ruim", "role"));
    const { call } = await open();
    expect((await call("set_role", { text: "a" })).text).toBe("disco cheio");
    expect((await call("set_role", { text: "a" })).text).toBe("texto");
    expect((await call("set_role", { text: "a" })).text).toBe("Papel ruim (role)");
  });
});

describe("team tools", () => {
  test("create_bot creates a teammate with optional role and accent", async () => {
    const { call, settled } = await open();
    const made = await call("create_bot", {
      name: "Nova Pessoa",
      role: "Vendas",
      accent: "teal",
      instructions: "Vende.",
    });
    const created = must(bots.listBots().find((item) => item.name === "Nova Pessoa"));
    expect(made.text).toBe(`Criei o bot Nova Pessoa (${created.id}).`);
    expect(created).toMatchObject({ role: "Vendas", accent: "teal", instructions: "Vende." });
    expect(settled[0]).toBe(`create_bot(Nova Pessoa) → ${created.id}`);
    const plain = await call("create_bot", { name: "Sem Papel", instructions: "" });
    expect(plain.isError).toBe(false);
    const failing = spy(bots, "createBot");
    failing.mockRejectedValueOnce("sem disco");
    expect((await call("create_bot", { name: "X", instructions: "" })).text).toBe("sem disco");
    failing.mockRejectedValueOnce(new Error("quebrou"));
    expect(await call("create_bot", { name: "X", instructions: "" })).toMatchObject({ isError: true, text: "quebrou" });
  });

  test("create_group resolves members by id, name or part of the name", async () => {
    const ana = await makeBot({ name: `Ána Grupo ${Date.now()}` });
    const beto = await makeBot({ name: `Beto Grupo ${Date.now()}` });
    const name = `Time ${crypto.randomUUID().slice(0, 6)}`;
    const { call } = await open();
    const made = await call("create_group", { name, members: [ana.id, beto.name.toUpperCase(), "beto grupo"] });
    expect(made.text).toBe(`Criei o grupo ${name} com 3 bots.`);
    const group = must(listGroups().find((item) => item.name === name));
    expect(group.members).toEqual([ana.id, beto.id]);
    const missing = await call("create_group", { name: "Outro", members: ["ninguem-aqui-xyz"] });
    expect(missing).toMatchObject({ isError: true, text: 'Não achei o bot "ninguem-aqui-xyz".' });
    const failing = spy(groups, "createGroup");
    failing.mockRejectedValueOnce("falhou");
    expect((await call("create_group", { name: "Z", members: [ana.id] })).text).toBe("falhou");
  });

  test("update_group adds, removes and renames; archive_group archives", async () => {
    const ana = await makeBot();
    const beto = await makeBot();
    const caio = await makeBot();
    const group = await createGroup({ name: `Squad ${Date.now()}`, members: [ana.id, beto.id] });
    const { call } = await open();
    const updated = await call("update_group", {
      group: group.name.toLowerCase(),
      add: [caio.id],
      remove: [ana.id],
      name: "Squad 2",
    });
    expect(updated.text).toBe("Grupo Squad 2 agora tem 2 bots.");
    expect(getGroup(group.id)?.members).toEqual([beto.id, caio.id]);
    const partial = await call("update_group", { group: group.id });
    expect(partial.text).toBe("Grupo Squad 2 agora tem 2 bots.");
    const byPart = await call("update_group", { group: "squad 2".slice(0, 5) });
    expect(byPart.isError).toBe(false);
    const unknown = await call("update_group", { group: "nenhum-grupo-assim" });
    expect(unknown).toMatchObject({ isError: true, text: 'Não achei o grupo "nenhum-grupo-assim".' });
    const unknownBot = await call("update_group", { group: group.id, add: ["zzz-nobody"] });
    expect(unknownBot.text).toBe('Não achei o bot "zzz-nobody".');
    const failing = spy(groups, "updateGroup");
    failing.mockRejectedValueOnce("x");
    expect((await call("update_group", { group: group.id })).text).toBe("x");
    failing.mockResolvedValueOnce(null as never);
    expect((await call("update_group", { group: group.id })).text).toBe("Grupo Squad 2 agora tem 2 bots.");
    expect((await call("archive_group", { group: group.id })).text).toBe("Arquivei o grupo Squad 2.");
    expect(getGroup(group.id)?.archivedAt).not.toBeNull();
  });
});

describe("connector tools", () => {
  beforeEach(() => {
    bot.connectors = { allowed: ["linear_server", "solo"], memory: true };
  });

  test("are hidden when runelay is off", async () => {
    const enabled = spy(runelay, "runelayEnabled");
    enabled.mockReturnValue(false);
    const { client } = await open();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("connector_call");
    expect(names).not.toContain("memory_search");
  });

  test("hide connector calls when nothing is allowed", async () => {
    const connectors = spy(bots, "connectorsOf");
    connectors.mockReturnValue({ allowed: [], memory: false });
    const { client } = await open();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("connector_search");
    expect(names).not.toContain("memory_read");
  });

  test("connector_search searches the allowed connections", async () => {
    fakeRunelay.tool("search_tools", () => [
      { name: "linear_server.list_issues", description: "lista", inputSchema: {} },
      { name: "github.create_pr", description: "x", inputSchema: {} },
    ]);
    const { call } = await open();
    const found = await call("connector_search", { query: "issues", limit: 2 });
    expect(JSON.parse(found.text)).toEqual([
      { name: "linear_server.list_issues", description: "lista", inputSchema: {} },
    ]);
    expect((await factsOfType(session, "call.requested"))[0].data).toMatchObject({
      capability: { name: "connector_search", label: "Procurar ferramentas: issues" },
    });
  });

  test("connector_call reads directly, asks before sending and refuses unknown connections", async () => {
    fakeRunelay.tool("list_connections", () => [{ name: "linear_server", status: "ok", toolCount: 3 }]);
    fakeRunelay.tool("call_tool", (args) => ({ ran: args.name, big: "x".repeat(25_000) }));
    await runelay.listConnections(true);
    const { call, approvals, decisions } = await open();
    const blocked = await call("connector_call", { tool: "github.list_prs" });
    expect(blocked).toMatchObject({ isError: true });
    expect(blocked.text).toContain("não está liberada");
    const read = await call("connector_call", { tool: "linear_server.list_issues", args: { team: "x" } });
    expect(read.text).toContain("(cortado)");
    expect((await factsOfType(session, "call.requested")).at(-1)?.data).toMatchObject({
      capability: {
        name: "connector:linear_server.list_issues",
        label: "Linear: list_issues",
        connector: "linear_server",
      },
    });
    const sent = await call("connector_call", { tool: "solo.send_email", args: { to: "a" } });
    expect(sent.isError).toBe(false);
    expect(approvals[0].prompt).toContain("Posso rodar solo send_email?");
    expect(decisions.at(-1)?.reason).toContain("Lista dura");
    expect(await startedOf()).toMatchObject({ clearedBy: { interactionId: "int_1" } });
  });

  test("connector_call follows the conversation permission", async () => {
    fakeRunelay.tool("list_connections", () => {
      throw new Error("offline");
    });
    fakeRunelay.tool("call_tool", () => "ok");
    const readonly = await open({ permission: "readonly" });
    const denied = await readonly.call("connector_call", { tool: "solo.update_doc" });
    expect(denied.isError).toBe(true);
    expect(readonly.decisions.at(-1)).toMatchObject({ outcome: "blocked", reason: "Modo Somente leitura." });
    const edit = await open({ permission: "edit", approve: () => "deny" });
    const refused = await edit.call("connector_call", { tool: "solo.update_doc" });
    expect(refused.text).toBe("A pessoa negou essa ação.");
    expect(edit.decisions.at(-1)?.reason).toBe("Modo Editar: escrita em conector pede sua confirmação.");
    const scheduled = await open({ permission: "edit", isSchedule: true });
    expect((await scheduled.call("connector_call", { tool: "solo.update_doc" })).text).toBe(
      "Ninguém está aqui para aprovar essa ação agora.",
    );
    const full = await open({ permission: "full" });
    expect((await full.call("connector_call", { tool: "solo.send_email" })).text).toBe("ok");
    expect(full.approvals).toHaveLength(1);
    spy(runelay, "listConnections").mockRejectedValue(new Error("offline"));
    expect((await full.call("connector_call", { tool: "solo.send_email" })).text).toBe("ok");
    expect((await factsOfType(session, "call.requested")).at(-1)?.data).toMatchObject({
      capability: { name: "connector:solo.send_email" },
    });
    expect(full.decisions.at(-1)).toMatchObject({ outcome: "human", reason: "Jev desligado." });
    const fallback = await open({ permission: undefined });
    expect((await fallback.call("connector_call", { tool: "solo.update_doc" })).text).toBe("ok");
  });

  test("connector_call runs read-only sql directly and always asks a person before writing to a database", async () => {
    fakeRunelay.tool("list_connections", () => []);
    fakeRunelay.tool("call_tool", () => "ok");
    const reader = await open();
    expect((await reader.call("connector_call", { tool: "solo.execute_sql", args: { query: "select 1" } })).text).toBe(
      "ok",
    );
    expect(reader.approvals).toHaveLength(0);
    const full = await open({ permission: "full" });
    const write = await full.call("connector_call", { tool: "solo.execute_sql", args: { query: "delete from t" } });
    expect(write.text).toBe("ok");
    expect(full.approvals).toHaveLength(1);
    expect(full.decisions.at(-1)).toMatchObject({ outcome: "human" });
    const migration = await full.call("connector_call", { tool: "solo.apply_migration", args: { name: "x" } });
    expect(migration.text).toBe("ok");
    expect(full.approvals).toHaveLength(2);
  });

  test("full access lets Jev clear a requested hard-list action and denies an unclear one in a routine", async () => {
    fakeRunelay.tool("list_connections", () => []);
    fakeRunelay.tool("call_tool", () => "ok");
    let requested = 0.95;
    fakeJev(() => ({
      answers: {
        requested: { type: "noul", noul: requested },
        irreversible: { type: "noul", noul: 0.05 },
        risk: { type: "score", score: 0.2, confidence: 0.9, probabilities: { "0": 0.9 } },
      },
    }));
    const full = await open({ permission: "full", request: "manda o e-mail de boas-vindas para a Ana" });
    expect((await full.call("connector_call", { tool: "solo.send_email" })).text).toBe("ok");
    expect(full.approvals).toHaveLength(0);
    expect(await startedOf()).toMatchObject({ clearedBy: { decision: "jev", hardList: true } });
    expect(full.decisions.at(-1)).toMatchObject({ outcome: "auto_approved", threshold: 0.5 });
    requested = 0.3;
    const unclear = await open({ permission: "full" });
    expect((await unclear.call("connector_call", { tool: "solo.send_email" })).text).toBe("ok");
    expect(unclear.approvals).toHaveLength(1);
    const routine = await open({ permission: "full", isSchedule: true });
    const denied = await routine.call("connector_call", { tool: "solo.send_email" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("registre no resumo da rotina");
    expect(routine.decisions.at(-1)).toMatchObject({ outcome: "denied", threshold: 0.85 });
    expect(routine.approvals).toHaveLength(0);
  });

  test("connector_call reports a failing remote tool", async () => {
    fakeRunelay.tool("list_connections", () => []);
    fakeRunelay.tool("call_tool", () => {
      throw new Error("remote broke");
    });
    const { call, settled } = await open();
    const failed = await call("connector_call", { tool: "solo.get_thing" });
    expect(failed).toMatchObject({ isError: true, text: "remote broke" });
    expect(await settledOf()).toMatchObject({ outcome: "failed", error: { message: "remote broke" } });
    expect(settled.at(-1)).toContain("erro: remote broke");
  });

  test("memory tools read and write the person's memory", async () => {
    fakeRunelay.tool("search_context", (args) => ({ searched: args }));
    fakeRunelay.tool("read_memory", (args) => `memória ${args.slug}`);
    fakeRunelay.tool("read_skill", (args) => `skill ${args.slug}`);
    fakeRunelay.tool("read_skill_file", (args) => `arquivo ${args.path}`);
    fakeRunelay.tool("write_memory", () => "salvo");
    const { call } = await open();
    expect(JSON.parse((await call("memory_search", { query: "q", kind: "skill" })).text)).toEqual({
      searched: { query: "q", kind: "skill", limit: 8 },
    });
    expect(JSON.parse((await call("memory_search", { query: "q" })).text)).toEqual({
      searched: { query: "q", limit: 8 },
    });
    expect((await call("memory_read", { slug: "m" })).text).toBe("memória m");
    expect((await call("skill_read", { slug: "s" })).text).toBe("skill s");
    expect((await call("skill_read", { slug: "s", path: "a.md" })).text).toBe("arquivo a.md");
    expect((await factsOfType(session, "decision.made")).filter((fact) => fact.data.tool === "skill_read")).toEqual([]);
    expect((await call("memory_write", { slug: "m", body: "b", name: "N" })).text).toBe("salvo");
    expect((await factsOfType(session, "call.requested")).at(-1)?.data).toMatchObject({
      input: { slug: "m", name: "N" },
      capability: { label: "Salvar memória m" },
    });
  });
});

describe("computer tools", () => {
  beforeEach(() => {
    bot.capabilities = { ...bot.capabilities, computer: true };
  });

  test("read tools run without approval and remember the UI tree", async () => {
    const computerCall = spy(computer, "callComputer");
    computerCall.mockImplementation((async (tool: string) =>
      tool === "computer_ui_tree"
        ? {
            app: "Mail",
            bundleId: "com.apple.mail",
            windows: [
              null,
              {
                id: "w1",
                children: [
                  { id: "b1", role: "button", title: "  Enviar " },
                  { id: "f1", role: "field", placeholder: "Busca" },
                  { role: "x" },
                ],
              },
            ],
          }
        : { ok: true }) as never);
    const { call, approvals } = await open({ approve: () => "deny" });
    const tree = await call("computer_ui_tree", { app: "Mail" });
    expect(JSON.parse(tree.text).app).toBe("Mail");
    expect((await factsOfType(session, "call.requested"))[0].data).toMatchObject({
      capability: { name: "computer_ui_tree", label: "Ler a tela do Mail", surface: "computer" },
    });
    expect((await call("computer_apps")).text).toBe('{"ok":true}');
    const click = await call("computer_click", { elementId: "b1", reason: "enviar o rascunho" });
    expect(click.text).toBe("A pessoa negou essa ação no computador.");
    expect(approvals[0]).toMatchObject({
      prompt: "Posso clicar em “Enviar” no seu Mac?",
      details: {
        reason: "enviar o rascunho",
        target: { label: "Enviar", role: "button", app: "Mail", bundleId: "com.apple.mail" },
      },
    });
    await call("computer_click", { elementId: "missing" });
    expect(approvals[1]).toMatchObject({
      prompt: "Posso clicar num ponto da tela?",
      details: { target: { label: "", role: "app", app: "Mail", bundleId: "com.apple.mail" } },
    });
    await call("computer_click", { elementId: "f1" });
    expect(approvals[2].details?.target?.label).toBe("Busca");
    await call("computer_open", { url: "https://www.site.com/x" });
    expect(approvals[3].details?.target).toEqual({ label: "site.com", role: "page", url: "https://www.site.com/x" });
    await call("computer_open", { url: "not a url" });
    expect(approvals[4].details?.target?.label).toBe("not a url");
    await call("computer_open", { app: "Notes" });
    expect(approvals[5].details?.target).toEqual({ label: "Notes", role: "app", app: "Notes" });
  });

  test("a bot without a remembered tree gets no target", async () => {
    const other = await makeBot();
    other.capabilities = { ...other.capabilities, computer: true };
    session = await newSession(other.id);
    const computerCall = spy(computer, "callComputer");
    computerCall.mockImplementation((async (tool: string) =>
      tool === "computer_ui_tree" ? { windows: "none" } : null) as never);
    const { call, approvals } = await open({ approve: () => "deny" }, other);
    await call("computer_scroll", { deltaY: 3 });
    expect(approvals[0].details).toEqual({ untilTurnEnd: true });
    await call("computer_ui_tree");
    await call("computer_key", { combo: "cmd+l" });
    expect(approvals[1].details).toEqual({ untilTurnEnd: true });
    await call("files_list", { path: "~/Desktop" });
    expect(await settledOf()).toMatchObject({ outcome: "completed", output: null });
  });

  test("acts after approval, by Jev, with full access or with only vault secrets", async () => {
    const computerCall = spy(computer, "callComputer");
    computerCall.mockResolvedValue({ screenshotPath: "/tmp/shot.png", done: true } as never);
    const approved = await open();
    expect((await approved.call("computer_type", { text: "olá" })).isError).toBe(false);
    expect(approved.approvals[0].prompt).toBe('Posso digitar no seu Mac: "olá"?');
    expect((await factsOfType(session, "computer.action"))[0].data).toMatchObject({
      tool: "computer_type",
      summary: 'Digitar "olá"',
      screenshotPath: "/tmp/shot.png",
    });
    await approved.call("computer_type", { text: "segredo:senha-mail" });
    expect(await startedOf()).toMatchObject({ clearedBy: { vault: true } });
    const full = await open({ permission: "full" });
    await full.call("computer_drag", { fromX: 1, fromY: 1, toX: 2, toY: 2 });
    expect(await startedOf()).toMatchObject({ clearedBy: { permission: "full" } });
    approvalJev(0.1);
    const jev = await open();
    await jev.call("files_mkdir", { path: "~/Desktop/x" });
    expect(await startedOf()).toMatchObject({ clearedBy: { decision: "jev" } });
    expect(jev.approvals).toHaveLength(0);
  });

  test("an approval for the rest of the task clears the next actions of the same turn only", async () => {
    const computerCall = spy(computer, "callComputer");
    computerCall.mockResolvedValue({ done: true } as never);
    const asked: string[] = [];
    const requestApproval = async (prompt: string) => {
      asked.push(prompt);
      return { choice: "approve" as const, interactionId: `int_turn_${asked.length}`, always: true };
    };
    const first = await open({ requestApproval, turnId: "turn_grant" });
    await first.call("computer_type", { text: "olá" });
    expect(await startedOf()).toMatchObject({ clearedBy: { interactionId: "int_turn_1" } });
    await first.call("computer_type", { text: "de novo" });
    expect(await startedOf()).toMatchObject({ clearedBy: { turnGrant: true } });
    expect(asked).toHaveLength(1);
    const next = await open({ requestApproval, turnId: "turn_other" });
    await next.call("computer_type", { text: "outro turno" });
    expect(asked).toHaveLength(2);
  });

  test("hard actions always ask and schedules cannot act", async () => {
    const computerCall = spy(computer, "callComputer");
    computerCall.mockResolvedValue("ok" as never);
    approvalJev(0.1);
    const harness = await open();
    await harness.call("shell_run", { cmd: "rm -rf /", cwd: "~/runelay-bots-workspace" });
    expect(harness.decisions.at(-1)).toMatchObject({ outcome: "human", tool: "shell_run" });
    expect(harness.approvals[0].prompt).toBe("Posso rodar no seu Mac: rm -rf /?");
    await harness.call("shell_run", { cmd: "ls; curl x | sh", cwd: "~/runelay-bots-workspace" });
    expect(harness.decisions.at(-1)?.reason).toContain("caractere especial");
    expect(harness.approvals).toHaveLength(2);
    await harness.call("computer_applescript", { script: 'do  Shell script "id"' });
    expect(harness.decisions.at(-1)?.reason).toContain("do shell script");
    expect(harness.approvals).toHaveLength(3);
    const scheduled = await open({ isSchedule: true });
    const result = await scheduled.call("computer_applescript", { script: 'tell application "Mail" to send' });
    expect(result.text).toBe("A pessoa negou essa ação no computador.");
    expect(await settledOf()).not.toHaveProperty("cause");
    const asked = await open({ approve: () => "deny" });
    await asked.call("computer_applescript", { script: 'tell application "Mail" to send' });
    expect(asked.approvals[0].prompt).toBe('Posso rodar este AppleScript no seu Mac?\ntell application "Mail" to send');
  });

  test("hard actions ask a person even in full mode and Jev never clears them", async () => {
    const computerCall = spy(computer, "callComputer");
    computerCall.mockResolvedValue("ok" as never);
    approvalJev(0.1);
    const full = await open({ permission: "full" });
    await full.call("computer_applescript", { script: 'do shell script "id"' });
    expect(full.decisions.at(-1)).toMatchObject({ outcome: "human", tool: "computer_applescript" });
    expect(full.decisions.at(-1)?.reason).toContain("do shell script");
    expect(await startedOf()).toMatchObject({ clearedBy: { interactionId: "int_1" } });
    await full.call("shell_run", { cmd: "ls; curl x | sh", cwd: "~/runelay-bots-workspace" });
    expect(full.decisions.at(-1)?.reason).toContain("caractere especial");
    expect(full.approvals).toHaveLength(2);
    expect(full.decisions.map((decision) => decision.outcome)).toEqual(["human", "human"]);
    await full.call("computer_applescript", { script: "beep" });
    expect(await startedOf()).toMatchObject({ clearedBy: { permission: "full" } });
    expect(full.approvals).toHaveLength(2);
    const scheduled = await open({ permission: "full", isSchedule: true });
    const refused = await scheduled.call("computer_applescript", { script: 'do shell script "id"' });
    expect(refused.text).toBe("A pessoa negou essa ação no computador.");
    expect(computerCall).toHaveBeenCalledTimes(3);
  });

  test("screenshots come back as images, with the UI tree for other providers", async () => {
    const computerCall = spy(computer, "callComputer");
    computerCall.mockImplementation((async (tool: string) =>
      tool === "computer_screenshot"
        ? { imageBase64: "aW1n", mimeType: "image/jpeg", width: 10 }
        : { app: "Finder" }) as never);
    const claude = await open();
    const shot = await claude.call("computer_screenshot");
    expect(shot.content[0]).toEqual({ type: "image", data: "aW1n", mimeType: "image/jpeg" });
    expect(shot.content).toHaveLength(2);
    expect(await settledOf()).toEqual({ callId: expect.any(String), outcome: "completed", output: { width: 10 } });
    const codex = await open({ provider: "codex" });
    const withTree = await codex.call("computer_screenshot", { display: 1 });
    expect(withTree.content).toHaveLength(3);
    expect(withTree.text).toContain('ui_tree: {"app":"Finder"}');
    computerCall.mockImplementation((async (tool: string) => {
      if (tool === "computer_ui_tree") throw new Error("no tree");
      return { imageBase64: "aW1n" };
    }) as never);
    const noTree = await codex.call("computer_screenshot");
    expect(noTree.content).toHaveLength(2);
    expect(noTree.content[0]).toMatchObject({ mimeType: "image/png" });
  });

  test("failures cancel the turn when the person takes over", async () => {
    const computerCall = spy(computer, "callComputer");
    const harness = await open({ permission: "full" });
    computerCall.mockRejectedValueOnce(new ComputerError("user_took_over", "assumiu"));
    await harness.call("record_start");
    computerCall.mockRejectedValueOnce(new ComputerError("stopped", "parou"));
    await harness.call("record_stop");
    computerCall.mockRejectedValueOnce(new ComputerError("COMPUTER_UNAVAILABLE", "fora"));
    expect((await harness.call("record_status")).text).toBe("COMPUTER_UNAVAILABLE: fora");
    computerCall.mockRejectedValueOnce("estranho");
    expect((await harness.call("files_read", { path: "a" })).text).toBe("estranho");
    expect(await settledOf()).toMatchObject({ error: { code: "TOOL_EXECUTION_FAILED" } });
    expect(harness.cancelled).toEqual(["Você assumiu o computador.", "A pessoa apertou Parar."]);
  });

  test("every computer tool has a label", async () => {
    const computerCall = spy(computer, "callComputer");
    computerCall.mockResolvedValue(null as never);
    const { call } = await open({ permission: "full" });
    await call("computer_windows");
    await call("files_move", { from: "a", to: "b" });
    await call("files_rename", { path: "a", name: "b" });
    await call("files_trash", { paths: ["a", "b"] });
    await call("files_write", { path: "a", content: "x" });
    await call("computer_open", { path: "/x" });
    await call("computer_open", {});
    await call("computer_key", { combo: "return" });
    await call("computer_applescript", { script: "beep" });
    await call("computer_ui_tree");
    const labels = (await factsOfType(session, "call.requested")).map(
      (fact) => (fact.data.capability as { label: string }).label,
    );
    expect(labels).toEqual([
      "Listar janelas",
      "Mover a",
      "Renomear a",
      "Lixeira (2 itens)",
      "Escrever a",
      "Abrir /x",
      "Abrir ",
      "Tecla return",
      "Rodar AppleScript",
      "Ler a tela",
    ]);
  });
});

describe("bot tools", () => {
  function tool(overrides: Partial<BotTool>): BotTool {
    return {
      name: "plain_tool",
      description: "d",
      shape: {
        value: z.string().optional(),
        ref: z.string().optional(),
        text: z.string().optional(),
        app: z.string().optional(),
      },
      approval: null,
      label: () => "Ferramenta",
      run: async (input) => ({ echoed: input }),
      ...overrides,
    };
  }

  test("plain tools run and report their output", async () => {
    const { call, settled } = await open({ tools: [tool({})] });
    const result = await call("plain_tool", { value: "v" });
    expect(JSON.parse(result.text)).toEqual({ echoed: { value: "v" } });
    expect(await startedOf()).toEqual({ callId: expect.any(String) });
    expect(settled[0]).toBe('plain_tool({"value":"v"}) → {"echoed":{"value":"v"}}');
  });

  test("tools that fail report the error", async () => {
    const { call } = await open({
      tools: [
        tool({
          run: async () => {
            throw new Error("explodiu");
          },
        }),
        tool({
          name: "odd_tool",
          run: () => Promise.reject("estranho"),
        }),
      ],
    });
    expect(await call("plain_tool")).toMatchObject({ isError: true, text: "explodiu" });
    expect((await call("odd_tool")).text).toBe("estranho");
  });

  test("images, files and artifacts become their own events", async () => {
    const attachment = { uploadId: "U1", name: "r.csv", mime: "text/csv", size: 1, kind: "file", url: "/u" };
    const { call, settled } = await open({
      tools: [
        tool({ name: "shot", run: async () => ({ imageBase64: "aW1n", width: 5 }) }),
        tool({ name: "send", run: async () => ({ ok: true, fileEvent: { type: "file.sent", data: { attachment } } }) }),
        tool({
          name: "art",
          run: async () => ({
            id: "art_1",
            artifactEvent: {
              type: "artifact.created",
              data: { artifactId: "art_1", title: "Painel", kind: "page", version: 1 },
            },
          }),
        }),
      ],
    });
    const shot = await call("shot");
    expect(shot.content[0]).toEqual({ type: "image", data: "aW1n", mimeType: "image/png" });
    expect(await settledOf()).toMatchObject({ output: { width: 5, image: `/bots/${bot.id}/desktop/latest.png` } });
    expect(JSON.parse((await call("send")).text)).toEqual({ ok: true });
    expect((await factsOfType(session, "file.sent"))[0].data).toMatchObject({ attachment, botId: bot.id });
    expect(JSON.parse((await call("art")).text)).toEqual({ id: "art_1" });
    expect((await factsOfType(session, "artifact.created"))[0].data).toMatchObject({
      artifactId: "art_1",
      botId: bot.id,
    });
    expect(settled).toEqual(['shot() → print {"width":5}', "send(r.csv) → enviado", "art(Painel) → v1"]);
  });

  test("block results become block events on the call log and on the main thread", async () => {
    const { call, settled } = await open({
      tools: [
        tool({
          name: "note",
          run: async () => ({
            id: "nt_1",
            blockEvent: {
              type: "block.created",
              data: {
                kind: "note",
                id: "nt_1",
                title: "Ata",
                version: 1,
                author: "bot",
                action: "created",
                preview: null,
              },
            },
          }),
        }),
      ],
    });
    expect(JSON.parse((await call("note")).text)).toEqual({ id: "nt_1" });
    expect(await settledOf()).toMatchObject({ outcome: "completed", output: { id: "nt_1" } });
    expect((await factsOfType(session, "block.created"))[0].data).toMatchObject({
      id: "nt_1",
      title: "Ata",
      botId: bot.id,
    });
    const thread = await ensureThread(bot.id);
    const main = getStoredSession(thread.sessionId);
    expect(main).toBeDefined();
    expect((await factsOfType(main as StoredSession, "block.created"))[0].data).toMatchObject({
      id: "nt_1",
      botId: bot.id,
    });
    expect(settled).toEqual(["note(Ata) → v1"]);
  });

  test("approval tools ask a person with details, and schedules are refused", async () => {
    const gated = tool({
      name: "risky",
      approval: (input) => `Posso fazer ${input.value}?`,
      details: async () => ({ reason: "porque sim" }),
    });
    const failingDetails = tool({
      name: "risky_two",
      approval: () => "Posso?",
      details: async () => {
        throw new Error("sem detalhes");
      },
    });
    const harness = await open({ tools: [gated, failingDetails], origin: "Ana" });
    expect((await harness.call("risky", { value: "isso" })).isError).toBe(false);
    expect(harness.approvals[0]).toMatchObject({
      prompt: "Posso fazer isso?",
      origin: "Ana",
      details: { reason: "porque sim" },
    });
    expect(await startedOf()).toMatchObject({ clearedBy: { interactionId: "int_1" } });
    await harness.call("risky_two");
    expect(harness.approvals[1].details).toBeUndefined();
    const denied = await open({ tools: [gated], approve: () => "deny" });
    expect((await denied.call("risky", { value: "x" })).text).toBe(
      "A pessoa negou essa ação. Não tente de novo sem pedir.",
    );
    expect(await settledOf()).toMatchObject({ outcome: "rejected", output: { approval: { interactionId: "int_1" } } });
    const scheduled = await open({ tools: [gated], isSchedule: true });
    const refused = await scheduled.call("risky", { value: "x" });
    expect(refused.text).toContain("Ninguém está aqui para aprovar");
    expect(await settledOf()).toMatchObject({ output: { approval: { interactionId: null } } });
  });

  test("gated tools ask Jev first and some always need a person", async () => {
    approvalJev(0.1);
    const gated = (name: string) => tool({ name, approval: () => `Posso ${name}?` });
    const browserBot = await makeBot();
    browserBot.capabilities = { ...browserBot.capabilities, browser: true };
    session = await newSession(browserBot.id);
    const harness = await open(
      { tools: [gated("browser_click"), gated("desktop_type"), gated("desktop_open"), gated("browser_fill")] },
      browserBot,
    );
    await harness.call("browser_click", { ref: "@e1" });
    expect(await startedOf()).toMatchObject({ clearedBy: { decision: "jev", model: "jev-test" } });
    expect(harness.approvals).toHaveLength(0);
    await harness.call("desktop_type", { text: "x" });
    expect(harness.decisions.at(-1)).toMatchObject({
      outcome: "human",
      reason: "Digitar, teclas e terminal sempre passam por uma pessoa.",
    });
    await harness.call("desktop_open", { app: "terminal" });
    expect(harness.decisions.at(-1)?.outcome).toBe("human");
    await harness.call("desktop_open", { app: "browser" });
    expect(harness.decisions.at(-1)?.outcome).toBe("auto_approved");
    expect(harness.approvals).toHaveLength(2);
    await harness.call("browser_fill", { ref: "@e2", text: "segredo:token-x" });
    expect((await factsOfType(session, "call.started")).at(-1)?.data).toMatchObject({ clearedBy: { vault: true } });
    const full = await open({ tools: [gated("browser_click")], permission: "full" });
    await full.call("browser_click", { ref: "@e1" });
    expect(await startedOf()).toMatchObject({ clearedBy: { permission: "full" } });
  });

  test("a hard human reason opens a card even in full mode and Jev never clears it", async () => {
    approvalJev(0.1);
    const outside = tool({
      name: "browser_click",
      approval: (input) => (input.value === "fora" ? "Posso enviar?" : null),
      humanReason: (input) => (input.value === "fora" ? "Sempre passa por uma pessoa." : null),
    });
    const browserBot = await makeBot();
    browserBot.capabilities = { ...browserBot.capabilities, browser: true };
    session = await newSession(browserBot.id);
    const full = await open({ tools: [outside], permission: "full" }, browserBot);
    expect((await full.call("browser_click", { value: "fora" })).isError).toBe(false);
    expect(full.approvals).toHaveLength(1);
    expect(full.decisions.at(-1)).toMatchObject({ outcome: "human", reason: "Sempre passa por uma pessoa." });
    expect(await startedOf()).toMatchObject({ clearedBy: { interactionId: "int_1" } });
    const jev = await open({ tools: [outside] }, browserBot);
    await jev.call("browser_click", { value: "fora" });
    expect(jev.decisions.map((decision) => decision.outcome)).toEqual(["auto_approved", "human"]);
    expect(jev.approvals).toHaveLength(1);
    await full.call("browser_click", { value: "dentro" });
    expect(full.approvals).toHaveLength(1);
    expect(await startedOf()).toEqual({ callId: expect.any(String) });
    const scheduled = await open({ tools: [outside], permission: "full", isSchedule: true }, browserBot);
    expect((await scheduled.call("browser_click", { value: "fora" })).text).toContain("Ninguém está aqui para aprovar");
  });
});

describe("delegate and handoff", () => {
  test("delegate passes work to a teammate and reports its result", async () => {
    const mate = await makeBot();
    const harness = await open({ delegates: [mate] });
    const done = await harness.call("delegate", { bot: mate.id, message: "faz o relatório" });
    expect(done.text).toBe("relatório");
    expect((await factsOfType(session, "call.requested"))[0].data).toMatchObject({
      capability: { name: mate.id, label: `Delegar para ${mate.name}` },
      delegation: { botId: mate.id },
    });
    expect(harness.settled[0]).toBe(`delegate(${mate.id}: faz o relatório) → relatório`);
    const late = await makeBot({ name: "Bot Tardio Ção" });
    await harness.call("delegate", { bot: "bot tardio cao", message: "gera" });
    expect(harness.settled[1]).toBe(`delegate(${late.id}: gera) → relatório`);
    expect((await factsOfType(session, "call.requested"))[1].data).toMatchObject({
      capability: { name: late.id, label: `Delegar para ${late.name}` },
    });
    const failing = await open({
      delegates: [mate],
      origin: "Bia",
      delegate: async () => {
        throw new Error("ocupado");
      },
    });
    expect(await failing.call("delegate", { bot: mate.id, message: "x" })).toMatchObject({
      isError: true,
      text: "ocupado",
    });
    const odd = await open({ delegates: [mate], delegate: () => Promise.reject("estranho") });
    expect((await odd.call("delegate", { bot: mate.id, message: "x" })).text).toBe("estranho");
  });

  test("handoff hands the group turn to another member", async () => {
    const mate = await makeBot();
    const harness = await open({ groupMembers: [mate] });
    const passed = await harness.call("handoff", { bot: mate.id, note: "sua vez" });
    expect(passed.text).toBe(`Ok, ${mate.name} responde em seguida.`);
    expect(harness.handoffs).toEqual([{ botId: mate.id, note: "sua vez" }]);
    expect((await factsOfType(session, "handoff.requested"))[0].data).toEqual({
      from: bot.id,
      to: mate.id,
      note: "sua vez",
    });
  });
});

describe("code tools", () => {
  test("workspace_open uses the VPS runner when the context has none", async () => {
    const opened = spy(actions, "openTaskWorkspace");
    opened.mockImplementation((async () => ({
      workspace: {
        id: "ws1",
        repo: "/r/app",
        repoName: "app",
        path: "/w/app",
        branch: "feat/x",
        base: "origin/main",
        baseCommit: "abc",
        task: "x",
        openedAt: "t",
        active: true,
        closedAt: null,
        install: { status: "skipped" },
      },
    })) as never);
    const { call } = await open({ runner: undefined, provider: "grok" });
    const result = await call("workspace_open", { repo: "app", task: "x" });
    expect(result.text).toContain("Workspace aberto: app em /w/app");
    expect(result.text).toContain("não roda código na VPS");
  });
});

describe("buildServer", () => {
  test("builds a server for a context without connecting it", async () => {
    const harness = toolContext(bot, session);
    revokes.push(harness.revoke);
    expect(buildServer(harness.context)).toBeDefined();
    expect(await factsOf(session)).toHaveLength(0);
  });
});
