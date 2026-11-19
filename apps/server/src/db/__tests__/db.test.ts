import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const dir = mkdtempSync(join(tmpdir(), "rb-db-"));
process.env.BOTS_DB_FILE = join(dir, "shared.db");
const { openDatabase, runMigrations, tables, writeTransaction, getDb, closeDb } = await import("..");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seedConversation(db: ReturnType<typeof openDatabase>) {
  db.insert(tables.conversations)
    .values({ sessionId: "s1", botId: "b1", kind: "thread", source: "chat", startedAt: "t", updatedAt: "t", meta: {} })
    .run();
}

describe("openDatabase", () => {
  test("applies pragmas and migrations once", () => {
    const file = join(dir, "nested", "a.db");
    const db = openDatabase(file);
    expect(db.$client.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.$client.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(runMigrations(db.$client)).toEqual([]);
    db.$client.close();
    const reopened = openDatabase(file, { readonly: true });
    expect(reopened.select().from(tables.bots).all()).toEqual([]);
    reopened.$client.close();
  });

  test("skips migrations when asked", () => {
    const db = openDatabase(":memory:", { migrate: false });
    expect(db.$client.query("SELECT name FROM sqlite_master WHERE name = 'bots'").get()).toBeNull();
  });

  test("fails on a missing migration file", () => {
    const db = openDatabase(":memory:", { migrate: false });
    expect(() => runMigrations(db.$client, [{ tag: "x", when: 1 }], {})).toThrow("migration file missing: x");
  });

  test("runs custom migrations in order", () => {
    const db = openDatabase(":memory:", { migrate: false });
    const file = join(dir, "one.sql");
    writeFileSync(file, "CREATE TABLE a (id integer);\n--> statement-breakpoint\n\nINSERT INTO a VALUES (1);");
    expect(runMigrations(db.$client, [{ tag: "one", when: 5 }], { one: file })).toEqual(["one"]);
    expect(runMigrations(db.$client, [{ tag: "one", when: 5 }], { one: file })).toEqual([]);
  });
});

describe("search", () => {
  test("indexes messages and follows updates and deletes", () => {
    const db = openDatabase(":memory:");
    seedConversation(db);
    const search = (term: string) =>
      db.$client.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(term).length;
    db.insert(tables.conversationEvents)
      .values({ sessionId: "s1", seq: 1, at: "t", text: "Produção caiu", facts: [] })
      .run();
    db.insert(tables.conversationEvents).values({ sessionId: "s1", seq: 2, at: "t", facts: [] }).run();
    expect(search("producao")).toBe(1);
    db.update(tables.conversationEvents)
      .set({ text: "outro assunto" })
      .where(eq(tables.conversationEvents.seq, 1))
      .run();
    expect(search("producao")).toBe(0);
    expect(search("assunto")).toBe(1);
    db.update(tables.conversationEvents).set({ text: "texto novo" }).where(eq(tables.conversationEvents.seq, 2)).run();
    db.delete(tables.conversationEvents).run();
    expect(search("assunto")).toBe(0);
    expect(search("novo")).toBe(0);
  });

  test("indexes live notes only", () => {
    const db = openDatabase(":memory:");
    const search = (term: string) =>
      db.$client.query("SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?").all(term).length;
    db.insert(tables.notes)
      .values({ id: "n1", title: "Reunião", markdown: "pauta", createdAt: "t", updatedAt: "t" })
      .run();
    expect(search("reuniao")).toBe(1);
    db.update(tables.notes).set({ deletedAt: "t" }).where(eq(tables.notes.id, "n1")).run();
    expect(search("reuniao")).toBe(0);
    db.update(tables.notes).set({ deletedAt: null, markdown: "ata" }).where(eq(tables.notes.id, "n1")).run();
    expect(search("ata")).toBe(1);
    db.delete(tables.notes).run();
    expect(search("ata")).toBe(0);
  });
});

describe("writeTransaction", () => {
  test("commits and rolls back", () => {
    const db = openDatabase(":memory:");
    writeTransaction(() => seedConversation(db), db);
    expect(() =>
      writeTransaction(() => {
        db.delete(tables.conversations).run();
        throw new Error("boom");
      }, db),
    ).toThrow("boom");
    expect(db.select().from(tables.conversations).all()).toHaveLength(1);
  });
});

describe("shared instance", () => {
  test("opens lazily and closes", () => {
    const first = getDb();
    expect(getDb()).toBe(first);
    expect(first.$client.filename).toBe(join(dir, "shared.db"));
    expect(writeTransaction(() => 1)).toBe(1);
    closeDb();
    closeDb();
    expect(getDb()).not.toBe(first);
    closeDb();
  });
});

describe("schema", () => {
  test("every foreign key points to a known table", async () => {
    const { getTableConfig, SQLiteTable } = await import("drizzle-orm/sqlite-core");
    const all = Object.values(tables).filter((value) => value instanceof SQLiteTable);
    const names = new Set(all.map((table) => getTableConfig(table).name));
    for (const table of all) {
      for (const key of getTableConfig(table).foreignKeys) {
        const reference = key.reference();
        expect(names.has(getTableConfig(reference.foreignTable).name)).toBe(true);
        expect(reference.foreignColumns.length).toBeGreaterThan(0);
      }
    }
  });
});
