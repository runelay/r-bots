import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { fakeProcesses, resetData } from "../../../../test/helpers";
import { type FakeFastQuery, fakeElevenLabs, fakeFastLayer, until } from "../../../../test/voice-helpers";
import type { BotDefinition } from "../../bots/services/bots.service";
import type { Fact } from "../../conversations/services/sessions.service";
import * as sessions from "../../conversations/services/sessions.service";
import * as engine from "../../engine/services/engine.service";
import {
  armIdle,
  type CallEvent,
  classifyAnswer,
  credentials,
  endAllCalls,
  endCall,
  findCall,
  isCourtesy,
  listVoices,
  mintToken,
  onUtterance,
  rateCall,
  repeatsReply,
  resetTokenLimits,
  speakableReply,
  startCall,
  tokenLimit,
  unclearUtterance,
  type VoiceCall,
  VoiceError,
  voiceEnabled,
  wantsHangup,
  warmVoiceLayers,
} from "../services/voice.service";

const eleven = fakeElevenLabs();
const fast = fakeFastLayer();
const deliver = spyOn(engine, "deliver").mockResolvedValue(undefined);
const saves: Promise<unknown>[] = [];
const realSave = sessions.StoredSession.prototype.save;
const save = spyOn(sessions.StoredSession.prototype, "save").mockImplementation(function (
  this: sessions.StoredSession,
) {
  const pending = realSave.call(this);
  saves.push(pending);
  return pending;
});
let botCounter = 0;

async function settleSaves() {
  while (saves.length > 0) await Promise.all(saves.splice(0));
}

function botOf(voice?: BotDefinition["voice"], role = ""): BotDefinition {
  botCounter++;
  return { id: `voice-bot-${botCounter}`, name: `Voz ${botCounter}`, role, voice } as BotDefinition;
}

async function factsOf(call: VoiceCall) {
  return (await call.session.log.lines()).flatMap((line) => (JSON.parse(line) as { facts?: Fact[] }).facts ?? []);
}

function listen(call: VoiceCall) {
  const events: CallEvent[] = [];
  call.listeners.add((event) => events.push(event));
  return events;
}

function emitFacts(call: VoiceCall, ...facts: Fact[]) {
  call.session.log.emit(...facts);
}

async function warmCall(bot = botOf()) {
  const call = await startCall(bot);
  const query = fast.last();
  await until(() => query.prompts.length === 1 && !call.fast.busy, "warm-up");
  return { call, query };
}

beforeAll(async () => {
  await resetData();
  process.env.ELEVENLABS_API_URL = eleven.url;
});

beforeEach(async () => {
  process.env.ELEVENLABS_API_KEY = "test-eleven-key";
  eleven.reset();
  fast.reset();
  deliver.mockClear();
});

afterEach(async () => {
  resetTokenLimits();
  await settleSaves();
  endAllCalls();
  await settleSaves();
  jest.useRealTimers();
});

afterAll(async () => {
  endAllCalls();
  fast.restore();
  deliver.mockRestore();
  save.mockRestore();
  delete process.env.ELEVENLABS_API_URL;
  delete process.env.ELEVENLABS_API_KEY;
  await eleven.stop();
});

describe("ElevenLabs tokens and voices", () => {
  test("missing API key disables voice and fails with 503", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    expect(voiceEnabled()).toBe(false);
    const error = await mintToken("realtime_scribe").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceError);
    expect(error).toMatchObject({ status: 503 });
    await expect(listVoices(true)).rejects.toMatchObject({ status: 503 });
    expect(eleven.calls).toHaveLength(0);
  });

  test("mints single-use tokens with the API key and maps failures to 502", async () => {
    expect(voiceEnabled()).toBe(true);
    eleven.on("POST", "/v1/single-use-token/realtime_scribe", () => Response.json({ token: "stt-token" }));
    eleven.on("POST", "/v1/single-use-token/tts_websocket", () => Response.json({}));
    expect(await mintToken("realtime_scribe")).toBe("stt-token");
    await expect(mintToken("tts_websocket")).rejects.toThrow("ElevenLabs não devolveu o token.");
    eleven.on("POST", "/v1/single-use-token/tts_websocket", () => new Response("no", { status: 401 }));
    await expect(mintToken("tts_websocket")).rejects.toThrow("ElevenLabs recusou o token (401).");
    expect(eleven.calls[0]).toEqual({
      method: "POST",
      path: "/v1/single-use-token/realtime_scribe",
      key: "test-eleven-key",
    });
  });

  test("lists voices across pages, Portuguese first, cached for ten minutes", async () => {
    eleven.on("GET", "/v2/voices", (url) =>
      url.searchParams.get("next_page_token") === "p2"
        ? Response.json({
            voices: [
              { voice_id: "v-pt", name: "Zeca", labels: { language: "pt", descriptive: "calmo" } },
              { voice_id: "v-bare" },
            ],
            has_more: false,
          })
        : Response.json({
            voices: [
              {
                voice_id: "v-en",
                name: "Alice",
                category: "premade",
                description: "bright",
                preview_url: "http://127.0.0.1/p.mp3",
                labels: { language: "en", accent: "american", gender: "female" },
              },
              { voice_id: "v-pt2", name: "Ana", labels: { language: "pt" } },
            ],
            has_more: true,
            next_page_token: "p2",
          }),
    );
    const voices = await listVoices(true);
    expect(voices.map((voice) => voice.voiceId)).toEqual(["v-pt2", "v-pt", "v-en", "v-bare"]);
    expect(voices[1]).toEqual({
      voiceId: "v-pt",
      name: "Zeca",
      category: "",
      language: "pt",
      accent: null,
      gender: null,
      description: "calmo",
      previewUrl: null,
    });
    expect(voices[2]).toMatchObject({
      accent: "american",
      gender: "female",
      description: "bright",
      category: "premade",
    });
    expect(voices[3]).toMatchObject({ name: "v-bare", language: null });
    expect(eleven.calls.map((call) => call.path)).toEqual([
      "/v2/voices?page_size=100",
      "/v2/voices?page_size=100&next_page_token=p2",
    ]);
    expect(await listVoices()).toBe(voices);
    expect(eleven.calls).toHaveLength(2);
  });

  test("a failed voice page is a 502 and an empty body ends the listing", async () => {
    eleven.on("GET", "/v2/voices", () => new Response("down", { status: 500 }));
    await expect(listVoices(true)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("(500)") });
    eleven.on("GET", "/v2/voices", () => Response.json({ has_more: true }));
    expect(await listVoices(true)).toEqual([]);
  });

  test("credentials build STT and TTS socket URLs for the bot voice", async () => {
    eleven.on("POST", "/v1/single-use-token/realtime_scribe", () => Response.json({ token: "s1" }));
    eleven.on("POST", "/v1/single-use-token/tts_websocket", () => Response.json({ token: "t1" }));
    const bot = botOf({ voiceId: "voice/x", speed: 1, language: "en" });
    const both = await credentials(bot, ["stt", "tts"]);
    expect(both.voice).toMatchObject({ voiceId: "voice/x", language: "en" });
    const stt = new URL(both.stt?.url ?? "");
    expect(stt.origin + stt.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(Object.fromEntries(stt.searchParams)).toMatchObject({
      language_code: "en",
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      token: "s1",
    });
    expect(both.stt).toMatchObject({ token: "s1", sampleRate: 16_000 });
    const tts = new URL(both.tts?.url ?? "");
    expect(tts.pathname).toBe("/v1/text-to-speech/voice%2Fx/multi-stream-input");
    expect(tts.searchParams.get("single_use_token")).toBe("t1");
    expect(both.tts).toMatchObject({ outputFormat: "pcm_24000", sampleRate: 24_000 });
    const onlyTts = await credentials(bot, ["tts"]);
    expect(onlyTts.stt).toBeUndefined();
    expect(onlyTts.tts?.token).toBe("t1");
    const onlyStt = await credentials(bot, ["stt"]);
    expect(onlyStt.tts).toBeUndefined();
  });

  test("token minting is rate limited per person and capped in flight", async () => {
    eleven.on("POST", "/v1/single-use-token/realtime_scribe", () => Response.json({ token: "s1" }));
    eleven.on("POST", "/v1/single-use-token/tts_websocket", () => Response.json({ token: "t1" }));
    const bot = botOf({ voiceId: "v", speed: 1, language: "pt" });
    for (let index = 0; index < tokenLimit.perMinute / 2; index++) await credentials(bot, ["stt", "tts"], "u1");
    const limited = await credentials(bot, ["stt"], "u1").catch((error: VoiceError) => error);
    expect(limited).toBeInstanceOf(VoiceError);
    expect((limited as VoiceError).status).toBe(429);
    expect((await credentials(bot, ["stt"], "u2")).stt?.token).toBe("s1");
    resetTokenLimits();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    eleven.on("POST", "/v1/single-use-token/tts_websocket", async () => {
      await gate;
      return Response.json({ token: "t2" });
    });
    const running = Array.from({ length: tokenLimit.concurrent }, () => credentials(bot, ["tts"], "u3"));
    const extra = await credentials(bot, ["tts"], "u3").catch((error: VoiceError) => error);
    expect((extra as VoiceError).status).toBe(429);
    release();
    expect((await Promise.all(running)).map((item) => item.tts?.token)).toEqual(
      Array(tokenLimit.concurrent).fill("t2"),
    );
    expect((await credentials(bot, ["tts"], "u3")).tts?.token).toBe("t2");
  });

  test("an insecure ElevenLabs url falls back to the real one", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const saved = process.env.ELEVENLABS_API_URL;
    process.env.ELEVENLABS_API_URL = "http://evil.example.com";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ token: "x" }));
    try {
      await mintToken("tts_websocket");
      expect(String(fetchSpy.mock.calls[0][0])).toBe("https://api.elevenlabs.io/v1/single-use-token/tts_websocket");
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
      process.env.ELEVENLABS_API_URL = saved;
    }
  });
});

describe("pure helpers", () => {
  test("speakableReply keeps short prose and rejects code, tables, headings and long lists", async () => {
    expect(speakableReply("Pronto, **feito**. Veja [o link](http://x.y) em https://a.b/c")).toBe(
      "Pronto, feito. Veja o link em",
    );
    expect(speakableReply("- um\n- dois")).toBe("um dois");
    expect(speakableReply("- a\n- b\n1. c")).toBeNull();
    expect(speakableReply("```js\nx\n```")).toBeNull();
    expect(speakableReply("| a | b |")).toBeNull();
    expect(speakableReply("# Título")).toBeNull();
    expect(speakableReply("x".repeat(601))).toBeNull();
    expect(speakableReply("y ".repeat(200))).toBeNull();
    expect(speakableReply("https://only.link")).toBeNull();
  });

  test("repeatsReply compares content words", async () => {
    expect(repeatsReply("Vou olhar", "Vou olhar seus emails")).toBe(false);
    expect(repeatsReply("Achei três emails do banco hoje cedo", "Os emails do banco chegaram hoje cedo")).toBe(true);
    expect(repeatsReply("Achei três emails do banco hoje cedo", "Nada novo por aqui")).toBe(false);
  });

  test("unclearUtterance flags invented English, hallucinations and weak transcripts in Portuguese calls", () => {
    expect(unclearUtterance("Thank you for watching!", "pt")).toBe(true);
    expect(unclearUtterance("Obrigado por assistir.", "pt")).toBe(true);
    expect(unclearUtterance("I think that is what you want to do with this.", "pt")).toBe(true);
    expect(unclearUtterance("You.", "pt")).toBe(true);
    expect(unclearUtterance("...", "pt")).toBe(true);
    expect(unclearUtterance("Olha meus emails", "pt")).toBe(false);
    expect(unclearUtterance("abre o PR do github e faz o merge", "pt")).toBe(false);
    expect(unclearUtterance("Okay", "pt")).toBe(false);
    expect(unclearUtterance("sim", "pt")).toBe(false);
    expect(unclearUtterance("Olha meus emails", "pt", { language: "eng" })).toBe(true);
    expect(unclearUtterance("Olha meus emails", "pt", { language: "por" })).toBe(false);
    expect(unclearUtterance("Olha meus emails", "pt", { confidence: 0.2 })).toBe(true);
    expect(unclearUtterance("I think that is what you want", "en")).toBe(false);
  });

  test("classifyAnswer reads yes and no in Portuguese", async () => {
    expect(classifyAnswer("Sim, pode!")).toBe("approve");
    expect(classifyAnswer("Faça isso")).toBe("approve");
    expect(classifyAnswer("Não, melhor não")).toBe("deny");
    expect(classifyAnswer("Cancela")).toBe("deny");
    expect(classifyAnswer("talvez depois")).toBeNull();
  });
});

describe("hang up by voice", () => {
  test("wantsHangup accepts a direct request and refuses negations and other objects", () => {
    for (const text of [
      "Ok, obrigado. Pode desligar.",
      "Pode desligar, obrigado!",
      "desliga",
      "Desliga aí",
      "tchau, pode encerrar",
      "Encerra a ligação.",
      "pode encerrar a chamada agora",
      "Beleza, vou desligar então. Tchau!",
    ])
      expect([text, wantsHangup(text)]).toEqual([text, true]);
    for (const text of [
      "não desliga ainda",
      "Não. Pode desligar.",
      "ainda não, espera",
      "desligar o servidor",
      "pode desligar o servidor de teste?",
      "quando eu terminar você desliga",
      "tchau",
      "obrigado",
      "",
    ])
      expect([text, wantsHangup(text)]).toEqual([text, false]);
  });

  test("isCourtesy spots thanks and goodbyes only", () => {
    expect(isCourtesy("Ok, obrigado.")).toBe(true);
    expect(isCourtesy("valeu, tchau")).toBe(true);
    expect(isCourtesy("obrigado, agora olha meus emails")).toBe(false);
    expect(isCourtesy("...")).toBe(false);
  });

  test("a spoken goodbye says one farewell, skips the bot turn and ends the call after playback", async () => {
    jest.useFakeTimers();
    const { call, query } = await warmCall();
    emitFacts(call, { type: "turn.started", data: {}, scope: { turnId: "running" } });
    const events = listen(call);
    const result = await onUtterance(call, "Ok, obrigado. Pode desligar.");
    expect(result).toMatchObject({ action: "hangup" });
    expect(deliver).not.toHaveBeenCalled();
    expect(query.prompts).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["speech.started", "speech.delta", "speech.done", "call.hangup"]);
    expect(events[0]).toMatchObject({ kind: "goodbye" });
    expect(events[2]).toMatchObject({ text: "Combinado, até mais." });
    expect(events[3]).toMatchObject({ speechId: events[0]?.id });
    emitFacts(
      call,
      { type: "content.completed", data: { phase: "reply", value: "Por nada." }, scope: { turnId: "running" } },
      { type: "turn.settled", data: { outcome: "completed" }, scope: { turnId: "running" } },
    );
    expect(await onUtterance(call, "alô?")).toEqual(result);
    expect(events.filter((event) => event.type === "speech.done")).toHaveLength(1);
    expect(call.ended).toBe(false);
    jest.advanceTimersByTime(8_000);
    expect(call.ended).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "call.ended" });
    const spoken = (await factsOf(call)).filter((fact) => fact.type === "content.completed");
    expect(spoken.map((fact) => fact.data.value)).toEqual(["Combinado, até mais.", "Por nada."]);
  });

  test("goodbye wins over an open approval and follows the voice language", async () => {
    const { call } = await warmCall(
      botOf({ voiceId: "abcdefgh12", speed: 1, language: "en" } as BotDefinition["voice"]),
    );
    const events = listen(call);
    call.pending = { interactionId: "i1", prompt: "Posso mandar o e-mail?" };
    expect(await onUtterance(call, "pode desligar")).toMatchObject({ action: "hangup" });
    expect(events.find((event) => event.type === "speech.done")).toMatchObject({ text: "Alright, talk soon." });
    endCall(call);
    expect(call.hangup).not.toBeNull();
  });

  test("thanks get only the bot reply, with no acknowledgement on top", async () => {
    const { call, query } = await warmCall();
    const events = listen(call);
    expect(await onUtterance(call, "Ok, obrigado.")).toMatchObject({ action: "message", continuation: false });
    expect(deliver).toHaveBeenCalledTimes(1);
    emitFacts(
      call,
      { type: "turn.started", data: {}, scope: { turnId: "thanks" } },
      { type: "content.completed", data: { phase: "reply", value: "Por nada." }, scope: { turnId: "thanks" } },
      { type: "turn.settled", data: { outcome: "completed" }, scope: { turnId: "thanks" } },
    );
    const done = events.filter((event) => event.type === "speech.done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ text: "Por nada." });
    expect(query.prompts.some((prompt) => prompt.startsWith("PESSOA"))).toBe(false);
  });
});

describe("calls", () => {
  test("startCall opens the thread session, warms the fast layer and replaces an older call of the bot", async () => {
    const bot = botOf(undefined, "Analista");
    const { call: first, query } = await warmCall(bot);
    expect(findCall(first.id)).toBe(first);
    expect(first.session.meta.botId).toBe(bot.id);
    expect(query.prompts[0]).toBe('CLASSIFIQUE: aquecimento. A pessoa disse: "ok"');
    expect(String(query.options.systemPrompt)).toContain(`Você é a voz de ${bot.name} (Analista)`);
    expect(String(query.options.systemPrompt)).not.toContain("Fale sempre em");
    expect(query.options).toMatchObject({ model: "claude-haiku-5-5", tools: [], settingSources: [] });
    expect(warmVoiceLayers()).toBeGreaterThanOrEqual(1);
    const second = await startCall(bot);
    expect(first.ended).toBe(true);
    expect(query.closed).toBe(true);
    expect(findCall(first.id)).toBeUndefined();
    expect(findCall(second.id)).toBe(second);
    expect((await factsOf(first)).find((fact) => fact.type === "voice.call.ended")?.data).toMatchObject({
      callId: first.id,
      botId: bot.id,
      durationSecs: 1,
    });
  });

  test("prompts ask for English or Spanish when the voice language is not Portuguese", async () => {
    await startCall(botOf({ voiceId: "v", speed: 1, language: "en" }));
    expect(String(fast.last().options.systemPrompt)).toContain("Fale sempre em inglês");
    await startCall(botOf({ voiceId: "v", speed: 1, language: "es" }));
    expect(String(fast.last().options.systemPrompt)).toContain("Fale sempre em espanhol");
  });

  test("startCall fails with 500 when the thread session is missing", async () => {
    const spy = spyOn(sessions, "getStoredSession").mockReturnValue(undefined);
    try {
      await expect(startCall(botOf())).rejects.toMatchObject({ status: 500 });
    } finally {
      spy.mockRestore();
    }
  });

  test("the fast layer spawns Claude Code through spawnMarked on Linux", async () => {
    await startCall(botOf());
    const spawn = fast.last().options.spawnClaudeCodeProcess;
    expect(spawn).toBeDefined();
    const processes = fakeProcesses(() => ({ hang: true }));
    const child = spawn?.({
      command: "claude",
      args: ["--print"],
      cwd: "/tmp",
      env: { A: "1" },
      signal: new AbortController().signal,
    } as SpawnOptions);
    expect(processes.calls[0]).toMatchObject({ command: "sh" });
    expect(processes.calls[0].args).toContain("claude");
    (child as unknown as { kill(): void }).kill();
  });

  test("an utterance delivers to the engine and speaks an acknowledgement", async () => {
    const { call, query } = await warmCall();
    const events = listen(call);
    const result = await onUtterance(call, "Olha meus emails");
    expect(result).toMatchObject({ action: "message", continuation: false, sessionId: call.session.meta.sessionId });
    expect(deliver).toHaveBeenCalledWith(
      call.session,
      expect.objectContaining({ text: "Olha meus emails", voice: true }),
    );
    await until(() => events.some((event) => event.type === "speech.done"), "ack");
    expect(query.prompts[1]).toBe("PESSOA: Olha meus emails");
    expect(events.map((event) => event.type)).toEqual([
      "speech.started",
      "speech.delta",
      "speech.delta",
      "speech.done",
    ]);
    expect(events[0]).toMatchObject({ kind: "ack" });
    expect(events.at(-1)).toMatchObject({ text: "Beleza, entendi." });
    expect(call.lastAck?.text).toBe("Beleza, entendi.");
    expect(call.spoken).toBe(1);
    const spoken = (await factsOf(call)).find((fact) => fact.type === "content.completed");
    expect(spoken?.data).toMatchObject({ value: "Beleza, entendi.", voice: true, spoken: true, botId: call.botId });
  });

  test("speech holds short and parenthesized starts, and silence produces no speech", async () => {
    const { call, query } = await warmCall();
    const events = listen(call);
    fast.responder = () => ({ hold: true });
    await onUtterance(call, "olha isso");
    await until(() => query.prompts.length === 2, "ack prompt");
    query.delta("Oi");
    query.delta("(");
    await until(() => events.length === 0 && call.fast.busy, "held");
    query.delta(") e aí");
    await until(() => events.length === 2, "release");
    query.delta(" tudo bem");
    query.result();
    await until(() => events.some((event) => event.type === "speech.done"), "done");
    expect(events.map((event) => event.type)).toEqual([
      "speech.started",
      "speech.delta",
      "speech.delta",
      "speech.done",
    ]);
    expect(events[1]).toMatchObject({ text: "Oi() e aí" });
    expect(events[3]).toMatchObject({ text: "Oi() e aí tudo bem" });

    events.length = 0;
    await onUtterance(call, "e agora");
    await until(() => query.prompts.length === 3, "second prompt");
    query.delta("(sil");
    query.delta("êncio)");
    query.result();
    await until(() => !call.fast.busy, "silence");
    expect(events).toEqual([]);

    await onUtterance(call, "mais uma");
    await until(() => query.prompts.length === 4, "third prompt");
    query.delta("(pensando");
    query.result();
    await until(() => events.some((event) => event.type === "speech.done"), "forced release");
    expect(events.at(-1)).toMatchObject({ text: "(pensando" });
  });

  test("a cancelled acknowledgement emits speech.cancelled and an empty one stays silent", async () => {
    const { call, query } = await warmCall();
    const events = listen(call);
    fast.responder = () => ({ hold: true });
    await onUtterance(call, "primeira");
    await until(() => query.prompts.length === 2, "prompt");
    query.delta("Certo, já vejo");
    await until(() => call.speaking !== null, "speaking");
    await onUtterance(call, "segunda", true);
    await until(() => events.some((event) => event.type === "speech.cancelled"), "cancel");
    expect(query.interrupts).toBe(1);
    await until(() => query.prompts.length === 3, "second prompt");
    query.result();
    await until(() => !call.fast.busy, "settled");
    expect(events.filter((event) => event.type === "speech.done")).toHaveLength(0);

    events.length = 0;
    fast.responder = () => ({ hold: true });
    const cancelled = onUtterance(call, "terceira");
    await cancelled;
    await until(() => query.prompts.length === 4, "fourth prompt");
    call.fast.cancelAll();
    await until(() => !call.fast.busy, "cancel unstarted");
    expect(events).toEqual([]);
  });

  test("an unclear utterance asks to repeat once and never reaches the engine", async () => {
    const { call } = await warmCall();
    const events = listen(call);
    const result = await onUtterance(call, "Thank you for watching.");
    expect(result).toMatchObject({ action: "repeat" });
    expect(deliver).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "speech.done", text: "Não entendi, pode repetir?" });
    expect(await onUtterance(call, "I think that is what you want to do.")).toMatchObject({ action: "ignored" });
    expect(events.filter((event) => event.type === "speech.done")).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("an utterance while a turn runs is a continuation without acknowledgement", async () => {
    const { call, query } = await warmCall();
    emitFacts(call, { type: "turn.started", data: {}, scope: { turnId: "t1" } });
    const result = await onUtterance(call, "e também isso");
    expect(result).toMatchObject({ action: "message", continuation: true });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(query.prompts).toHaveLength(1);
  });

  test("turn facts drive bot state, fillers, results and errors", async () => {
    const { call, query } = await warmCall();
    const events = listen(call);
    fast.responder = (prompt) => (prompt.startsWith("FERRAMENTA") ? "Tô abrindo o Gmail." : "Resumo falado.");
    emitFacts(call, { type: "turn.started", data: { turnId: "t1" } });
    expect(events.at(-1)).toEqual({ type: "bot.state", state: "working", turnId: "t1" });
    emitFacts(call, { type: "call.requested", data: { capability: { label: "Gmail" } }, scope: { turnId: "t1" } });
    expect(events).toContainEqual({ type: "bot.tool", label: "Gmail", turnId: "t1" });
    await until(() => events.some((event) => event.type === "speech.done" && event.text === "Tô abrindo o Gmail."));
    expect(query.prompts).toContain("FERRAMENTA: Gmail");
    emitFacts(call, { type: "call.requested", data: { capability: { label: "Drive" } }, scope: { turnId: "t1" } });
    emitFacts(call, { type: "call.requested", data: {}, scope: { turnId: "t1" } });
    expect(query.prompts.filter((prompt) => prompt.startsWith("FERRAMENTA"))).toHaveLength(1);
    emitFacts(
      call,
      { type: "content.completed", data: { phase: "reply", value: "Pronto, mandei." }, scope: { turnId: "t1" } },
      { type: "content.completed", data: { phase: "thinking", value: "x" }, scope: { turnId: "t1" } },
      { type: "turn.settled", data: { outcome: "completed" }, scope: { turnId: "t1" } },
    );
    expect(events.slice(-4).map((event) => event.type)).toEqual([
      "bot.state",
      "speech.started",
      "speech.delta",
      "speech.done",
    ]);
    expect(events.at(-1)).toMatchObject({ text: "Pronto, mandei." });

    emitFacts(
      call,
      { type: "turn.started", data: {}, scope: { turnId: "t2" } },
      {
        type: "content.completed",
        data: { phase: "reply", value: "# Relatório\n\nLonga resposta" },
        scope: { turnId: "t2" },
      },
      { type: "turn.settled", data: { outcome: "completed" }, scope: { turnId: "t2" } },
    );
    await until(() => query.prompts.some((prompt) => prompt.startsWith("RESULTADO: # Relatório")), "result");
    await until(() => events.some((event) => event.type === "speech.done" && event.text === "Resumo falado."));

    emitFacts(
      call,
      { type: "turn.started", data: {}, scope: { turnId: "t3" } },
      { type: "turn.settled", data: { outcome: "failed", error: { message: "sem acesso" } }, scope: { turnId: "t3" } },
      { type: "turn.started", data: {}, scope: { turnId: "t4" } },
      { type: "turn.settled", data: { outcome: "failed" }, scope: { turnId: "t4" } },
      { type: "turn.started", data: {}, scope: { turnId: "t5" } },
      { type: "turn.settled", data: { outcome: "cancelled" }, scope: { turnId: "t5" } },
    );
    await until(() => query.prompts.includes("ERRO: falhou sem detalhe"), "errors");
    expect(query.prompts).toContain("ERRO: sem acesso");
    expect(events.filter((event) => event.type === "bot.state" && event.state === "idle")).toHaveLength(5);
  });

  test("a superseded turn stays quiet and a repeated acknowledgement is retracted", async () => {
    const { call, query } = await warmCall();
    const events = listen(call);
    emitFacts(call, { type: "turn.started", data: {}, scope: { turnId: "old" } });
    call.turnStarts.set("old", Date.now() - 1_000);
    fast.responder = () => "Achei três emails do banco hoje cedo";
    await onUtterance(call, "quais emails do banco?", true);
    await until(() => call.lastAck !== null, "ack");
    const ackPart = call.lastAck?.partId;
    emitFacts(
      call,
      {
        type: "content.completed",
        data: { phase: "reply", value: "Os emails do banco chegaram hoje cedo, três ao todo." },
        scope: { turnId: "old" },
      },
      { type: "turn.settled", data: { outcome: "completed" }, scope: { turnId: "old" } },
    );
    expect(call.lastAck).toBeNull();
    const retracted = (await factsOf(call)).find((fact) => fact.data.retracted === true);
    expect(retracted?.data).toMatchObject({ partId: ackPart, value: "" });
    expect(events.filter((event) => event.type === "speech.done")).toHaveLength(1);
    expect(query.prompts.some((prompt) => prompt.startsWith("RESULTADO"))).toBe(false);
  });

  test("approvals are asked by voice and answered by keyword or by the fast classifier", async () => {
    const { call, query } = await warmCall();
    const events = listen(call);
    fast.responder = (prompt) =>
      prompt.startsWith("APROVACAO")
        ? "Posso apagar o arquivo? Posso?"
        : prompt.includes("depende")
          ? "NEGAR"
          : "OUTRO";
    emitFacts(call, {
      type: "interaction.opened",
      data: { interactionId: "i1", request: { prompt: "Apagar arquivo" } },
      scope: { turnId: "t1" },
    });
    expect(call.pending).toEqual({ interactionId: "i1", prompt: "Apagar arquivo" });
    expect(events).toContainEqual({ type: "approval.asked", interactionId: "i1", prompt: "Apagar arquivo" });
    expect(events).toContainEqual({ type: "bot.state", state: "awaiting", turnId: "t1" });
    await until(() => query.prompts.includes("APROVACAO: Apagar arquivo"), "approval prompt");

    expect(await onUtterance(call, "sim, pode")).toEqual({
      action: "answer",
      interactionId: "i1",
      optionId: "approve",
    });
    expect(events.at(-1)).toMatchObject({ type: "speech.done", text: "Beleza, seguindo." });
    expect(await onUtterance(call, "não")).toMatchObject({ optionId: "deny" });
    expect(events.at(-1)).toMatchObject({ text: "Tá bom, não vou fazer." });
    expect(await onUtterance(call, "depende do caso")).toMatchObject({ action: "answer", optionId: "deny" });
    fast.responder = () => "APROVAR";
    expect(await onUtterance(call, "acho que tudo bem")).toMatchObject({ optionId: "approve" });
    fast.responder = () => "OUTRO";
    expect(await onUtterance(call, "hmm sei lá")).toEqual({ action: "repeat", interactionId: "i1" });
    expect(events.at(-1)).toMatchObject({ text: "Não entendi. Posso seguir? Fala sim ou não." });
    expect(deliver).not.toHaveBeenCalled();

    emitFacts(call, { type: "interaction.settled", data: { interactionId: "other", outcome: "x" } });
    expect(call.pending).not.toBeNull();
    emitFacts(call, { type: "interaction.settled", data: { interactionId: "i1", outcome: "approved" } });
    expect(call.pending).toBeNull();
    expect(events.at(-1)).toEqual({ type: "approval.settled", interactionId: "i1", outcome: "approved" });
  });

  test("questions are read aloud and answered by letter, ordinal, label, free text or skip", async () => {
    const { call } = await warmCall();
    const events = listen(call);
    const applied = spyOn(engine, "answerQuestion").mockReturnValue(true);
    try {
      const options = [
        { id: "a", label: "Manter o critério de Reels", recommended: true },
        { id: "b", label: "Só a data da postagem" },
      ];
      const questions = [
        { id: "q1", title: "O que a checagem confere?", multiSelect: false, options },
        { id: "q2", title: "Qual rede?", multiSelect: true, options },
        { id: "q3", title: "Prazo?", multiSelect: false, options },
        { id: "q4", title: "Aviso?", multiSelect: false, options },
        { id: "q5", title: "Tom?", multiSelect: false, options },
      ];
      emitFacts(call, {
        type: "interaction.opened",
        data: { interactionId: "q", request: { kind: "question", prompt: "O que a checagem confere?", questions } },
        scope: { turnId: "t1" },
      });
      expect(events).toContainEqual({ type: "question.asked", interactionId: "q", questions });
      expect(events.at(-1)).toMatchObject({
        type: "speech.done",
        text: "Pergunta 1 de 5. O que a checagem confere? A, Manter o critério de Reels, que eu recomendo; B, Só a data da postagem. Ou fala outra coisa.",
      });
      expect(await onUtterance(call, "a segunda")).toEqual({ action: "question", interactionId: "q", index: 1 });
      expect(await onUtterance(call, "manter o critério de reels e só a data da postagem")).toMatchObject({
        index: 2,
      });
      expect(await onUtterance(call, "bê")).toMatchObject({ index: 3 });
      expect(await onUtterance(call, "pode pular")).toMatchObject({ index: 4 });
      expect(await onUtterance(call, "quero olhar os comentários também")).toEqual({
        action: "answered",
        interactionId: "q",
        applied: true,
      });
      expect(call.pending).toBeNull();
      expect(applied.mock.calls[0]?.[3]).toEqual({
        questions: [
          { questionId: "q1", optionIds: ["b"] },
          { questionId: "q2", optionIds: ["a", "b"] },
          { questionId: "q3", optionIds: ["b"] },
          { questionId: "q4", skipped: true },
          { questionId: "q5", optionIds: ["other"], text: "quero olhar os comentários também" },
        ],
      });
      expect(events.at(-1)).toMatchObject({ text: "Beleza, seguindo." });
      emitFacts(call, {
        type: "interaction.opened",
        data: { interactionId: "q2", request: { kind: "question", prompt: "Prazo?", questions: [questions[2]] } },
        scope: { turnId: "t2" },
      });
      expect(events.at(-1)).toMatchObject({
        text: "Prazo? A, Manter o critério de Reels, que eu recomendo; B, Só a data da postagem. Ou fala outra coisa.",
      });
      expect(await onUtterance(call, "tanto faz")).toMatchObject({ action: "answered" });
      expect(events.at(-1)).toMatchObject({ text: "Tá bom, eu decido." });
    } finally {
      applied.mockRestore();
    }
  });

  test("a classifier that fails falls back to repeating the question", async () => {
    const { call } = await warmCall();
    call.pending = { interactionId: "i9", prompt: "Mandar email" };
    fast.responder = () => ({ error: "overloaded" });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await onUtterance(call, "hã?")).toEqual({ action: "repeat", interactionId: "i9" });
      expect(warn.mock.calls[0]?.[0]).toContain("voice fast layer error: overloaded");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("fast layer lifecycle", () => {
  test("a stream failure releases pending jobs and the next ask reopens the layer", async () => {
    const { call, query } = await warmCall();
    fast.responder = () => ({ hold: true });
    const events = listen(call);
    await onUtterance(call, "um");
    await until(() => query.prompts.length === 2, "held prompt");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      query.fail(new Error("socket closed"));
      await until(() => warn.mock.calls.length === 1, "warn");
      expect(warn.mock.calls[0]).toEqual(["voice fast layer stopped", "socket closed"]);
    } finally {
      warn.mockRestore();
    }
    fast.responder = () => "De novo.";
    await onUtterance(call, "dois", true);
    expect(fast.queries).toHaveLength(2);
    await until(() => events.some((event) => event.type === "speech.done"), "reopened");
    expect(fast.last().prompts).toEqual(["PESSOA: dois"]);
  });

  test("the least recently used idle layer is evicted beyond the warm limit", async () => {
    const opened: FakeFastQuery[] = [];
    for (let index = 0; index < 4; index++) opened.push((await warmCall()).query);
    expect(opened[0].closed).toBe(true);
    expect(opened.slice(1).every((query) => !query.closed)).toBe(true);
    expect(warmVoiceLayers()).toBe(3);
  });

  test("an idle layer closes after the warm timeout and reopens on demand", async () => {
    jest.useFakeTimers();
    const { call, query } = await warmCall();
    const events = listen(call);
    armIdle(call);
    jest.advanceTimersByTime(5 * 60_000);
    expect(query.closed).toBe(true);
    expect(call.ended).toBe(false);
    fast.responder = () => "Voltei.";
    await onUtterance(call, "oi de novo");
    expect(fast.queries).toHaveLength(2);
    await until(() => events.some((event) => event.type === "speech.done"), "after reopen");
  });

  test("a busy layer is not evicted by the idle timer", async () => {
    jest.useFakeTimers();
    const { call, query } = await warmCall();
    listen(call);
    armIdle(call);
    fast.responder = () => ({ hold: true });
    await onUtterance(call, "segura");
    await until(() => query.prompts.length === 2, "held");
    jest.advanceTimersByTime(5 * 60_000);
    expect(query.closed).toBe(false);
  });

  test("cancelling drops queued speech, tolerates a failed interrupt and a failing close", async () => {
    fast.responder = () => ({ hold: true });
    const call = await startCall(botOf());
    const query = fast.last();
    listen(call);
    await until(() => query.prompts.length === 1, "warm-up held");
    emitFacts(
      call,
      { type: "turn.started", data: {}, scope: { turnId: "t1" } },
      { type: "turn.settled", data: { outcome: "failed", error: { message: "x" } }, scope: { turnId: "t1" } },
    );
    query.failInterrupt = true;
    await onUtterance(call, "esquece", true);
    expect(query.interrupts).toBe(1);
    await until(() => query.prompts.length === 2, "ack after cancel");
    expect(query.prompts[1]).toBe("PESSOA: esquece");
    expect(query.prompts.some((prompt) => prompt.startsWith("ERRO"))).toBe(false);
    query.failClose = true;
    endCall(call);
    expect(call.ended).toBe(true);
    expect(query.closed).toBe(true);
  });

  test("off Linux the SDK spawns Claude Code itself", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      await startCall(botOf());
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
    expect(fast.last().options.spawnClaudeCodeProcess).toBeUndefined();
  });

  test("an ended call answers nothing", async () => {
    const { call } = await warmCall();
    endCall(call);
    endCall(call);
    call.pending = { interactionId: "i", prompt: "p" };
    expect(await onUtterance(call, "tanto faz")).toEqual({ action: "repeat", interactionId: "i" });
    expect(fast.queries).toHaveLength(1);
  });
});

describe("idle calls and ratings", () => {
  test("a call without listeners ends after the idle timeout", async () => {
    jest.useFakeTimers();
    const { call } = await warmCall();
    const listener = () => undefined;
    call.listeners.add(listener);
    armIdle(call);
    expect(call.idleTimer).toBeNull();
    call.listeners.delete(listener);
    armIdle(call);
    jest.advanceTimersByTime(89_000);
    expect(call.ended).toBe(false);
    jest.advanceTimersByTime(1_000);
    expect(call.ended).toBe(true);
    expect(findCall(call.id)).toBeUndefined();
    armIdle(call);
    expect(call.idleTimer).toBeNull();
  });

  test("ratings go to the live call, the ended call or the bot thread", async () => {
    const bot = botOf();
    const { call } = await warmCall(bot);
    expect(await rateCall(bot, call.id, "up")).toBe(true);
    endCall(call);
    expect(await rateCall(bot, call.id, "down")).toBe(true);
    expect(await rateCall(bot, "call_unknown", null)).toBe(true);
    const rated = (await factsOf(call)).filter((fact) => fact.type === "voice.call.rated");
    expect(rated.map((fact) => fact.data)).toEqual([
      { callId: call.id, rating: "up" },
      { callId: call.id, rating: "down" },
      { callId: "call_unknown", rating: null },
    ]);
    const spy = spyOn(sessions, "getStoredSession").mockReturnValue(undefined);
    try {
      expect(await rateCall(bot, "call_other", "up")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
