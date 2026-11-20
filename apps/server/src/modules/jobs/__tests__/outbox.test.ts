import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { eq, isNull } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { waitFor } from "../../../../test/engine-helpers";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import { createDatabase, urlFor } from "../../../../test/postgres";
import { jobOutbox } from "../../../db/schema/jobs";
import * as jobsService from "../services/jobs.service";
import { defineJob, getJobView, stopJobs } from "../services/jobs.service";
import { enqueueInTx, outboxBatch, relayOutbox, startOutboxRelay, stopOutboxRelay } from "../services/outbox.service";

setDefaultTimeout(30_000);

let jobs: TestJobs;
let client: SQL;
let db: BunSQLDatabase;
const seen: string[] = [];

defineJob<{ note: string }>("outbox.test", {
  handler: async (payload) => {
    seen.push(payload.note);
  },
});

beforeAll(async () => {
  client = new SQL({ url: urlFor(await createDatabase()), max: 4 });
  db = drizzle({ client });
  await client.unsafe(
    "create table job_outbox (id text primary key, type text not null, payload jsonb not null, created_at timestamp (3) with time zone not null default now(), dispatched_at timestamp (3) with time zone)",
  );
  jobs = await startTestJobs();
});

afterAll(async () => {
  stopOutboxRelay();
  await jobs.stop();
  await client.close();
});

async function pending() {
  return db.select().from(jobOutbox).where(isNull(jobOutbox.dispatchedAt));
}

describe("outbox", () => {
  test("keeps the job only when the transaction commits", async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueInTx(tx, { type: "outbox.test", payload: { note: "desfeito" }, id: "rollback" });
        throw new Error("desfaz");
      }),
    ).rejects.toThrow("desfaz");
    const id = await db.transaction((tx) => enqueueInTx(tx, { type: "outbox.test", payload: { note: "feito" } }));
    expect((await pending()).map((row) => row.id)).toEqual([id]);
    expect(await relayOutbox(db)).toBe(1);
    await waitFor(() => seen.includes("feito"));
    expect(await getJobView(`outbox-${id}`)).toMatchObject({ type: "outbox.test", status: "completed" });
    const [row] = await db.select().from(jobOutbox).where(eq(jobOutbox.id, id));
    expect(row?.dispatchedAt).toBeString();
    expect(seen).not.toContain("desfeito");
  });

  test("drops unknown types, stops at a redis failure and waits while the queue is off", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const original = jobsService.enqueue;
    const refused = spyOn(jobsService, "enqueue").mockImplementation((type, payload, options) =>
      type === "outbox.test" ? Promise.reject(new Error("redis caiu")) : original(type, payload, options),
    );
    try {
      await enqueueInTx(db, { type: "outbox.nenhum", payload: {}, id: "unknown" });
      await enqueueInTx(db, { type: "outbox.test", payload: { note: "depois" }, id: "later" });
      expect(await relayOutbox(db)).toBe(1);
      expect((await pending()).map((row) => row.id)).toEqual(["later"]);
      expect(warn).toHaveBeenCalledWith("outbox later: redis caiu");
      expect(warn).toHaveBeenCalledWith("outbox unknown: Tipo de job desconhecido: outbox.nenhum.");
      refused.mockRestore();
      await stopJobs();
      expect(await relayOutbox(db)).toBe(0);
      await jobs.restart();
      expect(await relayOutbox(db)).toBe(1);
      await waitFor(() => seen.includes("depois"));
    } finally {
      refused.mockRestore();
      warn.mockRestore();
    }
  });

  test("relays in a loop until the outbox is empty and survives a broken database", async () => {
    for (let index = 0; index <= outboxBatch; index++)
      await enqueueInTx(db, { type: "outbox.test", payload: { note: `lote-${index}` }, id: `lote-${index}` });
    startOutboxRelay(db, 10);
    await waitFor(async () => (await pending()).length === 0, 8000);
    await waitFor(() => seen.includes(`lote-${outboxBatch}`), 8000);
    stopOutboxRelay();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const broken = { transaction: () => Promise.reject(new Error("pg fora")) } as unknown as typeof db;
      startOutboxRelay(broken, 10);
      await waitFor(() => warn.mock.calls.filter((call) => call[0] === "outbox: pg fora").length >= 2);
    } finally {
      stopOutboxRelay();
      warn.mockRestore();
    }
  });
});
