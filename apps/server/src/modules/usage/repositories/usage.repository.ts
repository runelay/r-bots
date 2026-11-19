import { inArray } from "drizzle-orm";
import { type Db, getDb } from "../../../db";
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

export function loadUsageIndex(db: Db = getDb()): UsageIndexRows {
  const index: UsageIndexRows = {
    version: readSetting("usage.index.version", 1, db),
    files: {},
    buckets: {},
    sessions: {},
    seen: {},
  };
  for (const row of db.select().from(usageCursors).all()) index.files[row.path] = row.state;
  for (const row of db.select().from(usageBuckets).all())
    index.buckets[`${row.hour}|${row.provider}|${row.model}|${row.tier}`] = row.counters;
  for (const row of db.select().from(usageSessions).all()) index.sessions[row.key] = [row.hour, row.model];
  for (const row of db.select().from(usageSeen).all()) index.seen[row.key] = row.hour;
  return index;
}

function chunks<T>(items: T[], size = 500) {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

export function saveUsageChanges(index: UsageIndexRows, changes: UsageChanges, db: Db = getDb()) {
  db.$client
    .transaction(() => {
      for (const path of changes.files) {
        const state = index.files[path];
        if (!state) continue;
        db.insert(usageCursors).values({ path, state }).onConflictDoUpdate({ target: usageCursors.path, set: { state } }).run();
      }
      const goneBuckets: string[] = [];
      for (const key of changes.buckets) {
        const counters = index.buckets[key];
        const [hour, provider, model, tier] = key.split("|");
        if (!counters) {
          goneBuckets.push(key);
          continue;
        }
        db.insert(usageBuckets)
          .values({ hour: Number(hour), provider: String(provider), model: String(model), tier: String(tier ?? ""), counters })
          .onConflictDoUpdate({
            target: [usageBuckets.hour, usageBuckets.provider, usageBuckets.model, usageBuckets.tier],
            set: { counters },
          })
          .run();
      }
      for (const key of goneBuckets) {
        const [hour, provider, model, tier] = key.split("|");
        db.$client.run("DELETE FROM usage_buckets WHERE hour = ? AND provider = ? AND model = ? AND tier = ?", [
          Number(hour),
          String(provider),
          String(model),
          String(tier ?? ""),
        ]);
      }
      const goneSessions: string[] = [];
      for (const key of changes.sessions) {
        const value = index.sessions[key];
        if (!value) {
          goneSessions.push(key);
          continue;
        }
        db.insert(usageSessions)
          .values({ key, hour: value[0], model: value[1] })
          .onConflictDoUpdate({ target: usageSessions.key, set: { hour: value[0], model: value[1] } })
          .run();
      }
      for (const part of chunks(goneSessions)) db.delete(usageSessions).where(inArray(usageSessions.key, part)).run();
      const goneSeen: string[] = [];
      for (const key of changes.seen) {
        const hour = index.seen[key];
        if (hour === undefined) {
          goneSeen.push(key);
          continue;
        }
        db.insert(usageSeen).values({ key, hour }).onConflictDoUpdate({ target: usageSeen.key, set: { hour } }).run();
      }
      for (const part of chunks(goneSeen)) db.delete(usageSeen).where(inArray(usageSeen.key, part)).run();
    })
    .immediate();
}
