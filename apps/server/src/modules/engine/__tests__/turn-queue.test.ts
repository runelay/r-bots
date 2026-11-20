import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { factsOfType, makeBot, newSession, waitFor } from "../../../../test/engine-helpers";
import {
  byBot,
  contextOf,
  hold,
  idle,
  quietEngine,
  restoreTracked,
  send,
  track,
} from "../../../../test/engine-turn-helpers";
import { fakeProviders } from "../../../../test/helpers";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import * as conversations from "../../conversations/services/conversations.service";
import * as jobsService from "../../jobs/services/jobs.service";
import {
  cancelJob,
  enqueue,
  getJobView,
  jobPrefix,
  laneConcurrency,
  redisCommand,
} from "../../jobs/services/jobs.service";
import type { JobContext } from "../../jobs/types/jobs.types";
import { cancel, conversationStatus, type DelegationHooks, deliver, isBusy } from "../services/engine.service";
import {
  cancelQueuedTurns,
  deliveryHandled,
  queuedTurns,
  runTurnJob,
  startTurnQueue,
  stopTurnQueue,
  turnJobId,
  turnJobType,
  turnStats,
  withdrawQueuedTurn,
} from "../services/turn-queue.service";
import { acquireTurnSlot, maxTurns } from "../services/turn-slots.service";

setDefaultTimeout(30_000);

let jobs: TestJobs;

function context(id = "manual"): JobContext {
  return {
    id,
    attempt: 1,
    signal: new AbortController().signal,
    defer: () => Promise.reject(new Error("defer")),
  };
}

function hooks() {
  const results: string[] = [];
  const value: DelegationHooks = {
    onStart: () => undefined,
    onAwaiting: () => undefined,
    finish: (result) => results.push(result.outcome),
  };
  return { value, results };
}

async function consumedIds(session: Parameters<typeof factsOfType>[0]) {
  return (await factsOfType(session, "delivery.consumed")).map((fact) => String(fact.data.deliveryId));
}

beforeAll(async () => {
  jobs = await startTestJobs({ turns: maxTurns, tasks: 2 });
  await startTurnQueue();
});

beforeEach(() => {
  quietEngine();
});

afterEach(() => {
  restoreTracked();
});

async function drained() {
  await waitFor(async () => {
    const counts = await jobsService.laneCounts();
    return counts !== null && counts.turns.running + counts.turns.queued + counts.turns.delayed === 0;
  }, 8000);
}

afterAll(async () => {
  await drained();
  stopTurnQueue();
  await jobs.stop();
});

describe("turn queue", () => {
  test("runs the turns of a conversation one by one, in order, through redis", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const first = hold();
    fakeProviders.next(first.script);
    const sent = [send(session, { text: "um" })];
    await first.started;
    fakeProviders.next((turn) => {
      turn.emit({ type: "done", ok: true });
    });
    sent.push(send(session, { text: "dois" }), send(session, { text: "três" }));
    await waitFor(() => queuedTurns(session.meta.sessionId) === 2);
    expect(isBusy(session.meta.sessionId)).toBe(true);
    const stats = await turnStats();
    expect(stats.running).toBe(1);
    expect(stats.queued).toBeGreaterThanOrEqual(2);
    expect(stats.max).toBe(maxTurns);
    first.release();
    await idle(session);
    expect(await consumedIds(session)).toEqual(sent.map((item) => item.deliveryId));
    expect(await deliveryHandled(session, sent[0].deliveryId)).toBe(true);
    expect(await deliveryHandled(session, "outro")).toBe(false);
    expect(await runTurnJob({ ...payloadOf(session, sent[0]) }, context())).toEqual({ skipped: "handled" });
  });

  test("marks a conversation as queued while every slot is busy and lifts the limit for suspended slots", async () => {
    const bot = await makeBot();
    const holds = [hold(), hold(), hold()];
    let index = 0;
    fakeProviders.next((turn) => holds[Math.min(index++, holds.length - 1)].script(turn));
    const busy = await Promise.all(Array.from({ length: maxTurns }, () => newSession(bot.id)));
    for (const session of busy) send(session);
    await Promise.all(holds.map((item) => item.started));
    const waiting = await newSession(bot.id);
    fakeProviders.next((turn) => {
      turn.emit({ type: "done", ok: true });
    });
    send(waiting);
    await waitFor(() => queuedTurns(waiting.meta.sessionId) === 1);
    expect(conversationStatus(waiting.meta.sessionId)).toBe("queued");
    const slot = await acquireTurnSlot("voice", new AbortController().signal, () => undefined);
    slot.suspend();
    expect(laneConcurrency("turns")).toBe(maxTurns + 1);
    slot.resume();
    expect(laneConcurrency("turns")).toBe(maxTurns);
    slot.release();
    for (const item of holds) item.release();
    for (const session of [...busy, waiting]) await idle(session);
    expect(conversationStatus(waiting.meta.sessionId)).toBe("idle");
  });

  test("hands the running promise back when the same delivery is picked twice", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const held = hold();
    fakeProviders.next(held.script);
    const sent = send(session);
    await held.started;
    const again = runTurnJob(payloadOf(session, sent), context());
    held.release();
    await again;
    await idle(session);
    expect(await consumedIds(session)).toEqual([sent.deliveryId]);
  });

  test("skips a conversation that is gone and tells the delegation", async () => {
    const delegation = hooks();
    const bot = await makeBot();
    const session = await newSession(bot.id);
    fakeProviders.next(hold().script);
    const sent = send(session, { delegation: delegation.value, source: "delegate" });
    await waitFor(() => fakeProviders.turns.length > 0);
    cancel(session);
    await idle(session);
    expect(
      await runTurnJob(
        { sessionId: "wrun_nenhuma", botId: bot.id, deliveryId: "sem-conversa", delivery: { ...sent } },
        context(),
      ),
    ).toEqual({ skipped: "session" });
  });

  test("cancelling a conversation drops its queued turns and finishes their delegations", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const held = hold();
    fakeProviders.next(held.script);
    send(session);
    await held.started;
    const delegation = hooks();
    send(session, { source: "delegate", delegation: delegation.value });
    send(session);
    await waitFor(() => queuedTurns(session.meta.sessionId) === 2);
    cancel(session);
    await waitFor(() => queuedTurns(session.meta.sessionId) === 0 && delegation.results.length === 1);
    await idle(session);
    expect(delegation.results).toEqual(["cancelled"]);
    expect((await factsOfType(session, "turn.settled")).map((fact) => fact.data.outcome)).toEqual(["cancelled"]);
  });

  test("cancelling the job stops the turn through its signal", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const held = hold();
    fakeProviders.next(held.script);
    const sent = send(session);
    await held.started;
    expect(await cancelJob(turnJobId(sent.deliveryId))).toBe(true);
    await idle(session);
    expect((await factsOfType(session, "turn.settled")).at(-1)?.data.outcome).toBe("cancelled");
  });

  test("withdraws a queued delegation and nothing else", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const held = hold();
    fakeProviders.next(held.script);
    const running = hooks();
    send(session, { source: "delegate", delegation: running.value });
    await held.started;
    const delegation = hooks();
    const queuedDelivery = send(session, { source: "delegate", delegation: delegation.value });
    await waitFor(async () => (await getJobView(turnJobId(queuedDelivery.deliveryId))) !== null);
    expect(await withdrawQueuedTurn(hooks().value)).toBe(false);
    expect(await withdrawQueuedTurn(running.value)).toBe(false);
    expect(await withdrawQueuedTurn(delegation.value)).toBe(true);
    expect(delegation.results).toEqual(["cancelled"]);
    held.release();
    await idle(session);
    expect(running.results).toEqual(["completed"]);
  });

  test("withdraws a delegation queued behind a busy target when the caller cancels", async () => {
    const boss = await makeBot();
    const worker = await makeBot();
    const busy = await newSession(worker.id);
    const busyHeld = hold();
    fakeProviders.next(busyHeld.script);
    send(busy);
    await busyHeld.started;
    track(spyOn(conversations, "createConversation").mockResolvedValue(busy));
    const bossSession = await newSession(boss.id);
    let failure = "";
    fakeProviders.next(
      byBot({
        [boss.id]: async (turn) => {
          await contextOf(turn)
            .delegate(worker.id, "faz", "call_del")
            .catch((error: Error) => {
              failure = error.message;
            });
          turn.emit({ type: "done", ok: true });
        },
      }),
    );
    send(bossSession);
    await waitFor(() => queuedTurns(busy.meta.sessionId) === 1);
    const [queuedId] = await redisCommand<string[]>("lrange", [`${jobPrefix}:turn-order:${busy.meta.sessionId}`, 1, 1]);
    await waitFor(async () => (await getJobView(turnJobId(queuedId ?? ""))) !== null);
    cancel(bossSession);
    await idle(bossSession);
    expect(failure).toBe("Pedido cancelado.");
    await waitFor(() => queuedTurns(busy.meta.sessionId) === 0);
    busyHeld.release();
    await idle(busy);
    expect(await factsOfType(busy, "turn.started")).toHaveLength(1);
  });

  test("still drops the queued turns when redis fails while cancelling or withdrawing", async () => {
    const warn = track(spyOn(console, "warn").mockImplementation(() => undefined));
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const held = hold();
    fakeProviders.next(held.script);
    send(session);
    await held.started;
    const delegation = hooks();
    const queuedDelivery = send(session, { source: "delegate", delegation: delegation.value });
    await waitFor(async () => (await getJobView(turnJobId(queuedDelivery.deliveryId))) !== null);
    const view = track(spyOn(jobsService, "getJobView").mockRejectedValue(new Error("sem redis")));
    expect(await withdrawQueuedTurn(delegation.value)).toBe(false);
    view.mockRestore();
    const command = track(spyOn(jobsService, "redisCommand").mockRejectedValue(new Error("sem redis")));
    await cancelQueuedTurns(session.meta.sessionId);
    command.mockRestore();
    expect(warn.mock.calls.filter((call) => call[0] === "fila: sem redis")).toHaveLength(2);
    held.release();
    await waitFor(() => delegation.results.length === 1);
    expect(delegation.results).toEqual(["cancelled"]);
    await idle(session);
  });

  test("runs the turn in process when the queue refuses it", async () => {
    const warn = track(spyOn(console, "warn").mockImplementation(() => undefined));
    track(spyOn(jobsService, "enqueue").mockRejectedValue(new Error("redis caiu")));
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const sent = send(session);
    await idle(session);
    expect(await consumedIds(session)).toEqual([sent.deliveryId]);
    expect(warn).toHaveBeenCalledWith("fila indisponível, turno roda direto: redis caiu");
    expect(queuedTurns(session.meta.sessionId)).toBe(0);
  });

  test("waits for a voice turn on the same conversation and skips a stale head", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    await redisCommand("rpush", [`${jobPrefix}:turn-order:${session.meta.sessionId}`, "sumiu"]);
    const voice = hold();
    fakeProviders.next(voice.script);
    await deliver(session, { deliveryId: "voz-1", text: "fala", source: "chat", voice: true });
    await voice.started;
    fakeProviders.next((turn) => {
      turn.emit({ type: "done", ok: true });
    });
    const sent = send(session);
    await waitFor(async () => (await getJobView(turnJobId(sent.deliveryId)))?.status === "delayed");
    voice.release();
    await idle(session);
    expect(await consumedIds(session)).toEqual(["voz-1", sent.deliveryId]);
  });

  test("rebuilds the queued count from redis on start", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const payload = payloadOf(session, { deliveryId: "tarde", text: "depois", source: "chat" });
    await enqueue(turnJobType, payload, { id: turnJobId("tarde"), delayMs: 60_000 });
    stopTurnQueue();
    expect(queuedTurns(session.meta.sessionId)).toBe(0);
    await startTurnQueue();
    expect(queuedTurns(session.meta.sessionId)).toBe(1);
    expect(conversationStatus(session.meta.sessionId)).toBe("queued");
    await cancelQueuedTurns(session.meta.sessionId);
    await redisCommand("rpush", [`${jobPrefix}:turn-order:${session.meta.sessionId}`, "tarde"]);
    await cancelQueuedTurns(session.meta.sessionId);
    expect(queuedTurns(session.meta.sessionId)).toBe(0);
  });

  test("reports the slots alone when the queue is off", async () => {
    await drained();
    stopTurnQueue();
    await jobsService.stopJobs();
    expect(await turnStats()).toEqual({ running: 0, queued: 0, max: maxTurns, failed: 0 });
    await jobs.restart();
    await startTurnQueue();
  });
});

function payloadOf(
  session: { meta: { sessionId: string; botId: string } },
  delivery: { deliveryId: string; text: string; source: "chat" | "schedule" | "delegate" },
) {
  const { deliveryId, text, source } = delivery;
  return {
    sessionId: session.meta.sessionId,
    botId: session.meta.botId,
    deliveryId,
    delivery: { deliveryId, text, source },
  };
}
