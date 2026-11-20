import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { apikey, device, session, user } from "../../../db/schema/auth";

type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export const deviceKeyLifetimeMs = 180 * 24 * 60 * 60_000;
export const deviceKeyRefreshMs = 30 * 24 * 60 * 60_000;

export interface DeviceRow {
  id: string;
  apiKeyId: string;
  userId: string;
  name: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  machineId: string | null;
  registeredAt: Date;
  createdAt: Date;
}

export function createDeviceRepository(db: Database) {
  async function byApiKey(apiKeyId: string): Promise<DeviceRow | null> {
    const [row] = await db.select().from(device).where(eq(device.apiKeyId, apiKeyId)).limit(1);
    return row ?? null;
  }

  async function list(userId?: string): Promise<DeviceRow[]> {
    const query = db.select().from(device);
    const rows = userId ? await query.where(eq(device.userId, userId)) : await query;
    return [...rows].sort((a, b) => a.registeredAt.getTime() - b.registeredAt.getTime() || a.id.localeCompare(b.id));
  }

  async function roles() {
    const rows = await db
      .select({ id: device.id, role: user.role })
      .from(device)
      .innerJoin(user, eq(user.id, device.userId));
    return new Map(rows.map((row) => [row.id, row.role ?? ""]));
  }

  async function byMachine(userId: string, machineId: string) {
    return db
      .select()
      .from(device)
      .where(and(eq(device.userId, userId), eq(device.machineId, machineId)))
      .orderBy(asc(device.registeredAt));
  }

  async function insert(row: DeviceRow) {
    await db.insert(device).values(row);
  }

  async function remove(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await db.select().from(device).where(inArray(device.id, ids));
    const keys = rows.map((row) => row.apiKeyId);
    if (keys.length > 0) await db.delete(apikey).where(inArray(apikey.id, keys));
    await db.delete(device).where(inArray(device.id, ids));
    return rows;
  }

  async function touchKey(apiKeyId: string, now = Date.now()) {
    const threshold = new Date(now + deviceKeyLifetimeMs - deviceKeyRefreshMs);
    const updated = await db
      .update(apikey)
      .set({ expiresAt: new Date(now + deviceKeyLifetimeMs) })
      .where(and(eq(apikey.id, apiKeyId), or(isNull(apikey.expiresAt), lt(apikey.expiresAt, threshold))))
      .returning({ id: apikey.id });
    return updated.length > 0;
  }

  async function revokeUser(userId: string) {
    await db.delete(session).where(eq(session.userId, userId));
    await db.delete(apikey).where(eq(apikey.referenceId, userId));
    const removed = await db.delete(device).where(eq(device.userId, userId)).returning({ id: device.id });
    return removed.map((row) => row.id);
  }

  return { byApiKey, list, roles, byMachine, insert, remove, touchKey, revokeUser };
}

export type DeviceRepository = ReturnType<typeof createDeviceRepository>;
