import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { dbFile } from "../config/storage";
import { runMigrations } from "./migrate";
import * as tables from "./tables";

export type Db = BunSQLiteDatabase<typeof tables> & { $client: Database };

export interface OpenOptions {
  migrate?: boolean;
  readonly?: boolean;
}

const pragmas = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA temp_store = MEMORY",
  "PRAGMA cache_size = -16000",
];

export function openDatabase(file: string = dbFile, options: OpenOptions = {}): Db {
  if (file !== ":memory:" && !options.readonly) mkdirSync(dirname(file), { recursive: true });
  const sqlite = options.readonly
    ? new Database(file, { readonly: true, strict: true })
    : new Database(file, { create: true, strict: true });
  for (const pragma of options.readonly ? pragmas.slice(2) : pragmas) sqlite.run(pragma);
  if (options.migrate !== false && !options.readonly) runMigrations(sqlite);
  return drizzle({ client: sqlite, schema: tables }) as Db;
}

let current: Db | null = null;

export function getDb() {
  current ??= openDatabase();
  return current;
}

export function closeDb() {
  if (!current) return;
  current.$client.run("PRAGMA optimize");
  current.$client.close();
  current = null;
}

export function writeTransaction<T>(run: () => T, db: Db = getDb()): T {
  return db.$client.transaction(run).immediate();
}

export { tables };
