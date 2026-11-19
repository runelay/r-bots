import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { factsOfType, fakeJev, makeBot, newSession, stopJev } from "../../../../test/engine-helpers";
import { fakeProviders, fakeRunelay, readyProbe, resetData } from "../../../../test/helpers";
import { getDb } from "../../../db";
import { teamMemory } from "../../../db/tables";
import type { Account } from "../../accounts/services/accounts.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import * as runelay from "../../connectors/services/runelay.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import { addTeamEntry, recentTeamEntries } from "../repositories/team-memory.repository";
import { capture, type RecallItem, teamLogBlock } from "../services/memory.service";

const account: Account = {
  id: "vps:claude",
  runner: "vps",
  provider: "claude",
  label: "claude",
  status: "ready",
  models: readyProbe("claude").models,
  detail: "",
  checkedAt: new Date().toISOString(),
};

const durableAnswers = { answers: { durable: { type: "noul", noul: 0.9 }, secret: { type: "noul", noul: 0 } } };

let bot: BotDefinition;
let log: EventLog;

beforeEach(async () => {
  await resetData();
  getDb().delete(teamMemory).run();
  bot = await makeBot();
  log = (await newSession(bot.id)).log;
});

afterEach(() => {
  stopJev();
});

function input(recalled: RecallItem[] = [], replyText = "Anotado, vou usar tabela.") {
  return {
    bot,
    account,
    model: "claude-sonnet",
    userText: "Prefiro números em tabela.",
    replyText,
    recalled,
    log,
    turnId: "turn_1",
  };
}

function extraction(text: string) {
  fakeProviders.next(({ emit }) => {
    emit({ type: "text", part: "0", text });
    emit({ type: "done", ok: true });
  });
}

function teamOf(botId: string) {
  return recentTeamEntries("nobody", "2000-01-01", 50).filter((entry) => entry.botId === botId);
}

describe("teamLogBlock", () => {
  test("is empty when no other bot logged anything today", async () => {
    addTeamEntry({ at: new Date().toISOString(), botId: bot.id, botName: bot.name, summary: "eu mesmo" });
    addTeamEntry({ at: "2001-01-01T10:00:00.000Z", botId: `${bot.id}-old`, botName: "Velho", summary: "antigo" });
    expect(await teamLogBlock(bot.id)).toBe("");
  });

  test("lists today's entries from other bots, oldest first", async () => {
    const other = await makeBot();
    const first = new Date().toISOString();
    addTeamEntry({ at: first, botId: other.id, botName: "Outro", summary: "fez a planilha" });
    addTeamEntry({ at: first, botId: bot.id, botName: bot.name, summary: "eu mesmo" });
    addTeamEntry({ at: first, botId: other.id, botName: "Outro", summary: "mandou o relatório" });
    const block = await teamLogBlock(bot.id);
    const lines = block.split("\n");
    expect(lines[0]).toBe("## O que o time fez hoje");
    expect(block).not.toContain("eu mesmo");
    expect(lines.slice(1)).toEqual([
      `- ${first.slice(11, 16)} Outro: fez a planilha`,
      `- ${first.slice(11, 16)} Outro: mandou o relatório`,
    ]);
  });
});

describe("capture", () => {
  test("records a fallback decision when Jev fails", async () => {
    fakeJev(() => new Response("down", { status: 503 }));
    await capture(input());
    const [decision] = factsOfType(log, "decision.made");
    expect(decision.data).toMatchObject({ kind: "memory", outcome: "fallback", answer: null, model: null });
    expect(String(decision.data.reason)).toContain("503");
    expect(fakeProviders.turns).toHaveLength(0);
  });

  test("skips on a secret verdict, a secret in the text, or a non durable exchange", async () => {
    fakeJev(() => ({ answers: {} }));
    await capture(input());
    fakeJev(() => durableAnswers);
    await capture(input([], "anotei a senha: hunter2"));
    fakeJev(() => ({ answers: { durable: { type: "noul", noul: 0.2 }, secret: { type: "noul", noul: 0 } } }));
    await capture(input());
    expect(factsOfType(log, "decision.made").map((fact) => fact.data)).toMatchObject([
      { outcome: "skip_secret", answer: { durable: 0, secret: 1 } },
      { outcome: "skip_secret", answer: { durable: 0.9, secret: 0 } },
      { outcome: "skip", model: "jev-test", threshold: 0.6 },
    ]);
    expect(fakeProviders.turns).toHaveLength(0);
    expect(fakeRunelay.toolCalls).toHaveLength(0);
  });

  test("writes new and updated memories and logs the team summary", async () => {
    fakeJev(() => durableAnswers);
    fakeRunelay.tool("write_memory", () => "ok");
    extraction(
      `Aqui: ${JSON.stringify({
        facts: [
          { title: "Prefere números em tabela", body: "A pessoa prefere tabela.", tags: ["formato"] },
          { title: "Usa Linear", body: "A pessoa usa Linear." },
          { title: "Token", body: "senha: hunter2" },
          { title: "", body: "sem título" },
        ],
        summary: "combinou formato de tabela",
      })}`,
    );
    await capture(input([{ slug: "pref-tabela", name: "Prefere números em tabela", description: "" }]));
    expect(factsOfType(log, "decision.made")[0].data).toMatchObject({ outcome: "capture", confidence: 0.8 });
    const request = fakeProviders.turns[0].request;
    expect(request.model).toBe("claude-haiku-5-5");
    expect(request.workKey).toBe(`${bot.id}/memory`);
    expect(request.prompt).toContain("- pref-tabela: Prefere números em tabela");
    const writes = fakeRunelay.toolCalls.filter((call) => call.name === "write_memory").map((call) => call.args);
    expect(writes.map((item) => item.slug)).toEqual(["pref-tabela", `rb-${bot.id}-usa-linear`]);
    expect(writes[0]).toMatchObject({ name: "Prefere números em tabela", type: "user" });
    expect(String(writes[0].body)).toContain(`Tags: runelay-bots, ${bot.id}, formato`);
    const saved = factsOfType(log, "memory.saved")[0];
    expect(saved.data).toMatchObject({
      titles: ["Prefere números em tabela", "Usa Linear"],
      items: [
        { slug: "pref-tabela", updated: true },
        { slug: `rb-${bot.id}-usa-linear`, updated: false },
      ],
      botId: bot.id,
    });
    expect(teamOf(bot.id)).toMatchObject([{ botName: bot.name, summary: "combinou formato de tabela" }]);
  });

  test("updates a recalled memory matched by slug", async () => {
    fakeJev(() => durableAnswers);
    fakeRunelay.tool("write_memory", () => "ok");
    extraction(JSON.stringify({ facts: [{ title: "Usa Ação", body: "Por slug." }] }));
    await capture(input([{ slug: "usa-acao", name: "Outro nome", description: "" }]));
    const writes = fakeRunelay.toolCalls.filter((call) => call.name === "write_memory").map((call) => call.args);
    expect(writes.map((item) => item.slug)).toEqual(["usa-acao"]);
    expect(factsOfType(log, "memory.saved")[0].data).toMatchObject({ items: [{ slug: "usa-acao", updated: true }] });
    expect(teamOf(bot.id)).toEqual([]);
  });

  test("stops when the extraction is not JSON, holds a secret summary or nothing new", async () => {
    fakeJev(() => durableAnswers);
    fakeRunelay.tool("write_memory", () => "ok");
    for (const text of [
      "sem json",
      "{ not: json }",
      JSON.stringify({ summary: "token: abcdefghijkl" }),
      JSON.stringify({}),
    ]) {
      extraction(text);
      await capture(input());
    }
    expect(fakeProviders.turns).toHaveLength(4);
    expect(fakeRunelay.toolCalls.filter((call) => call.name === "write_memory")).toHaveLength(0);
    expect(factsOfType(log, "memory.saved")).toHaveLength(0);
    expect(teamOf(bot.id)).toEqual([]);
  });

  test("does nothing while runelay is off", async () => {
    fakeJev(() => durableAnswers);
    const enabled = spyOn(runelay, "runelayEnabled").mockReturnValue(false);
    try {
      await capture(input());
    } finally {
      enabled.mockRestore();
    }
    expect(log.lines).toHaveLength(0);
  });
});
