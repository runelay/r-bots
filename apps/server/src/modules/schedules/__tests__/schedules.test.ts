import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { factsOfType, makeBot, waitFor } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import { env } from "../../../config/env";
import * as botsService from "../../bots/services/bots.service";
import * as sessionsService from "../../conversations/services/sessions.service";
import * as threadsService from "../../conversations/services/threads.service";
import { isBusy } from "../../engine/services/engine.service";
import * as jobsService from "../../jobs/services/jobs.service";
import { scheduledJobs } from "../../jobs/services/jobs.service";
import {
  fire,
  fireJobType,
  reloadSchedules,
  runFireJob,
  scheduleKey,
  startScheduler,
} from "../services/scheduler.service";

setDefaultTimeout(30_000);

let server: TestServer;
let jobs: TestJobs;
const restores: Array<() => void> = [];

function track<T extends { mockRestore(): void }>(spy: T) {
  restores.push(() => spy.mockRestore());
  return spy;
}

function quiet() {
  track(spyOn(console, "log").mockImplementation(() => undefined));
}

beforeAll(async () => {
  server = await startTestServer();
  jobs = await startTestJobs();
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

afterAll(async () => {
  await jobs.stop();
  await server.close();
});

const schedule = { name: "diaria", cron: "0 9 * * *", prompt: "Faça o resumo do dia." };

async function settled(sessionId: string) {
  await waitFor(() => !isBusy(sessionId));
}

describe("fire", () => {
  test("delivers the schedule prompt to the bot thread", async () => {
    quiet();
    const bot = await makeBot({ schedules: [schedule] });
    const started = await fire(bot.id, "diaria", "Faça o resumo do dia.");
    expect(started).not.toBeNull();
    const thread = await threadsService.ensureThread(bot.id);
    expect(started?.sessionId).toBe(thread.sessionId);
    await settled(thread.sessionId);
    const session = sessionsService.getStoredSession(thread.sessionId)!;
    const consumed = factsOfType(session, "delivery.consumed");
    expect(consumed.at(-1)?.data).toMatchObject({
      deliveryId: started?.deliveryId,
      source: "schedule",
      scheduleId: "diaria",
    });
  });

  test("returns null when the thread session is gone", async () => {
    quiet();
    const bot = await makeBot();
    track(spyOn(sessionsService, "getStoredSession").mockReturnValue(undefined));
    expect(await fire(bot.id, "x", "y")).toBeNull();
  });
});

function withSchedules(value: "on" | "off") {
  const previous = env.BOTS_SCHEDULES;
  env.BOTS_SCHEDULES = value;
  restores.push(() => {
    env.BOTS_SCHEDULES = previous;
  });
}

async function schedulersOf(botId: string) {
  return (await scheduledJobs()).filter((item) => item.key.startsWith(`schedule.${botId}.`));
}

describe("reloadSchedules", () => {
  test("registers one scheduler per schedule, keeps it on reload and drops stale ones", async () => {
    const log = track(spyOn(console, "log").mockImplementation(() => undefined));
    const bot = await makeBot({ schedules: [schedule] });
    track(spyOn(botsService, "listBots").mockReturnValue([bot]));
    await reloadSchedules();
    const [registered] = await schedulersOf(bot.id);
    expect(registered).toMatchObject({
      key: scheduleKey(bot.id, "diaria"),
      type: fireJobType,
      pattern: "0 9 * * *",
      timezone: bot.schedules[0]?.timezone,
    });
    expect(log.mock.calls.some((call) => String(call[0]).includes(`${scheduleKey(bot.id, "diaria")}@`))).toBe(true);
    const upsert = track(spyOn(jobsService, "schedule"));
    await reloadSchedules();
    expect(upsert).not.toHaveBeenCalled();
    expect(await schedulersOf(bot.id)).toHaveLength(1);
    track(spyOn(botsService, "listBots").mockReturnValue([]));
    await reloadSchedules();
    expect(await schedulersOf(bot.id)).toHaveLength(0);
    expect(log).toHaveBeenCalledWith("schedules loaded: none");
  });

  test("logs an invalid cron and a failed reload without stopping the others", async () => {
    quiet();
    const errors = track(spyOn(console, "error").mockImplementation(() => undefined));
    const bot = await makeBot({ schedules: [schedule] });
    const broken = await makeBot();
    broken.schedules = [{ ...schedule, name: "quebrada", cron: "not a cron", timezone: "UTC", description: "" }];
    track(spyOn(botsService, "listBots").mockReturnValue([bot, broken]));
    await reloadSchedules();
    expect(errors.mock.calls.some((call) => call[0] === `invalid schedule ${broken.id}/quebrada`)).toBe(true);
    expect(await schedulersOf(bot.id)).toHaveLength(1);
    track(spyOn(jobsService, "scheduledJobs").mockRejectedValue(new Error("redis caiu")));
    await reloadSchedules();
    expect(errors.mock.calls.some((call) => call[0] === "schedules not loaded")).toBe(true);
  });

  test("runs the run missed while the server was down once it is back", async () => {
    quiet();
    withSchedules("on");
    const bot = await makeBot({ schedules: [{ ...schedule, cron: "* * * * * *" }] });
    track(spyOn(botsService, "listBots").mockReturnValue([bot]));
    await reloadSchedules();
    const [registered] = await schedulersOf(bot.id);
    await jobs.restart();
    const due = Date.parse(registered?.next ?? "");
    await waitFor(() => Date.now() > due + 1500, 5000);
    const upsert = track(spyOn(jobsService, "schedule"));
    await reloadSchedules();
    expect(upsert).not.toHaveBeenCalled();
    const thread = await waitFor(async () => {
      const state = await threadsService.ensureThread(bot.id);
      const session = sessionsService.getStoredSession(state.sessionId);
      return session && (await factsOfType(session, "delivery.consumed")).length > 0 ? state : null;
    }, 8000);
    track(spyOn(botsService, "listBots").mockReturnValue([]));
    await reloadSchedules();
    await settled(thread.sessionId);
    const session = sessionsService.getStoredSession(thread.sessionId);
    expect((await factsOfType(session!, "delivery.consumed"))[0]?.data).toMatchObject({
      source: "schedule",
      scheduleId: schedule.name,
    });
  });
});

describe("runFireJob", () => {
  test("skips when schedules are off or the schedule is gone", async () => {
    const bot = await makeBot({ schedules: [schedule] });
    withSchedules("off");
    expect(await runFireJob({ botId: bot.id, scheduleId: "diaria" })).toEqual({ skipped: "off" });
    withSchedules("on");
    expect(await runFireJob({ botId: bot.id, scheduleId: "outra" })).toEqual({ skipped: "gone" });
    expect(await runFireJob({ botId: "ninguem", scheduleId: "diaria" })).toEqual({ skipped: "gone" });
  });
});

describe("startScheduler", () => {
  test("does nothing when schedules are off", async () => {
    const log = track(spyOn(console, "log").mockImplementation(() => undefined));
    const changed = track(spyOn(botsService, "onBotsChanged").mockImplementation(() => undefined));
    withSchedules("off");
    await startScheduler();
    expect(log).toHaveBeenCalledWith("schedules off");
    expect(changed).not.toHaveBeenCalled();
  });

  test("loads the schedules and reloads them when bots change", async () => {
    const log = track(spyOn(console, "log").mockImplementation(() => undefined));
    const bot = await makeBot({ schedules: [schedule] });
    track(spyOn(botsService, "listBots").mockReturnValue([bot]));
    let listener: (() => void) | null = null;
    track(
      spyOn(botsService, "onBotsChanged").mockImplementation((next) => {
        listener = next;
      }),
    );
    withSchedules("on");
    await startScheduler();
    const key = scheduleKey(bot.id, "diaria");
    expect(log.mock.calls.some((call) => String(call[0]).includes(`${key}@`))).toBe(true);
    log.mockClear();
    track(spyOn(botsService, "listBots").mockReturnValue([]));
    (listener as unknown as () => void)();
    await waitFor(() => log.mock.calls.some((call) => call[0] === "schedules loaded: none"));
  });
});

describe("POST /bots/:id/schedules/:name/run", () => {
  test("starts the schedule and answers 202", async () => {
    quiet();
    const bot = await makeBot({ schedules: [schedule] });
    const response = await request<{ ok: boolean; sessionId: string; deliveryId: string; scheduleId: string }>(
      `/bots/${bot.id}/schedules/diaria/run`,
      { method: "POST", body: "{broken", headers: { "content-type": "application/json" } },
    );
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, scheduleId: "diaria" });
    expect(typeof response.body.deliveryId).toBe("string");
    await settled(response.body.sessionId);
  });

  test("answers 404 for an unknown schedule or route", async () => {
    const bot = await makeBot({ schedules: [schedule] });
    const missing = await request(`/bots/${bot.id}/schedules/outra/run`, { method: "POST" });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ ok: false, error: "Rotina não encontrada." });
    expect((await request(`/bots/${bot.id}/schedules/diaria/run`)).status).toBe(404);
    expect((await request(`/bots/${bot.id}/schedules/diaria/go`, { method: "POST" })).status).toBe(404);
  });

  test("answers 409 for an archived bot", async () => {
    const bot = await makeBot({ schedules: [schedule] });
    await botsService.setArchived(bot.id, true);
    const response = await request(`/bots/${bot.id}/schedules/diaria/run`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "bot_archived" });
  });

  test("answers 500 when the thread cannot be opened", async () => {
    quiet();
    const bot = await makeBot({ schedules: [schedule] });
    track(spyOn(sessionsService, "getStoredSession").mockReturnValue(undefined));
    const response = await request(`/bots/${bot.id}/schedules/diaria/run`, { method: "POST" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, error: "Não consegui abrir a conversa do bot." });
  });
});
