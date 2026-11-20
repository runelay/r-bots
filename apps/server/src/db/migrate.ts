import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Root } from "./client";
import { journal, migrationFiles } from "./migrations";

export interface JournalEntry {
  tag: string;
  when: number;
}

const migrateLock = 7_310_002;

export async function runMigrations(
  db: Root,
  entries: JournalEntry[] = journal.entries,
  files: Record<string, string> = migrationFiles,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${migrateLock})`);
    await tx.execute(
      sql`create table if not exists "__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`,
    );
    const [last] = await tx.execute<{ created_at: string }>(
      sql`select created_at from "__drizzle_migrations" order by created_at desc limit 1`,
    );
    const pending = entries.filter((entry) => !last || Number(last.created_at) < entry.when);
    for (const entry of pending) {
      const path = files[entry.tag];
      if (!path) throw new Error(`migration file missing: ${entry.tag}`);
      const query = readFileSync(path, "utf8");
      for (const statement of query.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      await tx.execute(
        sql`insert into "__drizzle_migrations" (hash, created_at) values (${createHash("sha256").update(query).digest("hex")}, ${entry.when})`,
      );
    }
    return pending.map((entry) => entry.tag);
  });
}
