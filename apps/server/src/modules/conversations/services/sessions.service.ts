import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import { sessionsDir } from "../../../config/env";
import { readJson, writeJson } from "../../../shared/json-file";
import { redactDeep } from "../../../shared/redact";
import type { PermissionMode } from "../../approvals/services/permissions.service";
import type { Checkpoint, WorkspaceState } from "../../code/services/workspace.service";

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
  pendingNotes?: string[];
  carryOver?: string | null;
  contextTokens?: number;
  workspace?: WorkspaceState;
  checkpoints?: Checkpoint[];
  revertedTurns?: string[];
  providerSynced?: Record<string, string>;
  handoff?: { summary: string; lastItemId: string; updatedAt: string };
  failover?: { from: string; to: string; since: string; until: string | null };
  lastEngine?: { account: string; model: string };
  permission?: PermissionMode;
  conversation?: ConversationInfo;
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

export class EventLog {
  readonly lines: string[] = [];
  private listeners = new Set<Listener>();
  private lastAt = 0;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load() {
    try {
      const text = await readFile(this.file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.lines.push(line);
        try {
          const at = Date.parse(JSON.parse(line).at);
          if (at > this.lastAt) this.lastAt = at;
        } catch {}
      }
    } catch {}
  }

  emit(...facts: Fact[]) {
    const now = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = now;
    const line = JSON.stringify({ at: new Date(now).toISOString(), facts: redactDeep(facts) });
    this.lines.push(line);
    const file = this.file;
    this.writes = this.writes.then(() => appendFile(file, `${line}\n`)).catch(() => undefined);
    for (const listener of this.listeners) listener(line);
  }

  progress(fact: Fact) {
    const line = JSON.stringify({ progress: redactDeep(fact) });
    for (const listener of this.listeners) listener(line);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class StoredSession {
  constructor(
    public meta: SessionMeta,
    readonly log: EventLog,
  ) {}

  save() {
    return writeJson(join(sessionsDir, `${this.meta.sessionId}.json`), this.meta);
  }
}

const sessions = new Map<string, StoredSession>();

export function newSessionId() {
  return `wrun_${ulid()}`;
}

export async function loadSessions() {
  await mkdir(sessionsDir, { recursive: true });
  for (const entry of await readdir(sessionsDir)) {
    if (!entry.endsWith(".json")) continue;
    const meta = await readJson<SessionMeta | null>(join(sessionsDir, entry), null);
    if (!meta?.sessionId) continue;
    if (meta.sdkSessionId && !meta.providerSessions) meta.providerSessions = { "vps:claude": meta.sdkSessionId };
    const log = new EventLog(join(sessionsDir, `${meta.sessionId}.ndjson`));
    await log.load();
    sessions.set(meta.sessionId, new StoredSession(meta, log));
  }
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
  const session = new StoredSession(meta, new EventLog(join(sessionsDir, `${sessionId}.ndjson`)));
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
