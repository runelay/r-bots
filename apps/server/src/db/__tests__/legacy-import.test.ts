import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "../../modules/storage/services/fs-blob-store";
import { openDatabase, tables } from "..";
import { compareCounts, dbCounts, factTypes, importLegacy, legacyCounts, messageOf } from "../legacy-import";

const dir = mkdtempSync(join(tmpdir(), "rb-legacy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, content: unknown) {
  const full = join(dir, "data", path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
}

function seed() {
  const at = "2026-11-19T10:00:00.000Z";
  write("bots/boss.json", {
    id: "boss",
    name: "Boss",
    role: "chefe",
    accent: "#f00",
    glyph: "B",
    instructions: "x",
    capabilities: {},
    schedules: [],
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    builtIn: true,
    permission: "full",
    custom: 1,
  });
  write("bots/bare.json", { id: "bare" });
  write("groups.json", [
    { id: "g1", name: "Time", members: ["boss", "bare"], createdAt: at, updatedAt: at, archivedAt: null },
    { id: "g2", createdAt: at },
  ]);
  write("sections.json", [
    { id: "s1", name: "Prod", order: 2, createdAt: at, archivedAt: null },
    { id: "s2", createdAt: at },
  ]);
  write("sessions/wrun_1.json", {
    sessionId: "wrun_1",
    botId: "boss",
    kind: "conversation",
    title: "Oi",
    startedAt: at,
    source: "chat",
    turnCount: 1,
    runCount: 1,
    conversation: {
      updatedAt: at,
      archivedAt: null,
      unread: 2,
      readAt: at,
      lastMessage: { role: "bot", text: "a", at },
    },
  });
  write(
    "sessions/wrun_1.ndjson",
    [
      JSON.stringify({
        at,
        facts: [
          { type: "delivery.consumed", data: { parts: [{ kind: "text", text: "olá produção" }, { kind: "image" }] } },
        ],
      }),
      JSON.stringify({
        at,
        facts: [
          { type: "content.completed", data: { kind: "text", value: "resposta" } },
          { type: "turn.settled", data: {} },
        ],
      }),
      "not json",
      "",
    ].join("\n"),
  );
  write("sessions/wrun_2.json", { botId: "bare", startedAt: at });
  write("sessions/broken.json", "null");
  write("threads/boss.json", { sessionId: "wrun_1", lastMessage: null, unread: 1, readAt: at });
  write("threads/bare.json", { sessionId: "wrun_2" });
  write("threads/empty.json", "null");
  write("threads/archive/boss/tha_1.json", {
    archiveId: "tha_1",
    archivedAt: at,
    state: { sessionId: "wrun_1", lastMessage: null },
  });
  write("threads/archive/boss/tha_2.json", "null");
  write(
    "team-log.ndjson",
    `${JSON.stringify({ at, botId: "boss", botName: "Boss", summary: "s", topic: "t" })}\n${JSON.stringify({ at })}\n`,
  );
  write("usage/prices.json", { at: 1, table: {} });
  write("usage/vps-index.json", {
    version: 3,
    files: { "/a.jsonl": { offset: 1, size: 2 } },
    buckets: { "1|claude|opus|standard": [1, 2, 3, 4, 5, 6, 7], "2|claude|opus": [1, 1, 1, 1, 1, 1, 1] },
    sessions: { "claude:1": [1, "opus"] },
    seen: { k: 1 },
  });
  write("vault/index.json", {
    login: {
      name: "login",
      description: "d",
      domains: ["x.com"],
      bots: ["boss"],
      touchId: "always",
      storage: "mac+server",
      kind: "password",
      createdAt: at,
      updatedAt: at,
      expiresAt: null,
      rotatedAt: null,
      lastUsedAt: null,
      lastUsedBy: null,
      lastTool: null,
    },
    bare: { createdAt: at },
  });
  write("vault/login.enc", { v: 1, iv: "AAAA", tag: "AAAA", ct: "AAAA" });
  write(
    "vault/audit.ndjson",
    `${JSON.stringify({ at, name: "login", outcome: "created", by: "person", extra: 1 })}\n${JSON.stringify({ at })}\n`,
  );
  write("code/worktrees.json", [
    {
      id: "w1",
      botId: "boss",
      sessionId: "wrun_1",
      repo: "/r",
      repoName: "r",
      branch: "b",
      base: "main",
      baseCommit: "c",
      path: "/p",
      pinned: true,
      status: "active",
      createdAt: at,
      lastAccessedAt: at,
      note: 1,
    },
    { id: "w2", botId: "boss", repo: "/r", path: "/p2", createdAt: at },
  ]);
  write("bots/boss/uploads/u1-photo.png", "png-bytes");
  write("bots/boss/uploads/.meta/u1.json", {
    uploadId: "u1",
    name: "photo.png",
    mime: "image/png",
    size: 9,
    kind: "image",
    file: "u1-photo.png",
    createdAt: at,
    source: "user",
    width: 1,
    height: 1,
    thumb: true,
  });
  write("bots/boss/uploads/.derived/u1/thumb.jpg", "thumb");
  write("bots/boss/uploads/.derived/u1/frames/1.png", "frame");
  write("bots/boss/uploads/.derived/u1/audio.mp3", "mp3");
  write("bots/boss/uploads/.derived/u1/prepared.json", "{}");
  write("bots/boss/uploads/.derived/u1/other.bin", "bin");
  write("bots/boss/uploads/u2-a.txt", "a");
  write("bots/boss/uploads/.meta/u2.json", { file: "u2-a.txt", createdAt: at });
  write("bots/boss/uploads/.meta/u3.json", { uploadId: "u3", name: "gone", file: "missing", createdAt: at });
  write("bots/boss/uploads/.meta/u4.json", "null");
  write("bots/bare/notes.txt", "x");
}

describe("legacy import", () => {
  test("imports everything and is idempotent", async () => {
    seed();
    const db = openDatabase(join(dir, "a.db"));
    const store = new FsBlobStore(join(dir, "blobs"));
    const first = await importLegacy(db, store, join(dir, "data"));
    expect(first.uploadFailures.map((failure) => failure.uploadId)).toEqual(["u3"]);
    expect(first.mismatches).toContain("uploads: legacy 4 db 2");
    expect(first.mismatches).toContain("conversations: legacy 3 db 2");
    expect(first.mismatches.some((item) => item.startsWith("upload boss/u3: "))).toBe(true);
    expect(first.after.events).toBe(3);
    expect(first.after.bots).toBe(2);
    const second = await importLegacy(db, store, join(dir, "data"));
    expect(second.after).toEqual(first.after);
    const upload = db
      .select()
      .from(tables.uploads)
      .all()
      .find((row) => row.id === "u1");
    expect(upload?.thumbKey).toBe("bots/boss/uploads/u1/derived/thumb.jpg");
    expect(Object.keys(upload?.derived ?? {})).toContain("frames/1.png");
    const events = db.select().from(tables.conversationEvents).all();
    expect(events.map((event) => event.role)).toEqual(["user", "bot", null]);
    expect(db.$client.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'producao'").all()).toHaveLength(
      1,
    );
    const secret = db
      .select()
      .from(tables.vaultSecrets)
      .all()
      .find((row) => row.name === "login");
    expect(secret?.ciphertext?.byteLength).toBe(3);
    db.$client.close();
  });

  test("reports per-session differences and survives an empty dir", async () => {
    const empty = await legacyCounts(join(dir, "nothing"));
    expect(empty.bots).toBe(0);
    const db = openDatabase(":memory:");
    expect(compareCounts(empty, dbCounts(db))).toEqual([]);
    const report = await importLegacy(db, new FsBlobStore(join(dir, "blobs2")), join(dir, "nothing"));
    expect(report.mismatches).toEqual([]);
    expect(compareCounts({ ...empty, eventsBySession: { s: 2 } }, empty)).toEqual(["events s: legacy 2 db 0"]);
  });

  test("re-uploads a blob whose content changed", async () => {
    const db = openDatabase(join(dir, "a.db"));
    const store = new FsBlobStore(join(dir, "blobs"));
    write("bots/boss/uploads/u1-photo.png", "new-bytes");
    await importLegacy(db, store, join(dir, "data"));
    const row = db
      .select()
      .from(tables.uploads)
      .all()
      .find((item) => item.id === "u1");
    expect(row?.sha256).toBe(new Bun.CryptoHasher("sha256").update("new-bytes").digest("hex"));
    const broken = Object.assign(Object.create(store), { get: async () => null });
    write("bots/boss/uploads/u1-photo.png", "third");
    const report = await importLegacy(db, broken, join(dir, "data"));
    expect(report.uploadFailures.some((failure) => failure.reason.includes("sha256 mismatch"))).toBe(true);
    const throwing = Object.assign(Object.create(store), {
      put: async () => {
        throw "plain";
      },
    });
    write("bots/boss/uploads/u1-photo.png", "fourth");
    expect(
      (await importLegacy(db, throwing, join(dir, "data"))).uploadFailures.some(
        (failure) => failure.reason === "plain",
      ),
    ).toBe(true);
    db.$client.close();
  });

  test("extracts message text", () => {
    expect(messageOf([{ type: "x" }])).toEqual({ role: null, text: null });
    expect(messageOf([{ type: "delivery.consumed", data: {} }])).toEqual({ role: null, text: null });
    expect(factTypes([{ type: "a" }, {}, { type: "b" }])).toBe("a b");
  });
});
