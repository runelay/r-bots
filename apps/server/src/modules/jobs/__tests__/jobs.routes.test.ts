import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { waitFor } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import { defineJob, enqueue, laneCounts, stopJobs } from "../services/jobs.service";
import type { JobPage, JobView } from "../types/jobs.types";

setDefaultTimeout(30_000);

let server: TestServer;
let jobs: TestJobs;
let fixed = false;

defineJob<{ botId: string }>("routes.flaky", {
  attempts: 1,
  handler: async () => {
    if (!fixed) throw new Error("sem sorte");
    return "ok";
  },
});

beforeAll(async () => {
  server = await startTestServer();
  jobs = await startTestJobs();
});

afterAll(async () => {
  await jobs.stop();
  await server.close();
});

describe("/jobs", () => {
  test("lists failed jobs page by page and retries one", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    for (const id of ["r-1", "r-2", "r-3"]) await enqueue("routes.flaky", { botId: "bot-x" }, { id });
    await waitFor(async () => (await laneCounts())?.tasks.failed === 3);
    warn.mockRestore();
    const first = await request<JobPage>("/jobs?status=failed&page=1&pageSize=2");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items[0]).toMatchObject({ type: "routes.flaky", status: "failed", error: "sem sorte" });
    const second = await request<JobPage>("/jobs?page=2&pageSize=2&queue=tasks");
    expect(second.body.items).toHaveLength(1);
    expect((await request<JobPage>("/jobs?status=failed&queue=turns")).body.total).toBe(0);
    fixed = true;
    const retried = await request<{ ok: boolean; job: JobView }>("/jobs/r-1/retry", { method: "POST" });
    expect(retried.status).toBe(202);
    expect(retried.body).toMatchObject({ ok: true, job: { id: "r-1" } });
    await waitFor(async () => (await laneCounts())?.tasks.failed === 2);
    expect((await request<JobPage>("/jobs?status=completed")).body.items.map((item) => item.id)).toContain("r-1");
  });

  test("answers 400 for bad filters, 404 for unknown jobs and routes", async () => {
    expect((await request("/jobs?status=sumido")).status).toBe(400);
    expect((await request("/jobs?queue=outra")).status).toBe(400);
    expect((await request("/jobs?page=0")).status).toBe(400);
    expect((await request("/jobs?pageSize=500")).body).toMatchObject({ field: "pageSize" });
    expect((await request("/jobs?page=1.5")).status).toBe(400);
    expect((await request("/jobs/r-2/retry", { method: "POST", body: "{x" })).status).toBe(202);
    expect((await request("/jobs/r-2/retry", { method: "POST" })).status).toBe(400);
    expect((await request("/jobs/nada/retry", { method: "POST" })).status).toBe(404);
    expect((await request("/jobs/r-2")).status).toBe(404);
  });

  test("answers 503 while the queue is off", async () => {
    await stopJobs();
    const response = await request("/jobs");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: "A fila não está ligada." });
    const english = await request("/jobs", { headers: { "accept-language": "en" } });
    expect(english.body).toEqual({ ok: false, error: "The queue is not on." });
  });
});
