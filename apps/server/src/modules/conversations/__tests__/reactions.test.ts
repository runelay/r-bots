import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  connectMcp,
  factsOfType,
  makeBot,
  newSession,
  textOf,
  toolContext,
  waitFor,
} from "../../../../test/engine-helpers";
import { fakeProviders, request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { withLanguage } from "../../../shared/i18n";
import { type BotDefinition, engineOf } from "../../bots/services/bots.service";
import { deliver, isBusy } from "../../engine/services/engine.service";
import * as captureJobs from "../../memory/services/capture-jobs.service";
import * as reactionsService from "../services/reactions.service";
import {
  addReaction,
  normalizeEmoji,
  normalizeTarget,
  reactionNote,
  removeReaction,
  resolveTarget,
  sessionReactions,
  targetsIn,
} from "../services/reactions.service";
import type { StoredSession } from "../services/sessions.service";
import { getStoredSession } from "../services/sessions.service";
import { ensureThread } from "../services/threads.service";

let server: TestServer;
let bot: BotDefinition;
let session: StoredSession;
const clients: Client[] = [];
const revokes: Array<() => unknown> = [];
const spies: Mock<(...args: never[]) => unknown>[] = [];

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
});

function userSays(target: StoredSession, deliveryId: string, text: string) {
  target.log.emit({
    type: "delivery.consumed",
    data: { deliveryId, source: "chat", parts: [{ kind: "text", text }] },
  });
}

function botSays(target: StoredSession, partId: string, text: string, botId?: string) {
  target.log.emit({
    type: "content.completed",
    data: { kind: "text", partId, phase: "reply", value: text, ...(botId ? { botId } : {}) },
  });
}

function reactionsPath(target = session) {
  return `/bots/${bot.id}/eve/v1/session/${target.meta.sessionId}/reactions`;
}

const user = { kind: "user" as const, id: "local" };

describe("emoji and target input", () => {
  test("accepts one emoji, with skin tone, flags and keycaps", () => {
    for (const emoji of ["👍", "❤️", "👍🏽", "🇧🇷", "1️⃣", " 🎉 "]) expect(normalizeEmoji(emoji)).toBe(emoji.trim());
  });

  test("rejects text, several emojis and other values", () => {
    for (const value of ["", "a", "ok", "👍👍", 5, null, "🎉".repeat(20)])
      expect(() => normalizeEmoji(value)).toThrow("Use um emoji só.");
    expect(() => normalizeTarget("")).toThrow("target inválido.");
    expect(() => normalizeTarget("x".repeat(201))).toThrow("target inválido.");
    expect(normalizeTarget(" run_0.0 ")).toBe("run_0.0");
    expect(() => withLanguage("en", () => normalizeEmoji("ok"))).toThrow("Use a single emoji.");
    expect(() => withLanguage("en", () => normalizeTarget(""))).toThrow("Invalid target.");
  });

  test("lists message targets from facts", () => {
    expect(
      targetsIn([
        { type: "delivery.consumed", data: { deliveryId: "d1" } },
        { type: "content.completed", data: { kind: "text", partId: "run_0.0" } },
        { type: "content.completed", data: { kind: "reasoning", partId: "run_0.1" } },
        { type: "turn.started", data: {} },
      ]),
    ).toEqual(["d1", "run_0.0"]);
  });
});

describe("resolveTarget", () => {
  test("finds user and bot messages and ignores non text parts", async () => {
    userSays(session, "d1", "oi");
    botSays(session, "run_0.0", "olá", "outro-bot");
    botSays(session, "run_0.1", "sem bot");
    session.log.emit({ type: "content.completed", data: { kind: "reasoning", partId: "run_0.2", value: "x" } });
    expect(await resolveTarget(session, "d1")).toEqual({ target: "d1", seq: 1, role: "user", botId: null, text: "oi" });
    expect(await resolveTarget(session, "run_0.0")).toMatchObject({ role: "bot", botId: "outro-bot", text: "olá" });
    expect(await resolveTarget(session, "run_0.1")).toMatchObject({ role: "bot", botId: bot.id });
    expect(await resolveTarget(session, "run_0.2")).toBeNull();
    expect(await resolveTarget(session, "nada")).toBeNull();
  });
});

describe("reaction routes", () => {
  test("adds, deduplicates and removes the person's reaction with stream events", async () => {
    userSays(session, "d1", "faz o relatório");
    botSays(session, "run_0.0", "Pronto, relatório feito.");
    const added = await request<{ ok: boolean; reactions: unknown[] }>(reactionsPath(), {
      method: "POST",
      body: { target: "run_0.0", emoji: "🎉" },
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      ok: true,
      target: "run_0.0",
      reactions: [{ target: "run_0.0", emoji: "🎉", author: user }],
    });
    await request(reactionsPath(), { method: "POST", body: { target: "run_0.0", emoji: "🎉" } });
    await request(reactionsPath(), { method: "POST", body: { target: "run_0.0", emoji: "❤️" } });
    expect((await factsOfType(session, "reaction.added")).map((fact) => fact.data.emoji)).toEqual(["🎉", "❤️"]);
    const removed = await request<{ removed: number; reactions: unknown[] }>(reactionsPath(), {
      method: "DELETE",
      body: { target: "run_0.0", emoji: "🎉" },
    });
    expect(removed.body).toMatchObject({ ok: true, removed: 1, reactions: [{ emoji: "❤️" }] });
    const [event] = await factsOfType(session, "reaction.removed");
    expect(event.data).toMatchObject({ target: "run_0.0", emoji: "🎉", author: user });
    const all = await request<{ removed: number; reactions: unknown[] }>(reactionsPath(), {
      method: "DELETE",
      body: { target: "run_0.0" },
    });
    expect(all.body).toMatchObject({ removed: 1, reactions: [] });
  });

  test("rejects a missing message, bad emoji and bad body", async () => {
    userSays(session, "d1", "oi");
    const missing = await request(reactionsPath(), { method: "POST", body: { target: "nada", emoji: "👍" } });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "message_not_found" });
    const bad = await request(reactionsPath(), { method: "POST", body: { target: "d1", emoji: "legal" } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: "emoji" });
    const badDelete = await request(reactionsPath(), { method: "DELETE", body: { target: "d1", emoji: "x" } });
    expect(badDelete.status).toBe(400);
    const noTarget = await request(reactionsPath(), { method: "POST", body: { emoji: "👍" } });
    expect(noTarget.body).toMatchObject({ field: "target" });
    const invalid = await request(reactionsPath(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);
  });

  test("history pages and the thread carry the reactions", async () => {
    userSays(session, "d1", "primeira");
    botSays(session, "run_0.0", "resposta");
    userSays(session, "d2", "segunda");
    await addReaction(session, { target: "d1", emoji: "👀", author: { kind: "bot", id: bot.id } });
    await addReaction(session, { target: "d2", emoji: "👍", author: user });
    const page = await request<{ events: unknown[]; reactions: unknown[] }>(
      `/bots/${bot.id}/eve/v1/session/${session.meta.sessionId}/events?before=2&limit=5`,
    );
    expect(page.body.events).toHaveLength(2);
    expect(page.body.reactions).toEqual([
      { target: "d1", emoji: "👀", author: { kind: "bot", id: bot.id }, at: expect.any(String) },
    ]);
    const thread = await ensureThread(bot.id);
    const main = getStoredSession(thread.sessionId);
    if (!main) throw new Error("thread ausente");
    userSays(main, "d9", "oi");
    await addReaction(main, { target: "d9", emoji: "❤️", author: user });
    const view = await request<{ reactions: Array<{ target: string; emoji: string }> }>(`/bots/${bot.id}/thread`);
    expect(view.body.reactions).toMatchObject([{ target: "d9", emoji: "❤️" }]);
    expect(await sessionReactions(session.meta.sessionId)).toHaveLength(2);
  });
});

describe("react tools", () => {
  async function open(messageId?: string) {
    const harness = toolContext(bot, session, messageId ? { messageId } : {});
    revokes.push(harness.revoke);
    const client = await connectMcp(`${server.url}/mcp/${bot.id}/${session.meta.sessionId}`, harness.context.token);
    clients.push(client);
    return async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
      return { json: JSON.parse(textOf(result)), isError: result.isError === true };
    };
  }

  test("reacts to the current message, swaps its reaction and takes it back", async () => {
    userSays(session, "d1", "roda a suíte longa");
    const call = await open("d1");
    const first = await call("react", { emoji: "👀" });
    expect(first).toMatchObject({ isError: false, json: { ok: true, target: "d1", reactions: [{ emoji: "👀" }] } });
    await call("react", { emoji: "👀" });
    const swapped = await call("react", { emoji: "✅" });
    expect(swapped.json.reactions).toEqual([
      { target: "d1", emoji: "✅", author: { kind: "bot", id: bot.id }, at: expect.any(String) },
    ]);
    expect((await factsOfType(session, "reaction.added")).map((fact) => fact.data.emoji)).toEqual(["👀", "✅"]);
    expect((await factsOfType(session, "reaction.removed")).map((fact) => fact.data.emoji)).toEqual(["👀"]);
    const taken = await call("unreact", {});
    expect(taken.json).toMatchObject({ ok: true, removed: 1, reactions: [] });
  });

  test("reacts to another message by target and reports errors", async () => {
    userSays(session, "d1", "oi");
    botSays(session, "run_0.0", "olá");
    const call = await open();
    expect((await call("react", { emoji: "👍", target: "d1" })).json).toMatchObject({ ok: true, target: "d1" });
    expect(await call("react", { emoji: "👍" })).toMatchObject({
      isError: true,
      json: { error: "Sem mensagem para reagir." },
    });
    expect(await call("unreact", {})).toMatchObject({
      isError: true,
      json: { error: "Sem mensagem para tirar a reação." },
    });
    expect(await call("react", { emoji: "texto", target: "d1" })).toMatchObject({
      isError: true,
      json: { error: "Use um emoji só." },
    });
    expect(await call("react", { emoji: "👍", target: "sumiu" })).toMatchObject({
      isError: true,
      json: { error: "Mensagem não encontrada." },
    });
  });
});

describe("unexpected failures", () => {
  test("surface as errors in the route and the tool", async () => {
    userSays(session, "d1", "oi");
    const broken = spyOn(reactionsService, "addReaction").mockRejectedValue(new Error("banco fora"));
    spies.push(broken as unknown as Mock<(...args: never[]) => unknown>);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    spies.push(error as unknown as Mock<(...args: never[]) => unknown>);
    const route = await request(reactionsPath(), { method: "POST", body: { target: "d1", emoji: "👍" } });
    expect(route.status).toBe(500);
    const harness = toolContext(bot, session, { messageId: "d1" });
    revokes.push(harness.revoke);
    const client = await connectMcp(`${server.url}/mcp/${bot.id}/${session.meta.sessionId}`, harness.context.token);
    clients.push(client);
    const result = (await client.callTool({ name: "react", arguments: { emoji: "👍" } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("banco fora");
  });
});

describe("reaction signals", () => {
  test("notes the person's reactions to this bot once", async () => {
    const other = await makeBot();
    userSays(session, "d1", "pergunta");
    botSays(session, "run_0.0", "Resposta longa ".repeat(10));
    botSays(session, "run_0.1", "do outro", other.id);
    await addReaction(session, { target: "d1", emoji: "👍", author: { kind: "bot", id: bot.id } });
    await addReaction(session, { target: "run_0.0", emoji: "👍", author: user });
    await addReaction(session, { target: "run_0.1", emoji: "😂", author: user });
    const note = await reactionNote(session, bot.id);
    expect(note).toContain("A pessoa reagiu 👍 à sua resposta (“Resposta longa");
    expect(note).toContain("…”)");
    expect(note).not.toContain("😂");
    expect(await reactionNote(session, bot.id)).toBe("");
    expect(await reactionNote(session, other.id)).toContain("A pessoa reagiu 😂 à sua resposta (“do outro”).");
    await removeReaction(session, { target: "run_0.0", author: user });
    await addReaction(session, { target: "run_0.0", emoji: "🎉", author: user });
    expect(await reactionNote(session, bot.id)).toContain("🎉");
  });

  test("👍 and 👎 on a bot reply feed the memory capture", async () => {
    const queued = spyOn(captureJobs, "queueCapture").mockResolvedValue(undefined);
    spies.push(queued as unknown as Mock<(...args: never[]) => unknown>);
    userSays(session, "d1", "manda em tabela");
    botSays(session, "run_0.0", "| a | b |");
    await addReaction(session, { target: "run_0.0", emoji: "👍", author: user });
    expect(queued).not.toHaveBeenCalled();
    session.meta.lastEngine = { account: engineOf(bot).account, model: "modelo" };
    await addReaction(session, { target: "run_0.0", emoji: "❤️", author: user });
    await addReaction(session, { target: "d1", emoji: "👎", author: user });
    await addReaction(session, { target: "run_0.0", emoji: "👎", author: user });
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0][0]).toMatchObject({
      bot: { id: bot.id },
      model: "modelo",
      userText: "manda em tabela",
      replyText: "| a | b |",
      recalled: [],
      feedback: "👎",
      turnId: "reaction_run_0.0",
      sessionId: session.meta.sessionId,
    });
    queued.mockRejectedValueOnce(new Error("fila fora"));
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    spies.push(warn as unknown as Mock<(...args: never[]) => unknown>);
    await removeReaction(session, { target: "run_0.0", author: user });
    expect(await addReaction(session, { target: "run_0.0", emoji: "👍", author: user })).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("reaction feedback failed", "fila fora");
    queued.mockRejectedValueOnce("texto");
    await removeReaction(session, { target: "run_0.0", author: user });
    await addReaction(session, { target: "run_0.0", emoji: "👍", author: user });
    expect(warn).toHaveBeenCalledWith("reaction feedback failed", "texto");
    session.meta.lastEngine = { account: "sumiu:claude", model: "modelo" };
    await removeReaction(session, { target: "run_0.0", author: user });
    await addReaction(session, { target: "run_0.0", emoji: "👍", author: user });
    expect(queued).toHaveBeenCalledTimes(3);
  });

  test("the next turn hears the reaction and the system prompt carries the guide", async () => {
    userSays(session, "d1", "oi");
    botSays(session, "run_0.0", "Oi! Tudo certo.");
    await addReaction(session, { target: "run_0.0", emoji: "❤️", author: user });
    await deliver(session, { deliveryId: "d2", text: "e agora?", source: "chat" });
    await waitFor(() => !isBusy(session.meta.sessionId) && fakeProviders.turns.length > 0);
    const turnRequest = fakeProviders.turns[0].request;
    expect(turnRequest.prompt).toContain("A pessoa reagiu ❤️ à sua resposta (“Oi! Tudo certo.”).");
    expect(turnRequest.systemPrompt).toContain("## Reações (`react`, `unreact`)");
    expect(session.meta.reactionsNoted?.[bot.id]).toBeString();
  });
});
