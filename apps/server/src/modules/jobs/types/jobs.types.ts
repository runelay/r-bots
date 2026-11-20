export type Lane = "turns" | "tasks";

export type JobStatus = "active" | "waiting" | "delayed" | "failed" | "completed";

export interface JobContext {
  id: string;
  attempt: number;
  signal: AbortSignal;
  defer: (ms: number) => Promise<never>;
}

export type JobHandler<T> = (payload: T, context: JobContext) => Promise<unknown>;

export interface JobDefinition<T> {
  lane?: Lane;
  attempts?: number;
  backoffMs?: number;
  handler: JobHandler<T>;
}

export interface EnqueueOptions {
  id?: string;
  priority?: number;
  delayMs?: number;
  attempts?: number;
}

export interface JobView {
  id: string;
  queue: Lane;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  ref: Record<string, string>;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface JobPage {
  items: JobView[];
  page: number;
  pageSize: number;
  total: number;
}

export interface LaneCounts {
  running: number;
  queued: number;
  delayed: number;
  failed: number;
}

export interface ScheduleSpec {
  pattern: string;
  timezone?: string;
}

export interface ScheduledJob {
  key: string;
  type: string;
  pattern: string | null;
  timezone: string | null;
  next: string | null;
}
