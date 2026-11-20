import { randomUUID } from "node:crypto";
import { asc, inArray, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { jobOutbox } from "../../../db/schema/jobs";
import { ValidationError } from "../../../shared/errors";
import { enqueue, jobsActive } from "./jobs.service";

export interface OutboxJob<T = unknown> {
  type: string;
  payload: T;
  id?: string;
}

export const outboxBatch = 100;

let relayTimer: ReturnType<typeof setTimeout> | null = null;
let relayRunning = false;

export async function enqueueInTx<Q extends PgQueryResultHKT, S extends Record<string, unknown>>(
  tx: PgDatabase<Q, S>,
  job: OutboxJob,
) {
  const id = job.id ?? randomUUID();
  await tx.insert(jobOutbox).values({ id, type: job.type, payload: job.payload });
  return id;
}

export async function relayOutbox<Q extends PgQueryResultHKT, S extends Record<string, unknown>>(
  db: PgDatabase<Q, S>,
  limit = outboxBatch,
) {
  if (!jobsActive()) return 0;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(jobOutbox)
      .where(isNull(jobOutbox.dispatchedAt))
      .orderBy(asc(jobOutbox.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const sent: string[] = [];
    for (const row of rows) {
      try {
        await enqueue(row.type, row.payload, { id: `outbox-${row.id}` });
        sent.push(row.id);
      } catch (error) {
        console.warn(`outbox ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        if (!(error instanceof ValidationError)) break;
        sent.push(row.id);
      }
    }
    if (sent.length > 0)
      await tx.update(jobOutbox).set({ dispatchedAt: new Date().toISOString() }).where(inArray(jobOutbox.id, sent));
    return sent.length;
  });
}

export function startOutboxRelay<Q extends PgQueryResultHKT, S extends Record<string, unknown>>(
  db: PgDatabase<Q, S>,
  intervalMs = 1000,
) {
  stopOutboxRelay();
  relayRunning = true;
  const tick = async () => {
    try {
      while (relayRunning && (await relayOutbox(db)) === outboxBatch) {}
    } catch (error) {
      console.warn(`outbox: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (relayRunning) relayTimer = setTimeout(tick, intervalMs);
  };
  relayTimer = setTimeout(tick, 0);
}

export function stopOutboxRelay() {
  relayRunning = false;
  if (relayTimer) clearTimeout(relayTimer);
  relayTimer = null;
}
