import { startJobs, stopJobs } from "../src/modules/jobs/services/jobs.service";
import type { Lane } from "../src/modules/jobs/types/jobs.types";
import { startRedis, type TestRedis } from "./redis";

export interface TestJobs {
  redis: TestRedis;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startTestJobs(concurrency: Partial<Record<Lane, number>> = { turns: 3, tasks: 2 }) {
  const redis = await startRedis();
  const start = () =>
    startJobs({ settings: redis.settings, concurrency, lockDurationMs: 2000, stalledIntervalMs: 500 });
  await start();
  return {
    redis,
    restart: async () => {
      await stopJobs();
      await start();
    },
    stop: async () => {
      await stopJobs();
      await redis.stop();
    },
  } satisfies TestJobs;
}
