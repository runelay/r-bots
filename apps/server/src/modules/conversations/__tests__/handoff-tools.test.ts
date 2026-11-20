import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import type { BotDefinition } from "../../bots/services/bots.service";
import { createConversation } from "../services/conversations.service";
import type { StoredSession } from "../services/sessions.service";

let server: TestServer;
let bot: BotDefinition;
let session: StoredSession;
const clients: Client[] = [];
const revokes: Array<() => unknown> = [];

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
});

async function open(options: ContextOptions = {}, sessionId = session.meta.sessionId) {
  const harness = toolContext(bot, session, { sessionId, ...options });
  revokes.push(harness.revoke);
  const client = await connectMcp(`${server.url}/mcp/${bot.id}/${sessionId}`, harness.context.token);
  clients.push(client);
  const read = async (args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: "thread_read", arguments: args })) as { isError?: boolean };
    return { json: JSON.parse(textOf(result)), isError: result.isError === true };
  };
  return { ...harness, read };
}

function say(text: string) {
  session.log.emit({
    type: "delivery.consumed",
    data: { source: "chat", parts: [{ kind: "text", text }] },
    scope: { turnId: "turn_0" },
  });
}

describe("thread_read", () => {
  test("reads a long item in chunks and logs the call", async () => {
    const long = "a".repeat(4000) + "b".repeat(1000);
    say(long);
    const harness = await open();
    const first = await harness.read({ itemId: "u_turn_0" });
    expect(first.isError).toBe(false);
    expect(first.json).toMatchObject({ itemId: "u_turn_0", offset: 0, totalChars: 5000, nextOffset: 4000 });
    expect(first.json.text).toBe("a".repeat(4000));
    const second = await harness.read({ itemId: "u_turn_0", offset: 4000 });
    expect(second.json).toMatchObject({ offset: 4000, nextOffset: null, text: "b".repeat(1000) });
    expect(harness.calls()).toBe(2);
    expect(harness.settled).toEqual(["thread_read(u_turn_0) → ok", "thread_read(u_turn_0) → ok"]);
    const [requested] = await factsOfType(session, "call.requested");
    expect(requested.data).toMatchObject({
      capability: { kind: "tool", name: "thread_read", label: "Relendo a conversa" },
      input: { itemId: "u_turn_0", offset: 0 },
      owner: { runId: "run_0" },
    });
    expect(requested.data).not.toHaveProperty("origin");
    expect(requested.scope).toEqual({ runId: "run_0", turnId: "turn_0" });
    const callId = String(requested.data.callId);
    expect((await factsOfType(session, "call.started"))[0].data).toEqual({ callId });
    expect((await factsOfType(session, "call.settled"))[1].data).toEqual({
      callId: String((await factsOfType(session, "call.requested"))[1].data.callId),
      outcome: "completed",
      output: { itemId: "u_turn_0", offset: 4000, chars: 1000, totalChars: 5000, nextOffset: null },
    });
  });

  test("fails with the recent ids when the item does not exist, under the owner call and origin", async () => {
    say("oi");
    const harness = await open({ ownerCallId: "call_owner", origin: "Bia" });
    const result = await harness.read({ itemId: "nada" });
    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ error: "Não achei o item nada nesta conversa.", recentIds: ["u_turn_0"] });
    const [requested] = await factsOfType(session, "call.requested");
    expect(requested.data).toMatchObject({ owner: { callId: "call_owner" }, origin: { agent: "Bia" } });
    expect((await factsOfType(session, "call.settled"))[0].data).toMatchObject({
      outcome: "failed",
      error: { code: "ITEM_NOT_FOUND", message: "Não achei o item nada nesta conversa." },
    });
    expect(harness.settled).toEqual(["thread_read(nada) → não achou"]);
  });

  test("fails when the conversation is not loaded", async () => {
    const harness = await open({}, "wrun_missing");
    const result = await harness.read({ itemId: "u_turn_0" });
    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ error: "Conversa não encontrada." });
    expect(harness.settled).toEqual(["thread_read(u_turn_0) → não achou"]);
    expect((await factsOfType(session, "call.settled"))[0].data).toMatchObject({
      outcome: "failed",
      error: { code: "ITEM_NOT_FOUND", message: "Conversa não encontrada." },
    });
  });
});

describe("thread_read across threads", () => {
  function sayIn(target: StoredSession, text: string, turnId = "turn_0") {
    target.log.emit({
      type: "delivery.consumed",
      data: { source: "chat", parts: [{ kind: "text", text }] },
      scope: { turnId },
    });
  }

  test("reads the last messages of a child or own thread and refuses others", async () => {
    const child = await createConversation(bot.id, {
      title: "Filha",
      meta: { parentSessionId: session.meta.sessionId },
    });
    sayIn(child, "primeira", "turn_0");
    sayIn(child, "x".repeat(4100), "turn_1");
    const harness = await open();
    const read = await harness.read({ threadId: child.meta.sessionId, limit: 1 });
    expect(read.isError).toBe(false);
    expect(read.json).toMatchObject({ sessionId: child.meta.sessionId, kind: "side", title: "Filha", status: "idle" });
    expect(read.json.messages).toHaveLength(1);
    expect(read.json.messages[0]).toMatchObject({ itemId: "u_turn_1", role: "user" });
    expect(read.json.messages[0].text).toHaveLength(4001);
    expect((await factsOfType(session, "call.settled"))[0].data).toMatchObject({
      outcome: "completed",
      output: { threadId: child.meta.sessionId, status: "idle", messages: 1 },
    });
    const item = await harness.read({ threadId: child.meta.sessionId, itemId: "u_turn_0" });
    expect(item.json).toMatchObject({ itemId: "u_turn_0", text: "primeira" });

    const stranger = await makeBot();
    const foreign = await createConversation(stranger.id, {});
    const refused = await harness.read({ threadId: foreign.meta.sessionId });
    expect(refused.isError).toBe(true);
    expect(refused.json.error).toBe("Não achei essa conversa entre as suas e as filhas desta.");
    const refusedItem = await harness.read({ threadId: foreign.meta.sessionId, itemId: "u_turn_0" });
    expect(refusedItem.json).toEqual({ error: "Conversa não encontrada." });
    const spawned = await createConversation(stranger.id, { meta: { spawnedBy: session.meta.sessionId } });
    expect((await harness.read({ threadId: spawned.meta.sessionId })).json.kind).toBe("thread");
    expect((await harness.read({ threadId: "wrun_none" })).isError).toBe(true);
    const empty = await harness.read({});
    expect(empty.json).toEqual({ error: "Passe itemId ou threadId." });
    expect(harness.settled.at(-1)).toBe("thread_read() → não achou");
  });

  test("a side thread reads the parent's items it inherited", async () => {
    say("da mãe");
    const side = await createConversation(bot.id, { meta: { parentSessionId: session.meta.sessionId } });
    sayIn(side, "da filha");
    const harness = await open({ log: side.log }, side.meta.sessionId);
    expect((await harness.read({ itemId: "u_turn_0" })).json.text).toBe("da filha");
    side.log.emit({ type: "noop", data: {} });
    const inherited = await harness.read({ itemId: "u_turn_0", offset: 0 });
    expect(inherited.json.text).toBe("da filha");
    const missing = await harness.read({ itemId: "u_turn_9" });
    expect(missing.isError).toBe(true);
    const orphan = await createConversation(bot.id, { meta: { parentSessionId: session.meta.sessionId } });
    session.log.emit({
      type: "delivery.consumed",
      data: { source: "chat", parts: [{ kind: "text", text: "só na mãe" }] },
      scope: { turnId: "turn_3" },
    });
    const fromParent = await open({ log: orphan.log }, orphan.meta.sessionId);
    expect((await fromParent.read({ itemId: "u_turn_3" })).json.text).toBe("só na mãe");
  });
});
