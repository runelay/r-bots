import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { fakeElevenLabs, fakeFastLayer } from "../../../../test/voice-helpers";
import { Req, Res } from "../../../shared/http";
import { type BotDefinition, createBot, setArchived, setDeleted } from "../../bots/services/bots.service";
import * as sessions from "../../conversations/services/sessions.service";
import * as engine from "../../engine/services/engine.service";
import { handleVoice } from "../routes/voice.routes";
import { endAllCalls, findCall, resetTokenLimits } from "../services/voice.service";

const eleven = fakeElevenLabs();
const fast = fakeFastLayer();
const deliver = spyOn(engine, "deliver").mockResolvedValue(undefined);
let server: TestServer;
let bot: BotDefinition;

interface Started {
  callId: string;
  sessionId: string;
  streamPath: string;
  fastModel: string;
  stt?: { token: string };
  tts?: { token: string };
}

function tokens() {
  eleven.on("POST", "/v1/single-use-token/realtime_scribe", () => Response.json({ token: "stt-1" }));
  eleven.on("POST", "/v1/single-use-token/tts_websocket", () => Response.json({ token: "tts-1" }));
}

async function startSession() {
  tokens();
  const started = await request<Started>(`/bots/${bot.id}/voice/session`, { method: "POST" });
  expect(started.status).toBe(201);
  return started.body;
}

beforeAll(async () => {
  await resetData();
  process.env.ELEVENLABS_API_URL = eleven.url;
  server = await startTestServer();
});

beforeEach(async () => {
  process.env.ELEVENLABS_API_KEY = "route-key";
  eleven.reset();
  fast.reset();
  deliver.mockClear();
  bot = await createBot({ name: `Voz ${crypto.randomUUID().slice(0, 6)}` });
});

afterEach(async () => {
  resetTokenLimits();
  endAllCalls();
  jest.useRealTimers();
});

afterAll(async () => {
  endAllCalls();
  await server.close();
  fast.restore();
  deliver.mockRestore();
  delete process.env.ELEVENLABS_API_URL;
  delete process.env.ELEVENLABS_API_KEY;
  await eleven.stop();
});

describe("GET /voice/voices", () => {
  test("lists voices, maps ElevenLabs refusals and network failures to errors", async () => {
    eleven.on("GET", "/v2/voices", () => Response.json({ voices: [{ voice_id: "v1", name: "Bia" }] }));
    const listed = await request<Array<{ voiceId: string }>>("/voice/voices?refresh=1");
    expect(listed.status).toBe(200);
    expect(listed.body.map((voice) => voice.voiceId)).toEqual(["v1"]);

    eleven.on("GET", "/v2/voices", () => new Response("x", { status: 503 }));
    const refused = await request("/voice/voices?refresh=1");
    expect(refused.status).toBe(502);
    expect(refused.body).toEqual({ ok: false, error: "ElevenLabs não listou as vozes (503)." });

    delete process.env.ELEVENLABS_API_KEY;
    const missing = await request<{ code: string }>("/voice/voices?refresh=1");
    expect(missing.status).toBe(503);
    expect(missing.body.code).toBe("not_configured");

    process.env.ELEVENLABS_API_KEY = "route-key";
    process.env.ELEVENLABS_API_URL = "http://127.0.0.1:9";
    try {
      const down = await request<{ ok: boolean; error: string }>("/voice/voices?refresh=1");
      expect(down.status).toBe(502);
      expect(down.body.error).toStartWith("ElevenLabs não respondeu:");
    } finally {
      process.env.ELEVENLABS_API_URL = eleven.url;
    }
  });
});

describe("/bots/:id/voice/session", () => {
  test("starting a call returns the stream path and both credentials", async () => {
    const started = await startSession();
    expect(started).toMatchObject({
      sessionId: expect.stringMatching(/^wrun_/),
      streamPath: `/bots/${bot.id}/voice/session/${started.callId}/stream`,
      fastModel: "claude-haiku-5-5",
      stt: { token: "stt-1" },
      tts: { token: "tts-1" },
    });
    expect(findCall(started.callId)?.botId).toBe(bot.id);
  });

  test("deleted and archived bots cannot start a call, and a missing key is a 503", async () => {
    await setArchived(bot.id, true);
    const archived = await request(`/bots/${bot.id}/voice/session`, { method: "POST", body: { a: 1 } });
    expect(archived).toMatchObject({ status: 409, body: { code: "bot_archived" } });
    await setDeleted(bot.id, true);
    const deleted = await request(`/bots/${bot.id}/voice/session`, { method: "POST", body: "{bad" });
    expect(deleted).toMatchObject({ status: 409, body: { code: "bot_deleted" } });
    const other = await createBot({ name: `Sem chave ${crypto.randomUUID().slice(0, 6)}` });
    delete process.env.ELEVENLABS_API_KEY;
    const missing = await request(`/bots/${other.id}/voice/session`, { method: "POST" });
    expect(missing).toMatchObject({
      status: 503,
      body: { ok: false, error: "Conecte o ElevenLabs em Configurações › Integrações para usar a voz." },
    });
  });

  test("unknown routes and finished calls are 404", async () => {
    expect((await request(`/bots/${bot.id}/voice/other`)).status).toBe(404);
    const gone = await request(`/bots/${bot.id}/voice/session/call_nope/stream`);
    expect(gone).toMatchObject({ status: 404, body: { code: "call_not_found" } });
    const { callId } = await startSession();
    expect((await request(`/bots/${bot.id}/voice/session/${callId}/unknown`, { method: "POST" })).status).toBe(404);
    const other = await createBot({ name: `Outro ${crypto.randomUUID().slice(0, 6)}` });
    expect((await request(`/bots/${other.id}/voice/session/${callId}/stream`)).status).toBe(404);
  });

  test("tokens are minted for the requested types", async () => {
    const { callId } = await startSession();
    const path = `/bots/${bot.id}/voice/session/${callId}/tokens`;
    const stt = await request<Started>(path, { method: "POST", body: { types: ["stt", "x"] } });
    expect(stt.status).toBe(200);
    expect(stt.body.stt?.token).toBe("stt-1");
    expect(stt.body.tts).toBeUndefined();
    const fallback = await request<Started>(path, { method: "POST", body: { types: ["x"] } });
    expect(fallback.body).toMatchObject({ stt: { token: "stt-1" }, tts: { token: "tts-1" } });
    const all = await request<Started>(path, { method: "POST" });
    expect(all.body).toMatchObject({ stt: { token: "stt-1" }, tts: { token: "tts-1" } });
  });

  test("utterances are validated, delivered and accepted", async () => {
    const { callId, sessionId } = await startSession();
    const path = `/bots/${bot.id}/voice/session/${callId}/utterance`;
    expect(await request(path, { method: "POST", body: { text: "  " } })).toMatchObject({
      status: 400,
      body: { field: "text" },
    });
    expect(await request(path, { method: "POST", body: "{nope" })).toMatchObject({
      status: 400,
      body: { error: "JSON inválido.", field: "body" },
    });
    const accepted = await request(path, { method: "POST", body: { text: ` ${"a".repeat(5_000)} ` } });
    expect(accepted).toMatchObject({
      status: 202,
      body: { ok: true, action: "message", sessionId, continuation: false },
    });
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: "a".repeat(4_000), voice: true });
  });

  test("an unexpected failure is a 500 from the server", async () => {
    const { callId } = await startSession();
    deliver.mockImplementationOnce(() => {
      throw new Error("engine down");
    });
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failed = await request(`/bots/${bot.id}/voice/session/${callId}/utterance`, {
        method: "POST",
        body: { text: "oi" },
      });
      expect(failed).toMatchObject({ status: 500, body: { ok: false } });
    } finally {
      error.mockRestore();
    }
  });

  test("interrupt reports the speech it cut and DELETE ends the call", async () => {
    const { callId } = await startSession();
    const call = findCall(callId);
    if (!call) throw new Error("call missing");
    call.speaking = "speech_x";
    const cut = await request(`/bots/${bot.id}/voice/session/${callId}/interrupt`, { method: "POST", body: "{x" });
    expect(cut).toMatchObject({ status: 200, body: { ok: true, interrupted: "speech_x" } });
    const ended = await request(`/bots/${bot.id}/voice/session/${callId}`, { method: "DELETE" });
    expect(ended).toMatchObject({ status: 200, body: { ok: true } });
    expect(findCall(callId)).toBeUndefined();
    expect(call.ended).toBe(true);
  });

  test("ratings accept up, down or null and 404 without a session", async () => {
    const { callId } = await startSession();
    const path = `/bots/${bot.id}/voice/session/${callId}/rating`;
    expect(await request(path, { method: "POST", body: { rating: "meh" } })).toMatchObject({
      status: 400,
      body: { field: "rating" },
    });
    expect(
      await request(path, { method: "POST", headers: { "accept-language": "en" }, body: { rating: "meh" } }),
    ).toMatchObject({ body: { error: "Use rating up, down or null." } });
    expect(await request(path, { method: "POST", body: { rating: null } })).toMatchObject({
      status: 200,
      body: { ok: true, callId, rating: null },
    });
    const spy = spyOn(sessions, "getStoredSession").mockReturnValue(undefined);
    try {
      const missing = await request(`/bots/${bot.id}/voice/session/call_x/rating`, {
        method: "POST",
        body: { rating: "up" },
      });
      expect(missing).toMatchObject({ status: 404, body: { code: "call_not_found" } });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("call stream", () => {
  test("streams call.ready, relays call events, sends heartbeats and re-arms idle on close", async () => {
    const { callId, sessionId } = await startSession();
    const call = findCall(callId);
    if (!call) throw new Error("call missing");
    jest.useFakeTimers();
    const controller = new AbortController();
    const raw = new Request(`http://127.0.0.1/bots/${bot.id}/voice/session/${callId}/stream`, {
      signal: controller.signal,
    });
    const res = new Res(controller.signal);
    await handleVoice(new Req(raw), res, "GET", bot, ["session", callId, "stream"]);
    const response = await res.response;
    expect(response.headers.get("x-voice-call-id")).toBe(callId);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    const next = async () => JSON.parse(decoder.decode((await reader.read()).value)) as Record<string, unknown>;
    expect(await next()).toMatchObject({ type: "call.ready", callId, sessionId, pending: null });
    expect(call.listeners.size).toBe(1);
    expect(call.idleTimer).toBeNull();
    for (const listener of call.listeners) listener({ type: "bot.state", state: "working" });
    expect(await next()).toMatchObject({ type: "bot.state", state: "working", at: expect.any(String) });
    jest.advanceTimersByTime(15_000);
    expect(await next()).toEqual({ type: "heartbeat" });
    controller.abort();
    expect(call.listeners.size).toBe(0);
    expect(call.idleTimer).not.toBeNull();
    jest.advanceTimersByTime(90_000);
    expect(call.ended).toBe(true);
  });
});
