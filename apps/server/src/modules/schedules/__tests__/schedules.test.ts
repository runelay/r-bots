import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { scheduledJobs } from "croner";
import { factsOfType, makeBot, waitFor } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { env } from "../../../config/env";
import * as botsService from "../../bots/services/bots.service";
import * as sessionsService from "../../conversations/services/sessions.service";
import * as threadsService from "../../conversations/services/threads.service";
import { isBusy } from "../../engine/services/engine.service";
import { fire, reloadSchedules, startScheduler } from "../services/scheduler.service";

let server: TestServer;
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
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

afterAll(async () => {
  const listBots = spyOn(botsService, "listBots").mockReturnValue([]);
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  reloadSchedules();
  log.mockRestore();
  listBots.mockRestore();
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

describe("reloadSchedules", () => {
  test("registers a named job per schedule and fires it on trigger", async () => {
    quiet();
    const bot = await makeBot({ schedules: [schedule] });
    track(spyOn(botsService, "listBots").mockReturnValue([bot]));
    reloadSchedules();
    const job = scheduledJobs.find((item) => item.name === `${bot.id}:diaria`);
    expect(job?.nextRun()).toBeInstanceOf(Date);
    await job!.trigger();
    const thread = await waitFor(async () => {
      const state = await threadsService.ensureThread(bot.id);
      const session = sessionsService.getStoredSession(state.sessionId);
      return session && factsOfType(session, "delivery.consumed").length > 0 ? state : null;
    });
    await settled(thread.sessionId);
    reloadSchedules();
    expect(scheduledJobs.filter((item) => item.name === `${bot.id}:diaria`)).toHaveLength(1);
  });

  test("logs a failed run and an invalid cron without stopping the others", async () => {
    quiet();
    const errors = track(spyOn(console, "error").mockImplementation(() => undefined));
    const bot = await makeBot({ schedules: [schedule] });
    const broken = await makeBot();
    broken.schedules = [{ ...schedule, name: "quebrada", cron: "not a cron", timezone: "UTC", description: "" }];
    track(spyOn(botsService, "listBots").mockReturnValue([bot, broken]));
    reloadSchedules();
    expect(errors.mock.calls.some((call) => call[0] === `invalid schedule ${broken.id}/quebrada`)).toBe(true);
    const failure = new Error("thread indisponível");
    track(spyOn(threadsService, "ensureThread").mockRejectedValue(failure));
    await scheduledJobs.find((item) => item.name === `${bot.id}:diaria`)!.trigger();
    await waitFor(() => errors.mock.calls.some((call) => call[0] === "schedule failed" && call[1] === failure));
  });

  test("logs none when no bot has schedules", () => {
    const log = track(spyOn(console, "log").mockImplementation(() => undefined));
    track(spyOn(botsService, "listBots").mockReturnValue([]));
    reloadSchedules();
    expect(log).toHaveBeenCalledWith("schedules loaded: none");
  });
});

describe("startScheduler", () => {
  test("does nothing when schedules are off", () => {
    const log = track(spyOn(console, "log").mockImplementation(() => undefined));
    const changed = track(spyOn(botsService, "onBotsChanged").mockImplementation(() => undefined));
    startScheduler();
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
    const previous = env.BOTS_SCHEDULES;
    env.BOTS_SCHEDULES = "on";
    try {
      startScheduler();
    } finally {
      env.BOTS_SCHEDULES = previous;
    }
    expect(log.mock.calls.some((call) => String(call[0]).includes(`${bot.id}:diaria@`))).toBe(true);
    expect(listener).not.toBeNull();
    log.mockClear();
    listener!();
    expect(log.mock.calls.some((call) => String(call[0]).includes(`${bot.id}:diaria@`))).toBe(true);
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
