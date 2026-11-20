import { ulid } from "ulid";
import { redactDeep } from "../../../shared/redact";
import type { PermissionMode } from "../../approvals/services/permissions.service";
import type { Checkpoint, WorkspaceState } from "../../code/services/workspace.service";
import {
  appendEventRow,
  eventRows,
  lastEventAt,
  lineOf,
  loadConversationRows,
  saveConversationRow,
} from "../repositories/sessions.repository";

export interface Fact {
  type: string;
  data: Record<string, unknown>;
  scope?: Record<string, string>;
}

export type SessionSource = "chat" | "schedule" | "thread";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionMeta {
  sessionId: string;
  botId: string;
  kind: "thread" | "session" | "group" | "conversation";
  title: string;
  startedAt: string;
  source: "chat" | "schedule";
  scheduleId?: string;
  sdkSessionId: string | null;
  turnCount: number;
  runCount: number;
  usageTotals: UsageTotals | null;
  scheduleSummaries?: Record<string, string>;
  providerSessions?: Record<string, string>;
  recallSeen?: Record<string, string[]>;
  pendingNotes?: string[];
  carryOver?: string | null;
  contextTokens?: number;
  workspace?: WorkspaceState;
  workspaces?: WorkspaceState[];
  checkpoints?: Checkpoint[];
  revertedTurns?: string[];
  providerSynced?: Record<string, string>;
  handoff?: { summary: string; lastItemId: string; updatedAt: string };
  failover?: { from: string; to: string; since: string; until: string | null };
  lastEngine?: { account: string; model: string };
  permission?: PermissionMode;
  conversation?: ConversationInfo;
  parentSessionId?: string;
  spawnedBy?: string;
  forkPending?: string[];
}

export interface ConversationInfo {
  titleSource: "auto" | "user" | "pending";
  lastMessage: { role: "user" | "bot"; text: string; at: string; botId?: string } | null;
  unread: number;
  readAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
  delegatedBy?: { botId: string; name: string; sessionId: string; callId: string };
}

type Listener = (line: string) => void;

const idleEvictMs = 30 * 60_000;
const logs = new Set<EventLog>();

export class EventLog {
  private cache: string[] | null = null;
  private listeners = new Set<Listener>();
  private touchedAt = Date.now();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly sessionId: string,
    private seq = 0,
    private lastAt: number | null = seq === 0 ? 0 : null,
  ) {
    logs.add(this);
  }

  get size() {
    return this.seq;
  }

  async flush() {
    await this.writes;
  }

  async lines(): Promise<string[]> {
    this.touchedAt = Date.now();
    while (!this.cache) {
      const upto = this.seq;
      await this.flush();
      const rows = await eventRows(this.sessionId, 0, upto);
      if (!this.cache && this.seq === upto) this.cache = rows.map(lineOf);
    }
    return this.cache;
  }

  async slice(start: number, end = this.seq) {
    const from = Math.max(0, start);
    const to = Math.min(this.seq, end);
    if (to <= from) return [];
    if (this.cache) return this.cache.slice(from, to);
    await this.flush();
    return (await eventRows(this.sessionId, from, to)).map(lineOf);
  }

  async rows(start: number, end: number) {
    await this.flush();
    return eventRows(this.sessionId, Math.max(0, start), Math.min(this.seq, end));
  }

  async load() {
    if (this.lastAt !== null) return;
    const stored = await lastEventAt(this.sessionId);
    this.lastAt = Math.max(this.lastAt ?? 0, stored ? Date.parse(stored) || 0 : 0);
  }

  emit(...facts: Fact[]) {
    const now = Math.max(Date.now(), (this.lastAt ?? 0) + 1);
    this.lastAt = now;
    const at = new Date(now).toISOString();
    const redacted = redactDeep(facts);
    const line = JSON.stringify({ at, facts: redacted });
    const seq = ++this.seq;
    this.writes = this.writes.then(() =>
      appendEventRow(this.sessionId, seq, at, redacted).catch((error: unknown) => {
        console.error(`event ${this.sessionId}#${seq} not saved`, error);
      }),
    );
    this.cache?.push(line);
    for (const listener of this.listeners) listener(line);
  }

  progress(fact: Fact) {
    const line = JSON.stringify({ progress: redactDeep(fact) });
    for (const listener of this.listeners) listener(line);
  }

  subscribe(listener: Listener) {
    this.touchedAt = Date.now();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  evictIfIdle(now = Date.now()) {
    if (!this.cache || this.listeners.size > 0 || now - this.touchedAt < idleEvictMs) return false;
    this.cache = null;
    return true;
  }
}

export function evictIdleLogs(now = Date.now()) {
  let evicted = 0;
  for (const log of logs) if (log.evictIfIdle(now)) evicted++;
  return evicted;
}

export class StoredSession {
  constructor(
    public meta: SessionMeta,
    readonly log: EventLog,
  ) {}

  async save() {
    await saveConversationRow(this.meta);
  }
}

const sessions = new Map<string, StoredSession>();

export function newSessionId() {
  return `wrun_${ulid()}`;
}

export async function loadSessions() {
  for (const { meta, lastSeq, lastAt } of await loadConversationRows()) {
    if (!meta?.sessionId) continue;
    if (meta.sdkSessionId && !meta.providerSessions) meta.providerSessions = { "vps:claude": meta.sdkSessionId };
    const log = new EventLog(meta.sessionId, lastSeq, lastAt ? Date.parse(lastAt) || 0 : 0);
    sessions.set(meta.sessionId, new StoredSession(meta, log));
  }
  setInterval(() => evictIdleLogs(), 5 * 60_000).unref();
}

export async function createStoredSession(
  input: Pick<SessionMeta, "botId" | "kind" | "source" | "title"> & { scheduleId?: string },
) {
  const sessionId = newSessionId();
  const meta: SessionMeta = {
    sessionId,
    botId: input.botId,
    kind: input.kind,
    title: input.title,
    startedAt: new Date().toISOString(),
    source: input.source,
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    sdkSessionId: null,
    turnCount: 0,
    runCount: 0,
    usageTotals: null,
  };
  const session = new StoredSession(meta, new EventLog(sessionId));
  sessions.set(sessionId, session);
  await session.save();
  return session;
}

export function getStoredSession(sessionId: string) {
  return sessions.get(sessionId);
}

export function allStoredSessions() {
  return [...sessions.values()];
}

export function sessionsOf(botId: string) {
  return [...sessions.values()].filter((session) => session.meta.botId === botId);
}

const maxTitle = 80;

export function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxTitle ? `${clean.slice(0, maxTitle - 1)}…` : clean;
}
