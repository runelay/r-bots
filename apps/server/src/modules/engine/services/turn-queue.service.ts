import { getStoredSession, type StoredSession } from "../../conversations/services/sessions.service";
import {
  cancelJob,
  defineJob,
  enqueue,
  getJobView,
  jobPrefix,
  laneCounts,
  listJobs,
  redisCommand,
  setLaneConcurrency,
} from "../../jobs/services/jobs.service";
import type { JobContext } from "../../jobs/types/jobs.types";
import { cancel, type DelegationHooks, type Delivery, runDelivery, sessionBusy, useTurnQueue } from "./engine.service";
import { maxTurns, onSuspendedChange, slotStats } from "./turn-slots.service";

export const turnJobType = "turn.run";
export const busyDelayMs = 400;

export type StoredDelivery = Omit<Delivery, "delegation">;

export interface TurnPayload {
  sessionId: string;
  botId: string;
  deliveryId: string;
  delivery: StoredDelivery;
}

const priorities: Record<Delivery["source"], number> = { delegate: 1, chat: 2, schedule: 3 };
const hooks = new Map<string, DelegationHooks>();
const queued = new Map<string, Set<string>>();
const running = new Map<string, Promise<void>>();
const dropped = new Set<string>();
let unwatch: (() => void) | null = null;

export const turnJobId = (deliveryId: string) => `turn-${deliveryId}`;
const orderKey = (sessionId: string) => `${jobPrefix}:turn-order:${sessionId}`;

function markQueued(sessionId: string, deliveryId: string) {
  const set = queued.get(sessionId) ?? new Set<string>();
  set.add(deliveryId);
  queued.set(sessionId, set);
}

function unmarkQueued(sessionId: string, deliveryId: string) {
  const set = queued.get(sessionId);
  set?.delete(deliveryId);
  if (set?.size === 0) queued.delete(sessionId);
}

export function queuedTurns(sessionId: string) {
  return queued.get(sessionId)?.size ?? 0;
}

async function forget(sessionId: string, deliveryId: string) {
  unmarkQueued(sessionId, deliveryId);
  hooks.delete(deliveryId);
  await redisCommand<number>("lrem", [orderKey(sessionId), 0, deliveryId]);
}

export async function enqueueTurn(session: StoredSession, delivery: Delivery) {
  const { delegation, ...stored } = delivery;
  const sessionId = session.meta.sessionId;
  if (delegation) hooks.set(delivery.deliveryId, delegation);
  markQueued(sessionId, delivery.deliveryId);
  try {
    await redisCommand<number>("rpush", [orderKey(sessionId), delivery.deliveryId]);
    await enqueue<TurnPayload>(
      turnJobType,
      { sessionId, botId: session.meta.botId, deliveryId: delivery.deliveryId, delivery: stored },
      { id: turnJobId(delivery.deliveryId), priority: priorities[delivery.source] },
    );
  } catch (error) {
    unmarkQueued(sessionId, delivery.deliveryId);
    hooks.delete(delivery.deliveryId);
    throw error;
  }
}

async function isHead(sessionId: string, deliveryId: string) {
  for (;;) {
    const head = await redisCommand<string | null>("lindex", [orderKey(sessionId), 0]);
    if (!head || head === deliveryId) return true;
    const view = await getJobView(turnJobId(head));
    if (view && view.status !== "completed" && view.status !== "failed") return false;
    await redisCommand<number>("lrem", [orderKey(sessionId), 0, head]);
  }
}

export async function deliveryHandled(session: StoredSession, deliveryId: string) {
  const lines = await session.log.lines();
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes(deliveryId) || !line.includes('"handled"')) continue;
    const facts = (JSON.parse(line) as { facts?: { type: string; data?: Record<string, unknown> }[] }).facts ?? [];
    if (
      facts.some(
        (fact) =>
          fact.type === "delivery.settled" && fact.data?.deliveryId === deliveryId && fact.data?.outcome === "handled",
      )
    )
      return true;
  }
  return false;
}

export async function runTurnJob(payload: TurnPayload, context: JobContext) {
  const { sessionId, deliveryId } = payload;
  const inflight = running.get(deliveryId);
  if (inflight) return inflight;
  if (dropped.delete(deliveryId) || context.signal.aborted) {
    hooks.get(deliveryId)?.finish({ outcome: "cancelled", reply: "" });
    await forget(sessionId, deliveryId);
    return { skipped: "cancelled" };
  }
  const session = getStoredSession(sessionId);
  if (!session) {
    hooks.get(deliveryId)?.finish({ outcome: "failed", reply: "", error: "A conversa não existe mais." });
    await forget(sessionId, deliveryId);
    return { skipped: "session" };
  }
  if (await deliveryHandled(session, deliveryId)) {
    await forget(sessionId, deliveryId);
    return { skipped: "handled" };
  }
  if (sessionBusy(sessionId) || !(await isHead(sessionId, deliveryId))) return context.defer(busyDelayMs);
  unmarkQueued(sessionId, deliveryId);
  const hook = hooks.get(deliveryId);
  const onAbort = () => cancel(session);
  context.signal.addEventListener("abort", onAbort, { once: true });
  const run = runDelivery(session, { ...payload.delivery, ...(hook ? { delegation: hook } : {}) });
  running.set(deliveryId, run);
  try {
    await run;
  } finally {
    running.delete(deliveryId);
    context.signal.removeEventListener("abort", onAbort);
    await forget(sessionId, deliveryId);
  }
  return { skipped: false };
}

defineJob<TurnPayload>(turnJobType, { lane: "turns", attempts: 1, handler: runTurnJob });

async function dropTurn(deliveryId: string) {
  dropped.add(deliveryId);
  await cancelJob(turnJobId(deliveryId));
}

export async function cancelQueuedTurns(sessionId: string) {
  for (const deliveryId of queued.get(sessionId) ?? []) dropped.add(deliveryId);
  try {
    for (const deliveryId of await redisCommand<string[]>("lrange", [orderKey(sessionId), 0, -1])) {
      if (running.has(deliveryId)) continue;
      await dropTurn(deliveryId);
      hooks.get(deliveryId)?.finish({ outcome: "cancelled", reply: "" });
      await forget(sessionId, deliveryId);
    }
  } catch (error) {
    console.warn(`fila: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function withdrawQueuedTurn(target: DelegationHooks) {
  try {
    for (const [deliveryId, hook] of hooks) {
      if (hook !== target || running.has(deliveryId)) continue;
      const view = await getJobView(turnJobId(deliveryId));
      if (!view || view.status === "completed" || view.status === "failed") return false;
      await dropTurn(deliveryId);
      hook.finish({ outcome: "cancelled", reply: "" });
      await forget(view.ref.sessionId ?? "", deliveryId);
      return true;
    }
  } catch (error) {
    console.warn(`fila: ${error instanceof Error ? error.message : String(error)}`);
  }
  return false;
}

async function rebuildQueued() {
  queued.clear();
  for (const status of ["waiting", "delayed"] as const) {
    const page = await listJobs({ status, queue: "turns", page: 1, pageSize: 10_000 });
    for (const item of page.items)
      if (item.type === turnJobType && item.ref.sessionId && item.ref.deliveryId)
        markQueued(item.ref.sessionId, item.ref.deliveryId);
  }
}

export async function startTurnQueue() {
  useTurnQueue({
    enqueue: enqueueTurn,
    cancelSession: cancelQueuedTurns,
    withdraw: withdrawQueuedTurn,
    queued: queuedTurns,
  });
  unwatch?.();
  unwatch = onSuspendedChange((count) => setLaneConcurrency("turns", maxTurns + count));
  await rebuildQueued();
}

export function stopTurnQueue() {
  useTurnQueue(null);
  unwatch?.();
  unwatch = null;
  hooks.clear();
  queued.clear();
  dropped.clear();
}

export async function turnStats() {
  const slots = slotStats();
  const counts = await laneCounts();
  if (!counts) return { ...slots, failed: 0 };
  let waiting = 0;
  for (const set of queued.values()) waiting += set.size;
  return { running: slots.running, queued: waiting + slots.queued, failed: counts.turns.failed, max: slots.max };
}
