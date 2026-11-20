import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { waitFor } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { startTestJobs } from "../../../../test/jobs-helpers";
import * as conversations from "../../conversations/services/conversations.service";
import * as engine from "../../engine/services/engine.service";
import { defineJob, enqueue, laneCounts } from "../../jobs/services/jobs.service";
import { appWatching } from "../services/viewers.service";

let server: TestServer;
const restores: Array<() => void> = [];

defineJob<Record<string, never>>("status.fail", {
  attempts: 1,
  handler: async () => {
    throw new Error("falhou");
  },
});

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

afterAll(async () => {
  await server.close();
});

function lineReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async function next(): Promise<Record<string, unknown>> {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    return JSON.parse(line) as Record<string, unknown>;
  };
}

describe("GET /health and /meta", () => {
  test("answers health and the static metadata", async () => {
    expect((await request("/health")).body).toEqual({ ok: true });
    const meta = await request<{
      accents: unknown[];
      capabilities: unknown[];
      engine: string;
      model: string;
      efforts: string[];
    }>("/meta");
    expect(meta.body.engine).toBe("multi-provider");
    expect(meta.body.model).toBe(process.env.BOTS_MODEL ?? "claude-sonnet-5-5");
    expect(meta.body.efforts).toEqual(["low", "medium", "high"]);
    expect(meta.body.accents.length).toBeGreaterThan(0);
    expect(meta.body.capabilities.length).toBeGreaterThan(0);
  });
});

describe("GET /status", () => {
  test("reports bots, turn slots, warm voice layers and app watching", async () => {
    const response = await request<Record<string, unknown>>("/status");
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["appWatching", "bots", "jobs", "turns", "warmVoice"]);
    expect(typeof response.body.appWatching).toBe("boolean");
    expect(response.body.jobs).toBeNull();
    expect(response.body.turns).toMatchObject({ failed: 0 });
  });

  test("adds the real queue counts when the queue is on", async () => {
    const jobs = await startTestJobs();
    try {
      await enqueue("status.fail", {}, { id: "status-fail" });
      await waitFor(async () => (await laneCounts())?.tasks.failed === 1);
      const response = await request<{ jobs: Record<string, unknown>; turns: Record<string, number> }>("/status");
      expect(response.body.jobs).toMatchObject({
        running: 0,
        queued: 0,
        failed: 1,
        queues: { tasks: { failed: 1 }, turns: { failed: 0 } },
      });
      expect(response.body.turns).toMatchObject({ running: 0, queued: 0, failed: 0 });
    } finally {
      await jobs.stop();
    }
  }, 30_000);
});

describe("GET /status/stream", () => {
  test("streams a snapshot, status, conversation and heartbeat events, then cleans up", async () => {
    let statusListener: ((event: engine.StatusEvent) => void) | null = null;
    let conversationListener: ((event: conversations.ConversationEvent) => void) | null = null;
    const emitStatus = (event: engine.StatusEvent) => statusListener?.(event);
    const emitConversation = (event: conversations.ConversationEvent) => conversationListener?.(event);
    let unsubscribed = 0;
    const onStatus = spyOn(engine, "onStatus").mockImplementation((listener) => {
      statusListener = listener;
      return () => {
        unsubscribed++;
        return true;
      };
    });
    const onConversation = spyOn(conversations, "onConversation").mockImplementation((listener) => {
      conversationListener = listener;
      return () => {
        unsubscribed++;
        return true;
      };
    });
    const realInterval = globalThis.setInterval;
    const intervals = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms?: number) =>
      realInterval(callback, ms === 15_000 ? 1 : ms)) as typeof setInterval);
    restores.push(
      () => onStatus.mockRestore(),
      () => onConversation.mockRestore(),
      () => intervals.mockRestore(),
    );

    const controller = new AbortController();
    const response = await fetch(`${server.url}/status/stream`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const next = lineReader(response.body as ReadableStream<Uint8Array>);
    const snapshot = await next();
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot).toHaveProperty("bots");
    expect(snapshot).toHaveProperty("sessions");
    expect(appWatching(0)).toBe(true);

    emitStatus({ botId: "b1", status: "working" } as engine.StatusEvent);
    emitStatus({ botId: "b1", sessionId: "s1", status: "awaiting" } as engine.StatusEvent);
    emitConversation({ botId: "b1", sessionId: "s1", conversation: null });
    const seen: Array<Record<string, unknown>> = [];
    while (!seen.some((line) => line.type === "heartbeat") || seen.filter((l) => l.type !== "heartbeat").length < 3)
      seen.push(await next());
    expect(seen.filter((line) => line.type !== "heartbeat")).toEqual([
      { type: "status", botId: "b1", status: "working" },
      { type: "session", botId: "b1", sessionId: "s1", status: "awaiting" },
      { type: "conversation", botId: "b1", sessionId: "s1", conversation: null },
    ]);

    controller.abort();
    for (let attempt = 0; attempt < 10_000 && unsubscribed < 2; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(unsubscribed).toBeGreaterThanOrEqual(2);
    expect(appWatching(0)).toBe(false);
  });
});
