import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { fakeAgenda } from "../../../../test/agenda-helpers";
import { factsOfType, makeBot } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { encodeEventId } from "../../agenda/services/agenda.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import * as runelay from "../../connectors/services/runelay.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import { createNote, writeNote } from "../../notes/services/notes.service";
import { Req, Res } from "../../../shared/http";
import { blockRoots, handleBotBlocks } from "../routes/blocks.routes";

interface Failure {
  ok: false;
  error: string;
  code?: string;
  version?: number;
  accountId?: string;
}

const spies: Array<{ mockRestore(): void }> = [];
let server: TestServer;
let bot: BotDefinition;
let base: string;

beforeAll(async () => {
  server = await startTestServer();
  bot = await makeBot();
  base = `/bots/${bot.id}`;
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function threadFacts(type: string) {
  const thread = await ensureThread(bot.id);
  const session = getStoredSession(thread.sessionId);
  if (!session) throw new Error("thread session missing");
  return factsOfType(session, type) as Array<{ data: Record<string, unknown> }>;
}

describe("notes routes", () => {
  test("create, read, edit, link, move and delete a note", async () => {
    const folder = `Rotas ${Math.random().toString(36).slice(2, 7)}`;
    const created = await request<{ id: string; title: string; version: number }>(`${base}/notes`, {
      method: "POST",
      body: { title: "Agenda da semana", folder, content: "- [ ] ligar" },
    });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("Agenda da semana");
    const createdFacts = await threadFacts("block.created");
    expect(createdFacts.at(-1)?.data).toMatchObject({
      botId: bot.id,
      id: created.body.id,
      author: "user",
      kind: "note",
    });

    const other = await request<{ id: string }>(`${base}/notes`, {
      method: "POST",
      body: { title: "Diário", folder, content: "Ver [[Agenda da semana]]" },
    });
    expect(other.status).toBe(201);

    const list = await request<{ total: number }>(`${base}/notes?folder=${encodeURIComponent(folder)}`);
    expect([list.status, list.body.total]).toEqual([200, 2]);
    const tree = await request<{ notes: { items: Array<{ id: string }> } }>(
      `${base}/notes/tree?folder=${encodeURIComponent(folder)}`,
    );
    expect(tree.status).toBe(200);
    expect(tree.body.notes.items.map((item) => item.id).sort()).toEqual([created.body.id, other.body.id].sort());
    const search = await request<{ items: Array<{ id: string }> }>(`${base}/notes/search?q=ligar`);
    expect(search.status).toBe(200);
    expect(search.body.items.map((item) => item.id)).toContain(created.body.id);
    const resolved = await request<{ id: string }>(
      `${base}/notes/resolve?title=${encodeURIComponent("Agenda da semana")}&folder=${encodeURIComponent(folder)}`,
    );
    expect([resolved.status, resolved.body.id]).toEqual([200, created.body.id]);
    const unresolved = await request<Failure>(`${base}/notes/resolve`);
    expect(unresolved.status).toBe(400);
    expect(unresolved.body.ok).toBe(false);

    const read = await request<{ id: string; content: string }>(`${base}/notes/${created.body.id}`);
    expect([read.status, read.body.content]).toEqual([200, "- [ ] ligar"]);
    const put = await request<{ content: string; version: number }>(`${base}/notes/${created.body.id}`, {
      method: "PUT",
      body: { content: "- [ ] ligar\n- [ ] pagar" },
    });
    expect([put.status, put.body.content]).toEqual([200, "- [ ] ligar\n- [ ] pagar"]);
    const patch = await request<{ content: string }>(`${base}/notes/${created.body.id}`, {
      method: "PATCH",
      body: { ops: [{ op: "toggle_task", line: 0, done: true }] },
    });
    expect([patch.status, patch.body.content]).toEqual([200, "- [x] ligar\n- [ ] pagar"]);
    const backlinks = await request<{ items: Array<{ id: string }> }>(`${base}/notes/${created.body.id}/backlinks`);
    expect(backlinks.status).toBe(200);
    expect(backlinks.body.items.map((item) => item.id)).toEqual([other.body.id]);
    const moved = await request<{ note: { title: string }; relinked: number }>(
      `${base}/notes/${created.body.id}/move`,
      {
        method: "POST",
        body: { title: "Agenda nova" },
      },
    );
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ note: { title: "Agenda nova" }, relinked: 1 });
    const removed = await request<{ ok: boolean }>(`${base}/notes/${created.body.id}`, { method: "DELETE" });
    expect([removed.status, removed.body]).toEqual([200, { ok: true }]);
    expect((await threadFacts("block.deleted")).at(-1)?.data).toMatchObject({ id: created.body.id, preview: null });
    const gone = await request<Failure>(`${base}/notes/${created.body.id}`);
    expect(gone.status).toBe(404);
  });

  test("unknown note routes and bad bodies", async () => {
    expect((await request<Failure>(`${base}/notes`, { method: "PUT" })).status).toBe(404);
    expect((await request<Failure>(`${base}/notes/abc`, { method: "POST" })).status).toBe(404);
    expect((await request<Failure>(`${base}/notes/abc/move`, { method: "GET" })).status).toBe(404);
    expect((await request<Failure>(`${base}/notes/tree/extra/more`)).status).toBe(404);
    const array = await request<Failure>(`${base}/notes`, { method: "POST", body: [1, 2] });
    expect([array.status, array.body]).toEqual([400, { ok: false, error: "Corpo inválido." }]);
    const text = await request<Failure>(`${base}/notes`, {
      method: "POST",
      body: "{nope",
      headers: { "content-type": "application/json" },
    });
    expect([text.status, text.body]).toEqual([400, { ok: false, error: "JSON inválido." }]);
    const scalar = await request<Failure>(`${base}/notes`, { method: "POST", body: "42" });
    expect(scalar.status).toBe(400);
    expect(scalar.body.error).toBe("Corpo inválido.");
  });

  test("a stale bot write returns the conflict code and version", async () => {
    const { note } = createNote(bot.id, { title: `Conflito ${Date.now()}`, content: "a" }, "bot");
    writeNote(bot.id, note.id, { content: "b" }, "bot");
    const stale = await request<Failure>(`${base}/notes/${note.id}`, {
      method: "PUT",
      body: { content: "c", baseVersion: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      ok: false,
      error: "Mudou enquanto você editava. Recarregue para ver a versão nova.",
      code: "stale",
      version: 2,
    });
  });
});

describe("sheets routes", () => {
  test("sheet, tab, cells, format and structure", async () => {
    const created = await request<{ id: string; tabs: Array<{ id: string; name: string }> }>(`${base}/sheets`, {
      method: "POST",
      body: { title: "Vendas", cells: [{ a: "A1", input: "2" }] },
    });
    expect(created.status).toBe(201);
    const sheetId = created.body.id;
    const firstTab = created.body.tabs[0].id;
    expect(
      (await request<{ items: Array<{ id: string }> }>(`${base}/sheets?q=Vendas`)).body.items.map((item) => item.id),
    ).toContain(sheetId);
    const one = await request<{ id: string; title: string }>(`${base}/sheets/${sheetId}`);
    expect([one.status, one.body.title]).toEqual([200, "Vendas"]);
    const renamed = await request<{ title: string }>(`${base}/sheets/${sheetId}`, {
      method: "PATCH",
      body: { title: "Vendas 2026" },
    });
    expect([renamed.status, renamed.body.title]).toEqual([200, "Vendas 2026"]);

    const tab = await request<{ id: string; name: string }>(`${base}/sheets/${sheetId}/tabs`, {
      method: "POST",
      body: { name: "Resumo" },
    });
    expect([tab.status, tab.body.name]).toEqual([201, "Resumo"]);
    const patched = await request<{ name: string; frozenRows: number }>(
      `${base}/sheets/${sheetId}/tabs/${tab.body.id}`,
      {
        method: "PATCH",
        body: { name: "Total", frozenRows: 1 },
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "Total", frozenRows: 1 });

    const cells = await request<{ cells: Array<{ a: string; v: unknown }> }>(
      `${base}/sheets/${sheetId}/tabs/${firstTab}/cells`,
      {
        method: "POST",
        body: { cells: [{ a: "A2", input: "=A1*3" }] },
      },
    );
    expect(cells.status).toBe(200);
    expect(cells.body.cells.find((cell) => cell.a === "A2")?.v).toBe(6);
    const format = await request(`${base}/sheets/${sheetId}/tabs/${firstTab}/format`, {
      method: "POST",
      body: { ranges: ["A1:A2"], format: { bold: true } },
    });
    expect(format.status).toBe(200);
    const structure = await request<{ version: number; tab: { id: string } }>(
      `${base}/sheets/${sheetId}/tabs/${firstTab}/structure`,
      {
        method: "POST",
        body: { op: "insert_rows", at: 0, count: 1 },
      },
    );
    expect(structure.status).toBe(200);
    expect(structure.body.tab.id).toBe(firstTab);
    expect(typeof structure.body.version).toBe("number");
    const range = await request<{ cells: Array<{ a: string; input: string }> }>(
      `${base}/sheets/${sheetId}/tabs/${firstTab}/range?range=A1:A3`,
    );
    expect(range.status).toBe(200);
    expect(range.body.cells.map((cell) => [cell.a, cell.input])).toEqual([
      ["A2", "2"],
      ["A3", "=A2*3"],
    ]);

    const dropTab = await request<{ tabs: Array<{ id: string }> }>(`${base}/sheets/${sheetId}/tabs/${tab.body.id}`, {
      method: "DELETE",
    });
    expect(dropTab.status).toBe(200);
    expect(dropTab.body.tabs.map((item) => item.id)).toEqual([firstTab]);
    const removed = await request(`${base}/sheets/${sheetId}`, { method: "DELETE" });
    expect([removed.status, removed.body]).toEqual([200, { ok: true }]);
    expect((await threadFacts("block.deleted")).at(-1)?.data).toMatchObject({ kind: "sheet", id: sheetId });
  });

  test("unknown sheet routes", async () => {
    const created = await request<{ id: string; tabs: Array<{ id: string }> }>(`${base}/sheets`, {
      method: "POST",
      body: { title: "Rotas" },
    });
    const sheet = `${base}/sheets/${created.body.id}`;
    const tab = `${sheet}/tabs/${created.body.tabs[0].id}`;
    const misses: Array<[string, string]> = [
      [`${base}/sheets`, "DELETE"],
      [sheet, "POST"],
      [`${sheet}/other`, "GET"],
      [`${sheet}/tabs`, "GET"],
      [tab, "GET"],
      [`${tab}/range`, "POST"],
      [`${tab}/unknown`, "POST"],
    ];
    for (const [path, method] of misses) {
      const response = await request<Failure>(path, { method });
      expect([path, method, response.status, response.body.error]).toEqual([path, method, 404, "Rota não encontrada."]);
    }
  });
});

describe("agenda routes", () => {
  test("accounts, events and edits", async () => {
    const [account] = await fakeAgenda([
      {
        email: "dona@casa.com",
        events: {
          primary: [
            {
              id: "solo",
              summary: "Foco",
              start: { dateTime: "2026-11-20T09:00:00-03:00" },
              end: { dateTime: "2026-11-20T10:00:00-03:00" },
            },
          ],
        },
      },
    ]);
    const accounts = await request<Array<{ id: string; status: string }>>(`${base}/agenda/accounts`);
    expect(accounts.status).toBe(200);
    expect(accounts.body).toMatchObject([{ id: account.name, status: "ready" }]);

    const list = await request<{ items: Array<{ id: string; title: string }> }>(
      `${base}/agenda/events?start=2026-11-20&end=2026-11-21`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.title)).toEqual(["Foco"]);

    const created = await request<{ id: string; title: string }>(`${base}/agenda/events`, {
      method: "POST",
      body: { accountId: account.name, title: "Dentista", start: "2026-11-20T14:00", end: "2026-11-20T15:00" },
    });
    expect([created.status, created.body.title]).toEqual([201, "Dentista"]);
    expect((await threadFacts("block.updated")).at(-1)?.data).toMatchObject({ kind: "agenda", author: "user" });

    const updated = await request<{ title: string }>(
      `${base}/agenda/events/${encodeEventId(account.name, "primary", "solo")}`,
      {
        method: "PATCH",
        body: { title: "Foco total" },
      },
    );
    expect([updated.status, updated.body.title]).toEqual([200, "Foco total"]);

    const removed = await request(`${base}/agenda/events/${created.body.id}`, { method: "DELETE" });
    expect([removed.status, removed.body]).toEqual([200, { ok: true }]);
    expect(account.deleted.map((item) => String(item.eventId))).toEqual([
      "solo",
      expect.stringMatching(/^created\d+$/),
    ]);
  });

  test("agenda errors keep their status, code and extra fields", async () => {
    const [offline] = await fakeAgenda([{ status: "needs_auth" }]);
    const reconnect = await request<Failure>(`${base}/agenda/events`, {
      method: "POST",
      body: { accountId: offline.name, title: "x", start: "2026-11-20", end: "2026-11-21" },
    });
    expect(reconnect.status).toBe(409);
    expect(reconnect.body).toEqual({
      ok: false,
      error: "Essa conta precisa ser religada na runelay.",
      code: "needs_auth",
      accountId: offline.name,
    });
    const badPeriod = await request<Failure>(`${base}/agenda/events?start=2026-11-21&end=2026-11-20`);
    expect([badPeriod.status, badPeriod.body]).toEqual([400, { ok: false, error: "end precisa ser depois de start." }]);

    spies.push(spyOn(runelay, "listConnections").mockRejectedValueOnce(new Error("fetch failed")));
    const down = await request<Failure>(`${base}/agenda/accounts`);
    expect([down.status, down.body]).toEqual([502, { ok: false, error: "A agenda não respondeu: fetch failed" }]);

    spies.push(spyOn(runelay, "listConnections").mockRejectedValueOnce(new Error("disco cheio")));
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    spies.push(logged);
    const crash = await request<Failure>(`${base}/agenda/accounts`);
    expect([crash.status, crash.body]).toEqual([500, { ok: false, error: "disco cheio" }]);
    expect((logged.mock.calls[0]?.[0] as Error).message).toBe("disco cheio");
  });

  test("unknown agenda routes", async () => {
    const misses: Array<[string, string]> = [
      [`${base}/agenda/accounts`, "POST"],
      [`${base}/agenda/accounts/x`, "GET"],
      [`${base}/agenda/other`, "GET"],
      [`${base}/agenda/events`, "PUT"],
      [`${base}/agenda/events/abc`, "GET"],
    ];
    for (const [path, method] of misses) {
      const response = await request<Failure>(path, { method });
      expect([path, method, response.status]).toEqual([path, method, 404]);
    }
  });
});

describe("exports routes", () => {
  test("create, read and download an export", async () => {
    const note = await request<{ id: string }>(`${base}/notes`, {
      method: "POST",
      body: { title: `Ata ${Date.now()}`, content: "# Ata\n\nDecidimos tudo." },
    });
    const created = await request<{ id: string; status: string; fileName: string }>(`${base}/exports`, {
      method: "POST",
      body: { kind: "note", id: note.body.id, format: "md" },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("ready");
    const read = await request<{ id: string; status: string }>(`${base}/exports/${created.body.id}`);
    expect([read.status, read.body.id, read.body.status]).toEqual([200, created.body.id, "ready"]);
    const file = await request<string>(`${base}/exports/${created.body.id}/file`);
    expect(file.status).toBe(200);
    expect(file.text).toContain("Decidimos tudo.");
    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(created.body.fileName)}`,
    );
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect(file.headers.get("content-length")).toBe(String(new TextEncoder().encode(file.text).length));
    const missing = await request<Failure>(`${base}/exports/exp_nope`);
    expect([missing.status, missing.body.error]).toEqual([404, "Exportação não encontrada."]);
  });

  test("unknown export routes", async () => {
    for (const [path, method] of [
      [`${base}/exports`, "GET"],
      [`${base}/exports/exp_1`, "POST"],
      [`${base}/exports/exp_1/other`, "GET"],
    ] as const) {
      const response = await request<Failure>(path, { method });
      expect([path, response.status]).toEqual([path, 404]);
    }
  });
});

describe("dispatcher", () => {
  test("only the four block roots are routed and anything else is a 404", async () => {
    expect([...blockRoots]).toEqual(["notes", "sheets", "agenda", "exports"]);
    const raw = new Request("http://127.0.0.1/bots/x/other");
    const res = new Res(new AbortController().signal);
    await handleBotBlocks(new Req(raw), res, new URL(raw.url), "GET", bot, ["other"]);
    const response = await res.response;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Rota não encontrada." });
  });
});
