import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db, getDb, writeTransaction } from "../../../db";
import { readSetting } from "../../../db/settings";
import { usageBuckets, usageCursors, usageSeen, usageSessions } from "../../../db/tables";

export interface UsageIndexRows {
  version: number;
  files: Record<string, Record<string, unknown>>;
  buckets: Record<string, number[]>;
  sessions: Record<string, [number, string]>;
  seen: Record<string, number>;
}

export interface UsageChanges {
  files: Set<string>;
  buckets: Set<string>;
  sessions: Set<string>;
  seen: Set<string>;
}

export function emptyChanges(): UsageChanges {
  return { files: new Set(), buckets: new Set(), sessions: new Set(), seen: new Set() };
}

export async function loadUsageIndex(db: Db = getDb()): Promise<UsageIndexRows> {
  const index: UsageIndexRows = {
    version: await readSetting("usage.index.version", 1, db),
    files: {},
    buckets: {},
    sessions: {},
    seen: {},
  };
  for (const row of await db.select().from(usageCursors)) index.files[row.path] = row.state;
  for (const row of await db.select().from(usageBuckets))
    index.buckets[`${row.hour}|${row.provider}|${row.model}|${row.tier}`] = row.counters;
  for (const row of await db.select().from(usageSessions)) index.sessions[row.key] = [row.hour, row.model];
  for (const row of await db.select().from(usageSeen)) index.seen[row.key] = row.hour;
  return index;
}

function chunks<T>(items: T[], size = 500) {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

function bucketOf(key: string) {
  const [hour, provider, model, tier] = key.split("|");
  return { hour: Number(hour), provider: String(provider), model: String(model), tier: String(tier ?? "") };
}

export async function saveUsageChanges(index: UsageIndexRows, changes: UsageChanges, db: Db = getDb()) {
  const cursors = [...changes.files].flatMap((path) => (index.files[path] ? [{ path, state: index.files[path] }] : []));
  const buckets = [...changes.buckets].flatMap((key) =>
    index.buckets[key] ? [{ ...bucketOf(key), counters: index.buckets[key] }] : [],
  );
  const goneBuckets = [...changes.buckets].filter((key) => !index.buckets[key]).map(bucketOf);
  const sessions = [...changes.sessions].flatMap((key) => {
    const value = index.sessions[key];
    return value ? [{ key, hour: value[0], model: value[1] }] : [];
  });
  const goneSessions = [...changes.sessions].filter((key) => !index.sessions[key]);
  const seen = [...changes.seen].flatMap((key) =>
    index.seen[key] === undefined ? [] : [{ key, hour: index.seen[key] }],
  );
  const goneSeen = [...changes.seen].filter((key) => index.seen[key] === undefined);
  await writeTransaction(async (tx) => {
    for (const part of chunks(cursors))
      await tx
        .insert(usageCursors)
        .values(part)
        .onConflictDoUpdate({ target: usageCursors.path, set: { state: sql`excluded.state` } });
    for (const part of chunks(buckets))
      await tx
        .insert(usageBuckets)
        .values(part)
        .onConflictDoUpdate({
          target: [usageBuckets.hour, usageBuckets.provider, usageBuckets.model, usageBuckets.tier],
          set: { counters: sql`excluded.counters` },
        });
    for (const bucket of goneBuckets)
      await tx
        .delete(usageBuckets)
        .where(
          and(
            eq(usageBuckets.hour, bucket.hour),
            eq(usageBuckets.provider, bucket.provider),
            eq(usageBuckets.model, bucket.model),
            eq(usageBuckets.tier, bucket.tier),
          ),
        );
    for (const part of chunks(sessions))
      await tx
        .insert(usageSessions)
        .values(part)
        .onConflictDoUpdate({
          target: usageSessions.key,
          set: { hour: sql`excluded.hour`, model: sql`excluded.model` },
        });
    for (const part of chunks(goneSessions)) await tx.delete(usageSessions).where(inArray(usageSessions.key, part));
    for (const part of chunks(seen))
      await tx
        .insert(usageSeen)
        .values(part)
        .onConflictDoUpdate({ target: usageSeen.key, set: { hour: sql`excluded.hour` } });
    for (const part of chunks(goneSeen)) await tx.delete(usageSeen).where(inArray(usageSeen.key, part));
  }, db);
}
