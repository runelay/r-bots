import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { hold, idle, quietEngine, restoreTracked, run, sequence, track } from "../../../../test/engine-turn-helpers";
import { fakeProviders, replyWith, startTestServer, type TestServer } from "../../../../test/helpers";
import * as accounts from "../../accounts/services/accounts.service";
import { type BotDefinition, setArchived } from "../../bots/services/bots.service";
import type { WorkspaceState } from "../../code/services/workspace.service";
import { childConversations, publicConversation } from "../../conversations/services/conversations.service";
import { getStoredSession, type StoredSession } from "../../conversations/services/sessions.service";
import { outboxDir } from "../../uploads/services/send-file.service";
import * as uploads from "../../uploads/services/uploads.service";
import { importBotFile, publicUpload } from "../../uploads/services/uploads.service";
import * as engine from "../services/engine.service";
import {
  createThread,
  openSideThread,
  publicThread,
  reportToParent,
  sideContext,
  sideLimits,
  threadDepth,
} from "../services/side-threads.service";

let server: TestServer;
let bot: BotDefinition;
const clients: Client[] = [];
const revokes: Array<() => unknown> = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  quietEngine();
  bot = await makeBot();
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const revoke of revokes.splice(0)) revoke();
  restoreTracked();
});

async function consumed(session: StoredSession) {
  return (await factsOfType(session, "delivery.consumed")).map((fact) => fact.data) as Array<Record<string, unknown>>;
}

function workspace(): WorkspaceState {
  return {
    id: "repo-x-wt",
    repo: "/tmp/repo-x",
    repoName: "repo-x",
    path: "/tmp/worktrees/repo-x/repo-x-wt",
    branch: "feat/x",
    base: "main",
    baseCommit: "abc",
    task: "",
    openedAt: new Date().toISOString(),
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null },
  };
}

describe("side threads", () => {
  test("fork the parent's Claude session and leave the parent untouched", async () => {
    const parent = await newSession(bot.id);
    await run(parent, { text: "contexto da mãe" });
    const before = { ...parent.meta.providerSessions };
    const [key] = Object.keys(before);
    fakeProviders.next(replyWith("lado ok"));
    const { session: side, deliveryId } = await openSideThread(parent, { text: "verifica os testes" });
    expect(deliveryId).toEqual(expect.any(String));
    await idle(side);
    const request = fakeProviders.turns.at(-1)?.request;
    expect(request?.resume).toBe(before[key]);
    expect(request?.fork).toBe(true);
    expect(request?.prompt).not.toContain("Contexto da conversa principal");
    expect(request?.systemPrompt).toContain("## Conversa secundária");
    expect(request?.systemPrompt).toContain("## Conversas secundárias");
    expect(side.meta.title).toBe("↳ Verifica os testes");
    expect(side.meta.parentSessionId).toBe(parent.meta.sessionId);
    expect(side.meta.forkPending).toBeUndefined();
    expect(side.meta.providerSessions?.[key]).toBe(`session-${request?.turnId}`);
    expect(parent.meta.providerSessions).toEqual(before);
    expect((await publicConversation(side)).parentSessionId).toBe(parent.meta.sessionId);
    await run(side, { text: "e agora?" });
    expect(fakeProviders.turns.at(-1)?.request.fork).toBeUndefined();
  });

  test("still forks a Claude session when the accounts cannot be listed", async () => {
    const parent = await newSession(bot.id);
    await run(parent, { text: "contexto da mãe" });
    const [key] = Object.keys(parent.meta.providerSessions ?? {});
    track(spyOn(accounts, "listAccounts").mockRejectedValueOnce(new Error("accounts down")));
    fakeProviders.next(replyWith("lado ok"));
    const { session: side } = await openSideThread(parent, { text: "verifica os testes" });
    await idle(side);
    const request = fakeProviders.turns.at(-1)?.request;
    expect(request?.fork).toBe(true);
    expect(request?.resume).toBe(parent.meta.providerSessions?.[key]);
  });

  test("seed providers without fork with the parent's handoff and share the worktree", async () => {
    const parent = await newSession(bot.id);
    await run(parent, { text: "contexto da mãe" });
    parent.meta.providerSessions = { "vps:codex@home": "cx-1" };
    const { session: side } = await openSideThread(parent, { text: "segue por outro lado" });
    await idle(side);
    const request = fakeProviders.turns.at(-1)?.request;
    expect(request?.resume).toBeNull();
    expect(request?.fork).toBeUndefined();
    expect(request?.prompt).toContain("## Contexto da conversa principal");
    expect(request?.prompt).toContain("contexto da mãe");

    const open = workspace();
    parent.meta.workspaces = [open];
    parent.meta.workspace = open;
    const { session: coding } = await openSideThread(parent, { title: "Paralela" });
    expect(coding.meta.title).toBe("↳ Paralela");
    expect(coding.meta.workspaces).toEqual([open]);
    expect(coding.meta.workspace).not.toBe(open);
    expect(coding.meta.workspace?.id).toBe(open.id);
    expect(coding.meta.providerSessions).toBeUndefined();
    const context = await sideContext(coding, false);
    expect(context.note).toContain(open.path);
    expect(context.carry).toBe("");
  });

  test("report the result back to an idle parent as a new message", async () => {
    const parent = await newSession(bot.id);
    fakeProviders.next(replyWith("achei o bug"));
    const { session: side } = await openSideThread(parent, { text: "investiga", report: true });
    await idle(side);
    const [message] = await waitFor(async () => {
      const list = await consumed(parent);
      return list.length > 0 ? list : null;
    });
    await idle(parent);
    expect(message.side).toEqual({ sessionId: side.meta.sessionId, title: "↳ Investiga", outcome: "completed" });
    expect(message.parts).toEqual([
      { kind: "text", text: `Resultado da conversa secundária “↳ Investiga” (${side.meta.sessionId}):\nachei o bug` },
    ]);
  });

  test("steer the result into a parent turn that is still running", async () => {
    const parent = await newSession(bot.id);
    const held = hold([{ type: "text", part: "p", text: "mãe" }]);
    fakeProviders.next(sequence(held.script, replyWith("lado pronto"), replyWith("considerei")));
    engine.deliver(parent, { deliveryId: "dlv_parent", text: "trabalha", source: "chat" });
    await held.started;
    const { session: side } = await openSideThread(parent, { text: "faz em paralelo", report: true });
    await idle(side);
    const steered = await waitFor(async () => (await consumed(parent)).find((item) => item.steer === true));
    expect(steered.side).toMatchObject({ sessionId: side.meta.sessionId, outcome: "completed" });
    held.release();
    await idle(parent);
    expect(fakeProviders.turns.at(-1)?.request.prompt).toContain("Resultado da conversa secundária");
  });

  test("hand files, failures and cancels back to the parent", async () => {
    const parent = await newSession(bot.id);
    const side = (await openSideThread(parent)).session;
    mkdirSync(outboxDir(bot.id), { recursive: true });
    const path = join(outboxDir(bot.id), "grafico.txt");
    writeFileSync(path, "dados");
    const meta = await importBotFile(bot.id, path);
    const attachment = publicUpload(bot.id, meta);
    const delivered = track(spyOn(engine, "deliver").mockResolvedValue(undefined));
    const realRead = uploads.readUpload;
    track(
      spyOn(uploads, "readUpload").mockImplementation(async (owner, uploadId) =>
        uploadId === "upl_broken" ? Promise.reject(new Error("storage down")) : realRead(owner, uploadId),
      ),
    );
    await reportToParent(parent.meta.sessionId, side, {
      outcome: "completed",
      reply: " ",
      files: [
        { botId: bot.id, attachment },
        { botId: bot.id, attachment },
        { botId: "outro", attachment },
        { botId: bot.id, attachment: { ...attachment, uploadId: "upl_broken" } },
      ],
    });
    await reportToParent(parent.meta.sessionId, side, { outcome: "failed", reply: "", error: "quebrou" });
    await reportToParent(parent.meta.sessionId, side, { outcome: "failed", reply: "" });
    await reportToParent(parent.meta.sessionId, side, { outcome: "cancelled", reply: "" });
    await reportToParent("wrun_gone", side, { outcome: "completed", reply: "x" });
    const sent = delivered.mock.calls.map(([, delivery]) => delivery);
    expect(sent).toHaveLength(4);
    expect(sent[0].text).toEndWith(":\nTerminou sem responder.");
    expect(sent[0].attachments?.map((item) => item.uploadId)).toEqual([meta.uploadId]);
    expect(sent[1].text).toEndWith(":\nFalhou: quebrou");
    expect(sent[2].text).toEndWith(":\nFalhou: erro desconhecido");
    expect(sent[3].text).toEndWith(":\nParou antes de terminar.");
    expect(sent[3].attachments).toBeUndefined();
  });

  test("a failed report is only logged", async () => {
    const parent = await newSession(bot.id);
    const warn = track(spyOn(console, "warn").mockImplementation(() => undefined));
    const sent: engine.Delivery[] = [];
    track(
      spyOn(engine, "deliver").mockImplementation(async (_session, delivery) => {
        sent.push(delivery);
        if (delivery.side) throw new Error("fila caiu");
      }),
    );
    await openSideThread(parent, { text: "x", report: true });
    const hooks = sent[0].delegation;
    hooks?.onStart("turn_0");
    hooks?.onAwaiting(true);
    hooks?.finish({ outcome: "completed", reply: "ok" });
    await waitFor(() => warn.mock.calls.length > 0);
    expect(String(warn.mock.calls[0][0])).toContain("fila caiu");
  });
});

describe("thread guardrails", () => {
  test("refuse groups, deep nesting, too many running children and archived bots", async () => {
    const group = await newSession(bot.id, "group");
    await expect(openSideThread(group)).rejects.toMatchObject({ code: "not_conversation", status: 400 });
    await expect(createThread(group, bot, { message: "x" })).rejects.toMatchObject({ code: "group_session" });

    const parent = await newSession(bot.id);
    const child = (await openSideThread(parent)).session;
    const grandchild = (await openSideThread(child)).session;
    expect(threadDepth(grandchild)).toBe(2);
    await expect(openSideThread(grandchild)).rejects.toMatchObject({ code: "depth_limit" });

    const busy = await newSession(bot.id);
    for (let index = 0; index < sideLimits.running; index++) await openSideThread(busy);
    track(spyOn(engine, "conversationStatus").mockReturnValue("working"));
    await expect(openSideThread(busy)).rejects.toMatchObject({ code: "too_many_threads", status: 409 });
    restoreTracked();
    quietEngine();

    await setArchived(bot.id, true);
    await expect(openSideThread(parent)).rejects.toMatchObject({ code: "bot_unavailable" });
  });

  test("depth ignores missing parents and cycles", async () => {
    const a = await newSession(bot.id);
    const b = await newSession(bot.id);
    a.meta.parentSessionId = "wrun_missing";
    expect(threadDepth(a)).toBe(0);
    a.meta.parentSessionId = b.meta.sessionId;
    b.meta.parentSessionId = a.meta.sessionId;
    expect(threadDepth(a)).toBe(1);
    expect(await sideContext(b, true)).toMatchObject({ carry: "" });
    const lone = await newSession(bot.id);
    expect(await sideContext(lone, true)).toEqual({ note: "", carry: "" });
  });
});

describe("thread_create", () => {
  test("opens independent conversations for this bot or another one", async () => {
    const parent = await newSession(bot.id);
    parent.meta.permission = "edit";
    const worker = await makeBot({ name: `Obreiro ${Math.random().toString(36).slice(2, 6)}` });
    const own = await createThread(parent, bot, { message: "revisa o PR" });
    const other = await createThread(parent, bot, { bot: worker.name, title: "Levantamento", message: "levanta" });
    await idle(own);
    await idle(other);
    expect(own.meta).toMatchObject({ botId: bot.id, spawnedBy: parent.meta.sessionId, permission: "edit" });
    expect(own.meta.title).toBe("Revisa o PR");
    expect(other.meta).toMatchObject({ botId: worker.id, title: "Levantamento" });
    const prompts = fakeProviders.turns.map((turn) => turn.request.prompt);
    expect(prompts.some((prompt) => prompt.endsWith("revisa o PR"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("outro bot do time, abriu esta conversa com você:\nlevanta"))).toBe(
      true,
    );
    expect(childConversations(parent.meta.sessionId).map((item) => item.meta.sessionId)).toEqual([
      own.meta.sessionId,
      other.meta.sessionId,
    ]);
    expect(await publicThread(own)).toMatchObject({ kind: "thread", botId: bot.id, status: "idle" });
    await expect(createThread(parent, bot, { bot: "ninguém", message: "x" })).rejects.toMatchObject({
      code: "bot_unavailable",
    });
  });
});

describe("thread tools", () => {
  async function open(session: StoredSession) {
    const harness = toolContext(bot, session);
    revokes.push(harness.revoke);
    const client = await connectMcp(`${server.url}/mcp/${bot.id}/${session.meta.sessionId}`, harness.context.token);
    clients.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
      const text = textOf(result);
      return { json: result.isError ? text : JSON.parse(text), isError: result.isError === true };
    };
    return { ...harness, call };
  }

  test("thread_side, thread_create and thread_list", async () => {
    const parent = await newSession(bot.id);
    const harness = await open(parent);
    const side = await harness.call("thread_side", { message: "pesquisa", title: "Pesquisa" });
    expect(side.isError).toBe(false);
    expect(side.json).toMatchObject({ title: "↳ Pesquisa", note: expect.stringContaining("Roda em paralelo") });
    const sideSession = getStoredSession(side.json.sessionId) as StoredSession;
    await idle(sideSession);
    await waitFor(async () => (await consumed(parent)).find((item) => item.side));
    await idle(parent);
    const created = await harness.call("thread_create", { message: "outra frente", title: "Frente" });
    expect(created.json).toMatchObject({ title: "Frente", kind: "thread", botId: bot.id });
    await idle(getStoredSession(created.json.sessionId) as StoredSession);
    const listed = await harness.call("thread_list");
    expect(listed.json.threads.map((item: { kind: string }) => item.kind)).toEqual(["side", "thread"]);
    const requested = (await factsOfType(parent, "call.requested")).map((fact) => fact.data.capability);
    expect(requested).toEqual([
      { kind: "tool", name: "thread_side", label: "Abrir conversa secundária" },
      { kind: "tool", name: "thread_create", label: "Abrir conversa nova" },
      { kind: "tool", name: "thread_list", label: "Ver conversas filhas" },
    ]);
    expect(harness.settled[0]).toStartWith("thread_side → ");
  });

  test("tool errors come back as tool errors", async () => {
    const group = await newSession(bot.id, "group");
    const harness = await open(group);
    const side = await harness.call("thread_side", { message: "x" });
    expect(side.isError).toBe(true);
    expect(String(side.json)).toContain("Conversa secundária");
    const created = await harness.call("thread_create", { message: "x", bot: "ninguém" });
    expect(created.isError).toBe(true);
    expect((await factsOfType(group, "call.settled")).map((fact) => fact.data.outcome)).toEqual(["failed", "failed"]);
    expect(harness.settled[0]).toStartWith("thread_side → falhou:");
    const gone = toolContext(bot, group, { sessionId: "wrun_gone" });
    revokes.push(gone.revoke);
    const client = await connectMcp(`${server.url}/mcp/${bot.id}/wrun_gone`, gone.context.token);
    clients.push(client);
    const missing = (await client.callTool({ name: "thread_side", arguments: { message: "x" } })) as {
      isError?: boolean;
    };
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("Conversa não encontrada.");
    await group.log.flush();
  });
});
