import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type UsageProvider = "claude" | "codex";

export type Counters = [number, number, number, number, number, number, number];

export interface UsageRow {
  h: number;
  p: UsageProvider;
  m: string;
  s: string;
  c: Counters;
}

export interface SessionRow {
  p: UsageProvider;
  h: number;
  m: string;
}

export interface UsageSnapshot {
  rows: UsageRow[];
  sessions: SessionRow[];
  scannedAt: string;
  files: number;
}

interface CodexFileState {
  model: string;
  speed: string;
  session: string;
  start: number;
  prev: number[] | null;
}

interface FileCursor {
  offset: number;
  size: number;
  codex?: CodexFileState;
}

interface ScanIndex {
  version: number;
  files: Record<string, FileCursor>;
  buckets: Record<string, Counters>;
  sessions: Record<string, [number, string]>;
  seen: Record<string, number>;
}

const indexVersion = 1;
const keepSeconds = 100 * 86_400;
const emptyCounters = (): Counters => [0, 0, 0, 0, 0, 0, 0];

function hourOf(timestamp: string | undefined) {
  const ms = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 3_600_000) * 3600;
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

async function listJsonl(root: string) {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(root, 0);
  return found;
}

async function readNewLines(path: string, from: number, size: number, onLine: (line: string) => void) {
  if (size <= from) return from;
  const stream = createReadStream(path, { start: from, end: size - 1 });
  let carry: Buffer = Buffer.alloc(0);
  let consumed = from;
  for await (const chunk of stream) {
    const buffer = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let start = 0;
    let newline = buffer.indexOf(10, start);
    while (newline !== -1) {
      if (newline > start) onLine(buffer.toString("utf8", start, newline));
      consumed += newline - start + 1;
      start = newline + 1;
      newline = buffer.indexOf(10, start);
    }
    carry = buffer.subarray(start);
  }
  return consumed;
}

export class UsageScanner {
  private index: ScanIndex | null = null;
  private running: Promise<UsageSnapshot> | null = null;
  private last: UsageSnapshot | null = null;
  private lastAt = 0;

  constructor(
    private readonly indexPath: string,
    private readonly claudeRoot = join(homedir(), ".claude", "projects"),
    private readonly codexRoot = join(homedir(), ".codex", "sessions"),
  ) {}

  snapshot(maxAgeMs = 60_000) {
    if (this.last && Date.now() - this.lastAt < maxAgeMs) return Promise.resolve(this.last);
    if (this.running) return this.running;
    this.running = this.scan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async load() {
    if (this.index) return this.index;
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as ScanIndex;
      if (parsed.version === indexVersion) {
        this.index = parsed;
        return parsed;
      }
    } catch {}
    this.index = { version: indexVersion, files: {}, buckets: {}, sessions: {}, seen: {} };
    return this.index;
  }

  private add(index: ScanIndex, hour: number, provider: UsageProvider, model: string, speed: string, values: Counters) {
    const key = `${hour}|${provider}|${model}|${speed}`;
    const bucket = index.buckets[key] ?? emptyCounters();
    for (let i = 0; i < values.length; i++) bucket[i] += values[i];
    index.buckets[key] = bucket;
  }

  private session(index: ScanIndex, provider: UsageProvider, id: string, hour: number, model: string) {
    if (!id) return;
    const key = `${provider}:${id}`;
    const current = index.sessions[key];
    if (!current || hour < current[0]) index.sessions[key] = [hour, model];
  }

  private claudeLine(index: ScanIndex, line: string) {
    if (!line.includes('"usage"')) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (record.type !== "assistant") return;
    const message = record.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const model = typeof message?.model === "string" ? message.model : "";
    if (!usage || !model || model === "<synthetic>") return;
    const hour = hourOf(record.timestamp as string | undefined);
    if (hour === null) return;
    const dedupe = createHash("sha1").update(`${String(message?.id ?? "")}:${String(record.requestId ?? record.uuid ?? "")}`).digest("base64url").slice(0, 12);
    if (index.seen[dedupe] !== undefined) return;
    index.seen[dedupe] = hour;
    const creation = usage.cache_creation as Record<string, unknown> | undefined;
    const write = num(usage.cache_creation_input_tokens);
    const write1h = Math.min(write, num(creation?.ephemeral_1h_input_tokens));
    const speed = usage.speed === "fast" ? "fast" : "standard";
    this.add(index, hour, "claude", model, speed, [num(usage.input_tokens), num(usage.cache_read_input_tokens), write - write1h, write1h, num(usage.output_tokens), 0, 1]);
    this.session(index, "claude", String(record.sessionId ?? ""), hour, model);
  }

  private codexLine(index: ScanIndex, state: CodexFileState, line: string) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (record.type === "session_meta") {
      if (!state.session) {
        state.session = String(payload.id ?? payload.session_id ?? "");
        state.start = Date.parse(String(payload.timestamp ?? record.timestamp ?? "")) || 0;
      }
      return;
    }
    if (record.type === "turn_context") {
      if (typeof payload.model === "string") state.model = payload.model;
      if (typeof payload.service_tier === "string") state.speed = /priority|fast/.test(payload.service_tier) ? "fast" : "standard";
      return;
    }
    if (payload.type === "thread_settings_applied") {
      const tier = (payload.thread_settings as Record<string, unknown> | undefined)?.service_tier;
      if (typeof tier === "string") state.speed = /priority|fast/.test(tier) ? "fast" : "standard";
      return;
    }
    if (record.type !== "event_msg" || payload.type !== "token_count") return;
    const info = payload.info as Record<string, unknown> | null | undefined;
    const total = info?.total_token_usage as Record<string, unknown> | undefined;
    const last = info?.last_token_usage as Record<string, unknown> | undefined;
    if (!total) return;
    const fields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
    const totals = fields.map((field) => num(total[field]));
    const at = Date.parse(String(record.timestamp ?? ""));
    const previous = state.prev;
    state.prev = totals;
    if (state.start && Number.isFinite(at) && at < state.start - 1000) return;
    let delta: number[];
    if (previous && totals.every((value, i) => value >= previous[i])) delta = totals.map((value, i) => value - previous[i]);
    else if (previous) delta = fields.map((field) => num(last?.[field]));
    else delta = totals;
    if (delta[0] === 0 && delta[3] === 0) return;
    const hour = hourOf(record.timestamp as string | undefined);
    if (hour === null) return;
    const model = state.model || "codex";
    const uncached = Math.max(0, delta[0] - delta[1] - delta[2]);
    this.add(index, hour, "codex", model, state.speed, [uncached, delta[1], delta[2], 0, delta[3], delta[4], 1]);
    this.session(index, "codex", state.session, hour, model);
  }

  private async scan(): Promise<UsageSnapshot> {
    const index = await this.load();
    const [claudeFiles, codexFiles] = await Promise.all([listJsonl(this.claudeRoot), listJsonl(this.codexRoot)]);
    let changed = false;
    const visit = async (path: string, provider: UsageProvider) => {
      let info;
      try {
        info = await stat(path);
      } catch {
        return;
      }
      const cursor = index.files[path] ?? { offset: 0, size: 0 };
      if (info.size < cursor.offset) {
        cursor.offset = 0;
        if (cursor.codex) cursor.codex = undefined;
      }
      if (info.size === cursor.offset) return;
      if (provider === "codex" && !cursor.codex) cursor.codex = { model: "", speed: "standard", session: "", start: 0, prev: null };
      const state = cursor.codex;
      cursor.offset = await readNewLines(path, cursor.offset, info.size, (line) => {
        if (provider === "claude") this.claudeLine(index, line);
        else if (state) this.codexLine(index, state, line);
      });
      cursor.size = info.size;
      index.files[path] = cursor;
      changed = true;
    };
    for (const path of claudeFiles) await visit(path, "claude");
    for (const path of codexFiles) await visit(path, "codex");
    if (changed) {
      this.prune(index);
      await this.save(index);
    }
    this.last = this.toSnapshot(index, claudeFiles.length + codexFiles.length);
    this.lastAt = Date.now();
    return this.last;
  }

  private prune(index: ScanIndex) {
    const floor = Math.floor(Date.now() / 1000) - keepSeconds;
    for (const [key, hour] of Object.entries(index.seen)) if (hour < floor) delete index.seen[key];
    for (const key of Object.keys(index.buckets)) if (Number(key.split("|")[0]) < floor) delete index.buckets[key];
    for (const [key, value] of Object.entries(index.sessions)) if (value[0] < floor) delete index.sessions[key];
  }

  private async save(index: ScanIndex) {
    await mkdir(dirname(this.indexPath), { recursive: true });
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, this.indexPath);
  }

  private toSnapshot(index: ScanIndex, files: number): UsageSnapshot {
    const rows: UsageRow[] = Object.entries(index.buckets).map(([key, c]) => {
      const [h, p, m, s] = key.split("|");
      return { h: Number(h), p: p as UsageProvider, m, s, c: [...c] as Counters };
    });
    const sessions: SessionRow[] = Object.entries(index.sessions).map(([key, [h, m]]) => ({ p: key.split(":")[0] as UsageProvider, h, m }));
    return { rows, sessions, scannedAt: new Date().toISOString(), files };
  }
}
