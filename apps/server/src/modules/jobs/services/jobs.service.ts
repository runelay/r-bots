import { randomUUID } from "node:crypto";
import { DelayedError, type Job, type JobType, Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq";
import { RedisClient } from "bun";
import { type RedisSettings, redisSettings } from "../../../config/redis";
import { ValidationError } from "../../../shared/errors";
import { jobsText } from "../constants/jobs-messages.constants";
import type {
  EnqueueOptions,
  JobContext,
  JobDefinition,
  JobHandler,
  JobPage,
  JobStatus,
  JobView,
  Lane,
  LaneCounts,
  ScheduledJob,
  ScheduleSpec,
} from "../types/jobs.types";

export const jobPrefix = "runelay-bots";
export const lanes: Lane[] = ["turns", "tasks"];
export const jobStatuses: JobStatus[] = ["active", "waiting", "delayed", "failed", "completed"];

const statusTypes: Record<JobStatus, JobType[]> = {
  active: ["active"],
  waiting: ["waiting", "prioritized"],
  delayed: ["delayed"],
  failed: ["failed"],
  completed: ["completed"],
};

const refKeys = ["botId", "sessionId", "deliveryId", "exportId", "uploadId", "scheduleId", "outboxId"];

interface Registered {
  lane: Lane;
  attempts: number;
  backoffMs: number;
  handler: JobHandler<unknown>;
}

interface Runtime {
  queues: Record<Lane, Queue>;
  events: Record<Lane, QueueEvents>;
  workers: Record<Lane, Worker>;
  held: Map<string, { job: Job; token: string }>;
}

export interface StartOptions {
  settings?: RedisSettings;
  concurrency?: Partial<Record<Lane, number>>;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  readyTimeoutMs?: number;
}

const registry = new Map<string, Registered>();
let runtime: Runtime | null = null;

class InlineDefer extends Error {
  constructor(readonly ms: number) {
    super("deferred");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function defineJob<T>(type: string, definition: JobDefinition<T>) {
  registry.set(type, {
    lane: definition.lane ?? "tasks",
    attempts: definition.attempts ?? 5,
    backoffMs: definition.backoffMs ?? 2000,
    handler: definition.handler as JobHandler<unknown>,
  });
}

function definitionOf(type: string) {
  const entry = registry.get(type);
  if (!entry) throw new ValidationError(jobsText("unknownType", { type }), "type");
  return entry;
}

export function jobsActive() {
  return runtime !== null;
}

function requireRuntime() {
  if (!runtime) throw new Error(jobsText("queueOff"));
  return runtime;
}

function connectionOf(settings: RedisSettings) {
  return {
    host: settings.host,
    port: settings.port,
    db: settings.db,
    ...(settings.username ? { username: settings.username } : {}),
    ...(settings.password ? { password: settings.password } : {}),
    ...(settings.tls ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

async function processJob(job: Job, token: string | undefined, signal: AbortSignal | undefined) {
  const entry = registry.get(job.name);
  if (!entry) throw new UnrecoverableError(`Tipo de job desconhecido: ${job.name}`);
  const id = String(job.id);
  const held = runtime?.held;
  if (token) held?.set(id, { job, token });
  const context: JobContext = {
    id,
    attempt: job.attemptsMade + 1,
    signal: signal ?? new AbortController().signal,
    defer: async (ms) => {
      await job.moveToDelayed(Date.now() + ms, token);
      throw new DelayedError();
    },
  };
  try {
    return await entry.handler(job.data, context);
  } finally {
    held?.delete(id);
  }
}

function redisUrl(settings: RedisSettings) {
  const auth = settings.password
    ? `${encodeURIComponent(settings.username ?? "")}:${encodeURIComponent(settings.password)}@`
    : "";
  return `${settings.tls ? "rediss" : "redis"}://${auth}${settings.host}:${settings.port}/${settings.db}`;
}

async function probeRedis(settings: RedisSettings, timeoutMs: number) {
  const client = new RedisClient(redisUrl(settings), {
    connectionTimeout: timeoutMs,
    autoReconnect: false,
    maxRetries: 0,
    enableOfflineQueue: false,
  });
  try {
    await client.connect();
    await client.send("PING", []);
  } catch (error) {
    throw new Error(`Redis não respondeu em ${settings.host}:${settings.port}: ${(error as Error).message}`);
  } finally {
    client.close();
  }
}

export async function startJobs(options: StartOptions = {}) {
  if (runtime) return;
  const settings = options.settings ?? redisSettings();
  await probeRedis(settings, options.readyTimeoutMs ?? 10_000);
  const connection = connectionOf(settings);
  const base = { connection, prefix: jobPrefix };
  const queues = {} as Record<Lane, Queue>;
  const events = {} as Record<Lane, QueueEvents>;
  for (const lane of lanes) {
    queues[lane] = new Queue(lane, {
      ...base,
      defaultJobOptions: {
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 30 * 86_400, count: 5000 },
      },
    });
    events[lane] = new QueueEvents(lane, base);
    queues[lane].on("error", reportWorkerError);
    events[lane].on("error", reportWorkerError);
  }
  await Promise.all(lanes.flatMap((lane) => [queues[lane].waitUntilReady(), events[lane].waitUntilReady()]));
  const held = new Map<string, { job: Job; token: string }>();
  const workers = {} as Record<Lane, Worker>;
  runtime = { queues, events, workers, held };
  for (const lane of lanes) {
    const worker = new Worker(lane, processJob, {
      ...base,
      concurrency: Math.max(1, options.concurrency?.[lane] ?? 1),
      lockDuration: options.lockDurationMs ?? 20_000,
      stalledInterval: options.stalledIntervalMs ?? 10_000,
      maxStalledCount: 2,
    });
    worker.on("failed", (job, error) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
        console.warn(`job ${job.name} ${job.id} foi para os falhos: ${error.message}`);
    });
    worker.on("error", reportWorkerError);
    workers[lane] = worker;
  }
}

export function reportWorkerError(error: Error) {
  console.warn(`fila: ${error.message}`);
}

export async function releaseActiveJobs() {
  if (!runtime) return 0;
  const held = [...runtime.held.values()];
  runtime.held.clear();
  await Promise.allSettled(held.map(({ job, token }) => job.moveToWait(token)));
  return held.length;
}

export async function stopJobs() {
  const current = runtime;
  if (!current) return;
  runtime = null;
  await Promise.all(lanes.map((lane) => current.workers[lane].close(true)));
  await Promise.all(lanes.flatMap((lane) => [current.events[lane].close(), current.queues[lane].close()]));
}

export function setLaneConcurrency(lane: Lane, concurrency: number) {
  if (!runtime) return;
  runtime.workers[lane].concurrency = Math.max(1, Math.floor(concurrency));
}

export function laneConcurrency(lane: Lane) {
  return runtime ? runtime.workers[lane].concurrency : 0;
}

export async function redisCommand<T>(name: string, args: (string | number)[]): Promise<T> {
  const client = await requireRuntime().queues.turns.getBackend().client;
  return (await client.runCommand(name, args)) as T;
}

async function runInline(type: string, payload: unknown, id: string) {
  const entry = definitionOf(type);
  for (;;) {
    try {
      return await entry.handler(payload, {
        id,
        attempt: 1,
        signal: new AbortController().signal,
        defer: (ms) => Promise.reject(new InlineDefer(ms)),
      });
    } catch (error) {
      if (!(error instanceof InlineDefer)) throw error;
      await sleep(error.ms);
    }
  }
}

function jobOptions(entry: Registered, options: EnqueueOptions) {
  return {
    ...(options.id ? { jobId: options.id } : {}),
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.delayMs ? { delay: options.delayMs } : {}),
    attempts: options.attempts ?? entry.attempts,
    backoff: { type: "exponential", delay: entry.backoffMs },
  };
}

export async function enqueue<T>(type: string, payload: T, options: EnqueueOptions = {}) {
  const entry = definitionOf(type);
  if (!runtime) {
    const id = options.id ?? randomUUID();
    void runInline(type, payload, id).catch((error) =>
      console.warn(`job ${type} falhou: ${error instanceof Error ? error.message : String(error)}`),
    );
    return id;
  }
  const job = await runtime.queues[entry.lane].add(type, payload, jobOptions(entry, options));
  return String(job.id);
}

export async function runJob<T>(type: string, payload: T, options: EnqueueOptions & { waitMs: number }) {
  const entry = definitionOf(type);
  if (!runtime) {
    await runInline(type, payload, options.id ?? randomUUID());
    return "done" as const;
  }
  const job = await runtime.queues[entry.lane].add(type, payload, jobOptions(entry, options));
  try {
    await job.waitUntilFinished(runtime.events[entry.lane], options.waitMs);
    return "done" as const;
  } catch (error) {
    if (error instanceof Error && /timed out/i.test(error.message)) return "pending" as const;
    throw error;
  }
}

export async function schedule<T>(key: string, spec: ScheduleSpec, type: string, payload: T) {
  const entry = definitionOf(type);
  await requireRuntime().queues[entry.lane].upsertJobScheduler(
    key,
    { pattern: spec.pattern, ...(spec.timezone ? { tz: spec.timezone } : {}) },
    {
      name: type,
      data: payload,
      opts: { attempts: entry.attempts, backoff: { type: "exponential", delay: entry.backoffMs } },
    },
  );
}

export async function unschedule(key: string) {
  const current = requireRuntime();
  const removed = await Promise.all(lanes.map((lane) => current.queues[lane].removeJobScheduler(key)));
  return removed.some(Boolean);
}

export async function scheduledJobs(): Promise<ScheduledJob[]> {
  const current = requireRuntime();
  const lists = await Promise.all(lanes.map((lane) => current.queues[lane].getJobSchedulers(0, -1, true)));
  return lists.flat().map((item) => ({
    key: item.key,
    type: item.name,
    pattern: item.pattern ?? null,
    timezone: item.tz ?? null,
    next: item.next ? new Date(item.next).toISOString() : null,
  }));
}

function iso(value: number | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function refOf(data: unknown) {
  const ref: Record<string, string> = {};
  if (!data || typeof data !== "object") return ref;
  for (const key of refKeys) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" && value) ref[key] = value;
  }
  return ref;
}

function statusOf(state: string): JobStatus {
  if (state === "active" || state === "delayed" || state === "failed" || state === "completed") return state;
  return "waiting";
}

function viewOf(job: Job, lane: Lane, status: JobStatus): JobView {
  return {
    id: String(job.id),
    queue: lane,
    type: job.name,
    status,
    attempts: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    ref: refOf(job.data),
    createdAt: iso(job.timestamp),
    startedAt: iso(job.processedOn),
    finishedAt: iso(job.finishedOn),
    error: job.failedReason ? job.failedReason.slice(0, 500) : null,
  };
}

async function findJob(id: string) {
  const current = requireRuntime();
  for (const lane of lanes) {
    const job = await current.queues[lane].getJob(id);
    if (job) return { job, lane, status: statusOf(await job.getState()) };
  }
  return null;
}

export async function getJobView(id: string) {
  const found = await findJob(id);
  return found ? viewOf(found.job, found.lane, found.status) : null;
}

export async function cancelJob(id: string) {
  const found = await findJob(id);
  if (!found || found.status === "completed" || found.status === "failed") return false;
  if (found.status === "active") return requireRuntime().workers[found.lane].cancelJob(id, "cancelled");
  await found.job.remove();
  return true;
}

export async function retryJob(id: string) {
  const found = await findJob(id);
  if (!found) return null;
  if (found.status !== "failed") throw new ValidationError(jobsText("retryFailedOnly"), "id");
  await found.job.retry("failed", { resetAttemptsMade: true });
  return getJobView(id);
}

export interface ListOptions {
  status: JobStatus;
  queue?: Lane;
  page: number;
  pageSize: number;
}

export async function listJobs(options: ListOptions): Promise<JobPage> {
  const current = requireRuntime();
  const segments: { lane: Lane; type: JobType; count: number }[] = [];
  for (const lane of options.queue ? [options.queue] : lanes) {
    for (const type of statusTypes[options.status]) {
      segments.push({ lane, type, count: await current.queues[lane].getJobCountByTypes(type) });
    }
  }
  const total = segments.reduce((sum, item) => sum + item.count, 0);
  const items: JobView[] = [];
  let offset = (options.page - 1) * options.pageSize;
  let remaining = options.pageSize;
  for (const segment of segments) {
    if (remaining === 0) break;
    if (offset >= segment.count) {
      offset -= segment.count;
      continue;
    }
    const take = Math.min(remaining, segment.count - offset);
    const jobs = await current.queues[segment.lane].getJobs([segment.type], offset, offset + take - 1, false);
    for (const job of jobs) items.push(viewOf(job, segment.lane, options.status));
    remaining -= take;
    offset = 0;
  }
  return { items, page: options.page, pageSize: options.pageSize, total };
}

export async function laneCounts(): Promise<Record<Lane, LaneCounts> | null> {
  if (!runtime) return null;
  const current = runtime;
  const result = {} as Record<Lane, LaneCounts>;
  for (const lane of lanes) {
    const counts = await current.queues[lane].getJobCounts("active", "waiting", "prioritized", "delayed", "failed");
    result[lane] = {
      running: counts.active ?? 0,
      queued: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  }
  return result;
}
