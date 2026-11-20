import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import { type SQL as Query, sql } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { type DatabaseSettings, databaseSettings } from "../config/database";
import { rememberSecretValue } from "../shared/redact";
import { runMigrations } from "./migrate";
import * as tables from "./tables";

export type Root = BunSQLDatabase<typeof tables> & { $client: SQL };
type Transaction = Parameters<Parameters<Root["transaction"]>[0]>[0];
export type Db = Root | Transaction;

export interface OpenOptions {
  migrate?: boolean;
  settings?: DatabaseSettings;
}

const writeLock = 7_310_001;
const scope = new AsyncLocalStorage<Transaction>();

export function connect(settings: DatabaseSettings = databaseSettings()) {
  const password = decodeURIComponent(new URL(settings.url).password);
  if (password) rememberSecretValue("database", password);
  const client = new SQL({
    url: settings.url,
    max: settings.max,
    prepare: settings.prepare,
    tls: settings.tls,
    idleTimeout: 30,
    connectionTimeout: 15,
  });
  return drizzle({ client, schema: tables }) as Root;
}

export async function openDatabase(options: OpenOptions = {}) {
  if (options.migrate !== false) {
    const direct = connect(options.settings ?? databaseSettings(process.env, "direct"));
    try {
      await runMigrations(direct);
    } finally {
      await direct.$client.close();
    }
  }
  return connect(options.settings);
}

let current: Root | null = null;

export function rootDb() {
  current ??= connect();
  return current;
}

export function getDb(): Db {
  return scope.getStore() ?? rootDb();
}

export function useDb(db: Root | null) {
  current = db;
}

export async function initDb() {
  current = await openDatabase();
  return current;
}

export async function closeDb() {
  if (!current) return;
  const db = current;
  current = null;
  await db.$client.close();
}

export async function writeTransaction<T>(run: (tx: Db) => Promise<T> | T, db: Db = getDb()): Promise<T> {
  const active = scope.getStore();
  if (active) return run(active);
  if (!("$client" in db)) return run(db);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${writeLock})`);
    return scope.run(tx, () => run(tx));
  });
}

export async function queryRows<T>(query: Query, db: Db = getDb()): Promise<T[]> {
  return [...(await db.execute(query))] as T[];
}

export { tables };
