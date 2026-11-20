import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Queue } from "bullmq";
import { waitFor } from "../../../../test/engine-helpers";
import { startRedis, type TestRedis } from "../../../../test/redis";
import { ValidationError } from "../../../shared/errors";
import {
  cancelJob,
  defineJob,
  enqueue,
  getJobView,
  jobPrefix,
  jobsActive,
  laneConcurrency,
  laneCounts,
  listJobs,
  redisCommand,
  releaseActiveJobs,
  reportWorkerError,
  retryJob,
  runJob,
  schedule,
  scheduledJobs,
  setLaneConcurrency,
  startJobs,
  stopJobs,
  unschedule,
} from "../services/jobs.service";

setDefaultTimeout(30_000);

let redis: TestRedis;
const ran: string[] = [];
const deferred = new Set<string>();
const blockers: Array<(value: string) => void> = [];
const starts: string[] = [];
let brokenFixed = false;
const restores: Array<() => void> = [];

defineJob<{ n: number; botId?: string }>("test.double", { handler: async (payload) => payload.n * 2 });
defineJob<Record<string, never>>("test.flaky", {
  attempts: 3,
  backoffMs: 10,
  handler: async (_payload, context) => {
    if (context.attempt < 3) throw new Error(`falhou ${context.attempt}`);
    return context.attempt;
  },
});
defineJob<Record<string, never>>("test.broken", {
  attempts: 2,
  backoffMs: 10,
  handler: async () => {
    if (!brokenFixed) throw new Error("quebrado");
    return "ok";
  },
});
defineJob<{ ms: number }>("test.defer", {
  handler: async (payload, context) => {
    if (!deferred.has(context.id)) {
      deferred.add(context.id);
      return context.defer(payload.ms);
    }
    ran.push(`defer:${context.id}`);
  },
});
defineJob<Record<string, never>>("test.lane", {
  lane: "turns",
  handler: (_payload, context) =>
    new Promise((resolve) => {
      starts.push(context.id);
      context.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    }),
});
defineJob<Record<string, never>>("test.block", {
  handler: (_payload, context) =>
    new Promise((resolve) => {
      starts.push(context.id);
      blockers.push(resolve);
      context.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    }),
});

function quietWarn() {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  restores.push(() => warn.mockRestore());
  return warn;
}

beforeAll(async () => {
  redis = await startRedis();
  await startJobs({
    settings: redis.settings,
    concurrency: { turns: 1, tasks: 2 },
    lockDurationMs: 2000,
    stalledIntervalMs: 1000,
  });
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

afterAll(async () => {
  for (const release of blockers.splice(0)) release("done");
  await stopJobs();
  await redis.stop();
});

describe("jobs on redis", () => {
  test("starts once, reports and changes the concurrency per lane", async () => {
    await startJobs({ settings: redis.settings });
    expect(jobsActive()).toBe(true);
    expect(laneConcurrency("tasks")).toBe(2);
    setLaneConcurrency("tasks", 3.7);
    expect(laneConcurrency("tasks")).toBe(3);
    setLaneConcurrency("tasks", 0);
    expect(laneConcurrency("tasks")).toBe(1);
    setLaneConcurrency("tasks", 2);
    expect(await redisCommand<string>("ping", [])).toBe("PONG");
  });

  test("runs a job and waits for it to finish", async () => {
    expect(await runJob("test.double", { n: 2, botId: "bot-a" }, { id: "double-1", waitMs: 5000 })).toBe("done");
    const view = await getJobView("double-1");
    expect(view).toMatchObject({ queue: "tasks", type: "test.double", status: "completed", ref: { botId: "bot-a" } });
    expect(view?.finishedAt).toBeString();
  });

  test("retries with exponential backoff until the job works", async () => {
    expect(await runJob("test.flaky", {}, { id: "flaky-1", waitMs: 5000 })).toBe("done");
    expect(await getJobView("flaky-1")).toMatchObject({ status: "completed", attempts: 3, maxAttempts: 3 });
  });

  test("sends exhausted jobs to the failed list, pages it and retries one", async () => {
    const warn = quietWarn();
    await expect(runJob("test.broken", {}, { id: "broken-0", waitMs: 5000 })).rejects.toThrow("quebrado");
    for (const id of ["broken-1", "broken-2"]) await enqueue("test.broken", {}, { id });
    await waitFor(async () => (await laneCounts())?.tasks.failed === 3, 8000);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("foi para os falhos"))).toBe(true);
    const first = await listJobs({ status: "failed", page: 1, pageSize: 2 });
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toMatchObject({ status: "failed", attempts: 2, maxAttempts: 2, error: "quebrado" });
    const second = await listJobs({ status: "failed", page: 2, pageSize: 2 });
    expect(second.items).toHaveLength(1);
    expect((await listJobs({ status: "failed", queue: "turns", page: 1, pageSize: 5 })).total).toBe(0);
    expect((await listJobs({ status: "failed", page: 3, pageSize: 2 })).items).toEqual([]);
    brokenFixed = true;
    const retried = await retryJob("broken-1");
    expect(retried?.id).toBe("broken-1");
    await waitFor(async () => (await getJobView("broken-1"))?.status === "completed");
    expect(await retryJob("missing")).toBeNull();
    await expect(retryJob("broken-1")).rejects.toBeInstanceOf(ValidationError);
  });

  test("returns pending when the wait runs out and cancels an active job through its signal", async () => {
    expect(await runJob("test.block", {}, { id: "block-1", waitMs: 50 })).toBe("pending");
    await waitFor(async () => (await getJobView("block-1"))?.status === "active");
    expect((await laneCounts())?.tasks.running).toBe(1);
    expect(await cancelJob("block-1")).toBe(true);
    await waitFor(async () => (await getJobView("block-1"))?.status === "completed");
  });

  test("removes a waiting job and keeps finished ones", async () => {
    await enqueue("test.double", { n: 1 }, { id: "later", delayMs: 60_000, priority: 3 });
    expect((await listJobs({ status: "delayed", page: 1, pageSize: 10 })).items.map((item) => item.id)).toContain(
      "later",
    );
    expect(await cancelJob("later")).toBe(true);
    expect(await getJobView("later")).toBeNull();
    await enqueue("test.lane", {}, { id: "lane-1" });
    await enqueue("test.lane", {}, { id: "lane-2", priority: 2 });
    await waitFor(() => starts.includes("lane-1"));
    expect((await getJobView("lane-2"))?.status).toBe("waiting");
    expect((await listJobs({ status: "waiting", queue: "turns", page: 1, pageSize: 5 })).total).toBe(1);
    expect(await cancelJob("lane-2")).toBe(true);
    expect(await cancelJob("lane-1")).toBe(true);
    await waitFor(async () => (await getJobView("lane-1"))?.status === "completed");
    expect(await cancelJob("double-1")).toBe(false);
    expect(await cancelJob("nope")).toBe(false);
  });

  test("defers a job and runs it again later", async () => {
    await enqueue("test.defer", { ms: 20 }, { id: "defer-1" });
    await waitFor(() => ran.includes("defer:defer-1"));
  });

  test("fails a job whose type has no handler and refuses to enqueue it", async () => {
    const raw = new Queue("tasks", {
      connection: {
        host: redis.settings.host,
        port: redis.settings.port,
        password: redis.settings.password,
        maxRetriesPerRequest: null,
      },
      prefix: jobPrefix,
    });
    await raw.add("ghost", "texto", { jobId: "ghost-1" });
    await raw.close();
    await waitFor(async () => (await getJobView("ghost-1"))?.status === "failed");
    expect(await getJobView("ghost-1")).toMatchObject({ error: "Tipo de job desconhecido: ghost", ref: {} });
    await expect(enqueue("ghost", {})).rejects.toBeInstanceOf(ValidationError);
  });

  test("schedules, lists and removes repeatable jobs", async () => {
    await schedule("rep-utc", { pattern: "0 0 1 1 *", timezone: "UTC" }, "test.double", { n: 1 });
    await schedule("rep-local", { pattern: "0 0 1 1 *" }, "test.double", { n: 1 });
    const listed = await scheduledJobs();
    expect(listed.find((item) => item.key === "rep-utc")).toMatchObject({
      type: "test.double",
      pattern: "0 0 1 1 *",
      timezone: "UTC",
    });
    expect(listed.find((item) => item.key === "rep-local")?.timezone).toBeNull();
    expect(listed.find((item) => item.key === "rep-utc")?.next).toBeString();
    expect(await unschedule("rep-utc")).toBe(true);
    expect(await unschedule("rep-utc")).toBe(false);
    await unschedule("rep-local");
  });

  test("puts the held jobs back in line on shutdown", async () => {
    const warn = quietWarn();
    await enqueue("test.block", {}, { id: "block-2" });
    await waitFor(async () => (await getJobView("block-2"))?.status === "active");
    expect(await releaseActiveJobs()).toBe(1);
    expect(await releaseActiveJobs()).toBe(0);
    await waitFor(() => starts.filter((id) => id === "block-2").length === 2);
    expect(await cancelJob("block-2")).toBe(true);
    for (const release of blockers.splice(0)) release("done");
    await waitFor(async () => (await laneCounts())?.tasks.running === 0);
    warn.mockRestore();
  });

  test("logs worker errors", () => {
    const warn = quietWarn();
    reportWorkerError(new Error("conexão caiu"));
    expect(warn).toHaveBeenCalledWith("fila: conexão caiu");
  });
});

describe("jobs without redis", () => {
  test("runs handlers inline once, logs failures and handles defer", async () => {
    await stopJobs();
    await stopJobs();
    expect(jobsActive()).toBe(false);
    expect(await laneCounts()).toBeNull();
    expect(await releaseActiveJobs()).toBe(0);
    expect(laneConcurrency("turns")).toBe(0);
    setLaneConcurrency("turns", 5);
    await expect(scheduledJobs()).rejects.toThrow("A fila não está ligada.");
    expect(await runJob("test.double", { n: 1 }, { waitMs: 10 })).toBe("done");
    expect(await enqueue("test.defer", { ms: 5 }, { id: "inline-defer" })).toBe("inline-defer");
    await waitFor(() => ran.includes("defer:inline-defer"));
    brokenFixed = false;
    const warn = quietWarn();
    expect(await enqueue("test.broken", {})).toBeString();
    await waitFor(() => warn.mock.calls.some((call) => call[0] === "job test.broken falhou: quebrado"));
  });

  test("gives up when redis does not answer", async () => {
    await stopJobs();
    const warn = quietWarn();
    await expect(
      startJobs({ settings: { host: "127.0.0.1", port: 9, db: 0, tls: false }, readyTimeoutMs: 200 }),
    ).rejects.toThrow("Redis não respondeu em 127.0.0.1:9");
    expect(jobsActive()).toBe(false);
    warn.mockRestore();
  });
});
