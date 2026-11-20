import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { freshDb } from "../../../test/db-helpers";
import { createDatabase, settingsFor } from "../../../test/postgres";
import type { Db } from "..";

const dir = mkdtempSync(join(tmpdir(), "rb-db-"));
const db = await import("..");
const { readSetting, writeSetting } = await import("../settings");
const { isoOf, jsonText } = await import("../schema/types");
const search = await import("../search");
const { tables } = db;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = "2026-11-19T10:00:00.123Z";

async function seedConversation(target: Db) {
  await target
    .insert(tables.conversations)
    .values({ sessionId: "s1", botId: "b1", kind: "thread", source: "chat", startedAt: at, updatedAt: at, meta: {} });
}

describe("openDatabase", () => {
  test("migrates a new database once and can skip migrations", async () => {
    const name = await createDatabase();
    const migrated = await db.openDatabase({ settings: settingsFor(name) });
    expect(await db.runMigrations(migrated)).toEqual([]);
    expect(await migrated.select().from(tables.bots)).toEqual([]);
    await migrated.$client.close();
    const bare = await freshDb({ migrate: false });
    const [found] = await db.queryRows<{ name: string | null }>(
      sql`select to_regclass('public.bots')::text as name`,
      bare,
    );
    expect(found.name).toBeNull();
  });

  test("fails on a missing migration file and runs custom migrations in order", async () => {
    const bare = await freshDb({ migrate: false });
    await expect(db.runMigrations(bare, [{ tag: "x", when: 1 }], {})).rejects.toThrow("migration file missing: x");
    const file = join(dir, "one.sql");
    writeFileSync(file, "CREATE TABLE a (id integer);\n--> statement-breakpoint\n\nINSERT INTO a VALUES (1);");
    expect(await db.runMigrations(bare, [{ tag: "one", when: 5 }], { one: file })).toEqual(["one"]);
    expect(await db.runMigrations(bare, [{ tag: "one", when: 5 }], { one: file })).toEqual([]);
    expect(await db.queryRows<{ id: number }>(sql`select id from a`, bare)).toEqual([{ id: 1 }]);
  });
});

describe("search columns", () => {
  test("index message text without accents and follow updates and deletes", async () => {
    const target = await freshDb();
    await seedConversation(target);
    const hits = async (term: string) =>
      (
        await db.queryRows<{ seq: number }>(
          sql`select seq from conversation_events where search @@ to_tsquery('rb_search', ${term})`,
          target,
        )
      ).length;
    await target
      .insert(tables.conversationEvents)
      .values({ sessionId: "s1", seq: 1, at, text: "Produção caiu", facts: [] });
    await target.insert(tables.conversationEvents).values({ sessionId: "s1", seq: 2, at, facts: [] });
    expect(await hits("producao")).toBe(1);
    expect(await hits("PRODUÇÃO")).toBe(1);
    await target
      .update(tables.conversationEvents)
      .set({ text: "outro assunto" })
      .where(eq(tables.conversationEvents.seq, 1));
    expect(await hits("producao")).toBe(0);
    expect(await hits("assunto")).toBe(1);
    await target.delete(tables.conversationEvents);
    expect(await hits("assunto")).toBe(0);
  });

  test("weights note titles over the body", async () => {
    const target = await freshDb();
    await target
      .insert(tables.notes)
      .values({ id: "n1", title: "Reunião", markdown: "pauta da semana", createdAt: at, updatedAt: at });
    const hits = async (query: string) =>
      (
        await db.queryRows<{ id: string }>(
          sql`select id from notes where search @@ to_tsquery('rb_search', ${query})`,
          target,
        )
      ).length;
    expect(await hits("reuniao:*A")).toBe(1);
    expect(await hits("pauta:*A")).toBe(0);
    expect(await hits("pauta:*")).toBe(1);
    await target.update(tables.notes).set({ title: "Ata" }).where(eq(tables.notes.id, "n1"));
    expect(await hits("reuniao:*")).toBe(0);
  });
});

describe("writeTransaction", () => {
  test("commits, rolls back, reuses an open transaction and runs inside a given one", async () => {
    const target = await freshDb();
    await db.writeTransaction(() => seedConversation(target), target);
    await expect(
      db.writeTransaction(async (tx) => {
        await tx.delete(tables.conversations);
        throw new Error("boom");
      }, target),
    ).rejects.toThrow("boom");
    expect(await target.select().from(tables.conversations)).toHaveLength(1);
    const nested = await target.transaction(async (tx) =>
      db.writeTransaction(async (inner) => {
        expect(inner).toBe(tx);
        return 7;
      }, tx),
    );
    expect(nested).toBe(7);
    const outer = await db.writeTransaction(async (tx) =>
      db.writeTransaction(async (inner) => {
        expect(db.getDb()).toBe(tx);
        expect(inner).toBe(tx);
        return 8;
      }),
    );
    expect(outer).toBe(8);
  });
});

describe("shared instance", () => {
  test("opens lazily, can be replaced and closes", async () => {
    const shared = db.rootDb();
    expect(db.getDb()).toBe(shared);
    db.useDb(null);
    const lazy = db.rootDb();
    expect(lazy).not.toBe(shared);
    expect(db.rootDb()).toBe(lazy);
    expect(await db.queryRows<{ one: number }>(sql`select 1 as one`)).toEqual([{ one: 1 }]);
    await db.closeDb();
    await db.closeDb();
    const { forgetSecretValue, redactText } = await import("../../shared/redact");
    expect(redactText(`senha ${new URL(process.env.DATABASE_URL as string).password}`)).toBe("senha ••••");
    forgetSecretValue("database");
    const initialized = await db.initDb();
    expect(db.rootDb()).toBe(initialized);
    await db.closeDb();
    db.useDb(shared);
    expect(db.getDb()).toBe(shared);
  });
});

describe("settings", () => {
  test("reads a fallback, then any json value it wrote", async () => {
    const target = await freshDb();
    expect(await readSetting("k", 3, target)).toBe(3);
    for (const value of [{ a: [1, "x"] }, [1, 2], "texto", 5, true]) {
      await writeSetting("k", value, target);
      expect(await readSetting<unknown>("k", 0, target)).toEqual(value);
    }
  });
});

describe("column helpers", () => {
  test("jsonText keeps text and replaces the NUL escape postgres refuses", () => {
    expect(jsonText({ a: "x\u0000y" })).toBe('{"a":"x\\ufffdy"}');
    expect(jsonText({ a: "literal \\u0000" })).toBe('{"a":"literal \\\\u0000"}');
    expect(isoOf(new Date(at))).toBe(at);
    expect(isoOf("2026-11-19 10:00:00.123+00")).toBe(at);
  });

  test("timestamps and json survive a round trip", async () => {
    const target = await freshDb();
    await seedConversation(target);
    await target
      .insert(tables.conversationEvents)
      .values({ sessionId: "s1", seq: 1, at, facts: [{ type: "x", data: { text: "a\u0000b" } }] });
    const [event] = await target.select().from(tables.conversationEvents);
    expect(event.facts).toEqual([{ type: "x", data: { text: "a\u0000b" } }]);
    await target.insert(tables.settings).values({ key: "nul", value: { text: "a\u0000b" }, updatedAt: at });
    const [row] = await target.select().from(tables.settings).where(eq(tables.settings.key, "nul"));
    expect(row).toEqual({ key: "nul", value: { text: "a�b" }, updatedAt: at });
  });
});

describe("search helpers", () => {
  test("terms, prefix queries and ellipsis around a headline", () => {
    expect(search.searchTerms("  Olá, mundo_novo! ")).toEqual(["olá", "mundo", "novo"]);
    expect(search.prefixQuery(["a", "b"], "A")).toBe("a:*A & b:*A");
    expect(search.headlineOptions(16)).toContain("MaxWords=16");
    const open = search.markers.open;
    const close = search.markers.close;
    expect(search.withEllipsis(`${open}tudo${close}`, "tudo")).toBe(`${open}tudo${close}`);
    expect(search.withEllipsis("", "algo")).toBe("");
    expect(search.withEllipsis(`meio ${open}x${close}`, "começo meio x fim")).toBe(`…meio ${open}x${close}…`);
    expect(search.withEllipsis(`começo ${open}x${close}`, "começo x fim")).toBe(`começo ${open}x${close}…`);
    expect(search.withEllipsis(`${open}x${close} fim`, "começo x fim")).toBe(`…${open}x${close} fim`);
    expect(search.withEllipsis("trecho", "sem relação")).toBe("trecho…");
  });
});

describe("schema", () => {
  test("every foreign key points to a known table", async () => {
    const { getTableConfig, PgTable } = await import("drizzle-orm/pg-core");
    const all = Object.values(tables).filter((value) => value instanceof PgTable);
    const names = new Set(all.map((table) => getTableConfig(table).name));
    for (const table of all) {
      for (const key of getTableConfig(table).foreignKeys) {
        const reference = key.reference();
        expect(names.has(getTableConfig(reference.foreignTable).name)).toBe(true);
        expect(reference.foreignColumns.length).toBeGreaterThan(0);
      }
    }
  });

  test("auth tables build their indexes", async () => {
    const { getTableConfig, PgTable } = await import("drizzle-orm/pg-core");
    const auth = await import("../schema/auth");
    const all = Object.values(auth).filter((value) => value instanceof PgTable);
    expect(all.map((table) => getTableConfig(table).indexes.length).reduce((sum, count) => sum + count, 0)).toBe(11);
    const targets = all.flatMap((table) =>
      getTableConfig(table).foreignKeys.map((key) => getTableConfig(key.reference().foreignTable).name),
    );
    expect(new Set(targets)).toEqual(new Set(["user"]));
  });

  test("ownerId builds a required owner column that follows the user on delete", async () => {
    const { getTableConfig, pgTable } = await import("drizzle-orm/pg-core");
    const { ownerId, user } = await import("../schema/auth");
    const config = getTableConfig(pgTable("owned", { ownerId: ownerId() }));
    expect(config.columns.map((column) => [column.name, column.notNull])).toEqual([["owner_id", true]]);
    const [key] = config.foreignKeys;
    const reference = key.reference();
    expect(reference.foreignTable).toBe(user);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual(["id"]);
    expect(key.onDelete).toBe("cascade");
  });
});
