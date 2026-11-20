import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { agendaBlockId } from "@runelay-bots/protocol";
import { and, eq } from "drizzle-orm";
import { fakeAgenda, toolCallsOf } from "../../../../test/agenda-helpers";
import { getDb } from "../../../db";
import { calendarCache } from "../../../db/tables";
import { agendaVersion, type BlockError } from "../../blocks/services/blocks.shared";
import * as runelay from "../../connectors/services/runelay.service";
import {
  agendaPreview,
  agendaTimezone,
  createEvent,
  decodeEventId,
  deleteEvent,
  encodeEventId,
  externalAttendees,
  externalAttendeesCached,
  listAccounts,
  listEvents,
  needsApproval,
  toEvent,
  updateEvent,
} from "../services/agenda.service";

const range = { start: "2026-11-20T00:00:00-03:00", end: "2026-11-21T00:00:00-03:00" };
const spies: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as BlockError;
  }
  throw new Error("expected a failure");
}

function botId() {
  return `bot-agenda-${Math.random().toString(36).slice(2, 8)}`;
}

describe("accounts", () => {
  test("labels, colors, calendars, needs_auth and the identity cache", async () => {
    const [personal, work, blank, offline, broken] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        calendars: [
          { id: "primary", primary: true, summary: "ana@gmail.com" },
          { id: "team@group", summary: "Time", accessRole: "writer" },
          { id: "feriados", accessRole: "reader" },
        ],
      },
      { email: "bia@acme.com.br" },
      { email: "" },
      { status: "needs_auth" },
      { whoamiFails: true },
    ]);
    const accounts = await listAccounts();
    expect(accounts.map((item) => item.id)).toEqual([personal.name, work.name, blank.name, offline.name, broken.name]);
    expect(accounts[0]).toEqual({
      id: personal.name,
      color: "blue",
      primary: true,
      label: "Pessoal",
      email: "ana@gmail.com",
      status: "ready",
      calendars: [
        { id: "primary", name: "Principal", color: "blue", selected: true },
        { id: "team@group", name: "Time", color: "blue", selected: true },
        { id: "feriados", name: "feriados", color: "blue", selected: false },
      ],
    });
    expect(accounts[1]).toMatchObject({ label: "Acme", color: "green", primary: false, status: "ready" });
    expect(accounts[2]).toMatchObject({ label: "Conta 3", email: "", status: "ready" });
    expect(accounts[3]).toMatchObject({
      status: "needs_auth",
      email: "",
      calendars: [],
      label: expect.stringContaining("Google Calendar"),
    });
    expect(accounts[4]).toMatchObject({ status: "needs_auth", email: "", calendars: [] });
    const whoamiCalls = toolCallsOf(`${personal.name}.account_whoami`).length;
    await listAccounts();
    expect(toolCallsOf(`${personal.name}.account_whoami`)).toHaveLength(whoamiCalls);
  });
});

describe("event ids and mapping", () => {
  test("encodes and decodes ids and rejects broken ones", async () => {
    const id = encodeEventId("google_calendar", "primary", "abc");
    expect(decodeEventId(id)).toEqual({ accountId: "google_calendar", calendarId: "primary", googleId: "abc" });
    expect(() => decodeEventId("not-json")).toThrow("Evento não encontrado.");
    const partial = Buffer.from(JSON.stringify(["google_calendar", "", ""])).toString("base64url");
    try {
      decodeEventId(partial);
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as BlockError).status).toBe(404);
    }
  });

  test("maps a Google event with meet, attendees and status", async () => {
    const event = toEvent("acc", "primary", {
      id: "e1",
      summary: "  Reunião  ",
      description: "Pauta",
      location: "Sala 2",
      status: "tentative",
      start: { dateTime: "2026-11-20T10:00:00-03:00" },
      end: { dateTime: "2026-11-20T11:00:00-03:00" },
      conferenceData: {
        entryPoints: [
          { uri: "tel:1", entryPointType: "phone" },
          { uri: "https://meet/x", entryPointType: "video" },
        ],
      },
      attendees: [
        { email: "a@x.com", displayName: "A", responseStatus: "accepted", self: true, organizer: true },
        { email: "b@x.com", responseStatus: "weird" },
      ],
      updated: "2026-11-01T00:00:00Z",
    });
    expect(event).toEqual({
      id: encodeEventId("acc", "primary", "e1"),
      accountId: "acc",
      calendarId: "primary",
      title: "Reunião",
      start: "2026-11-20T10:00:00-03:00",
      end: "2026-11-20T11:00:00-03:00",
      allDay: false,
      meet: true,
      meetUrl: "https://meet/x",
      location: "Sala 2",
      description: "Pauta",
      attendees: [
        { email: "a@x.com", name: "A", response: "accepted", self: true, organizer: true },
        { email: "b@x.com", name: null, response: "needsAction", self: false, organizer: false },
      ],
      status: "tentative",
      recurring: false,
      updatedAt: "2026-11-01T00:00:00Z",
    });
  });

  test("fills defaults for a bare event and flags recurring and cancelled ones", async () => {
    const bare = toEvent("acc", "primary", { id: "e2_20261120T130000Z", status: "cancelled" });
    expect(bare).toMatchObject({
      title: "(sem título)",
      start: "",
      end: "",
      allDay: false,
      meet: false,
      meetUrl: null,
      location: null,
      description: null,
      attendees: [],
      status: "cancelled",
      recurring: true,
    });
    expect(Number.isNaN(Date.parse(bare.updatedAt))).toBe(false);
    const allDay = toEvent("acc", "primary", {
      id: "e3",
      start: { date: "2026-11-20" },
      end: { date: "2026-11-21" },
      hangoutLink: "https://meet/h",
      recurringEventId: "base",
    });
    expect(allDay).toMatchObject({ allDay: true, meetUrl: "https://meet/h", recurring: true, status: "confirmed" });
  });

  test("external attendees ignore the person's own e-mails", async () => {
    expect(externalAttendees(["Ana@Gmail.com", "joao@fora.com"], ["ana@gmail.com"])).toEqual(["joao@fora.com"]);
    await fakeAgenda([{ email: "dona@casa.com" }]);
    await listAccounts();
    expect(await externalAttendeesCached({ attendees: ["DONA@casa.com", "visita@fora.com"] })).toEqual([
      "visita@fora.com",
    ]);
    expect(await externalAttendeesCached({ attendees: "x" })).toEqual([]);
    expect(await needsApproval({})).toEqual([]);
    expect(await needsApproval({ attendees: ["dona@casa.com", "outro@fora.com"] })).toEqual(["outro@fora.com"]);
    spies.push(spyOn(runelay, "listConnections").mockRejectedValueOnce(new Error("fetch failed")));
    expect(await needsApproval({ attendees: ["dona@casa.com"] })).toEqual(["dona@casa.com"]);
  });
});

describe("approval after a restart", () => {
  test("uses the stored e-mails of the accounts, not only what this process saw", async () => {
    const [account] = await fakeAgenda([{ email: "dona@reinicio.com" }]);
    await listAccounts();
    const stored = (
      await getDb()
        .select()
        .from(calendarCache)
        .where(and(eq(calendarCache.calendarId, "identity"), eq(calendarCache.eventId, account.name)))
        .limit(1)
    )[0];
    expect(stored?.data).toEqual({ email: "dona@reinicio.com" });
    await getDb()
      .insert(calendarCache)
      .values({
        calendarId: "identity",
        eventId: "google_calendar_antes_do_restart",
        startsAt: "",
        data: { email: "Trabalho@Empresa.com" },
        fetchedAt: new Date().toISOString(),
      });
    expect(
      await externalAttendeesCached({ attendees: ["trabalho@empresa.com", "DONA@reinicio.com", "visita@fora.com"] }),
    ).toEqual(["visita@fora.com"]);
  });
});

describe("listEvents", () => {
  test("sorts by the real instant across days, with all-day events at local midnight", async () => {
    await fakeAgenda([
      {
        email: "ana@gmail.com",
        events: {
          primary: [
            { id: "next", summary: "Feriado amanhã", start: { date: "2026-11-21" }, end: { date: "2026-11-22" } },
            {
              id: "night",
              summary: "Noite",
              start: { dateTime: "2026-11-20T22:00:00-03:00" },
              end: { dateTime: "2026-11-20T23:00:00-03:00" },
            },
            {
              id: "utc",
              summary: "Manhã seguinte",
              start: { dateTime: "2026-11-21T12:00:00Z" },
              end: { dateTime: "2026-11-21T13:00:00Z" },
            },
            { id: "today", summary: "Feriado hoje", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
          ],
        },
      },
    ]);
    const list = await listEvents({ start: range.start, end: "2026-11-22T00:00:00-03:00" });
    expect(list.items.map((item) => item.title)).toEqual(["Feriado hoje", "Noite", "Feriado amanhã", "Manhã seguinte"]);
  });

  test("validates the period", async () => {
    expect((await failure(listEvents({ end: range.end }))).message).toBe("start é obrigatório.");
    expect((await failure(listEvents({ start: "ontem", end: range.end }))).message).toBe("start inválido.");
    expect((await failure(listEvents({ start: range.start, end: "" }))).message).toBe("end é obrigatório.");
    expect((await failure(listEvents({ start: range.end, end: range.start }))).message).toBe(
      "end precisa ser depois de start.",
    );
    expect((await failure(listEvents({ start: "2026-01-01", end: "2026-04-01" }))).message).toBe(
      "Período de no máximo 62 dias.",
    );
  });

  test("merges selected calendars, pages, sorts, filters and caches", async () => {
    const [first, second] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        calendars: [
          { id: "primary", primary: true },
          { id: "feriados", accessRole: "reader" },
        ],
        events: {
          primary: [
            {
              id: "late",
              summary: "Tarde",
              start: { dateTime: "2026-11-20T15:00:00-03:00" },
              end: { dateTime: "2026-11-20T16:00:00-03:00" },
            },
            { id: "allday", summary: "Feriado", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
            { id: "gone", summary: "Cancelado", status: "cancelled", start: { dateTime: "2026-11-20T08:00:00-03:00" } },
          ],
          feriados: [{ id: "hidden", summary: "Nunca", start: { date: "2026-11-20" } }],
        },
      },
      {
        email: "bia@acme.com",
        pageSize: 1,
        events: {
          primary: [
            {
              id: "early",
              summary: "Cedo",
              start: { dateTime: "2026-11-20T09:00:00-03:00" },
              end: { dateTime: "2026-11-20T10:00:00-03:00" },
            },
            {
              id: "noon",
              summary: "Almoço",
              start: { dateTime: "2026-11-20T12:00:00-03:00" },
              end: { dateTime: "2026-11-20T13:00:00-03:00" },
            },
          ],
        },
      },
    ]);
    const list = await listEvents({ ...range, q: " reunião " });
    expect(list.timezone).toBe(agendaTimezone);
    expect(list.items.map((item) => item.title)).toEqual(["Feriado", "Cedo", "Almoço", "Tarde"]);
    expect(toolCallsOf(`${first.name}.calendar_list_events`).map((call) => call.args.calendarId)).toEqual(["primary"]);
    const paged = toolCallsOf(`${second.name}.calendar_list_events`);
    expect(paged.map((call) => call.args.pageToken)).toEqual([undefined, "1"]);
    expect(paged[0].args).toMatchObject({
      calendarId: "primary",
      timeMin: "2026-11-20T03:00:00Z",
      timeMax: "2026-11-21T03:00:00Z",
      maxResults: 250,
      q: "reunião",
    });

    await listEvents({ ...range, q: "reunião" });
    expect(toolCallsOf(`${second.name}.calendar_list_events`)).toHaveLength(2);
    await listEvents({ ...range, q: "reunião" }, true);
    expect(toolCallsOf(`${second.name}.calendar_list_events`)).toHaveLength(4);

    const onlyFirst = await listEvents({ ...range, accounts: ` ${first.name} ,nope` });
    expect(onlyFirst.items.map((item) => item.accountId)).toEqual([first.name, first.name]);
    const onlySecond = await listEvents({ start: "2026-11-20", end: "2026-11-21", accounts: [second.name] });
    expect(onlySecond.items.map((item) => item.title)).toEqual(["Cedo", "Almoço"]);
    expect(toolCallsOf(`${second.name}.calendar_list_events`).at(-1)?.args).not.toHaveProperty("q");
  });
});

describe("preview", () => {
  test("keeps the first 20 events plus the ones asked for and survives a failing calendar", async () => {
    const base = Date.parse("2026-11-20T08:00:00-03:00");
    const events = Array.from({ length: 25 }, (_, index) => ({
      id: `ev${String(index).padStart(2, "0")}`,
      summary: `Evento ${index}`,
      start: { dateTime: new Date(base + index * 20 * 60_000).toISOString() },
      end: { dateTime: new Date(base + (index * 20 + 10) * 60_000).toISOString() },
    }));
    const [account] = await fakeAgenda([{ email: "ana@gmail.com", events: { primary: events } }]);
    const wanted = encodeEventId(account.name, "primary", "ev24");
    const preview = await agendaPreview("2026-11-20T10:00:00-03:00", false, [wanted, "missing"]);
    expect(preview).toMatchObject({
      kind: "agenda",
      view: "day",
      start: "2026-11-20T03:00:00.000Z",
      end: "2026-11-21T03:00:00.000Z",
      timezone: agendaTimezone,
      accounts: [{ id: account.name, label: "Pessoal", color: "blue" }],
    });
    expect(preview.events).toHaveLength(21);
    expect(preview.events.at(-1)).toEqual({
      id: wanted,
      accountId: account.name,
      title: "Evento 24",
      start: "2026-11-20T19:00:00.000Z",
      end: "2026-11-20T19:10:00.000Z",
      allDay: false,
      meet: false,
    });

    await fakeAgenda([{ email: "ana@gmail.com", listFails: true }]);
    const empty = await agendaPreview("2026-11-22", true, []);
    expect(empty.start).toBe("2026-11-22T03:00:00.000Z");
    expect(empty.events).toEqual([]);
  });
});

describe("createEvent", () => {
  test("rejects unknown accounts, accounts to reconnect and unknown calendars", async () => {
    const [ready, offline] = await fakeAgenda([{ email: "ana@gmail.com" }, { status: "needs_auth" }]);
    const bot = botId();
    const missing = await failure(createEvent(bot, { accountId: "google_calendar_nope" }, "bot"));
    expect([missing.status, missing.message]).toEqual([404, "Conta de agenda não encontrada."]);
    const reconnect = await failure(createEvent(bot, { accountId: offline.name }, "bot"));
    expect([reconnect.status, reconnect.code, reconnect.extra]).toEqual([
      409,
      "needs_auth",
      { accountId: offline.name },
    ]);
    const calendar = await failure(createEvent(bot, { accountId: ready.name, calendarId: "outro" }, "bot"));
    expect([calendar.status, calendar.message]).toEqual([404, "Calendário não encontrado nessa conta."]);
  });

  test("validates the body before calling Google", async () => {
    const [account] = await fakeAgenda([{ email: "ana@gmail.com" }]);
    const bot = botId();
    const base = { accountId: account.name, title: "Café", start: "2026-11-20T10:00", end: "2026-11-20T11:00" };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, meet: true }, "O conector do Google Calendar ainda não cria link do Meet."],
      [{ ...base, start: "" }, "start é obrigatório."],
      [{ ...base, start: "amanhã" }, "start inválido."],
      [{ ...base, allDay: true, start: "20/11/2026" }, "start inválido."],
      [{ ...base, end: undefined }, "end é obrigatório."],
      [{ ...base, title: "  " }, "title é obrigatório."],
    ];
    for (const [body, message] of cases) expect((await failure(createEvent(bot, body, "bot"))).message).toBe(message);
    expect(account.created).toEqual([]);
  });

  test("creates a timed event, bumps the agenda version and drops the cached range", async () => {
    const [account] = await fakeAgenda([{ email: "ana@gmail.com" }]);
    const bot = botId();
    const later = { start: "2026-11-25", end: "2026-11-26" };
    await listEvents(later);
    await listEvents(later);
    const listCalls = () =>
      toolCallsOf(`${account.name}.calendar_list_events`).filter(
        (call) => call.args.timeMin === "2026-11-25T03:00:00Z",
      );
    expect(listCalls()).toHaveLength(1);
    const { event, blockEvent } = await createEvent(
      bot,
      {
        accountId: account.name,
        title: " Café ",
        start: "2026-11-20T10:00",
        end: "2026-11-20T11:00:00",
        description: "Conversa",
        location: "Padaria",
        attendees: ["ana@gmail.com", ""],
      },
      "user",
    );
    expect(account.created).toEqual([
      {
        calendarId: "primary",
        summary: "Café",
        start: "2026-11-20T10:00:00-03:00",
        end: "2026-11-20T11:00:00-03:00",
        timeZone: agendaTimezone,
        description: "Conversa",
        location: "Padaria",
        attendees: ["ana@gmail.com"],
      },
    ]);
    expect(event).toMatchObject({
      accountId: account.name,
      calendarId: "primary",
      title: "Café",
      start: "2026-11-20T10:00:00-03:00",
      location: "Padaria",
      description: "Conversa",
      attendees: [{ email: "ana@gmail.com", response: "needsAction" }],
    });
    expect(await agendaVersion(bot)).toBe(1);
    expect(blockEvent.type).toBe("block.updated");
    expect(blockEvent.data).toMatchObject({
      kind: "agenda",
      id: agendaBlockId,
      title: "Agenda",
      version: 1,
      author: "user",
      action: "edited",
      changed: { eventIds: [event.id] },
    });
    expect(blockEvent.data.preview).toMatchObject({ events: [{ id: event.id, title: "Café" }] });
    await listEvents(later);
    expect(listCalls()).toHaveLength(2);
  });

  test("creates an all-day event on a writable calendar and fails without an id", async () => {
    const [account] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        calendars: [
          { id: "primary", primary: true },
          { id: "team@group", summary: "Time", accessRole: "owner" },
        ],
        createReply: (args, id) => (args.summary === "Sem id" ? {} : { id }),
      },
    ]);
    const bot = botId();
    const { event } = await createEvent(
      bot,
      {
        accountId: account.name,
        calendarId: "team@group",
        title: "Folga",
        allDay: true,
        start: "2026-11-21T00:00",
        end: "2026-11-22",
      },
      "bot",
    );
    expect(event).toMatchObject({ calendarId: "team@group", allDay: true, start: "2026-11-21", end: "2026-11-22" });
    expect(account.created[0]).not.toHaveProperty("description");
    expect(account.created[0]).not.toHaveProperty("attendees");
    const zoned = await createEvent(
      bot,
      { accountId: account.name, title: "Call", start: "2026-11-20T13:00:00Z", end: "2026-11-20T14:00:00+01:00" },
      "bot",
    );
    expect(zoned.event).toMatchObject({ start: "2026-11-20T13:00:00Z", end: "2026-11-20T14:00:00+01:00" });
    const noId = await failure(
      createEvent(bot, { accountId: account.name, title: "Sem id", start: range.start, end: range.end }, "bot"),
    );
    expect([noId.status, noId.message]).toEqual([502, "O Google Calendar não devolveu o evento criado."]);
  });
});

describe("deleteEvent", () => {
  test("deletes a listed event and previews its day", async () => {
    const [account] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        events: {
          primary: [
            { id: "keep", summary: "Fica", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
            { id: "drop", summary: "Sai", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
          ],
        },
      },
    ]);
    const bot = botId();
    await listEvents(range);
    const id = encodeEventId(account.name, "primary", "drop");
    const event = await deleteEvent(bot, id, "bot");
    expect(account.deleted).toEqual([{ calendarId: "primary", eventId: "drop" }]);
    expect(event.data).toMatchObject({ action: "edited", author: "bot", version: 1, changed: { eventIds: [id] } });
    expect(event.data.preview).toMatchObject({
      start: "2026-11-20T03:00:00.000Z",
      events: [{ title: "Fica", allDay: true }],
    });
  });

  test("deletes an event that was never listed and rejects bad ids", async () => {
    const [account] = await fakeAgenda([{ email: "ana@gmail.com" }]);
    const bot = botId();
    const event = await deleteEvent(bot, encodeEventId(account.name, "primary", "unseen"), "user");
    expect(account.deleted).toEqual([{ calendarId: "primary", eventId: "unseen" }]);
    expect(event.data.version).toBe(1);
    expect((await failure(deleteEvent(bot, "%%%", "user"))).status).toBe(404);
  });
});

describe("updateEvent", () => {
  test("recreates a simple event with the merged fields", async () => {
    const [account] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        events: {
          primary: [
            {
              id: "solo",
              summary: "Foco",
              location: "Casa",
              description: "Sem reunião",
              start: { dateTime: "2026-11-20T09:00:00-03:00" },
              end: { dateTime: "2026-11-20T10:00:00-03:00" },
              attendees: [{ email: "ANA@gmail.com" }, { email: "eu@x.com", self: true }],
            },
          ],
        },
      },
    ]);
    const bot = botId();
    await listEvents(range);
    const oldId = encodeEventId(account.name, "primary", "solo");
    const { event, blockEvent } = await updateEvent(bot, oldId, { title: "Foco total", location: null }, "user");
    expect(account.created).toEqual([
      {
        calendarId: "primary",
        summary: "Foco total",
        start: "2026-11-20T09:00:00-03:00",
        end: "2026-11-20T10:00:00-03:00",
        timeZone: agendaTimezone,
        description: "Sem reunião",
      },
    ]);
    expect(account.deleted).toEqual([{ calendarId: "primary", eventId: "solo" }]);
    expect(event).toMatchObject({ title: "Foco total", location: null, description: "Sem reunião" });
    expect(event.id).not.toBe(oldId);
    expect(blockEvent.data).toMatchObject({ version: 1, changed: { eventIds: [event.id] } });

    await listEvents(range, true);
    const again = await updateEvent(
      bot,
      event.id,
      { allDay: true, start: "2026-11-23", end: "2026-11-24", description: "Dia todo" },
      "user",
    );
    expect(again.event).toMatchObject({
      allDay: true,
      start: "2026-11-23",
      title: "Foco total",
      description: "Dia todo",
    });
    expect(await agendaVersion(bot)).toBe(2);
  });

  test("undoes the new copy when the old event cannot be deleted", async () => {
    const [account] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        deleteFails: (eventId) => eventId === "solo",
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
    const bot = botId();
    await listEvents(range);
    const oldId = encodeEventId(account.name, "primary", "solo");
    const error = await failure(updateEvent(bot, oldId, { title: "Foco total" }, "user"));
    expect([error.status, error.code, error.extra]).toEqual([502, "update_failed", { eventIds: [oldId] }]);
    expect(error.message).toBe(
      "O Google Calendar não apagou o evento antigo, então desfiz a cópia nova. Nada mudou na agenda.",
    );
    expect(account.created).toHaveLength(1);
    const copy = account.deleted.map((item) => item.eventId);
    expect(copy).toHaveLength(1);
    expect(copy[0]).not.toBe("solo");
    expect(account.events.primary.map((item) => item.id)).toEqual(["solo"]);
    expect(await agendaVersion(bot)).toBe(0);
    const after = await listEvents(range);
    expect(after.items.map((item) => item.title)).toEqual(["Foco"]);
  });

  test("reports both copies when the rollback fails too", async () => {
    const [account] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        deleteFails: () => true,
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
    await listEvents(range);
    const oldId = encodeEventId(account.name, "primary", "solo");
    const error = await failure(updateEvent(botId(), oldId, { title: "Foco total" }, "user"));
    const newId = encodeEventId(account.name, "primary", String(account.events.primary[1].id));
    expect([error.status, error.code, error.extra]).toEqual([502, "update_duplicated", { eventIds: [oldId, newId] }]);
    expect(error.message).toBe(
      "O Google Calendar não apagou o evento antigo nem a cópia nova. Os dois ficaram na agenda; apague um deles.",
    );
    expect(account.events.primary).toHaveLength(2);
  });

  test("refuses unknown, shared and recurring events", async () => {
    const [account] = await fakeAgenda([
      {
        email: "ana@gmail.com",
        events: {
          primary: [
            {
              id: "shared",
              summary: "Com gente",
              start: { dateTime: range.start },
              attendees: [{ email: "fora@x.com" }],
            },
            { id: "series", summary: "Semanal", recurringEventId: "base", start: { dateTime: range.start } },
            { id: "inst_20261120", summary: "Instância", start: { dateTime: range.start } },
            { id: "meetless", summary: "Sem meet", start: { dateTime: range.start }, end: { dateTime: range.end } },
          ],
        },
      },
    ]);
    const bot = botId();
    const unknown = await failure(updateEvent(bot, encodeEventId(account.name, "primary", "nunca"), {}, "bot"));
    expect([unknown.status, unknown.message]).toEqual([
      404,
      "Evento não encontrado; liste a agenda do período antes de editar.",
    ]);
    await listEvents(range);
    for (const googleId of ["shared", "series", "inst_20261120"]) {
      const refused = await failure(updateEvent(bot, encodeEventId(account.name, "primary", googleId), {}, "bot"));
      expect([refused.status, refused.code]).toEqual([409, "unsupported"]);
    }
    const meet = await failure(
      updateEvent(bot, encodeEventId(account.name, "primary", "meetless"), { meet: true }, "bot"),
    );
    expect(meet.message).toBe("O conector do Google Calendar ainda não cria link do Meet.");
    expect(account.created).toEqual([]);
    expect(account.deleted).toEqual([]);
  });
});
