import { chmod, cp, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { and, count, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  artifactContentKey,
  artifactExtension,
  saveArtifactRow,
} from "../modules/artifacts/repositories/artifacts.repository";
import type { ArtifactMeta } from "../modules/artifacts/services/artifacts.service";
import type { BlobStore } from "../modules/storage/services/blob-store";
import { sha256Of } from "../modules/storage/services/blob-store";
import { blobKeys } from "../modules/storage/services/storage.service";
import type { Db } from "./client";
import {
  artifacts,
  artifactVersions,
  blobs,
  bots,
  codeWorkspaces,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  sections,
  settings,
  teamMemory,
  threads,
  uploads,
  usageBuckets,
  usageCursors,
  usageSeen,
  usageSessions,
  vaultAudit,
  vaultSecrets,
} from "./tables";

type Json = Record<string, unknown>;

export interface LegacyCounts {
  bots: number;
  groups: number;
  sections: number;
  conversations: number;
  events: number;
  threads: number;
  teamMemory: number;
  uploads: number;
  secrets: number;
  vaultAudit: number;
  codeWorkspaces: number;
  artifacts: number;
  artifactVersions: number;
  eventsBySession: Record<string, number>;
}

export interface UploadFailure {
  botId: string;
  uploadId: string;
  reason: string;
}

export interface ImportReport {
  before: LegacyCounts;
  after: LegacyCounts;
  mismatches: string[];
  uploadFailures: UploadFailure[];
  copiedFiles: number;
}

export interface ImportOptions {
  targetDataDir?: string;
}

const botColumns = new Set([
  "id",
  "name",
  "role",
  "accent",
  "glyph",
  "instructions",
  "permission",
  "builtIn",
  "capabilities",
  "schedules",
  "engine",
  "decisions",
  "connectors",
  "memory",
  "computer",
  "voice",
  "sidebar",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "deletedAt",
]);

async function readJsonFile<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return (await file.json()) as T;
}

async function readLines(path: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text()).split("\n").filter((line) => line.trim());
}

async function list(dir: string) {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

async function filesUnder(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function pickExtra(source: Json, known: Set<string>) {
  const extra: Json = {};
  for (const [key, value] of Object.entries(source)) if (!known.has(key)) extra[key] = value;
  return Object.keys(extra).length ? extra : null;
}

function parseLine(line: string): { at: string; facts: unknown[] } {
  try {
    const parsed = JSON.parse(line) as { at?: string; facts?: unknown[] };
    return { at: parsed.at ?? "", facts: Array.isArray(parsed.facts) ? parsed.facts : [] };
  } catch {
    return { at: "", facts: [{ type: "legacy.unparsed", data: { line } }] };
  }
}

export function messageOf(facts: unknown[]) {
  const texts: string[] = [];
  let role: "user" | "bot" | null = null;
  for (const fact of facts as { type?: string; data?: Json }[]) {
    if (fact?.type === "delivery.consumed") {
      const parts = (fact.data?.parts ?? []) as { kind?: string; text?: string }[];
      for (const part of parts) if (part.kind === "text" && part.text) texts.push(part.text);
      role ??= "user";
    } else if (
      fact?.type === "content.completed" &&
      fact.data?.kind === "text" &&
      typeof fact.data.value === "string"
    ) {
      texts.push(fact.data.value);
      role ??= "bot";
    }
  }
  return texts.length ? { role, text: texts.join("\n") } : { role: null, text: null };
}

export function factTypes(facts: unknown[]) {
  return (facts as { type?: string }[])
    .map((fact) => fact?.type)
    .filter(Boolean)
    .join(" ");
}

async function legacyArtifacts(legacyDir: string) {
  const found: ArtifactMeta[] = [];
  for (const botId of await list(join(legacyDir, "bots"))) {
    for (const artifactId of await list(join(legacyDir, "bots", botId, "artifacts"))) {
      const meta = await readJsonFile<ArtifactMeta>(
        join(legacyDir, "bots", botId, "artifacts", artifactId, "meta.json"),
      );
      if (meta?.id) found.push({ ...meta, botId, versions: meta.versions ?? [] });
    }
  }
  return found;
}

export async function legacyCounts(legacyDir: string): Promise<LegacyCounts> {
  const botFiles = (await list(join(legacyDir, "bots"))).filter((name) => name.endsWith(".json"));
  const sessionFiles = (await list(join(legacyDir, "sessions"))).filter((name) => name.endsWith(".json"));
  const eventsBySession: Record<string, number> = {};
  for (const name of sessionFiles) {
    const sessionId = name.slice(0, -5);
    eventsBySession[sessionId] = (await readLines(join(legacyDir, "sessions", `${sessionId}.ndjson`))).length;
  }
  let threadCount = 0;
  for (const name of await list(join(legacyDir, "threads"))) if (name.endsWith(".json")) threadCount++;
  for (const owner of await list(join(legacyDir, "threads", "archive")))
    threadCount += (await list(join(legacyDir, "threads", "archive", owner))).filter((name) =>
      name.endsWith(".json"),
    ).length;
  let uploadCount = 0;
  for (const botId of await list(join(legacyDir, "bots")))
    uploadCount += (await list(join(legacyDir, "bots", botId, "uploads", ".meta"))).filter((name) =>
      name.endsWith(".json"),
    ).length;
  let artifactCount = 0;
  let artifactVersionCount = 0;
  for (const meta of await legacyArtifacts(legacyDir)) {
    artifactCount++;
    artifactVersionCount += meta.versions.length;
  }
  const vaultIndex = (await readJsonFile<Json>(join(legacyDir, "vault", "index.json"))) ?? {};
  return {
    bots: botFiles.length,
    groups: ((await readJsonFile<unknown[]>(join(legacyDir, "groups.json"))) ?? []).length,
    sections: ((await readJsonFile<unknown[]>(join(legacyDir, "sections.json"))) ?? []).length,
    conversations: sessionFiles.length,
    events: Object.values(eventsBySession).reduce((sum, value) => sum + value, 0),
    threads: threadCount,
    teamMemory: (await readLines(join(legacyDir, "team-log.ndjson"))).length,
    uploads: uploadCount,
    secrets: Object.keys(vaultIndex).length,
    vaultAudit: (await readLines(join(legacyDir, "vault", "audit.ndjson"))).length,
    codeWorkspaces: ((await readJsonFile<unknown[]>(join(legacyDir, "code", "worktrees.json"))) ?? []).length,
    artifacts: artifactCount,
    artifactVersions: artifactVersionCount,
    eventsBySession,
  };
}

export function dbCounts(db: Db): LegacyCounts {
  const total = (table: SQLiteTable) => db.select({ value: count() }).from(table).get()?.value ?? 0;
  const eventsBySession: Record<string, number> = {};
  for (const row of db
    .select({ sessionId: conversationEvents.sessionId, value: count() })
    .from(conversationEvents)
    .groupBy(conversationEvents.sessionId)
    .all())
    eventsBySession[row.sessionId] = row.value;
  return {
    bots: total(bots),
    groups: total(groups),
    sections: total(sections),
    conversations: total(conversations),
    events: total(conversationEvents),
    threads: total(threads),
    teamMemory: total(teamMemory),
    uploads: total(uploads),
    secrets: total(vaultSecrets),
    vaultAudit: total(vaultAudit),
    codeWorkspaces: total(codeWorkspaces),
    artifacts: total(artifacts),
    artifactVersions: total(artifactVersions),
    eventsBySession,
  };
}

function importBots(db: Db, rows: Json[]) {
  for (const bot of rows) {
    const values = {
      id: String(bot.id),
      name: String(bot.name ?? bot.id),
      role: String(bot.role ?? ""),
      accent: String(bot.accent ?? ""),
      glyph: String(bot.glyph ?? ""),
      instructions: String(bot.instructions ?? ""),
      permission: (bot.permission as string | undefined) ?? null,
      builtIn: bot.builtIn === true,
      capabilities: (bot.capabilities as Json | undefined) ?? {},
      schedules: (bot.schedules as Json[] | undefined) ?? [],
      engine: (bot.engine as Json | undefined) ?? null,
      decisions: (bot.decisions as Json | undefined) ?? null,
      connectors: (bot.connectors as Json | undefined) ?? null,
      memory: (bot.memory as Json | undefined) ?? null,
      computer: (bot.computer as Json | undefined) ?? null,
      voice: (bot.voice as Json | undefined) ?? null,
      sidebar: (bot.sidebar as Json | undefined) ?? null,
      extra: pickExtra(bot, botColumns),
      createdAt: String(bot.createdAt ?? new Date(0).toISOString()),
      updatedAt: String(bot.updatedAt ?? bot.createdAt ?? new Date(0).toISOString()),
      archivedAt: (bot.archivedAt as string | null | undefined) ?? null,
      deletedAt: (bot.deletedAt as string | null | undefined) ?? null,
    };
    db.insert(bots).values(values).onConflictDoUpdate({ target: bots.id, set: values }).run();
  }
}

function importGroups(db: Db, rows: Json[]) {
  for (const group of rows) {
    const values = {
      id: String(group.id),
      name: String(group.name ?? ""),
      extra: pickExtra(group, new Set(["id", "name", "members", "createdAt", "updatedAt", "archivedAt"])),
      createdAt: String(group.createdAt),
      updatedAt: String(group.updatedAt ?? group.createdAt),
      archivedAt: (group.archivedAt as string | null | undefined) ?? null,
    };
    db.insert(groups).values(values).onConflictDoUpdate({ target: groups.id, set: values }).run();
    db.delete(groupMembers).where(eq(groupMembers.groupId, values.id)).run();
    const members = (group.members as string[] | undefined) ?? [];
    members.forEach((botId, position) => {
      db.insert(groupMembers).values({ groupId: values.id, botId, position }).onConflictDoNothing().run();
    });
  }
}

function importSections(db: Db, rows: Json[]) {
  for (const section of rows) {
    const values = {
      id: String(section.id),
      name: String(section.name ?? ""),
      position: Number(section.order ?? 0),
      extra: pickExtra(section, new Set(["id", "name", "order", "createdAt", "updatedAt", "archivedAt"])),
      createdAt: String(section.createdAt),
      updatedAt: (section.updatedAt as string | undefined) ?? null,
      archivedAt: (section.archivedAt as string | null | undefined) ?? null,
    };
    db.insert(sections).values(values).onConflictDoUpdate({ target: sections.id, set: values }).run();
  }
}

async function importSessions(db: Db, legacyDir: string) {
  const dir = join(legacyDir, "sessions");
  const insertEvent = db.$client.query(
    "INSERT INTO conversation_events (session_id, seq, at, types, role, text, facts) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, seq) DO NOTHING",
  );
  for (const name of (await list(dir)).filter((entry) => entry.endsWith(".json"))) {
    const meta = await readJsonFile<Json>(join(dir, name));
    if (!meta) continue;
    const sessionId = String(meta.sessionId ?? name.slice(0, -5));
    const lines = await readLines(join(dir, `${sessionId}.ndjson`));
    const parsed = lines.map(parseLine);
    const conversation = (meta.conversation as Json | undefined) ?? {};
    const lastAt = parsed.findLast((line) => line.at)?.at;
    const values = {
      sessionId,
      botId: String(meta.botId),
      kind: String(meta.kind ?? "session"),
      title: String(meta.title ?? ""),
      source: String(meta.source ?? "chat"),
      scheduleId: (meta.scheduleId as string | undefined) ?? null,
      startedAt: String(meta.startedAt),
      updatedAt: String(conversation.updatedAt ?? lastAt ?? meta.startedAt),
      archivedAt: (conversation.archivedAt as string | null | undefined) ?? null,
      unread: Number(conversation.unread ?? 0),
      readAt: (conversation.readAt as string | null | undefined) ?? null,
      lastMessage: (conversation.lastMessage as Json | null | undefined) ?? null,
      turnCount: Number(meta.turnCount ?? 0),
      runCount: Number(meta.runCount ?? 0),
      lastSeq: parsed.length,
      meta,
    };
    db.$client
      .transaction(() => {
        db.insert(conversations)
          .values(values)
          .onConflictDoUpdate({ target: conversations.sessionId, set: values })
          .run();
        parsed.forEach((line, position) => {
          const message = messageOf(line.facts);
          insertEvent.run(
            sessionId,
            position + 1,
            line.at,
            factTypes(line.facts),
            message.role,
            message.text,
            JSON.stringify(line.facts),
          );
        });
      })
      .immediate();
  }
}

async function importThreads(db: Db, legacyDir: string) {
  const dir = join(legacyDir, "threads");
  for (const name of (await list(dir)).filter((entry) => entry.endsWith(".json"))) {
    const state = await readJsonFile<Json>(join(dir, name));
    if (!state) continue;
    const ownerId = name.slice(0, -5);
    const values = {
      id: ownerId,
      ownerId,
      sessionId: String(state.sessionId),
      lastMessage: (state.lastMessage as Json | null | undefined) ?? null,
      unread: Number(state.unread ?? 0),
      readAt: (state.readAt as string | null | undefined) ?? null,
      archivedAt: null,
    };
    db.insert(threads).values(values).onConflictDoUpdate({ target: threads.id, set: values }).run();
  }
  for (const ownerId of await list(join(dir, "archive"))) {
    for (const name of (await list(join(dir, "archive", ownerId))).filter((entry) => entry.endsWith(".json"))) {
      const archived = await readJsonFile<{ archiveId: string; archivedAt: string; state: Json }>(
        join(dir, "archive", ownerId, name),
      );
      if (!archived) continue;
      const values = {
        id: archived.archiveId,
        ownerId,
        sessionId: String(archived.state.sessionId),
        lastMessage: (archived.state.lastMessage as Json | null | undefined) ?? null,
        unread: Number(archived.state.unread ?? 0),
        readAt: (archived.state.readAt as string | null | undefined) ?? null,
        archivedAt: archived.archivedAt,
      };
      db.insert(threads).values(values).onConflictDoUpdate({ target: threads.id, set: values }).run();
    }
  }
}

async function importTeamMemory(db: Db, legacyDir: string) {
  for (const line of await readLines(join(legacyDir, "team-log.ndjson"))) {
    const entry = JSON.parse(line) as Json;
    const values = {
      at: String(entry.at),
      botId: String(entry.botId ?? ""),
      botName: String(entry.botName ?? ""),
      summary: String(entry.summary ?? ""),
      extra: pickExtra(entry, new Set(["at", "botId", "botName", "summary"])),
    };
    const exists = db
      .select({ id: teamMemory.id })
      .from(teamMemory)
      .where(
        and(eq(teamMemory.at, values.at), eq(teamMemory.botId, values.botId), eq(teamMemory.summary, values.summary)),
      )
      .get();
    if (!exists) db.insert(teamMemory).values(values).run();
  }
}

function setSetting(db: Db, key: string, value: unknown) {
  const values = { key, value, updatedAt: new Date().toISOString() };
  db.insert(settings).values(values).onConflictDoUpdate({ target: settings.key, set: values }).run();
}

async function importUsage(db: Db, legacyDir: string) {
  const prices = await readJsonFile<Json>(join(legacyDir, "usage", "prices.json"));
  if (prices) setSetting(db, "usage.prices", prices);
  const index = await readJsonFile<{
    version: number;
    files: Record<string, Json>;
    buckets: Record<string, number[]>;
    sessions: Record<string, [number, string]>;
    seen: Record<string, number>;
  }>(join(legacyDir, "usage", "vps-index.json"));
  if (!index) return;
  setSetting(db, "usage.index.version", index.version);
  db.$client
    .transaction(() => {
      for (const [key, counters] of Object.entries(index.buckets ?? {})) {
        const [hour, provider, model, tier] = key.split("|");
        const values = {
          hour: Number(hour),
          provider: String(provider),
          model: String(model),
          tier: String(tier ?? ""),
          counters,
        };
        db.insert(usageBuckets)
          .values(values)
          .onConflictDoUpdate({
            target: [usageBuckets.hour, usageBuckets.provider, usageBuckets.model, usageBuckets.tier],
            set: { counters },
          })
          .run();
      }
      for (const [key, [hour, model]] of Object.entries(index.sessions ?? {})) {
        db.insert(usageSessions)
          .values({ key, hour, model })
          .onConflictDoUpdate({ target: usageSessions.key, set: { hour, model } })
          .run();
      }
      for (const [path, state] of Object.entries(index.files ?? {})) {
        db.insert(usageCursors)
          .values({ path, state })
          .onConflictDoUpdate({ target: usageCursors.path, set: { state } })
          .run();
      }
      for (const [key, hour] of Object.entries(index.seen ?? {})) {
        db.insert(usageSeen).values({ key, hour }).onConflictDoUpdate({ target: usageSeen.key, set: { hour } }).run();
      }
    })
    .immediate();
}

async function importVault(db: Db, legacyDir: string) {
  const dir = join(legacyDir, "vault");
  const index = (await readJsonFile<Record<string, Json>>(join(dir, "index.json"))) ?? {};
  for (const [name, meta] of Object.entries(index)) {
    const sealed = await readJsonFile<{ iv: string; tag: string; ct: string }>(join(dir, `${name}.enc`));
    const values = {
      name,
      description: String(meta.description ?? ""),
      kind: String(meta.kind ?? "password"),
      storage: String(meta.storage ?? "mac"),
      touchId: String(meta.touchId ?? "always"),
      domains: (meta.domains as string[] | undefined) ?? [],
      bots: (meta.bots as string[] | undefined) ?? [],
      iv: sealed ? Buffer.from(sealed.iv, "base64") : null,
      tag: sealed ? Buffer.from(sealed.tag, "base64") : null,
      ciphertext: sealed ? Buffer.from(sealed.ct, "base64") : null,
      expiresAt: (meta.expiresAt as string | null | undefined) ?? null,
      createdAt: String(meta.createdAt),
      updatedAt: String(meta.updatedAt ?? meta.createdAt),
      rotatedAt: (meta.rotatedAt as string | null | undefined) ?? null,
      lastUsedAt: (meta.lastUsedAt as string | null | undefined) ?? null,
      lastUsedBy: (meta.lastUsedBy as string | null | undefined) ?? null,
      lastTool: (meta.lastTool as string | null | undefined) ?? null,
    };
    db.insert(vaultSecrets).values(values).onConflictDoUpdate({ target: vaultSecrets.name, set: values }).run();
  }
  for (const line of await readLines(join(dir, "audit.ndjson"))) {
    const entry = JSON.parse(line) as Json;
    const values = {
      at: String(entry.at),
      name: String(entry.name ?? ""),
      outcome: String(entry.outcome ?? ""),
      by: (entry.by as string | undefined) ?? null,
      extra: pickExtra(entry, new Set(["at", "name", "outcome", "by"])),
    };
    const exists = db
      .select({ id: vaultAudit.id })
      .from(vaultAudit)
      .where(
        and(eq(vaultAudit.at, values.at), eq(vaultAudit.name, values.name), eq(vaultAudit.outcome, values.outcome)),
      )
      .get();
    if (!exists) db.insert(vaultAudit).values(values).run();
  }
}

async function importCode(db: Db, legacyDir: string) {
  const rows = (await readJsonFile<Json[]>(join(legacyDir, "code", "worktrees.json"))) ?? [];
  const known = new Set([
    "id",
    "botId",
    "sessionId",
    "repo",
    "repoName",
    "branch",
    "base",
    "baseCommit",
    "path",
    "pinned",
    "status",
    "prUrl",
    "createdAt",
    "lastAccessedAt",
  ]);
  for (const row of rows) {
    const values = {
      id: String(row.id),
      botId: String(row.botId),
      sessionId: (row.sessionId as string | null | undefined) ?? null,
      repo: String(row.repo),
      repoName: String(row.repoName ?? ""),
      branch: String(row.branch ?? ""),
      base: (row.base as string | null | undefined) ?? null,
      baseCommit: (row.baseCommit as string | null | undefined) ?? null,
      path: String(row.path),
      pinned: row.pinned === true,
      status: String(row.status ?? "active"),
      prUrl: (row.prUrl as string | null | undefined) ?? null,
      extra: pickExtra(row, known),
      createdAt: String(row.createdAt),
      lastAccessedAt: (row.lastAccessedAt as string | null | undefined) ?? null,
    };
    db.insert(codeWorkspaces).values(values).onConflictDoUpdate({ target: codeWorkspaces.id, set: values }).run();
  }
}

async function uploadVerified(db: Db, store: BlobStore, path: string, key: string, mime: string, botId: string) {
  const local = await sha256Of(Bun.file(path).stream());
  const known = db.select().from(blobs).where(eq(blobs.key, key)).get();
  const head = known?.sha256 === local.sha256 ? await store.head(key) : null;
  if (!known || known.sha256 !== local.sha256 || head?.size !== local.size) {
    await store.put(key, Bun.file(path).stream(), { mime });
    const remote = await store.get(key);
    const check = remote ? await sha256Of(remote) : null;
    if (check?.sha256 !== local.sha256 || check.size !== local.size) throw new Error(`sha256 mismatch for ${key}`);
    const values = {
      key,
      mime,
      size: local.size,
      sha256: local.sha256,
      botId,
      sessionId: null,
      createdAt: new Date().toISOString(),
    };
    db.insert(blobs)
      .values(values)
      .onConflictDoUpdate({ target: blobs.key, set: { mime, size: local.size, sha256: local.sha256 } })
      .run();
  }
  return local;
}

function derivedMime(name: string) {
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function importUploads(db: Db, store: BlobStore, legacyDir: string, failures: UploadFailure[]) {
  for (const botId of await list(join(legacyDir, "bots"))) {
    const dir = join(legacyDir, "bots", botId, "uploads");
    if (!(await stat(dir).catch(() => null))?.isDirectory()) continue;
    const keys = blobKeys(botId);
    for (const name of (await list(join(dir, ".meta"))).filter((entry) => entry.endsWith(".json"))) {
      const meta = await readJsonFile<Json>(join(dir, ".meta", name));
      if (!meta) continue;
      const uploadId = String(meta.uploadId ?? name.slice(0, -5));
      try {
        const mime = String(meta.mime ?? "application/octet-stream");
        const blobKey = keys.upload(uploadId, String(meta.name ?? meta.file));
        const local = await uploadVerified(db, store, join(dir, String(meta.file)), blobKey, mime, botId);
        const derived: Record<string, string> = {};
        const derivedRoot = join(dir, ".derived", uploadId);
        for (const relativePath of await filesUnder(derivedRoot)) {
          const key = keys.derived(uploadId, relativePath.replaceAll("/", "__"));
          await uploadVerified(db, store, join(derivedRoot, relativePath), key, derivedMime(relativePath), botId);
          derived[relativePath] = key;
        }
        const values = {
          id: uploadId,
          botId,
          sessionId: (meta.sessionId as string | undefined) ?? null,
          name: String(meta.name ?? meta.file),
          mime,
          size: local.size,
          kind: String(meta.kind ?? "file"),
          source: String(meta.source ?? "user"),
          blobKey,
          sha256: local.sha256,
          width: (meta.width as number | undefined) ?? null,
          height: (meta.height as number | undefined) ?? null,
          duration: (meta.duration as number | undefined) ?? null,
          waveform: (meta.waveform as number[] | undefined) ?? null,
          thumbKey: derived["thumb.jpg"] ?? null,
          derived: Object.keys(derived).length ? derived : null,
          transcript: (meta.transcript as string | undefined) ?? null,
          transcriptSource: (meta.transcriptSource as string | undefined) ?? null,
          createdAt: String(meta.createdAt),
        };
        db.insert(uploads).values(values).onConflictDoUpdate({ target: uploads.id, set: values }).run();
      } catch (error) {
        failures.push({ botId, uploadId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

async function importArtifacts(db: Db, store: BlobStore, legacyDir: string, failures: UploadFailure[]) {
  for (const meta of await legacyArtifacts(legacyDir)) {
    try {
      const dir = join(legacyDir, "bots", meta.botId, "artifacts", meta.id);
      const mime = meta.kind === "canvas" ? "application/json" : "text/html; charset=utf-8";
      for (const version of meta.versions) {
        const file = join(dir, `v${version.n}.${artifactExtension(meta.kind)}`);
        await uploadVerified(
          db,
          store,
          file,
          artifactContentKey(meta.botId, meta.id, version.n, meta.kind),
          mime,
          meta.botId,
        );
      }
      saveArtifactRow(meta, db);
    } catch (error) {
      failures.push({
        botId: meta.botId,
        uploadId: meta.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const skippedOnDisk = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie"]);

async function copyTree(from: string, to: string) {
  if (!(await stat(from).catch(() => null))) return 0;
  const before = (await filesUnder(to)).length;
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (source) => !skippedOnDisk.has(basename(source)) && basename(source) !== "worktrees.json",
  });
  return (await filesUnder(to)).length - before;
}

export async function copyDiskData(legacyDir: string, targetDataDir: string) {
  if (resolve(legacyDir) === resolve(targetDataDir)) return 0;
  let copied = 0;
  for (const name of ["work", "workspaces", "code"])
    copied += await copyTree(join(legacyDir, name), join(targetDataDir, name));
  for (const botId of await list(join(legacyDir, "bots")))
    for (const name of ["browser", "desktop"])
      copied += await copyTree(join(legacyDir, "bots", botId, name), join(targetDataDir, "bots", botId, name));
  const secret = Bun.file(join(legacyDir, "auth.secret"));
  const targetSecret = join(targetDataDir, "auth.secret");
  if ((await secret.exists()) && !(await Bun.file(targetSecret).exists())) {
    await Bun.write(targetSecret, secret);
    await chmod(targetSecret, 0o600);
    copied++;
  }
  return copied;
}

export function compareCounts(before: LegacyCounts, after: LegacyCounts) {
  const mismatches: string[] = [];
  for (const key of Object.keys(before) as (keyof LegacyCounts)[]) {
    if (key === "eventsBySession") continue;
    if (before[key] !== after[key]) mismatches.push(`${key}: legacy ${before[key]} db ${after[key]}`);
  }
  for (const [sessionId, value] of Object.entries(before.eventsBySession)) {
    const stored = after.eventsBySession[sessionId] ?? 0;
    if (stored !== value) mismatches.push(`events ${sessionId}: legacy ${value} db ${stored}`);
  }
  return mismatches;
}

export async function importLegacy(
  db: Db,
  store: BlobStore,
  legacyDir: string,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const before = await legacyCounts(legacyDir);
  const uploadFailures: UploadFailure[] = [];
  const botRows: Json[] = [];
  for (const name of (await list(join(legacyDir, "bots"))).filter((entry) => entry.endsWith(".json"))) {
    const bot = await readJsonFile<Json>(join(legacyDir, "bots", name));
    if (bot) botRows.push(bot);
  }
  const groupRows = (await readJsonFile<Json[]>(join(legacyDir, "groups.json"))) ?? [];
  const sectionRows = (await readJsonFile<Json[]>(join(legacyDir, "sections.json"))) ?? [];
  db.$client
    .transaction(() => {
      importBots(db, botRows);
      importGroups(db, groupRows);
      importSections(db, sectionRows);
    })
    .immediate();
  await importSessions(db, legacyDir);
  await importThreads(db, legacyDir);
  await importTeamMemory(db, legacyDir);
  await importUsage(db, legacyDir);
  await importVault(db, legacyDir);
  await importCode(db, legacyDir);
  await importUploads(db, store, legacyDir, uploadFailures);
  await importArtifacts(db, store, legacyDir, uploadFailures);
  const copiedFiles = options.targetDataDir ? await copyDiskData(legacyDir, options.targetDataDir) : 0;
  db.$client.run("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')");
  const after = dbCounts(db);
  const mismatches = compareCounts(before, after);
  for (const failure of uploadFailures)
    mismatches.push(`upload ${failure.botId}/${failure.uploadId}: ${failure.reason}`);
  return { before, after, mismatches, uploadFailures, copiedFiles };
}
