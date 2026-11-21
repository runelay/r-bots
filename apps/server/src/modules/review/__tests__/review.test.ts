import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { makeBot, waitFor } from "../../../../test/engine-helpers";
import { fakeProviders, fakeRunelay, request, startTestServer, type TestServer } from "../../../../test/helpers";
import { getDb } from "../../../db/client";
import * as settings from "../../../db/settings";
import { readSetting } from "../../../db/settings";
import { settings as settingsTable } from "../../../db/tables";
import { resetClock } from "../../../shared/clock";
import {
  type BotDefinition,
  getBot,
  listBots,
  setArchived,
  setDeleted,
  updateSidebar,
} from "../../bots/services/bots.service";
import { listConnections } from "../../connectors/services/runelay.service";
import * as conversations from "../../conversations/services/conversations.service";
import { isBusy } from "../../engine/services/engine.service";
import { type GhOutput, setGhRunner } from "../../github/services/gh-client.service";
import { clearLinearCache } from "../../linear/services/linear.service";
import {
  builtInPresets,
  composeMessage,
  defaultBot,
  githubContext,
  linearContext,
  presetOf,
  type ReviewPreset,
  type ReviewWindow,
  readPresets,
  savePresets,
  windowOf,
} from "../services/review.service";

type Tool = (args: Record<string, unknown>) => unknown;

const tools = new Map<string, Tool>();
const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const ghCalls: Array<{ args: string[]; query: string; variables: Record<string, unknown> }> = [];
let gh: () => GhOutput = () => ghData({});
const spies: Mock<(...args: never[]) => unknown>[] = [];
const archivedBefore: string[] = [];

const period: ReviewWindow = { since: "2026-11-14T00:00:00-03:00", day: "2026-11-14", label: "últimos 7 dias" };

function ghData(data: unknown): GhOutput {
  return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
}

function register() {
  fakeRunelay.tool("list_connections", () => [{ name: "linear_server", status: "ok", toolCount: 30 }]);
  fakeRunelay.tool("call_tool", (args) => {
    const name = String(args.name).replace(/^linear_server\./, "");
    const params = (args.args ?? {}) as Record<string, unknown>;
    toolCalls.push({ name, args: params });
    const tool = tools.get(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    return tool(params);
  });
}

function catalog() {
  tools.set("list_teams", () => ({ teams: [{ id: "team-1", key: "ENG", name: "Acme" }] }));
  tools.set("list_custom_views", () => ({ customViews: [{ id: "v1", name: "Produto" }] }));
  tools.set("list_projects", () => ({ projects: [{ id: "p1", name: "Board" }] }));
}

function issueTools(updated: unknown[], started: unknown[]) {
  tools.set("list_issues", (args) => (args.state === "started" ? { issues: started } : { issues: updated }));
}

async function settled(sessionId: string) {
  await waitFor(() => !isBusy(sessionId));
}

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
  for (const bot of listBots(false, { hidden: true })) {
    archivedBefore.push(bot.id);
    await setArchived(bot.id, true);
  }
  setGhRunner(async (args, stdin) => {
    const parsed = stdin ? (JSON.parse(stdin) as { query: string; variables: Record<string, unknown> }) : null;
    ghCalls.push({ args, query: parsed?.query ?? "", variables: parsed?.variables ?? {} });
    return gh();
  });
});

afterAll(async () => {
  setGhRunner(null);
  for (const id of archivedBefore) await setArchived(id, false);
  await server.close();
});

beforeEach(async () => {
  tools.clear();
  toolCalls.length = 0;
  ghCalls.length = 0;
  clearLinearCache();
  resetClock();
  register();
  await listConnections(true);
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  gh = () => ghData({});
  await getDb().delete(settingsTable).where(eq(settingsTable.key, "review.presets"));
  for (const bot of listBots(false, { hidden: true })) await setArchived(bot.id, true);
});

describe("review presets", () => {
  test("ships the built-in presets", () => {
    expect(builtInPresets().map((preset) => preset.id)).toEqual(["daily", "week", "pulls"]);
  });

  test("validates a preset", () => {
    expect(presetOf({ id: "a", name: " Daily ", prompt: "Resuma", scope: "custom", days: 3 }, 0)).toEqual({
      id: "a",
      name: "Daily",
      prompt: "Resuma",
      scope: "custom",
      days: 3,
      linear: true,
      github: true,
      botId: null,
    });
    expect(() => presetOf({ name: "x", prompt: "y", scope: "year" }, 0)).toThrow();
    expect(() => presetOf({ name: "x", prompt: "y", scope: "custom", days: 120 }, 0)).toThrow();
    expect(() => presetOf({ name: "x", prompt: "y", scope: "today", linear: false, github: false }, 0)).toThrow();
  });

  test("fills defaults and rejects malformed fields", () => {
    const week = presetOf({ id: "bad id!", name: "Semana", prompt: "p", scope: "week", botId: "", github: false }, 2);
    expect(week).toMatchObject({ scope: "week", days: 7, botId: null, linear: true, github: false });
    expect(week.id).toMatch(/^[\w-]{8}$/);
    expect(presetOf({ name: "Hoje", prompt: "p", scope: "today", days: 2.5, botId: "boss" }, 0)).toMatchObject({
      days: 1,
      botId: "boss",
    });
    const fails: Array<[unknown, string]> = [
      [null, "Preset inválido."],
      [[], "Preset inválido."],
      [{ name: "x", prompt: "y", scope: "today", botId: 4 }, "Bot inválido."],
      [{ name: "x", prompt: "y", scope: "today", botId: "b".repeat(81) }, "Bot inválido."],
      [{ name: " ", prompt: "y", scope: "today" }, "Preencha o nome."],
      [{ name: "n".repeat(61), prompt: "y", scope: "today" }, "o nome pode ter até 60 caracteres."],
      [{ name: "x", prompt: 3, scope: "today" }, "Preencha o pedido."],
      [{ name: "x", prompt: "y", scope: "custom", days: 0 }, "O período vai de 1 a 90 dias."],
    ];
    for (const [value, message] of fails) expect(() => presetOf(value, 1)).toThrow(message);
  });

  test("composes a compact message and cuts long context", () => {
    const [daily] = builtInPresets();
    const message = composeMessage(daily, { since: "2026-11-20T00:00:00-03:00", day: "2026-11-20", label: "hoje" }, [
      "## Linear\n\n- ENG-1 Algo · Em progresso",
    ]);
    expect(message.startsWith(daily.prompt)).toBe(true);
    expect(message).toContain("Período: hoje (desde 2026-11-20).");
    expect(message).toContain("- ENG-1 Algo · Em progresso");
    const long = composeMessage(daily, period, ["x".repeat(20_000)]);
    expect(long).toContain(`${"x".repeat(14_000)}\n…(cortado)`);
    expect(long).not.toContain("x".repeat(14_001));
  });

  test("saves presets, renaming repeated ids", async () => {
    const saved = await savePresets({
      presets: [
        { id: "same", name: "A", prompt: "a", scope: "today" },
        { id: "same", name: "B", prompt: "b", scope: "week" },
      ],
    });
    expect(saved[0].id).toBe("same");
    expect(saved[1].id).not.toBe("same");
    expect(await readPresets()).toEqual(saved);
    expect(await readSetting<ReviewPreset[] | null>("review.presets", null)).toEqual(saved);
    await expect(savePresets({ presets: "x" })).rejects.toThrow("Mande a lista em presets.");
    await expect(savePresets([])).rejects.toThrow("Mande a lista em presets.");
    await expect(savePresets(null)).rejects.toThrow("Mande a lista em presets.");
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `P${index}`, prompt: "p", scope: "today" }));
    await expect(savePresets({ presets: many })).rejects.toThrow("Até 20 presets.");
  });

  test("falls back to the built-in presets when the setting cannot be read", async () => {
    spies.push(spyOn(settings, "readSetting").mockRejectedValue(new Error("db down")) as never);
    expect(await readPresets()).toEqual(builtInPresets());
  });
});

describe("default bot and window", () => {
  test("prefers the boss, then a pinned bot, then the oldest usable bot", async () => {
    expect(defaultBot()).toBeNull();
    const first = await makeBot();
    const pinned = await makeBot();
    await updateSidebar(pinned.id, { pinned: true }, () => false);
    const gone = await makeBot({ name: "Boss apagado" });
    await setDeleted(gone.id, true);
    expect(defaultBot()?.id).toBe(pinned.id);
    const boss = await makeBot({ name: "Meu Boss" });
    expect(defaultBot()?.id).toBe(boss.id);
    await setArchived(boss.id, true);
    await updateSidebar(pinned.id, { pinned: false }, () => false);
    expect(defaultBot()?.id).toBe(first.id);
  });

  test("builds the period in the user timezone", async () => {
    const now = new Date("2026-11-21T02:00:00Z");
    expect(await windowOf({ scope: "today", days: 9 }, now)).toEqual({
      since: "2026-11-20T00:00:00-03:00",
      day: "2026-11-20",
      label: "hoje",
    });
    expect(await windowOf({ scope: "week", days: 1 }, now)).toEqual({
      since: "2026-11-14T00:00:00-03:00",
      day: "2026-11-14",
      label: "últimos 7 dias",
    });
    expect((await windowOf({ scope: "custom", days: 3 }, now)).label).toBe("últimos 3 dias");
    expect((await windowOf({ scope: "custom", days: 3 }, now)).day).toBe("2026-11-18");
    expect((await windowOf({ scope: "custom", days: 7 }, now)).label).toBe("últimos 7 dias");
    expect((await windowOf({ scope: "today", days: 1 })).label).toBe("hoje");
  });
});

describe("Linear context", () => {
  test("groups done, started, ongoing and touched issues", async () => {
    issueTools(
      [
        {
          id: "ENG-1",
          title: "Login",
          status: "Concluído",
          completedAt: "2026-11-15T10:00:00Z",
          project: { name: "Board" },
          assignee: "Ana",
        },
        {
          id: "ENG-2",
          title: "Busca",
          status: "Em progresso",
          statusType: "started",
          startedAt: "2026-11-16T10:00:00Z",
          project: "Web",
          assignee: { name: "Bia" },
        },
        { id: "ENG-3", title: "Antiga", status: "Em progresso", statusType: "started", startedAt: "2026-11-01" },
        { id: "ENG-4", title: "Mexida", status: "A fazer", completedAt: "2026-11-01T00:00:00Z", project: "" },
        {},
      ],
      [{ id: "ENG-3", title: "Antiga", status: "Em progresso" }, { id: "ENG-2" }, { id: "ENG-5", title: "Nova" }],
    );
    const context = await linearContext(period, null, null);
    expect(context).toBe(
      [
        "## Linear (minhas issues)",
        "### Concluídas no período (1)\n- ENG-1 Login · Concluído · Board · Ana",
        "### Começadas no período (1)\n- ENG-2 Busca · Em progresso · Web · Bia",
        "### Em andamento agora (2)\n- ENG-3 Antiga · Em progresso\n- ENG-5 Nova · ",
        "### Mexidas no período (2)\n- ENG-4 Mexida · A fazer\n- ?  · ",
      ].join("\n\n"),
    );
    const [updated, started] = toolCalls.filter((call) => call.name === "list_issues");
    expect(updated.args).toMatchObject({ assignee: "me", updatedAt: period.since, limit: 100 });
    expect(started.args).toMatchObject({ assignee: "me", state: "started", limit: 50 });
  });

  test("says nothing happened when the lists are empty", async () => {
    tools.set("list_issues", () => ({}));
    expect(await linearContext(period, "mine", null)).toBe("## Linear (minhas issues)\n\nNada no período.");
  });

  test("scopes by team, saved view or project and names the scope", async () => {
    catalog();
    issueTools([], []);
    expect(await linearContext(period, "team:team-1", "p1")).toStartWith("## Linear (Acme · Board)");
    expect(toolCalls.find((call) => call.name === "list_issues")?.args).toMatchObject({
      team: "team-1",
      project: "p1",
    });
    toolCalls.length = 0;
    expect(await linearContext(period, "view:v1", null)).toStartWith("## Linear (Produto)");
    expect(toolCalls.find((call) => call.name === "list_issues")?.args).toMatchObject({ customView: "v1" });
    toolCalls.length = 0;
    expect(await linearContext(period, "project:p1", "other")).toStartWith("## Linear (Board)");
    expect(toolCalls.find((call) => call.name === "list_issues")?.args).toMatchObject({ project: "p1" });
    expect(await linearContext(period, "view:unknown", "p404")).toStartWith("## Linear (minhas issues)");
  });

  test("keeps the default label when the catalog fails", async () => {
    issueTools([], []);
    tools.set("list_teams", () => {
      throw new Error("boom");
    });
    tools.set("list_projects", () => {
      throw new Error("boom");
    });
    expect(await linearContext(period, "team:team-1", null)).toStartWith("## Linear (minhas issues)");
    expect(await linearContext(period, null, "p1")).toStartWith("## Linear (minhas issues)\n");
    expect(toolCalls.filter((call) => call.name === "list_issues").at(-1)?.args).toMatchObject({
      assignee: "me",
      project: "p1",
    });
  });

  test("rejects malformed scopes before calling Linear", async () => {
    await expect(linearContext(period, "team:a b", null)).rejects.toThrow("Visão inválida.");
    await expect(linearContext(period, "board:x", null)).rejects.toThrow("Visão inválida.");
    await expect(linearContext(period, null, "a/b")).rejects.toThrow("Projeto inválido.");
    expect(toolCalls).toHaveLength(0);
  });
});

describe("GitHub context", () => {
  test("lists each search with state and counts", async () => {
    const pull = {
      number: 7,
      title: "Board",
      url: "https://github.com/acme/api/pull/7",
      repository: { nameWithOwner: "acme/api" },
    };
    gh = () =>
      ghData({
        opened: { issueCount: 3, nodes: [{ ...pull, state: "OPEN" }, null, { title: "sem número" }] },
        merged: { nodes: [{ ...pull, state: "MERGED" }] },
        reviewed: { issueCount: 1, nodes: [{ number: 2, state: "CLOSED" }] },
        waiting: { nodes: [{ ...pull, state: "OPEN", isDraft: true }] },
      });
    const context = await githubContext(period);
    expect(context).toBe(
      [
        "## GitHub",
        "### PRs que abri no período (3)\n- acme/api#7 Board (aberto) https://github.com/acme/api/pull/7",
        "### PRs meus mergeados no período (1)\n- acme/api#7 Board (mergeado) https://github.com/acme/api/pull/7",
        "### PRs que revisei no período (1)\n- ?#2  (fechado) ",
        "### PRs esperando a minha revisão (1)\n- acme/api#7 Board (rascunho) https://github.com/acme/api/pull/7",
      ].join("\n\n"),
    );
    expect(ghCalls[0].variables).toMatchObject({
      opened: "is:pr author:@me created:>=2026-11-14 sort:updated-desc",
      merged: "is:pr author:@me is:merged merged:>=2026-11-14 sort:updated-desc",
    });
    expect(ghCalls[0].query).toContain("waiting: search(type: ISSUE, query: $waiting, first: 30)");
  });

  test("says nothing happened when every search is empty", async () => {
    gh = () => ghData({ opened: { nodes: [] } });
    expect(await githubContext(period)).toBe("## GitHub\n\nNada no período.");
  });
});

describe("review routes", () => {
  test("lists presets with the default bot", async () => {
    const empty = await request<{ presets: Array<{ id: string }>; defaultBotId: string | null }>("/review");
    expect(empty.status).toBe(200);
    expect(empty.body.presets.map((preset) => preset.id)).toEqual(["daily", "week", "pulls"]);
    expect(empty.body.defaultBotId).toBeNull();
    const bot = await makeBot();
    expect((await request<{ defaultBotId: string }>("/review")).body.defaultBotId).toBe(bot.id);
  });

  test("saves presets and validates the body", async () => {
    const bot = await makeBot();
    const saved = await request<{ presets: Array<{ id: string; name: string }>; defaultBotId: string }>(
      "/review/presets",
      { method: "PUT", body: { presets: [{ id: "mine", name: "Meu", prompt: "Resuma", scope: "today" }] } },
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ presets: [{ id: "mine", name: "Meu" }], defaultBotId: bot.id });
    expect((await request<{ presets: unknown[] }>("/review")).body.presets).toEqual(saved.body.presets);
    const invalid = await request<{ field: string }>("/review/presets", { method: "PUT", body: { presets: [{}] } });
    expect(invalid.status).toBe(400);
    expect((await request("/review/presets", { method: "PUT" })).status).toBe(400);
    expect(
      (
        await request("/review/presets", {
          method: "PUT",
          body: "{not json",
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(400);
  });

  test("answers 404 for unknown routes", async () => {
    expect((await request("/review/presets")).status).toBe(404);
    expect((await request("/review/run")).status).toBe(404);
    expect((await request("/review", { method: "POST" })).status).toBe(404);
    expect((await request("/review/run/x", { method: "POST" })).status).toBe(404);
  });

  test("validates the run body", async () => {
    const run = (body: unknown) => request<{ error: string }>("/review/run", { method: "POST", body });
    expect((await run([1])).body.error).toBe("Corpo inválido.");
    expect((await request<{ error: string }>("/review/run", { method: "POST" })).body.error).toBe("Corpo inválido.");
    expect((await run({})).body.error).toBe("Escolha o preset.");
    expect((await run({ presetId: "" })).body.error).toBe("Escolha o preset.");
    expect((await run({ presetId: "x".repeat(121) })).status).toBe(400);
    expect((await run({ presetId: "daily", botId: 3 })).body.error).toBe("Valor inválido.");
    expect((await run({ presetId: "nope" })).body.error).toBe("Preset não encontrado.");
    expect((await run({ presetId: "daily" })).body.error).toBe("Crie um bot para rodar o review.");
  });

  test("runs a preset on the chosen bot with Linear and GitHub context", async () => {
    await makeBot({ name: "Boss" });
    const chosen = await makeBot();
    const now = new Date().toISOString();
    issueTools([{ id: "ENG-9", title: "Feito hoje", status: "Concluído", completedAt: now }], []);
    gh = () =>
      ghData({
        open: { nodes: [{ number: 4, title: "Meu PR", state: "OPEN", repository: { nameWithOwner: "acme/api" } }] },
      });
    const reply = await request<{
      botId: string;
      sessionId: string;
      title: string;
      warnings: string[];
      conversation: { sessionId: string; botId: string };
      sessionBasePath: string;
      deliveryId: string;
    }>("/review/run", { method: "POST", body: { presetId: "daily", botId: chosen.id } });
    expect(reply.status).toBe(201);
    const window = await windowOf({ scope: "today", days: 1 });
    expect(reply.body).toMatchObject({
      botId: chosen.id,
      title: `Daily de hoje · ${window.day.slice(8, 10)}/${window.day.slice(5, 7)}`,
      warnings: [],
      conversation: { sessionId: reply.body.sessionId, botId: chosen.id },
      sessionBasePath: `/bots/${chosen.id}/eve/v1`,
    });
    expect(reply.body.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    await settled(reply.body.sessionId);
    const prompt = fakeProviders.turns.at(-1)?.request.prompt ?? "";
    expect(prompt).toContain(builtInPresets()[0].prompt);
    expect(prompt).toContain("- ENG-9 Feito hoje · Concluído");
    expect(prompt).toContain("- acme/api#4 Meu PR (aberto)");
  });

  test("falls back to the default bot and reports sources that failed", async () => {
    const boss = await makeBot({ name: "Boss" });
    const archived = await makeBot();
    await setArchived(archived.id, true);
    tools.set("list_issues", () => {
      throw new Error("entity not found");
    });
    gh = () => ({ code: 1, stdout: "", stderr: "HTTP 401" });
    const reply = await request<{ botId: string; sessionId: string; warnings: string[] }>("/review/run", {
      method: "POST",
      body: { presetId: "week", botId: archived.id, view: "mine", project: null },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.botId).toBe(boss.id);
    expect(reply.body.warnings.sort()).toEqual(["Não achei isso no Linear.", "o GitHub não respondeu"]);
    await settled(reply.body.sessionId);
    const prompt = fakeProviders.turns.at(-1)?.request.prompt ?? "";
    expect(prompt).toContain("## Linear\n\nNão deu para ler o Linear agora.");
    expect(prompt).toContain("## GitHub\n\nNão deu para ler o GitHub agora.");
  });

  test("uses the preset bot, skips disabled sources and hides non-Linear errors", async () => {
    await makeBot({ name: "Boss" });
    const owner = (await makeBot()) as BotDefinition;
    await savePresets({
      presets: [
        {
          id: "lin",
          name: "Só Linear",
          prompt: "Resuma o Linear",
          scope: "custom",
          days: 2,
          github: false,
          botId: owner.id,
        },
      ],
    });
    const reply = await request<{ botId: string; sessionId: string; warnings: string[] }>("/review/run", {
      method: "POST",
      body: { presetId: "lin", view: "team:bad id" },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.botId).toBe(owner.id);
    expect(reply.body.warnings).toEqual(["o Linear não respondeu"]);
    expect(ghCalls).toHaveLength(0);
    await settled(reply.body.sessionId);
    const prompt = fakeProviders.turns.at(-1)?.request.prompt ?? "";
    expect(prompt).toContain("Período: últimos 2 dias");
    expect(prompt).not.toContain("## GitHub");
    expect(getBot(owner.id)?.archivedAt).toBeFalsy();
  });

  test("answers 502 when the conversation cannot be created", async () => {
    await makeBot();
    await savePresets({ presets: [{ id: "gh", name: "GH", prompt: "p", scope: "today", linear: false }] });
    spies.push(spyOn(conversations, "createConversation").mockRejectedValue(new Error("disk full")) as never);
    const failed = await request<{ ok: boolean; error: string }>("/review/run", {
      method: "POST",
      body: { presetId: "gh" },
    });
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ ok: false, error: "disk full" });
    spies.push(spyOn(conversations, "createConversation").mockRejectedValue("x".repeat(400)) as never);
    const raw = await request<{ error: string }>("/review/run", { method: "POST", body: { presetId: "gh" } });
    expect(raw.status).toBe(502);
    expect(raw.body.error).toBe("Erro interno.");
  });
});
