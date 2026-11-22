import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { makeBot } from "../../../../test/engine-helpers";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import * as botCode from "../../code/services/bot-code.service";
import { createSection } from "../../sections/services/sections.service";
import { postGreeting, publicBot } from "../services/bot-view.service";
import * as botsService from "../services/bots.service";
import { getBot } from "../services/bots.service";

interface PublicBot {
  id: string;
  name: string;
  role: string;
  sessionBasePath: string;
  hasBrowser: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  sidebar: { pinned: boolean; sectionId: string | null; hidden: boolean };
  thread: { sessionId: string | null; lastMessage: { text: string } | null; running: boolean; status: string };
  code: unknown;
  conversations: unknown[];
}

let server: TestServer;
const spies: Mock<(...args: never[]) => unknown>[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function suffix() {
  return Math.random().toString(36).slice(2, 7);
}

describe("bot list", () => {
  test("creates a bot with a greeting and finds it by search", async () => {
    const name = `Joaná ${suffix()}`;
    const created = await request<PublicBot>("/bots", {
      method: "POST",
      body: { name, instructions: "Cuida das finanças." },
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe(name);
    expect(created.body.role).toBe("Cuida das finanças");
    expect(created.body.sessionBasePath).toBe(`/bots/${created.body.id}/eve/v1`);
    expect(created.body.thread.lastMessage?.text).toContain(`Oi! Eu sou ${name}`);
    expect(created.body.thread.running).toBe(false);
    expect(created.body.thread.status).toBe("idle");

    const all = await request<PublicBot[]>("/bots");
    expect(all.status).toBe(200);
    expect(all.body.map((bot) => bot.id)).toContain(created.body.id);

    const byName = await request<PublicBot[]>(`/bots?q=${encodeURIComponent(name.toUpperCase().replace("Á", "A"))}`);
    expect(byName.body.map((bot) => bot.id)).toEqual([created.body.id]);
    const byRole = await request<PublicBot[]>(`/bots?q=${encodeURIComponent("finanças")}`);
    expect(byRole.body.map((bot) => bot.id)).toContain(created.body.id);
    const byMessage = await request<PublicBot[]>(`/bots?q=${encodeURIComponent(`eu sou ${name}`)}`);
    expect(byMessage.body.map((bot) => bot.id)).toEqual([created.body.id]);
    const none = await request<PublicBot[]>(`/bots?q=${suffix()}${suffix()}`);
    expect(none.body).toEqual([]);
  });

  test("lists archived, deleted and hidden bots only when asked", async () => {
    const archived = await makeBot();
    const deleted = await makeBot();
    const section = await createSection({ name: `Sec ${suffix()}` });
    await request(`/bots/${archived.id}/archive`, { method: "POST" });
    await request(`/bots/${deleted.id}/delete`, { method: "POST" });
    const hidden = await makeBot();
    const sidebar = await request<PublicBot>(`/bots/${hidden.id}/sidebar`, {
      method: "PATCH",
      body: { hidden: true, sectionId: section.id },
    });
    expect(sidebar.status).toBe(200);
    expect(sidebar.body.sidebar).toEqual({ pinned: false, hidden: true, sectionId: section.id });

    const ids = async (query: string) => (await request<PublicBot[]>(`/bots${query}`)).body.map((bot) => bot.id);
    const plain = await ids("");
    expect(plain).not.toContain(archived.id);
    expect(plain).not.toContain(deleted.id);
    expect(plain).not.toContain(hidden.id);
    expect(await ids("?archived=1")).toContain(archived.id);
    expect(await ids("?deleted=1")).toContain(deleted.id);
    expect(await ids("?hidden=1")).toContain(hidden.id);
  });

  test("rejects invalid bodies and other methods", async () => {
    const invalid = await request<{ ok: boolean; field: string }>("/bots", { method: "POST", body: { name: "" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ ok: false, field: "name" });
    const method = await request<{ error: string }>("/bots", { method: "DELETE" });
    expect(method.status).toBe(405);
    expect(method.body.error).toBe("Método não permitido.");
  });
});

describe("single bot", () => {
  test("reads, patches, archives, deletes and restores", async () => {
    const bot = await makeBot();
    const read = await request<PublicBot>(`/bots/${bot.id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(bot.id);
    expect(read.body.code).toBeNull();

    const patched = await request<PublicBot>(`/bots/${bot.id}`, { method: "PATCH", body: { role: "Revisor" } });
    expect(patched.status).toBe(200);
    expect(patched.body.role).toBe("Revisor");
    const badPatch = await request<{ field: string }>(`/bots/${bot.id}`, { method: "PATCH", body: { accent: "x" } });
    expect(badPatch.status).toBe(400);
    expect(badPatch.body.field).toBe("accent");

    const archived = await request<PublicBot>(`/bots/${bot.id}/archive`, { method: "POST" });
    expect(archived.body.archivedAt).not.toBeNull();
    const unarchived = await request<PublicBot>(`/bots/${bot.id}/unarchive`, { method: "POST" });
    expect(unarchived.body.archivedAt).toBeNull();

    const deleted = await request<PublicBot>(`/bots/${bot.id}/delete`, { method: "POST", body: "{broken" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedAt).not.toBeNull();
    const restored = await request<PublicBot>(`/bots/${bot.id}/restore`, { method: "POST" });
    expect(restored.body.deletedAt).toBeNull();
    expect(getBot(bot.id)?.deletedAt).toBeNull();

    const badSidebar = await request<{ field: string }>(`/bots/${bot.id}/sidebar`, {
      method: "PATCH",
      body: { sectionId: "sec_none" },
    });
    expect(badSidebar.status).toBe(400);
    expect(badSidebar.body.field).toBe("sectionId");
  });

  test("answers 404 when the bot disappears during a write", async () => {
    const bot = await makeBot();
    const mocks = [
      spyOn(botsService, "updateBot").mockResolvedValue(null),
      spyOn(botsService, "setDeleted").mockResolvedValue(null),
      spyOn(botsService, "updateSidebar").mockResolvedValue(null),
      spyOn(botsService, "setArchived").mockResolvedValue(null),
    ];
    const writes: [string, "PATCH" | "POST", unknown][] = [
      [`/bots/${bot.id}`, "PATCH", { role: "Revisor" }],
      [`/bots/${bot.id}/delete`, "POST", {}],
      [`/bots/${bot.id}/sidebar`, "PATCH", { pinned: true }],
      [`/bots/${bot.id}/archive`, "POST", {}],
    ];
    try {
      for (const [path, method, body] of writes) {
        const answer = await request<{ error: string }>(path, { method, body });
        expect(answer.status).toBe(404);
        expect(answer.body.error).toBe("Bot não encontrada.");
      }
    } finally {
      for (const mock of mocks) mock.mockRestore();
    }
  });

  test("speaks English when the request asks for it", async () => {
    const headers = { "accept-language": "en" };
    const missing = await request<{ error: string }>("/bots/nobody-here", { headers });
    expect(missing.body.error).toBe("Bot not found.");
    const created = await request<PublicBot>("/bots", { method: "POST", headers, body: { name: "English Bot" } });
    expect(created.body.thread.lastMessage?.text).toBe(
      "Hi! I'm English Bot and I just joined the team. What do you want me to do?",
    );
    const meta = await request<{ capabilities: Array<{ id: string; label: string }> }>("/meta", { headers });
    expect(meta.body.capabilities.find((item) => item.id === "computer")?.label).toBe("Your Mac");
  });

  test("unknown bot and unknown route", async () => {
    const missing = await request<{ error: string }>("/bots/nobody-here");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Bot não encontrada.");
    const bot = await makeBot();
    const unknown = await request<{ ok: boolean }>(`/bots/${bot.id}/whatever`);
    expect(unknown.status).toBe(404);
  });

  test("forwards nested routes to their modules", async () => {
    const bot = await makeBot();
    const thread = await request<{ sessionId: string; running: boolean }>(`/bots/${bot.id}/thread`);
    expect(thread.status).toBe(200);
    expect(thread.body.running).toBe(false);

    const sessions = await request<Array<{ sessionId: string; thread: boolean }>>(`/bots/${bot.id}/sessions`);
    expect(sessions.status).toBe(200);
    expect(sessions.body).toEqual([expect.objectContaining({ sessionId: thread.body.sessionId, thread: true })]);

    const conversations = await request<unknown[]>(`/bots/${bot.id}/conversations`);
    expect(conversations.status).toBe(200);
    expect(conversations.body.length).toBe(1);

    const artifacts = await request<unknown[]>(`/bots/${bot.id}/artifacts`);
    expect(artifacts.status).toBe(200);
    expect(artifacts.body).toEqual([]);

    const schedule = await request<{ error: string }>(`/bots/${bot.id}/schedules/none/run`, { method: "POST" });
    expect(schedule.status).toBe(404);
    expect(schedule.body.error).toBe("Rotina não encontrada.");

    const browser = await request<{ field: string }>(`/bots/${bot.id}/browser/control`, {
      method: "POST",
      body: { mode: "x" },
    });
    expect(browser.status).toBe(400);
    expect(browser.body.field).toBe("mode");

    const code = await request<{ workspace: null; files: unknown[] }>(`/bots/${bot.id}/code`);
    expect(code.status).toBe(200);
    expect(code.body).toMatchObject({ workspace: null, files: [] });

    await request(`/bots/${bot.id}/delete`, { method: "POST" });
    const uploads = await request<{ code: string }>(`/bots/${bot.id}/uploads`, { method: "POST", body: "x" });
    expect(uploads.status).toBe(409);
    expect(uploads.body.code).toBe("bot_deleted");

    const voice = await request(`/bots/${bot.id}/voice/other`);
    expect(voice.status).toBe(404);

    const eve = await request(`/bots/${bot.id}/eve/v2/session`);
    expect(eve.status).toBe(404);
  });
});

describe("bot view", () => {
  test("falls back when code lookups fail", async () => {
    const bot = await makeBot();
    spies.push(
      spyOn(botCode, "botIsCoding").mockImplementation(() => Promise.reject(new Error("boom"))) as never,
      spyOn(botCode, "botCodeSummary").mockImplementation(() => Promise.reject(new Error("boom"))) as never,
    );
    const view = await publicBot(bot);
    expect(view.hasBrowser).toBe(false);
    expect(view.code).toBeNull();
    expect(view.computer).toEqual({ allowedRoots: ["~/Desktop", "~/Downloads", "~/Documents"] });
  });

  test("greets once in the main thread", async () => {
    const bot = await makeBot();
    await postGreeting(bot);
    const view = await publicBot(bot);
    expect(view.thread.lastMessage?.text).toBe(
      `Oi! Eu sou ${bot.name} e acabei de chegar no time. O que você quer que eu faça?`,
    );
    expect(view.thread.unread).toBe(1);
  });
});
