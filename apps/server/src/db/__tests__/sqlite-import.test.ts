import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { freshDb } from "../../../test/db-helpers";
import { queryRows, tables } from "..";
import { user } from "../schema/auth";
import { allTables, convertValue, ImportError, importOrder, importSqlite } from "../sqlite-import";

const at = "2026-11-19T10:00:00.000Z";

function source() {
  const sqlite = new Database(":memory:");
  sqlite.run(
    "CREATE TABLE conversations (session_id TEXT PRIMARY KEY, bot_id TEXT, kind TEXT, title TEXT, source TEXT, schedule_id TEXT, started_at TEXT, updated_at TEXT, archived_at TEXT, unread INTEGER, read_at TEXT, last_message TEXT, turn_count INTEGER, run_count INTEGER, last_seq INTEGER, meta TEXT)",
  );
  sqlite.run(
    "CREATE TABLE conversation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER, at TEXT, types TEXT, role TEXT, text TEXT, facts TEXT)",
  );
  sqlite.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  sqlite.run(
    "CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified INTEGER, image TEXT, role TEXT, banned INTEGER, ban_reason TEXT, ban_expires INTEGER, created_at INTEGER, updated_at INTEGER)",
  );
  sqlite.run(
    "CREATE TABLE vault_secrets (name TEXT PRIMARY KEY, description TEXT, kind TEXT, storage TEXT, touch_id TEXT, domains TEXT, bots TEXT, iv BLOB, tag BLOB, ciphertext BLOB, expires_at TEXT, created_at TEXT, updated_at TEXT, rotated_at TEXT, last_used_at TEXT, last_used_by TEXT, last_tool TEXT)",
  );
  sqlite.run("CREATE TABLE uploads_legacy (id TEXT)");
  sqlite.run(
    `INSERT INTO conversations VALUES ('s1', 'b1', 'thread', 'Oi', 'chat', NULL, '${at}', '${at}', NULL, 2, NULL, '{"role":"user","text":"oi"}', 1, 1, 7, '{"sessionId":"s1"}')`,
  );
  sqlite.run("INSERT INTO conversation_events VALUES (7, 's1', 7, ?, 'delivery.consumed', 'user', ?, ?)", [
    at,
    `a${String.fromCharCode(0)}b`,
    '[{"type":"x","data":{"t":"a\\u0000b"}}]',
  ]);
  sqlite.run("INSERT INTO conversation_events VALUES (3, 's1', 3, '', 'legacy.unparsed', NULL, NULL, '[]')");
  sqlite.run(`INSERT INTO settings VALUES ('nada', 'null', '${at}'), ('k', '{"a":[1,2]}', '${at}')`);
  sqlite.run(
    `INSERT INTO user VALUES ('u1', 'Ana', 'ana@x.com', 1, NULL, 'owner', 0, NULL, NULL, ${Date.parse(at)}, ${Date.parse(at)})`,
  );
  sqlite.run(
    `INSERT INTO vault_secrets VALUES ('k', 'd', 'password', 'server', 'always', '["x.com"]', '[]', x'0102', x'0304', x'0506', NULL, '${at}', '${at}', NULL, NULL, NULL, NULL)`,
  );
  return sqlite;
}

describe("sqlite import", () => {
  test("orders parents first and converts each column type", () => {
    const names = importOrder(allTables()).map((table) => getTableConfig(table).name);
    expect(names.indexOf("conversations")).toBeLessThan(names.indexOf("conversation_events"));
    expect(names.indexOf("user")).toBeLessThan(names.indexOf("session"));
    expect(names).toContain("job_outbox");
    expect(convertValue(user.createdAt, Date.parse(at))).toEqual(new Date(at));
    expect(convertValue(tables.bots.capabilities, "null")).toBeTruthy();
    expect(convertValue(tables.bots.engine, "null")).toBeNull();
    expect(convertValue(tables.uploads.duration, "1.5")).toBe(1.5);
  });

  test("copies every table in one transaction, keeps ids and sequences and refuses to overwrite", async () => {
    const db = await freshDb();
    const sqlite = source();
    const report = await importSqlite(sqlite, db, { batch: 1 });
    expect(report.countsMatch).toBe(true);
    expect(report.tables).toContainEqual({ table: "conversation_events", source: 2, target: 2 });
    expect(report.tables.map((item) => item.table)).not.toContain("uploads_legacy");
    expect(report.skipped).toContain("job_outbox");
    const events = await queryRows<{ id: string; at: Date | null; text: string | null; facts: string }>(
      sql`select id, at, text, facts::text as facts from conversation_events order by id`,
      db,
    );
    expect(events.map((row) => [Number(row.id), row.at, row.text])).toEqual([
      [3, null, null],
      [7, new Date(at), "a�b"],
    ]);
    expect(events[1].facts).toBe('[{"type":"x","data":{"t":"a\\u0000b"}}]');
    const [fresh] = await db
      .insert(tables.conversationEvents)
      .values({ sessionId: "s1", seq: 8, at, facts: [] })
      .returning({ id: tables.conversationEvents.id });
    expect(fresh.id).toBe(8);
    expect(await db.select().from(tables.settings).where(eq(tables.settings.key, "k"))).toEqual([
      { key: "k", value: { a: [1, 2] }, updatedAt: at },
    ]);
    const [owner] = await db.select().from(user);
    expect(owner).toMatchObject({ id: "u1", emailVerified: true, banned: false, createdAt: new Date(at) });
    const [secret] = await db.select().from(tables.vaultSecrets);
    expect([...(secret.ciphertext ?? [])]).toEqual([5, 6]);
    expect(secret.domains).toEqual(["x.com"]);
    await expect(importSqlite(sqlite, db)).rejects.toBeInstanceOf(ImportError);
    const again = await importSqlite(sqlite, db, { replace: true });
    expect(again.tables).toEqual(report.tables);
    expect(await db.select().from(tables.conversationEvents)).toHaveLength(2);
  });

  test("an empty sqlite file writes nothing", async () => {
    const db = await freshDb();
    const report = await importSqlite(new Database(":memory:"), db);
    expect(report).toMatchObject({ tables: [], countsMatch: true });
    expect(report.skipped.length).toBe(allTables().length);
  });
});
