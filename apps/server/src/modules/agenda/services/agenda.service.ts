import type {
  AgendaAccount,
  AgendaEvent,
  AgendaList,
  AgendaPreview,
  AttendeeResponse,
  BlockAuthor,
} from "@runelay-bots/protocol";
import { agendaBlockId } from "@runelay-bots/protocol";
import { and, eq, like, lt } from "drizzle-orm";
import { getDb } from "../../../db";
import { calendarCache } from "../../../db/tables";
import { defaultTimezone, offsetOf, userTimezone, zonedDay } from "../../../shared/clock";
import { BlockError, blockEvent, bumpAgendaVersion, nowIso } from "../../blocks/services/blocks.shared";
import { type Connection, listConnections, runelayCall } from "../../connectors/services/runelay.service";

export const agendaTimezone = defaultTimezone;

function addDays(day: string, amount: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function localMidnight(day: string, zone: string) {
  return `${day}T00:00:00${offsetOf(new Date(`${day}T12:00:00Z`), zone)}`;
}
const cacheTtlMs = 60_000;
const maxRangeDays = 62;
const palette = ["blue", "green", "violet", "orange", "pink", "teal"];
const accountPattern = /^google_calendar(_\d+)?$/;
const identityKey = "identity";

interface GoogleCalendar {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
}

interface GoogleEvent {
  id: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }>;
  hangoutLink?: string | null;
  conferenceData?: { entryPoints?: Array<{ uri?: string; entryPointType?: string }> };
  recurringEventId?: string;
  updated?: string;
  htmlLink?: string | null;
}

const videoLink =
  /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/[^\s"'<>)]+|teams\.microsoft\.com\/[^\s"'<>)]+|teams\.live\.com\/[^\s"'<>)]+)/i;

export function videoLinkIn(...texts: Array<string | null | undefined>) {
  for (const text of texts) {
    const found = text?.match(videoLink)?.[0];
    if (found) return found;
  }
  return null;
}

const identities = new Map<string, { at: number; email: string; calendars: GoogleCalendar[] }>();

function calendarAccounts(connections: Connection[]) {
  return connections
    .filter((item) => accountPattern.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

async function rememberEmail(account: string, email: string) {
  const row = { calendarId: identityKey, eventId: account, startsAt: "", data: { email }, fetchedAt: nowIso() };
  await getDb()
    .insert(calendarCache)
    .values(row)
    .onConflictDoUpdate({ target: [calendarCache.calendarId, calendarCache.eventId], set: row });
}

async function storedEmails() {
  return (await getDb().select().from(calendarCache).where(eq(calendarCache.calendarId, identityKey)))
    .map((row) => String((row.data as { email?: unknown }).email ?? ""))
    .filter(Boolean);
}

async function identity(account: string) {
  const known = identities.get(account);
  if (known && Date.now() - known.at < 10 * 60_000) return known;
  const [who, list] = await Promise.all([
    runelayCall("call_tool", { name: `${account}.account_whoami`, args: {} }) as Promise<{ email?: string }>,
    runelayCall("call_tool", { name: `${account}.calendar_list_calendars`, args: {} }) as Promise<{
      calendars?: GoogleCalendar[];
    }>,
  ]);
  const value = { at: Date.now(), email: String(who?.email ?? ""), calendars: list?.calendars ?? [] };
  identities.set(account, value);
  await rememberEmail(account, value.email);
  return value;
}

function labelFor(email: string, index: number) {
  const domain = email.split("@")[1] ?? "";
  if (!domain) return `Conta ${index + 1}`;
  if (/^(gmail|googlemail|hotmail|outlook|icloud|yahoo)\./.test(domain)) return "Pessoal";
  const name = domain.split(".")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function selectedCalendar(calendar: GoogleCalendar) {
  return Boolean(calendar.primary) || calendar.accessRole === "owner" || calendar.accessRole === "writer";
}

export async function listAccounts(): Promise<AgendaAccount[]> {
  const accounts = calendarAccounts(await listConnections());
  return Promise.all(
    accounts.map(async (connection, index) => {
      const base = {
        id: connection.name,
        color: palette[index % palette.length],
        primary: index === 0,
      };
      if (connection.status !== "ok")
        return { ...base, label: connection.label, email: "", status: "needs_auth" as const, calendars: [] };
      try {
        const who = await identity(connection.name);
        return {
          ...base,
          label: labelFor(who.email, index),
          email: who.email,
          status: "ready" as const,
          calendars: who.calendars.map((calendar) => ({
            id: calendar.id,
            name: calendar.primary ? "Principal" : (calendar.summary ?? calendar.id),
            color: base.color,
            selected: selectedCalendar(calendar),
          })),
        };
      } catch {
        return { ...base, label: connection.label, email: "", status: "needs_auth" as const, calendars: [] };
      }
    }),
  );
}

async function requireAccount(accountId: string) {
  const accounts = await listAccounts();
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw new BlockError("Conta de agenda não encontrada.", 404);
  if (account.status !== "ready")
    throw new BlockError("Essa conta precisa ser religada na runelay.", 409, "needs_auth", { accountId });
  return { account, accounts };
}

export function encodeEventId(accountId: string, calendarId: string, googleId: string) {
  return Buffer.from(JSON.stringify([accountId, calendarId, googleId])).toString("base64url");
}

export function decodeEventId(eventId: string) {
  try {
    const [accountId, calendarId, googleId] = JSON.parse(
      Buffer.from(eventId, "base64url").toString("utf8"),
    ) as string[];
    if (!accountId || !calendarId || !googleId) throw new Error();
    return { accountId, calendarId, googleId };
  } catch {
    throw new BlockError("Evento não encontrado.", 404);
  }
}

export function toEvent(accountId: string, calendarId: string, raw: GoogleEvent): AgendaEvent {
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime);
  const meetUrl =
    raw.hangoutLink ??
    raw.conferenceData?.entryPoints?.find((item) => item.entryPointType === "video")?.uri ??
    videoLinkIn(raw.location, raw.description);
  const responses: AttendeeResponse[] = ["accepted", "declined", "tentative", "needsAction"];
  return {
    id: encodeEventId(accountId, calendarId, raw.id),
    accountId,
    calendarId,
    title: raw.summary?.trim() || "(sem título)",
    start: raw.start?.dateTime ?? raw.start?.date ?? "",
    end: raw.end?.dateTime ?? raw.end?.date ?? "",
    allDay,
    meet: Boolean(meetUrl),
    meetUrl,
    calendarUrl: raw.htmlLink ?? null,
    location: raw.location ?? null,
    description: raw.description ?? null,
    attendees: (raw.attendees ?? []).map((item) => ({
      email: item.email,
      name: item.displayName ?? null,
      response: responses.includes(item.responseStatus as AttendeeResponse)
        ? (item.responseStatus as AttendeeResponse)
        : "needsAction",
      self: Boolean(item.self),
      organizer: Boolean(item.organizer),
    })),
    status: raw.status === "tentative" ? "tentative" : raw.status === "cancelled" ? "cancelled" : "confirmed",
    recurring: Boolean(raw.recurringEventId) || /_\d{8}(T\d{6}Z)?$/.test(raw.id),
    updatedAt: raw.updated ?? nowIso(),
  };
}

function rangeKey(start: string, end: string, q: string) {
  return `range:${start}|${end}|${q}`;
}

async function cacheRead(calendarKey: string, key: string) {
  const row = (
    await getDb()
      .select()
      .from(calendarCache)
      .where(and(eq(calendarCache.calendarId, calendarKey), eq(calendarCache.eventId, key)))
      .limit(1)
  )[0];
  if (!row || Date.now() - Date.parse(row.fetchedAt) > cacheTtlMs) return null;
  return row.data as { items: GoogleEvent[] };
}

async function cacheWrite(calendarKey: string, key: string, start: string, end: string, items: GoogleEvent[]) {
  const row = {
    calendarId: calendarKey,
    eventId: key,
    startsAt: start,
    endsAt: end,
    data: { items },
    fetchedAt: nowIso(),
  };
  const db = getDb();
  await db
    .insert(calendarCache)
    .values(row)
    .onConflictDoUpdate({ target: [calendarCache.calendarId, calendarCache.eventId], set: row });
  for (const item of items) {
    const event = {
      calendarId: calendarKey,
      eventId: item.id,
      startsAt: item.start?.dateTime ?? item.start?.date ?? start,
      endsAt: item.end?.dateTime ?? item.end?.date ?? null,
      data: item as unknown as Record<string, unknown>,
      fetchedAt: row.fetchedAt,
    };
    await db
      .insert(calendarCache)
      .values(event)
      .onConflictDoUpdate({ target: [calendarCache.calendarId, calendarCache.eventId], set: event });
  }
  await db
    .delete(calendarCache)
    .where(
      and(
        like(calendarCache.eventId, "range:%"),
        lt(calendarCache.fetchedAt, new Date(Date.now() - 3_600_000).toISOString()),
      ),
    );
}

async function invalidate(accountId: string) {
  await getDb()
    .delete(calendarCache)
    .where(and(like(calendarCache.calendarId, `${accountId}|%`), like(calendarCache.eventId, "range:%")));
}

async function fetchEvents(
  accountId: string,
  calendarId: string,
  start: string,
  end: string,
  q: string,
  fresh: boolean,
) {
  const calendarKey = `${accountId}|${calendarId}`;
  const key = rangeKey(start, end, q);
  if (!fresh) {
    const cached = await cacheRead(calendarKey, key);
    if (cached) return cached.items;
  }
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 8; page++) {
    const result = (await runelayCall("call_tool", {
      name: `${accountId}.calendar_list_events`,
      args: {
        calendarId,
        timeMin: start,
        timeMax: end,
        maxResults: 250,
        ...(q ? { q } : {}),
        ...(pageToken ? { pageToken } : {}),
      },
    })) as { events?: GoogleEvent[]; nextPageToken?: string | null };
    items.push(...(result?.events ?? []));
    pageToken = result?.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  await cacheWrite(calendarKey, key, start, end, items);
  return items;
}

function isoBound(value: unknown, field: string, zone: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new BlockError(`${field} é obrigatório.`);
  const withZone = /^\d{4}-\d{2}-\d{2}$/.test(text) ? localMidnight(text, zone) : text;
  const parsed = Date.parse(withZone);
  if (Number.isNaN(parsed)) throw new BlockError(`${field} inválido.`);
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function listEvents(query: Record<string, unknown>, fresh = false): Promise<AgendaList> {
  const zone = await userTimezone();
  const start = isoBound(query.start, "start", zone);
  const end = isoBound(query.end, "end", zone);
  if (Date.parse(end) <= Date.parse(start)) throw new BlockError("end precisa ser depois de start.");
  if (Date.parse(end) - Date.parse(start) > maxRangeDays * 86_400_000)
    throw new BlockError(`Período de no máximo ${maxRangeDays} dias.`);
  const wanted =
    typeof query.accounts === "string" && query.accounts.trim()
      ? new Set(query.accounts.split(",").map((item) => item.trim()))
      : Array.isArray(query.accounts)
        ? new Set((query.accounts as unknown[]).map(String))
        : null;
  const q = typeof query.q === "string" ? query.q.trim() : "";
  const accounts = (await listAccounts()).filter((item) => item.status === "ready" && (!wanted || wanted.has(item.id)));
  const lists = await Promise.all(
    accounts.flatMap((account) =>
      account.calendars
        .filter((calendar) => calendar.selected)
        .map(async (calendar) =>
          (await fetchEvents(account.id, calendar.id, start, end, q, fresh)).map((raw) =>
            toEvent(account.id, calendar.id, raw),
          ),
        ),
    ),
  );
  const items = lists
    .flat()
    .filter((item) => item.status !== "cancelled")
    .sort((a, b) => sortKey(a, zone) - sortKey(b, zone));
  return { timezone: zone, items };
}

function sortKey(event: AgendaEvent, zone: string) {
  return Date.parse(event.allDay ? localMidnight(event.start.slice(0, 10), zone) : event.start);
}

async function cachedEvent(accountId: string, calendarId: string, googleId: string) {
  const row = (
    await getDb()
      .select()
      .from(calendarCache)
      .where(and(eq(calendarCache.calendarId, `${accountId}|${calendarId}`), eq(calendarCache.eventId, googleId)))
      .limit(1)
  )[0];
  return row ? (row.data as unknown as GoogleEvent) : null;
}

export function externalAttendees(emails: string[], ownEmails: string[]) {
  const own = new Set(ownEmails.map((item) => item.toLowerCase()));
  return emails.filter((email) => !own.has(email.toLowerCase()));
}

export async function externalAttendeesCached(input: Record<string, unknown>) {
  const attendees = Array.isArray(input.attendees) ? input.attendees.map(String) : [];
  return externalAttendees(attendees, await storedEmails());
}

export async function needsApproval(input: Record<string, unknown>) {
  const attendees = Array.isArray(input.attendees) ? input.attendees.map(String) : [];
  if (!attendees.length) return [];
  const accounts = await listAccounts().catch(() => []);
  return externalAttendees(
    attendees,
    accounts.map((item) => item.email),
  );
}

function dayBounds(value: string, allDay: boolean, zone: string) {
  const day = allDay ? value.slice(0, 10) : zonedDay(new Date(value), zone);
  const start = new Date(localMidnight(day, zone));
  const end = new Date(localMidnight(addDays(day, 1), zone));
  return { start: start.toISOString(), end: end.toISOString(), day };
}

export async function agendaPreview(around: string, allDay: boolean, eventIds: string[]): Promise<AgendaPreview> {
  const zone = await userTimezone();
  const { start, end } = dayBounds(around, allDay, zone);
  const accounts = (await listAccounts()).filter((item) => item.status === "ready");
  const list = await listEvents({ start, end }, true).catch(() => ({ items: [] as AgendaEvent[] }));
  const picked = list.items.slice(0, 20);
  for (const id of eventIds)
    if (!picked.some((item) => item.id === id)) {
      const extra = list.items.find((item) => item.id === id);
      if (extra) picked.push(extra);
    }
  return {
    kind: "agenda",
    view: "day",
    start,
    end,
    timezone: zone,
    accounts: accounts.map(({ id, label, color }) => ({ id, label, color })),
    events: previewEvents(picked),
  };
}

const listPreviewLimit = 80;

function previewEvents(events: AgendaEvent[]) {
  return events.map(({ id, accountId, title, start, end, allDay, meet }) => ({
    id,
    accountId,
    title,
    start,
    end,
    allDay,
    meet,
  }));
}

export async function listEventsBlock(botId: string, query: Record<string, unknown>) {
  const list = await listEvents(query);
  const zone = list.timezone;
  const start = isoBound(query.start, "start", zone);
  const end = isoBound(query.end, "end", zone);
  const accounts = (await listAccounts()).filter((item) => item.status === "ready");
  const view: AgendaPreview["view"] = Date.parse(end) - Date.parse(start) <= 26 * 3_600_000 ? "day" : "week";
  const preview: AgendaPreview = {
    kind: "agenda",
    view,
    start,
    end,
    timezone: zone,
    accounts: accounts.map(({ id, label, color }) => ({ id, label, color })),
    events: previewEvents(list.items.slice(0, listPreviewLimit)),
  };
  const version = await bumpAgendaVersion(botId);
  return { list, blockEvent: blockEvent("agenda", agendaBlockId, "Agenda", version, "bot", "edited", preview) };
}

function normalizeWhen(value: unknown, allDay: boolean, field: string, zone: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new BlockError(`${field} é obrigatório.`);
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text.slice(0, 10))) throw new BlockError(`${field} inválido.`);
    return text.slice(0, 10);
  }
  if (Number.isNaN(Date.parse(text))) throw new BlockError(`${field} inválido.`);
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) return text;
  const local = text.length === 16 ? `${text}:00` : text;
  return `${local}${offsetOf(new Date(`${local}Z`), zone)}`;
}

async function createRaw(accountId: string, calendarId: string, body: Record<string, unknown>) {
  const allDay = Boolean(body.allDay);
  if (body.meet === true) throw new BlockError("O conector do Google Calendar ainda não cria link do Meet.");
  const zone = await userTimezone();
  const start = normalizeWhen(body.start, allDay, "start", zone);
  const end = normalizeWhen(body.end, allDay, "end", zone);
  const title = String(body.title ?? "").trim();
  if (!title) throw new BlockError("title é obrigatório.");
  const attendees = Array.isArray(body.attendees) ? body.attendees.map(String).filter(Boolean) : [];
  const raw = (await runelayCall("call_tool", {
    name: `${accountId}.calendar_create_event`,
    args: {
      calendarId,
      summary: title,
      start,
      end,
      timeZone: zone,
      ...(body.description ? { description: String(body.description) } : {}),
      ...(body.location ? { location: String(body.location) } : {}),
      ...(attendees.length ? { attendees } : {}),
    },
  })) as GoogleEvent & { event?: GoogleEvent };
  const event = (raw?.event ?? raw) as GoogleEvent;
  if (!event?.id) throw new BlockError("O Google Calendar não devolveu o evento criado.", 502);
  await invalidate(accountId);
  return toEvent(accountId, calendarId, {
    start: allDay ? { date: start } : { dateTime: start },
    end: allDay ? { date: end } : { dateTime: end },
    summary: title,
    description: (body.description as string) ?? null,
    location: (body.location as string) ?? null,
    attendees: attendees.map((email) => ({ email })),
    ...event,
  });
}

export async function createEvent(botId: string, body: Record<string, unknown>, author: BlockAuthor) {
  const accountId = String(body.accountId ?? "");
  const { account } = await requireAccount(accountId);
  const calendarId = String(body.calendarId ?? "") || "primary";
  if (calendarId !== "primary" && !account.calendars.some((item) => item.id === calendarId))
    throw new BlockError("Calendário não encontrado nessa conta.", 404);
  const event = await createRaw(accountId, calendarId, body);
  const version = await bumpAgendaVersion(botId);
  const preview = await agendaPreview(event.start, event.allDay, [event.id]);
  return {
    event,
    blockEvent: blockEvent("agenda", agendaBlockId, "Agenda", version, author, "edited", preview, {
      eventIds: [event.id],
    }),
  };
}

export async function deleteEvent(botId: string, eventId: string, author: BlockAuthor) {
  const { accountId, calendarId, googleId } = decodeEventId(eventId);
  await requireAccount(accountId);
  const before = await cachedEvent(accountId, calendarId, googleId);
  await runelayCall("call_tool", {
    name: `${accountId}.calendar_delete_event`,
    args: { calendarId, eventId: googleId },
  });
  await invalidate(accountId);
  const version = await bumpAgendaVersion(botId);
  const start = before?.start?.dateTime ?? before?.start?.date ?? nowIso();
  const preview = await agendaPreview(start, Boolean(before?.start?.date && !before?.start?.dateTime), []);
  return blockEvent("agenda", agendaBlockId, "Agenda", version, author, "edited", preview, { eventIds: [eventId] });
}

export async function updateEvent(botId: string, eventId: string, body: Record<string, unknown>, author: BlockAuthor) {
  const { accountId, calendarId, googleId } = decodeEventId(eventId);
  const { account } = await requireAccount(accountId);
  const current = await cachedEvent(accountId, calendarId, googleId);
  if (!current) throw new BlockError("Evento não encontrado; liste a agenda do período antes de editar.", 404);
  const others = (current.attendees ?? []).filter(
    (item) => !item.self && item.email.toLowerCase() !== account.email.toLowerCase(),
  );
  if (others.length || current.recurringEventId || /_\d{8}(T\d{6}Z)?$/.test(googleId))
    throw new BlockError(
      "O conector do Google Calendar ainda não edita eventos com convidados ou recorrentes. Peça para a pessoa ajustar no Google Calendar.",
      409,
      "unsupported",
    );
  const existing = toEvent(accountId, calendarId, current);
  const allDay = body.allDay === undefined ? existing.allDay : Boolean(body.allDay);
  const merged = {
    title: body.title ?? existing.title,
    start: body.start ?? existing.start,
    end: body.end ?? existing.end,
    allDay,
    location: body.location === undefined ? existing.location : body.location,
    description: body.description === undefined ? existing.description : body.description,
    attendees: body.attendees ?? [],
    meet: body.meet === true ? true : undefined,
  };
  const event = await createRaw(accountId, calendarId, merged);
  try {
    await runelayCall("call_tool", {
      name: `${accountId}.calendar_delete_event`,
      args: { calendarId, eventId: googleId },
    });
  } catch {
    const copy = decodeEventId(event.id).googleId;
    const undone = await runelayCall("call_tool", {
      name: `${accountId}.calendar_delete_event`,
      args: { calendarId, eventId: copy },
    }).then(
      () => true,
      () => false,
    );
    await invalidate(accountId);
    throw new BlockError(
      undone
        ? "O Google Calendar não apagou o evento antigo, então desfiz a cópia nova. Nada mudou na agenda."
        : "O Google Calendar não apagou o evento antigo nem a cópia nova. Os dois ficaram na agenda; apague um deles.",
      502,
      undone ? "update_failed" : "update_duplicated",
      { eventIds: undone ? [eventId] : [eventId, event.id] },
    );
  }
  await invalidate(accountId);
  const version = await bumpAgendaVersion(botId);
  const preview = await agendaPreview(event.start, event.allDay, [event.id]);
  return {
    event,
    blockEvent: blockEvent("agenda", agendaBlockId, "Agenda", version, author, "edited", preview, {
      eventIds: [event.id],
    }),
  };
}
