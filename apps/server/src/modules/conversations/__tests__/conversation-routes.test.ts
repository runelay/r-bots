import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, type Mock, spyOn, test } from "bun:test";
import { makeBot, waitFor } from "../../../../test/engine-helpers";
import {
  fakeProviders,
  fakeRunelay,
  request,
  resetData,
  startTestServer,
  type TestServer,
} from "../../../../test/helpers";
import { Req, Res } from "../../../shared/http";
import { type BotDefinition, setArchived, setDeleted } from "../../bots/services/bots.service";
import * as runelay from "../../connectors/services/runelay.service";
import { deliver, isBusy } from "../../engine/services/engine.service";
import { handleEve } from "../routes/sessions.routes";
import { createConversation } from "../services/conversations.service";
import { getStoredSession, type StoredSession } from "../services/sessions.service";
import { ensureThread } from "../services/threads.service";

interface Conversation {
  sessionId: string;
  botId: string;
  title: string;
  main: boolean;
  sessionBasePath?: string;
  deliveryId?: string;
  archivedAt?: string | null;
  unread?: number;
}

let server: TestServer;
let bot: BotDefinition;
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
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  jest.useRealTimers();
});

function slug() {
  return `skill-${Math.random().toString(36).slice(2, 9)}`;
}

function skill(name: string) {
  const id = slug();
  fakeRunelay.route("GET", `/skills/${id}`, { data: { slug: id, name, body: "passos" } });
  return id;
}

async function upload(target = bot) {
  const response = await request<{ uploadId: string }>(`/bots/${target.id}/uploads`, {
    method: "POST",
    headers: { "x-file-name": "nota.txt", "content-type": "text/plain" },
    body: "conteúdo da nota",
  });
  expect(response.status).toBe(201);
  return response.body.uploadId;
}

async function settled(sessionId: string) {
  await waitFor(() => !isBusy(sessionId));
}

async function hold(session: StoredSession) {
  let release = () => undefined as void;
  fakeProviders.next(
    ({ emit, signal }) =>
      new Promise<void>((resolve) => {
        release = () => {
          emit({ type: "done", ok: true });
          resolve();
        };
        signal.addEventListener("abort", () => release(), { once: true });
      }),
  );
  const before = fakeProviders.turns.length;
  deliver(session, { deliveryId: "hold", text: "trabalha", source: "chat" });
  await waitFor(() => fakeProviders.turns.length > before);
  return async () => {
    release();
    await settled(session.meta.sessionId);
  };
}

const base = () => `/bots/${bot.id}/conversations`;

describe("conversation list and creation", () => {
  test("lists the main thread and archived conversations", async () => {
    const list = await request<Conversation[]>(base());
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ main: true, botId: bot.id })]);
    const archived = await request<Conversation[]>(`${base()}?archived=1`);
    expect(archived.body).toEqual([]);
  });

  test("creates a conversation with a first message, skills and attachments", async () => {
    const skillId = skill("Relatório");
    const attachment = await upload();
    const created = await request<Conversation>(base(), {
      method: "POST",
      body: {
        title: "Plano",
        permission: "edit",
        message: "Monta o plano",
        skills: [skillId],
        attachments: [attachment],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Plano", main: false, sessionBasePath: `/bots/${bot.id}/eve/v1` });
    expect(typeof created.body.deliveryId).toBe("string");
    expect(getStoredSession(created.body.sessionId)?.meta.permission).toBe("edit");
    await waitFor(() => fakeProviders.turns.some((turn) => turn.request.prompt.includes("Monta o plano")));
    await settled(created.body.sessionId);

    const onlySkill = await request<Conversation>(base(), { method: "POST", body: { skills: [skill("Resumo")] } });
    expect(onlySkill.status).toBe(201);
    expect(typeof onlySkill.body.deliveryId).toBe("string");
    await waitFor(() => fakeProviders.turns.some((turn) => turn.request.prompt.includes("Siga a skill Resumo")));
    await settled(onlySkill.body.sessionId);

    const empty = await request<Conversation>(base(), { method: "POST" });
    expect(empty.status).toBe(201);
    expect(empty.body.deliveryId).toBeUndefined();
    expect(empty.body.title).toBe("Nova conversa");
  });

  test("rejects invalid creation bodies", async () => {
    const cases: Array<[unknown, number, Record<string, unknown>]> = [
      ["[]", 400, { error: "Corpo inválido.", field: "body" }],
      ["{broken", 400, { error: "JSON inválido.", field: "body" }],
      [{ color: 1 }, 400, { field: "color" }],
      [{ title: 5 }, 400, { field: "title" }],
      [{ title: "x".repeat(81) }, 400, { field: "title" }],
      [{ permission: "root" }, 400, { field: "permission" }],
      [{ message: 3 }, 400, { error: "Field 'message' must be a string." }],
      [{ skills: ["Bad Slug"] }, 400, { error: "Field 'skills' has an invalid slug." }],
      [
        { skills: ["a", "b", "c", "d", "e", "f"] },
        400,
        { error: "Field 'skills' must be an array with up to 5 slugs." },
      ],
      [{ attachments: "x" }, 400, { error: "Field 'attachments' must be an array with up to 10 upload ids." }],
      [{ attachments: ["nope"] }, 400, { error: "Field 'attachments' has an invalid upload id." }],
      [{ attachments: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] }, 400, { field: "attachments" }],
      [{ skills: ["missing-skill-x"] }, 400, { error: "Essa skill não existe mais na runelay.", field: "skills" }],
    ];
    for (const [body, status, expected] of cases) {
      const response = await request<Record<string, unknown>>(base(), { method: "POST", body });
      expect({ body, status: response.status }).toEqual({ body, status });
      expect(response.body).toMatchObject({ ok: false, ...expected });
    }
  });

  test("reports runelay failures and a missing runelay for skills", async () => {
    const failing = slug();
    fakeRunelay.route("GET", `/skills/${failing}`, { status: 500, body: { error: { message: "down" } } });
    const broken = await request<{ error: string }>(base(), { method: "POST", body: { skills: [failing] } });
    expect(broken.status).toBe(502);
    expect(broken.body.error).toContain("runelay não respondeu");

    spies.push(spyOn(runelay, "runelayEnabled").mockReturnValue(false) as never);
    const off = await request<{ error: string }>(base(), { method: "POST", body: { skills: [slug()] } });
    expect(off.status).toBe(503);
    expect(off.body.error).toBe("runelay não está configurado no servidor.");
  });

  test("refuses archived and deleted bots", async () => {
    await setArchived(bot.id, true);
    const archived = await request<{ code: string }>(base(), { method: "POST", body: { message: "oi" } });
    expect(archived.status).toBe(409);
    expect(archived.body.code).toBe("bot_archived");
    await setArchived(bot.id, false);
    await setDeleted(bot.id, true);
    const deleted = await request<{ code: string }>(base(), { method: "POST", body: { message: "oi" } });
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe("bot_deleted");
  });
});

describe("conversation search", () => {
  test("validates the query and returns a page", async () => {
    const missing = await request<{ field: string }>(`${base()}/search`);
    expect(missing.status).toBe(400);
    expect(missing.body.field).toBe("q");
    const long = await request<{ error: string }>(`${base()}/search?q=${"a".repeat(201)}`);
    expect(long.status).toBe(400);
    expect(long.body.error).toBe("A busca pode ter até 200 caracteres.");
    const page = await request<{ hits: unknown[]; nextCursor: number | null }>(
      `${base()}/search?q=planejamento&limit=abc&cursor=abc`,
    );
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ hits: [], nextCursor: null });
  });
});

describe("single conversation", () => {
  test("reads, renames, archives, marks and moves", async () => {
    const session = await createConversation(bot.id, { title: "Inicial" });
    const path = `${base()}/${session.meta.sessionId}`;
    const read = await request<Conversation>(path);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe("Inicial");

    const renamed = await request<Conversation>(path, { method: "PATCH", body: { title: "Novo" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("Novo");
    const badRename = await request<{ field: string }>(path, { method: "PATCH", body: { title: "" } });
    expect(badRename.status).toBe(400);
    expect(badRename.body.field).toBe("title");

    const archived = await request<Conversation>(`${path}/archive`, { method: "POST", body: "{broken" });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    const unarchived = await request<Conversation>(`${path}/unarchive`, { method: "POST" });
    expect(unarchived.body.archivedAt).toBeNull();

    const unread = await request<Conversation>(`${path}/unread`, { method: "POST" });
    expect(unread.body.unread).toBe(1);
    const markedRead = await request<Conversation>(`${path}/read`, { method: "POST" });
    expect(markedRead.body.unread).toBe(0);

    const other = await makeBot();
    const moved = await request<Conversation>(`${path}/move`, { method: "POST", body: { botId: other.id } });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ botId: other.id, sessionBasePath: `/bots/${other.id}/eve/v1` });
    const gone = await request<{ error: string }>(path);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe("Conversa não encontrada.");
  });

  test("main thread read state and conversation errors", async () => {
    const thread = await ensureThread(bot.id);
    const path = `${base()}/${thread.sessionId}`;
    const unread = await request<Conversation>(`${path}/unread`, { method: "POST" });
    expect(unread.status).toBe(200);
    expect(unread.body).toMatchObject({ main: true, unread: 1 });
    const read = await request<Conversation>(`${path}/read`, { method: "POST" });
    expect(read.body.unread).toBe(0);

    const archive = await request<{ code: string }>(`${path}/archive`, { method: "POST" });
    expect(archive.status).toBe(400);
    expect(archive.body.code).toBe("main_conversation");

    const session = await createConversation(bot.id, {});
    const conv = `${base()}/${session.meta.sessionId}`;
    const unavailable = await request<{ code: string }>(`${conv}/move`, { method: "POST", body: { botId: "nobody" } });
    expect(unavailable.status).toBe(400);
    expect(unavailable.body.code).toBe("bot_unavailable");
    expect((await request(`${conv}/other`, { method: "POST" })).status).toBe(404);
    expect((await request(conv, { method: "DELETE" })).status).toBe(404);
  });
});

describe("main thread routes", () => {
  test("marks, resets and restores the thread", async () => {
    const path = `/bots/${bot.id}/thread`;
    const unread = await request<{ unread: number }>(`${path}/unread`, { method: "POST", body: "{broken" });
    expect(unread.status).toBe(200);
    expect(unread.body.unread).toBe(1);
    const read = await request<{ unread: number }>(`${path}/read`, { method: "POST", body: "{broken" });
    expect(read.body.unread).toBe(0);

    const first = await request<{ sessionId: string; running: boolean }>(path);
    expect(first.body.running).toBe(false);
    const reset = await request<{ sessionId: string; archiveId: string }>(`${path}/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(reset.body.archiveId).toMatch(/^tha_/);
    expect(reset.body.sessionId).not.toBe(first.body.sessionId);

    const restored = await request<{ sessionId: string; archiveId: string | null }>(`${path}/restore`, {
      method: "POST",
      body: { archiveId: reset.body.archiveId },
    });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ sessionId: first.body.sessionId, archiveId: null });

    const invalid = await request<{ field: string }>(`${path}/restore`, { method: "POST", body: { archiveId: "x" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.field).toBe("archiveId");
    const broken = await request<{ field: string }>(`${path}/restore`, { method: "POST", body: "{broken" });
    expect(broken.status).toBe(400);
    const missing = await request<{ error: string }>(`${path}/restore`, {
      method: "POST",
      body: { archiveId: "tha_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Essa conversa arquivada não existe mais.");
    expect((await request(`${path}/other`, { method: "POST" })).status).toBe(404);
  });

  test("refuses to reset while a turn is running", async () => {
    const thread = await ensureThread(bot.id);
    const session = getStoredSession(thread.sessionId) as StoredSession;
    const release = await hold(session);
    const busy = await request<{ code: string }>(`/bots/${bot.id}/thread/reset`, { method: "POST" });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("turn_running");
    const view = await request<{ running: boolean }>(`/bots/${bot.id}/thread`);
    expect(view.body.running).toBe(true);
    await release();
  });
});

describe("eve sessions", () => {
  const eve = () => `/bots/${bot.id}/eve/v1/session`;

  test("starts sessions with and without a message", async () => {
    const started = await request<{ ok: boolean; sessionId: string; deliveryId: string }>(eve(), {
      method: "POST",
      body: { message: "Começa" },
    });
    expect(started.status).toBe(202);
    expect(started.headers.get("x-eve-session-id")).toBe(started.body.sessionId);
    await waitFor(() => fakeProviders.turns.some((turn) => turn.request.prompt.includes("Começa")));
    await settled(started.body.sessionId);

    const quiet = await request<{ sessionId: string }>(eve(), { method: "POST" });
    expect(quiet.status).toBe(202);
    const session = getStoredSession(quiet.body.sessionId) as StoredSession;
    expect(session.meta.kind).toBe("session");
    expect(isBusy(session.meta.sessionId)).toBe(false);
  });

  test("validates new session requests", async () => {
    expect((await request<{ error: string }>(eve())).status).toBe(405);
    const broken = await request<{ error: string }>(eve(), { method: "POST", body: "{broken" });
    expect(broken.status).toBe(400);
    expect(broken.body.error).toBe("Invalid JSON body.");
    const notObject = await request<{ error: string }>(eve(), { method: "POST", body: "[1]" });
    expect(notObject.body.error).toBe("Body must be a JSON object.");
    const unknown = await request<{ error: string }>(eve(), { method: "POST", body: { other: 1 } });
    expect(unknown.body.error).toContain("Unknown field 'other'");
    const answers = await request<{ error: string }>(eve(), { method: "POST", body: { answers: "x" } });
    expect(answers.body.error).toBe("Field 'answers' must be an array.");
    const skillFail = await request(eve(), { method: "POST", body: { skills: ["missing-skill-y"] } });
    expect(skillFail.status).toBe(400);
    const attachFail = await request(eve(), { method: "POST", body: { attachments: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] } });
    expect(attachFail.status).toBe(400);
    await setDeleted(bot.id, true);
    const deleted = await request<{ code: string }>(eve(), { method: "POST", body: { message: "x" } });
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe("bot_deleted");
  });

  test("posts messages, answers and cancels in a session", async () => {
    const session = await createConversation(bot.id, {});
    const path = `${eve()}/${session.meta.sessionId}`;
    const attachment = await upload();
    const sent = await request<{ sessionId: string; deliveryId: string }>(path, {
      method: "POST",
      body: { message: "Olá", attachments: [attachment] },
    });
    expect(sent.status).toBe(202);
    await waitFor(() => fakeProviders.turns.some((turn) => turn.request.prompt.includes("Olá")));
    await settled(session.meta.sessionId);

    const bySkill = await request(path, { method: "POST", body: { skills: [skill("Checklist")] } });
    expect(bySkill.status).toBe(202);
    await waitFor(() => fakeProviders.turns.some((turn) => turn.request.prompt.includes("Siga a skill Checklist")));
    await settled(session.meta.sessionId);

    const nothing = await request(path, { method: "POST" });
    expect(nothing.status).toBe(202);

    const badAnswer = await request<{ error: string }>(path, {
      method: "POST",
      body: { answers: [{ optionId: "x" }] },
    });
    expect(badAnswer.status).toBe(400);
    expect(badAnswer.body.error).toContain("interactionId and optionId");
    for (const optionId of ["approve", "deny", "approve_always"]) {
      const stale = await request<{ code: string }>(path, {
        method: "POST",
        body: { answers: [{ interactionId: "int_none", optionId }] },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("interaction_not_pending");
    }
    const broken = await request<{ error: string }>(path, { method: "POST", body: "{broken" });
    expect(broken.status).toBe(400);
    const problem = await request<{ error: string }>(path, { method: "POST", body: { message: 1 } });
    expect(problem.body.error).toBe("Field 'message' must be a string.");
    const skillFail = await request(path, { method: "POST", body: { skills: ["missing-skill-z"] } });
    expect(skillFail.status).toBe(400);
    const attachFail = await request(path, { method: "POST", body: { attachments: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] } });
    expect(attachFail.status).toBe(400);

    const cancelled = await request<{ ok: boolean; sessionId: string }>(`${path}/cancel`, {
      method: "POST",
      body: "{broken",
    });
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toMatchObject({ ok: true, sessionId: session.meta.sessionId });
    expect((await request(`${path}/other`)).status).toBe(404);

    await setArchived(bot.id, true);
    const archived = await request<{ code: string }>(path, { method: "POST", body: { message: "x" } });
    expect(archived.status).toBe(409);
    expect(archived.body.code).toBe("bot_archived");
  });

  test("hides sessions of other bots", async () => {
    const other = await makeBot();
    const session = await createConversation(other.id, {});
    const response = await request<{ code: string }>(`${eve()}/${session.meta.sessionId}/events`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("session_not_active");
    expect((await request(`/bots/${bot.id}/eve/v1/other`)).status).toBe(404);
  });

  test("pages events backwards", async () => {
    const session = await createConversation(bot.id, {});
    for (let index = 0; index < 5; index++)
      session.log.emit({ type: "content.completed", data: { kind: "text", value: `m${index}` } });
    const total = session.log.size;
    const path = `${eve()}/${session.meta.sessionId}/events`;
    const last = await request<{ events: Array<{ index: number }>; nextBefore: number | null; total: number }>(
      `${path}?limit=2`,
    );
    expect(last.status).toBe(200);
    expect(last.body.total).toBe(total);
    expect(last.body.events.map((event) => event.index)).toEqual([total - 2, total - 1]);
    expect(last.body.nextBefore).toBe(total - 2);
    const all = await request<{ events: unknown[]; nextBefore: number | null }>(`${path}?limit=abc&before=`);
    expect(all.body.events).toHaveLength(total);
    expect(all.body.nextBefore).toBeNull();
    const early = await request<{ events: Array<{ index: number }> }>(`${path}?before=1&limit=500`);
    expect(early.body.events.map((event) => event.index)).toEqual([0]);
    const bad = await request<{ field: string }>(`${path}?before=-1`);
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("before");
  });
});

describe("eve stream", () => {
  async function open(session: StoredSession, query: string) {
    const controller = new AbortController();
    const raw = new Request(`http://127.0.0.1/bots/${bot.id}/eve/v1/session/${session.meta.sessionId}/stream${query}`, {
      signal: controller.signal,
    });
    const res = new Res(controller.signal);
    const url = new URL(raw.url);
    await handleEve(new Req(raw), res, url, bot, ["v1", "session", session.meta.sessionId, "stream"]);
    return { pending: res.response, controller };
  }

  test("replays the log and ends when not following", async () => {
    const session = await createConversation(bot.id, {});
    session.log.emit({ type: "content.completed", data: { kind: "text", value: "a" } });
    const response = await (await open(session, "?follow=false&startIndex=abc")).pending;
    expect(response.headers.get("x-eve-stream-version")).toBe("27");
    expect(response.headers.get("x-eve-session-id")).toBe(session.meta.sessionId);
    const lines = (await response.text()).trim().split("\n");
    expect(lines).toHaveLength(session.log.size);
    const skipped = await open(session, `?includeTailIndex=1&startIndex=${session.log.size - 1}`);
    expect((await (await skipped.pending).text()).trim().split("\n")).toHaveLength(1);
  });

  test("follows new lines, heartbeats and ends the lease", async () => {
    const session = await createConversation(bot.id, {});
    jest.useFakeTimers();
    const { pending, controller } = await open(session, `?startIndex=${session.log.size}`);
    session.log.emit({ type: "content.completed", data: { kind: "text", value: "ao vivo" } });
    const response = await pending;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    const next = async () => JSON.parse(decoder.decode((await reader.read()).value).trim()) as Record<string, unknown>;
    expect(JSON.stringify(await next())).toContain("ao vivo");
    jest.advanceTimersByTime(15_000);
    expect(await next()).toEqual({ $eve: "heartbeat" });
    jest.advanceTimersByTime(5 * 60_000);
    const tail: Record<string, unknown>[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const line of decoder.decode(chunk.value).trim().split("\n")) tail.push(JSON.parse(line));
    }
    expect(tail.at(-1)).toEqual({ $eve: "stream.lease-ended" });
    controller.abort();
  });
});

describe("sessions list", () => {
  test("shows the main thread first and only used side sessions", async () => {
    const thread = await ensureThread(bot.id);
    const used = await createConversation(bot.id, { title: "Usada" });
    used.meta.turnCount = 1;
    used.meta.scheduleId = "manha";
    const unused = await createConversation(bot.id, { title: "Vazia" });
    const list = await request<Array<{ sessionId: string; title: string; thread: boolean; scheduleId?: string }>>(
      `/bots/${bot.id}/sessions`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({ sessionId: thread.sessionId, title: "Conversa principal", thread: true }),
      expect.objectContaining({ sessionId: used.meta.sessionId, title: "Usada", thread: false, scheduleId: "manha" }),
    ]);
    expect(list.body.some((item) => item.sessionId === unused.meta.sessionId)).toBe(false);
  });
});
