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
    const [requested] = factsOfType(session, "call.requested");
    expect(requested.data).toMatchObject({
      capability: { kind: "tool", name: "thread_read", label: "Relendo a conversa" },
      input: { itemId: "u_turn_0", offset: 0 },
      owner: { runId: "run_0" },
    });
    expect(requested.data).not.toHaveProperty("origin");
    expect(requested.scope).toEqual({ runId: "run_0", turnId: "turn_0" });
    const callId = String(requested.data.callId);
    expect(factsOfType(session, "call.started")[0].data).toEqual({ callId });
    expect(factsOfType(session, "call.settled")[1].data).toEqual({
      callId: String(factsOfType(session, "call.requested")[1].data.callId),
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
    const [requested] = factsOfType(session, "call.requested");
    expect(requested.data).toMatchObject({ owner: { callId: "call_owner" }, origin: { agent: "Bia" } });
    expect(factsOfType(session, "call.settled")[0].data).toMatchObject({
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
    expect(factsOfType(session, "call.settled")[0].data).toMatchObject({
      outcome: "failed",
      error: { code: "ITEM_NOT_FOUND", message: "Conversa não encontrada." },
    });
  });
});
