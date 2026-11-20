import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { factsOfType, fakeJev, makeBot, stopJev } from "../../../../test/engine-helpers";
import { accountFields, fakeProviders, fakeRunelay, readyProbe, resetData } from "../../../../test/helpers";
import { getDb, tables } from "../../../db";
import type { Account } from "../../accounts/services/accounts.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import * as runelay from "../../connectors/services/runelay.service";
import { createStoredSession, type EventLog } from "../../conversations/services/sessions.service";
import { defaultMemory } from "../constants/memory.constants";
import { addTeamEntry, teamEntryExists } from "../repositories/team-memory.repository";
import {
  capture,
  cheapCall,
  cheapModel,
  hasSecret,
  type RecallItem,
  recall,
  recallBlock,
  summarizeForReset,
  teamLogBlock,
} from "../services/memory.service";

const account = (provider: Account["provider"], runner: Account["runner"] = "vps"): Account => ({
  id: `${runner}:${provider}`,
  runner,
  provider,
  label: provider,
  ...accountFields(`${runner}:${provider}`, provider),
  status: "ready",
  models: readyProbe(provider).models,
  detail: "",
  checkedAt: new Date().toISOString(),
});

let bot: BotDefinition;
let log: EventLog;

beforeEach(async () => {
  await resetData();
  bot = await makeBot();
  await getDb().delete(tables.teamMemory);
  log = (await createStoredSession({ botId: bot.id, kind: "session", source: "chat", title: "" })).log;
});

afterEach(async () => {
  stopJev();
  jest.useRealTimers();
});

describe("memory constants", () => {
  test("recall and capture are on by default", async () => {
    expect(defaultMemory).toEqual({ recall: true, capture: true });
  });
});

describe("recall", () => {
  test("maps runelay search results into clean recall items", async () => {
    fakeRunelay.tool("search_context", () => [
      { slug: "a", name: "**Pref** tabela", description: "Gosta   de tabela" },
      { slug: "b", snippet: "trecho" },
      {},
      ...Array.from({ length: 4 }, (_, index) => ({ slug: `x${index}`, name: "x", description: "y" })),
    ]);
    const items = await recall(bot, "como mostro os números?");
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({ slug: "a", name: "Pref tabela", description: "Gosta de tabela" });
    expect(items[1]).toEqual({ slug: "b", name: "b", description: "trecho" });
    expect(items[2]).toEqual({ slug: "", name: "", description: "" });
    expect(fakeRunelay.toolCalls[0].args).toMatchObject({ kind: "memory", limit: 5 });
    expect(String(fakeRunelay.toolCalls[0].args.query)).toContain("Tester");
  });

  test("returns nothing for non-list results, failures, or when runelay is off", async () => {
    fakeRunelay.tool("search_context", () => ({ not: "a list" }));
    expect(await recall(bot, "x")).toEqual([]);
    fakeRunelay.tool("search_context", () => {
      throw new Error("boom");
    });
    expect(await recall(bot, "x")).toEqual([]);
    const enabled = spyOn(runelay, "runelayEnabled").mockReturnValue(false);
    try {
      expect(await recall(bot, "x")).toEqual([]);
    } finally {
      enabled.mockRestore();
    }
  });

  test("gives up after three seconds when runelay hangs", async () => {
    jest.useFakeTimers();
    const call = spyOn(runelay, "runelayCall").mockReturnValue(new Promise(() => undefined));
    try {
      const pending = recall(bot, "x");
      jest.advanceTimersByTime(3000);
      expect(await pending).toEqual([]);
    } finally {
      call.mockRestore();
    }
  });
});

describe("recallBlock", () => {
  test("is empty without items and lists items until the cap", async () => {
    expect(recallBlock([])).toBe("");
    const block = recallBlock([{ slug: "s", name: "Nome", description: "Desc" }]);
    expect(block).toContain("## O que você já sabe");
    expect(block).toContain("- Nome: Desc (memória `s`)");
    const many: RecallItem[] = Array.from({ length: 40 }, (_, index) => ({
      slug: `s${index}`,
      name: "n",
      description: "d".repeat(220),
    }));
    const capped = recallBlock(many);
    expect(capped.length).toBeLessThanOrEqual(6000);
    expect(capped).not.toContain("`s39`");
  });
});

describe("teamLogBlock", () => {
  test("is empty without entries", async () => {
    expect(await teamLogBlock(bot.id)).toBe("");
  });

  test("shows today's entries from other bots only", async () => {
    const today = new Date().toISOString();
    await addTeamEntry({ at: today, botId: "other", botName: "Outro", summary: "fez a planilha" });
    await addTeamEntry({ at: today, botId: bot.id, botName: bot.name, summary: "eu mesmo" });
    await addTeamEntry({ at: "2001-01-01T10:00:00.000Z", botId: "other", botName: "Outro", summary: "velho" });
    const block = await teamLogBlock(bot.id);
    expect(block).toContain("## O que o time fez hoje");
    expect(block).toContain(`${today.slice(11, 16)} Outro: fez a planilha`);
    expect(block).not.toContain("eu mesmo");
    expect(block).not.toContain("velho");
  });

  test("is empty when nothing from today remains", async () => {
    await addTeamEntry({ at: "2001-01-01T00:00:00Z", botId: "o", botName: "O", summary: "s" });
    expect(await teamLogBlock(bot.id)).toBe("");
  });
});

describe("hasSecret", () => {
  test("flags tokens, keys, cards and documents", async () => {
    for (const text of [
      "sk-abcdefghijklmnopqrstu",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abc",
      "Bearer abcdefghijklmnopqrstu",
      "a".repeat(32).replace(/a/g, "f"),
      "4111 1111 1111 1111",
      "123.456.789-09",
      "senha: hunter2",
    ])
      expect(hasSecret(text)).toBe(true);
    expect(hasSecret("prefere tabela")).toBe(false);
  });
});

describe("cheapModel", () => {
  test("picks the cheap model per provider", async () => {
    expect(cheapModel(account("claude"), "big")).toBe("claude-haiku-5-5");
    expect(cheapModel(account("cursor"), "big")).toBe("auto");
    expect(cheapModel(account("codex"), "big")).toBe("big");
  });
});

describe("cheapCall", () => {
  test("joins the text the provider emits", async () => {
    fakeProviders.next(({ emit }) => {
      emit({ type: "text", part: "0", text: "um" });
      emit({ type: "text", part: "1", text: "dois " });
      emit({ type: "done", ok: true });
    });
    expect(await cheapCall(account("claude"), "m", "sys", "prompt", "bot/memory")).toBe("um\ndois");
    const turn = fakeProviders.turns[0];
    expect(turn.request).toMatchObject({ provider: "claude", model: "m", effort: "low", systemPrompt: "sys" });
    expect(turn.request.workKey).toBe("bot/memory");
  });

  test("throws the provider failure", async () => {
    fakeProviders.next(({ emit }) => emit({ type: "done", ok: false, message: "quebrou" }));
    await expect(cheapCall(account("claude"), "m", "s", "p", "k")).rejects.toThrow("quebrou");
    fakeProviders.next(({ emit }) => emit({ type: "done", ok: false }));
    await expect(cheapCall(account("claude"), "m", "s", "p", "k")).rejects.toThrow("falhou");
  });

  test("aborts the provider after ninety seconds", async () => {
    jest.useFakeTimers();
    let aborted = false;
    fakeProviders.next(
      ({ signal, emit }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            emit({ type: "done", ok: false, message: "cancelled" });
            resolve();
          });
        }),
    );
    const pending = cheapCall(account("claude"), "m", "s", "p", "k");
    jest.advanceTimersByTime(90_000);
    await expect(pending).rejects.toThrow("cancelled");
    expect(aborted).toBe(true);
  });
});

describe("capture", () => {
  const input = (recalled: RecallItem[] = [], replyText = "Anotado, vou usar tabela.") => ({
    bot,
    account: account("claude"),
    model: "claude-sonnet",
    userText: "Prefiro números em tabela.",
    replyText,
    recalled,
    log,
    turnId: "turn_1",
  });

  test("does nothing while Jev is off", async () => {
    await capture(input());
    expect(await log.lines()).toHaveLength(0);
  });

  test("does nothing while runelay is off", async () => {
    fakeJev(() => ({ answers: {} }));
    const enabled = spyOn(runelay, "runelayEnabled").mockReturnValue(false);
    try {
      await capture(input());
    } finally {
      enabled.mockRestore();
    }
    expect(await log.lines()).toHaveLength(0);
  });

  test("records a fallback decision when Jev fails", async () => {
    fakeJev(() => new Response("down", { status: 503 }));
    await capture(input());
    const [decision] = await factsOfType(log, "decision.made");
    expect(decision.data).toMatchObject({ kind: "memory", outcome: "fallback", answer: null });
    expect(String(decision.data.reason)).toContain("503");
  });

  test("skips when the exchange carries a secret or is not durable", async () => {
    fakeJev(() => ({ answers: {} }));
    await capture(input());
    expect((await factsOfType(log, "decision.made"))[0].data).toMatchObject({
      outcome: "skip_secret",
      answer: { durable: 0, secret: 1 },
    });
    fakeJev(() => ({ answers: { durable: { type: "noul", noul: 0.2 }, secret: { type: "noul", noul: 0 } } }));
    await capture(input());
    expect((await factsOfType(log, "decision.made"))[1].data).toMatchObject({ outcome: "skip", model: "jev-test" });
    expect(fakeProviders.turns).toHaveLength(0);
  });

  test("writes new and updated memories and logs the team summary", async () => {
    fakeJev(() => ({ answers: { durable: { type: "noul", noul: 0.9 }, secret: { type: "noul", noul: 0 } } }));
    fakeRunelay.tool("write_memory", () => "ok");
    fakeProviders.next(({ emit }) => {
      emit({
        type: "text",
        part: "0",
        text: `Aqui: ${JSON.stringify({
          facts: [
            { title: "Prefere números em tabela", body: "A pessoa prefere tabela.", tags: ["formato"] },
            { title: "Usa Linear", body: "A pessoa usa Linear." },
            { title: "Token", body: "senha: hunter2" },
            { title: "", body: "sem título" },
          ],
          summary: "combinou formato de tabela",
        })}`,
      });
      emit({ type: "done", ok: true });
    });
    await capture(input([{ slug: "pref-tabela", name: "Prefere números em tabela", description: "" }]));
    expect(fakeProviders.turns[0].request.model).toBe("claude-haiku-5-5");
    expect(fakeProviders.turns[0].request.prompt).toContain("- pref-tabela: Prefere números em tabela");
    const writes = fakeRunelay.toolCalls.filter((call) => call.name === "write_memory").map((call) => call.args);
    expect(writes.map((item) => item.slug)).toEqual(["pref-tabela", `rb-${bot.id}-usa-linear`]);
    expect(String(writes[1].body)).toContain(`Tags: runelay-bots, ${bot.id}`);
    const saved = (await factsOfType(log, "memory.saved"))[0];
    expect(saved.data).toMatchObject({
      titles: ["Prefere números em tabela", "Usa Linear"],
      items: [
        { slug: "pref-tabela", updated: true },
        { slug: `rb-${bot.id}-usa-linear`, updated: false },
      ],
      botId: bot.id,
    });
    const [team] = await getDb().select().from(tables.teamMemory);
    expect(team).toMatchObject({ botId: bot.id, botName: bot.name, summary: "combinou formato de tabela" });
    expect(await teamEntryExists({ at: team.at, botId: bot.id, botName: bot.name, summary: team.summary })).toBe(true);
    expect(await teamEntryExists({ at: team.at, botId: "other", botName: bot.name, summary: team.summary })).toBe(
      false,
    );
  });

  test("stops when the extraction is not JSON or holds nothing new", async () => {
    fakeJev(() => ({ answers: { durable: { type: "noul", noul: 0.9 }, secret: { type: "noul", noul: 0 } } }));
    fakeRunelay.tool("write_memory", () => "ok");
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "sem json" }));
    await capture(input());
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "{ quebrado" }));
    await capture(input());
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "{ not: json }" }));
    await capture(input());
    fakeProviders.next(({ emit }) =>
      emit({ type: "text", part: "0", text: JSON.stringify({ summary: "token: abcdefghijkl" }) }),
    );
    await capture(input());
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: JSON.stringify({}) }));
    await capture(input());
    expect(fakeRunelay.toolCalls.filter((call) => call.name === "write_memory")).toHaveLength(0);
    expect(await factsOfType(log, "memory.saved")).toHaveLength(0);
    expect(await getDb().select().from(tables.teamMemory)).toEqual([]);
  });
});

describe("summarizeForReset", () => {
  test("asks the cheap model to merge the previous summary with new items", async () => {
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "- resumo" }));
    expect(await summarizeForReset(account("codex"), "gpt", "Bia", "antes", "[u_1] oi")).toBe("- resumo");
    expect(fakeProviders.turns[0].request.prompt).toContain("Resumo até agora:\nantes");
    expect(fakeProviders.turns[0].request.workKey).toBe("Bia/summary");
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "novo" }));
    await summarizeForReset(account("codex"), "gpt", "Bia", "", "[u_1] oi");
    expect(fakeProviders.turns[1].request.prompt.startsWith("Itens novos")).toBe(true);
  });
});
