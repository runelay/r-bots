import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { fakeProcesses, resetData } from "../../../../test/helpers";
import { mediaTools } from "../../../../test/media-helpers";
import { getDb, tables } from "../../../db";
import { withLanguage } from "../../../shared/i18n";
import type { BotDefinition } from "../../bots/services/bots.service";
import { fileEventOf, uploadGuide, uploadTools } from "../../uploads/services/uploads.service";
import { maxSpeechChars, speechFileName, speechTools, synthesizeSpeech } from "../services/speech-tools.service";

const bot = {
  id: "speech-bot",
  name: "Narrador",
  voice: { voiceId: "BotVoice12345678", speed: 1.1, language: "en" },
} as unknown as BotDefinition;

interface Seen {
  path: string;
  query: string;
  key: string | null;
  body: Record<string, unknown>;
}

const mp3 = Buffer.from("ID3fake-mp3-bytes");
let seen: Seen[] = [];
let reply: () => Response = () => new Response(mp3, { headers: { "content-type": "audio/mpeg" } });

const eleven = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({
      path: url.pathname,
      query: url.search,
      key: req.headers.get("xi-api-key"),
      body: (await req.json()) as Record<string, unknown>,
    });
    return reply();
  },
});

const tool = () => speechTools(bot)[0];
const attachmentRead = () => uploadTools(bot.id)[1];
const signal = new AbortController().signal;

beforeAll(() => {
  process.env.ELEVENLABS_API_URL = eleven.url.toString().replace(/\/$/, "");
});

beforeEach(async () => {
  await resetData();
  await getDb().delete(tables.uploads);
  process.env.ELEVENLABS_API_KEY = "speech-key";
  seen = [];
  reply = () => new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
  fakeProcesses(mediaTools({ probe: { format: { duration: "2.5" }, streams: [{ codec_type: "audio" }] } }).handler);
});

afterAll(() => {
  delete process.env.ELEVENLABS_API_URL;
  delete process.env.ELEVENLABS_API_KEY;
  eleven.stop(true);
});

describe("speech_create", () => {
  test("generates the MP3 with the bot voice and attaches it", async () => {
    const result = (await tool().run({ text: "Olá, mundo.", title: "Resumo da Nota" }, signal)) as {
      uploadId: string;
      name: string;
      path: string;
      fileEvent: unknown;
    };
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/v1/text-to-speech/BotVoice12345678");
    expect(seen[0].query).toContain("output_format=mp3_44100_128");
    expect(seen[0].key).toBe("speech-key");
    expect(seen[0].body).toMatchObject({
      text: "Olá, mundo.",
      model_id: "eleven_multilingual_v2",
      language_code: "en",
      voice_settings: { speed: 1.1 },
    });
    expect(result.name).toMatch(/^resumo-da-nota-\d{8}-\d{6}\.mp3$/);
    expect(result.path).toContain("/audios/");
    expect(readFileSync(result.path)).toEqual(mp3);
    expect(fileEventOf(result)?.type).toBe("file.sent");
    const read = await attachmentRead().run({ uploadId: result.uploadId }, signal);
    expect(read).toMatchObject({ kind: "audio", transcript: "Olá, mundo." });
    expect(seen).toHaveLength(1);
  });

  test("voiceId overrides the bot voice for one call", async () => {
    const result = (await tool().run({ text: "Teste", voiceId: "OtherVoice123456" }, signal)) as { name: string };
    expect(seen[0].path).toBe("/v1/text-to-speech/OtherVoice123456");
    expect(result.name).toMatch(/^audio-/);
  });

  test("works without an abort signal", async () => {
    const { path } = await synthesizeSpeech(bot, { text: "Sem sinal" });
    expect(existsSync(path)).toBe(true);
  });

  test("asks to connect ElevenLabs when there is no key", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await expect(tool().run({ text: "Oi" }, signal)).rejects.toThrow("Configurações › Integrações");
    expect(seen).toHaveLength(0);
  });

  test("surfaces the ElevenLabs error message", async () => {
    reply = () => Response.json({ detail: { message: "quota exceeded" } }, { status: 401 });
    await expect(tool().run({ text: "Oi" }, signal)).rejects.toThrow("401: quota exceeded");
    reply = () => Response.json({ detail: { status: "voice_not_found" } }, { status: 404 });
    await expect(tool().run({ text: "Oi" }, signal)).rejects.toThrow("404: voice_not_found");
    reply = () => Response.json({ detail: "bad text" }, { status: 422 });
    await expect(tool().run({ text: "Oi" }, signal)).rejects.toThrow("422: bad text");
    reply = () => new Response("oops", { status: 500 });
    await expect(tool().run({ text: "Oi" }, signal)).rejects.toThrow("(500)");
  });

  test("rejects an empty audio", async () => {
    reply = () => new Response(new Uint8Array(0));
    await expect(tool().run({ text: "Oi" }, signal)).rejects.toThrow("áudio vazio");
  });

  test("labels, shape and guide", async () => {
    expect(await tool().label({ title: "Nota" })).toBe("Gerar áudio: Nota");
    expect(await tool().label({})).toBe("Gerar áudio");
    expect(await withLanguage("en", () => tool().label({ title: "Note" }))).toBe("Generate audio: Note");
    expect(tool().approval).toBeNull();
    const shape = z.object(tool().shape);
    expect(shape.safeParse({ text: "x".repeat(maxSpeechChars + 1) }).success).toBe(false);
    expect(shape.safeParse({ text: "ok", voiceId: "bad id" }).success).toBe(false);
    expect(shape.safeParse({ text: "ok", voiceId: "GoodVoice1234" }).success).toBe(true);
    expect(tool().description).toContain("http_request");
    expect(uploadGuide).toContain("speech_create");
  });

  test("file names are slugged and timestamped", () => {
    const at = new Date("2026-11-21T16:48:05Z");
    expect(speechFileName("Tradução: parte 1!", at)).toBe("traducao-parte-1-20261121-164805.mp3");
    expect(speechFileName(undefined, at)).toBe("audio-20261121-164805.mp3");
    expect(speechFileName("!!!", at)).toBe("audio-20261121-164805.mp3");
  });
});
