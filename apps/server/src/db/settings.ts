import { eq } from "drizzle-orm";
import { type Db, getDb } from "./client";
import { settings } from "./tables";

export function readSetting<T>(key: string, fallback: T, db: Db = getDb()): T {
  const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  return row ? (row.value as T) : fallback;
}

export function writeSetting(key: string, value: unknown, db: Db = getDb()) {
  const row = { key, value, updatedAt: new Date().toISOString() };
  db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row }).run();
}
