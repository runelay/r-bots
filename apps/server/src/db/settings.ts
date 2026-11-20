import { eq } from "drizzle-orm";
import { type Db, getDb } from "./client";
import { settings } from "./tables";

export async function readSetting<T>(key: string, fallback: T, db: Db = getDb()): Promise<T> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row ? (row.value as T) : fallback;
}

export async function writeSetting(key: string, value: unknown, db: Db = getDb()) {
  const row = { key, value, updatedAt: new Date().toISOString() };
  await db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row });
}
