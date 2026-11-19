import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { journal, migrationFiles } from "./migrations";

export interface JournalEntry {
  tag: string;
  when: number;
}

export function runMigrations(
  sqlite: Database,
  entries: JournalEntry[] = journal.entries,
  files: Record<string, string> = migrationFiles,
) {
  sqlite.run(
    "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  const last = sqlite
    .query<{ created_at: number }, []>("SELECT created_at FROM `__drizzle_migrations` ORDER BY created_at DESC LIMIT 1")
    .get();
  const pending = entries.filter((entry) => !last || Number(last.created_at) < entry.when);
  if (!pending.length) return [];
  sqlite
    .transaction(() => {
      for (const entry of pending) {
        const path = files[entry.tag];
        if (!path) throw new Error(`migration file missing: ${entry.tag}`);
        const query = readFileSync(path, "utf8");
        for (const statement of query.split("--> statement-breakpoint")) {
          if (statement.trim()) sqlite.run(statement);
        }
        sqlite.run("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [
          createHash("sha256").update(query).digest("hex"),
          entry.when,
        ]);
      }
    })
    .immediate();
  return pending.map((entry) => entry.tag);
}
