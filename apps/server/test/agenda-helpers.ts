import { listConnections } from "../src/modules/connectors/services/runelay.service";
import { fakeRunelay, type ToolHandler } from "./fake-runelay";

export interface FakeCalendar {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
}

export type FakeGoogleEvent = { id: string } & Record<string, unknown>;

export interface FakeAgendaSpec {
  email?: string;
  status?: string;
  calendars?: FakeCalendar[];
  events?: Record<string, FakeGoogleEvent[]>;
  pageSize?: number;
  whoamiFails?: boolean;
  listFails?: boolean;
  createReply?: (args: Record<string, unknown>, id: string) => unknown;
}

export interface FakeAgendaAccount extends FakeAgendaSpec {
  name: string;
  events: Record<string, FakeGoogleEvent[]>;
  created: Array<Record<string, unknown>>;
  deleted: Array<Record<string, unknown>>;
}

let counter = 0;
const handlers = new Map<string, ToolHandler>();

function tool(name: string, handler: ToolHandler) {
  handlers.set(name, handler);
}

function callTool(args: Record<string, unknown>) {
  const name = String(args.name);
  const handler = handlers.get(name);
  if (!handler) throw new Error(`unknown tool ${name}`);
  return handler((args.args ?? {}) as Record<string, unknown>);
}

function whenOf(value: unknown) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { date: text } : { dateTime: text };
}

function register(account: FakeAgendaAccount) {
  tool(`${account.name}.account_whoami`, () => {
    if (account.whoamiFails) throw new Error("token expirado");
    return { email: account.email ?? "" };
  });
  tool(`${account.name}.calendar_list_calendars`, () => ({
    calendars: account.calendars ?? [{ id: "primary", primary: true }],
  }));
  tool(`${account.name}.calendar_list_events`, (args) => {
    if (account.listFails) throw new Error("quota exceeded");
    const all = account.events[String(args.calendarId)] ?? [];
    const size = account.pageSize ?? Math.max(all.length, 1);
    const offset = Number(args.pageToken ?? 0);
    const next = offset + size;
    return { events: all.slice(offset, next), nextPageToken: next < all.length ? String(next) : null };
  });
  tool(`${account.name}.calendar_create_event`, (args) => {
    counter++;
    const id = `created${counter}`;
    account.created.push(args);
    const calendarId = String(args.calendarId);
    account.events[calendarId] = [
      ...(account.events[calendarId] ?? []),
      { id, summary: args.summary, start: whenOf(args.start), end: whenOf(args.end) },
    ];
    return account.createReply ? account.createReply(args, id) : { event: { id, status: "confirmed" } };
  });
  tool(`${account.name}.calendar_delete_event`, (args) => {
    account.deleted.push(args);
    const calendarId = String(args.calendarId);
    account.events[calendarId] = (account.events[calendarId] ?? []).filter((item) => item.id !== args.eventId);
    return { ok: true };
  });
}

export async function fakeAgenda(specs: FakeAgendaSpec[]) {
  const accounts: FakeAgendaAccount[] = specs.map((spec) => {
    counter++;
    return {
      ...spec,
      name: `google_calendar_${1000 + counter}`,
      events: { ...(spec.events ?? {}) },
      created: [],
      deleted: [],
    };
  });
  fakeRunelay.tool("list_connections", () => [
    { name: "github", status: "ok" },
    ...accounts.map((account) => ({ name: account.name, status: account.status ?? "ok" })),
  ]);
  for (const account of accounts) register(account);
  fakeRunelay.tool("call_tool", callTool);
  await listConnections(true);
  return accounts;
}

export function toolCallsOf(name: string) {
  return fakeRunelay.toolCalls
    .filter((call) => call.name === "call_tool" && call.args.name === name)
    .map((call) => ({ name, args: (call.args.args ?? {}) as Record<string, unknown> }));
}
