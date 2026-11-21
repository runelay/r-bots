import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { makeBot, newSession, waitFor } from "../../../../test/engine-helpers";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import { rootDb, tables } from "../../../db";
import { findAccount } from "../../accounts/services/accounts.service";
import { engineOf } from "../../bots/services/bots.service";
import { getJobView, stopJobs } from "../../jobs/services/jobs.service";
import { startOutboxRelay, stopOutboxRelay } from "../../jobs/services/outbox.service";
import { queueCapture, runCaptureJob } from "../services/capture-jobs.service";
import * as memory from "../services/memory.service";

setDefaultTimeout(30_000);

let jobs: TestJobs;
const restores: Array<() => void> = [];

beforeAll(async () => {
  jobs = await startTestJobs();
  await rootDb().delete(tables.jobOutbox);
  startOutboxRelay(rootDb(), 20);
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

afterAll(async () => {
  stopOutboxRelay();
  await jobs.stop();
});

async function input() {
  const bot = await makeBot();
  const session = await newSession(bot.id);
  const account = await findAccount(engineOf(bot).account);
  if (!account) throw new Error("conta de teste ausente");
  return {
    bot,
    account,
    session,
    value: {
      bot,
      account,
      model: "modelo",
      userText: "prefiro tabelas",
      replyText: "anotado",
      recalled: [{ slug: "rb-x", name: "X", description: "d" }],
      log: session.log,
      turnId: "turn_0",
      sessionId: session.meta.sessionId,
    },
  };
}

describe("memory capture job", () => {
  test("captures through the queue with the bot, account and log rebuilt from ids", async () => {
    const capture = spyOn(memory, "capture").mockResolvedValue(undefined);
    restores.push(() => capture.mockRestore());
    const { bot, account, session, value } = await input();
    await queueCapture(value);
    await waitFor(() => capture.mock.calls.length === 1);
    const [received] = capture.mock.calls[0] ?? [];
    expect(received).toMatchObject({
      model: "modelo",
      userText: "prefiro tabelas",
      replyText: "anotado",
      recalled: value.recalled,
      turnId: "turn_0",
    });
    expect(received?.bot.id).toBe(bot.id);
    expect(received?.account.id).toBe(account.id);
    expect(received?.log).toBe(session.log);
    const dispatched = async () =>
      (await rootDb().select().from(tables.jobOutbox).where(eq(tables.jobOutbox.type, "memory.capture"))).some(
        (row) => row.dispatchedAt !== null && (row.payload as { turnId?: string }).turnId === "turn_0",
      );
    expect(await waitFor(dispatched)).toBe(true);
  });

  test("retries when the capture fails and skips what no longer exists", async () => {
    const capture = spyOn(memory, "capture")
      .mockRejectedValueOnce(new Error("runelay fora"))
      .mockResolvedValue(undefined);
    restores.push(() => capture.mockRestore());
    const { value } = await input();
    await queueCapture(value);
    await waitFor(() => capture.mock.calls.length === 2, 8000);
    const payload = {
      botId: value.bot.id,
      accountId: value.account.id,
      model: "m",
      userText: "a",
      replyText: "b",
      recalled: [],
      sessionId: "wrun_sumiu",
      turnId: "turn_0",
    };
    expect(await runCaptureJob(payload)).toEqual({ skipped: true });
    expect(await runCaptureJob({ ...payload, botId: "ninguem" })).toEqual({ skipped: true });
    expect(await runCaptureJob({ ...payload, accountId: "conta:nenhuma" })).toEqual({ skipped: true });
    expect(await getJobView("nada")).toBeNull();
  });

  test("carries the reaction feedback through the job", async () => {
    const capture = spyOn(memory, "capture").mockResolvedValue(undefined);
    restores.push(() => capture.mockRestore());
    const { value } = await input();
    await queueCapture({ ...value, turnId: "reaction_run_0.0", feedback: "👍" });
    await waitFor(() => capture.mock.calls.some(([call]) => call.turnId === "reaction_run_0.0"), 8000);
    const call = capture.mock.calls.find(([item]) => item.turnId === "reaction_run_0.0")?.[0];
    expect(call?.feedback).toBe("👍");
  });

  test("captures in process while the queue is off", async () => {
    const capture = spyOn(memory, "capture").mockResolvedValue(undefined);
    restores.push(() => capture.mockRestore());
    await stopJobs();
    const { value } = await input();
    await queueCapture(value);
    expect(capture).toHaveBeenCalledWith(value);
    await jobs.restart();
  });
});
