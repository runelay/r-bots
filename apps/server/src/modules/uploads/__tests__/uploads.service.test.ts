import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import * as anydoc from "@firecrawl/anydoc";
import { ulid } from "ulid";
import { waitFor } from "../../../../test/engine-helpers";
import { fakeProcesses, resetData, testDataDir, writeData } from "../../../../test/helpers";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import { connectFakeRunner, fastTimers, fixtureFile, mediaTools, pcmSamples } from "../../../../test/media-helpers";
import { botsDir } from "../../../config/env";
import { getDb, tables } from "../../../db";
import { Req, Res } from "../../../shared/http";
import * as jobsService from "../../jobs/services/jobs.service";
import { getJobView } from "../../jobs/services/jobs.service";
import { blobKeys, getBlobStore, putBlob } from "../../storage/services/storage.service";
import { readUploadRow, saveUploadRow } from "../repositories/uploads.repository";
import { exportsTmpDir, isDenied, macPathAllowed, outboxDir } from "../services/send-file.service";
import {
  attachmentsTitle,
  fileEventOf,
  importBotFile,
  kindOf,
  listUploads,
  prepareAttachments,
  publicUpload,
  readUpload,
  resolveUploads,
  runPrepareJob,
  scribeSlots,
  serveUpload,
  type UploadMeta,
  uploadGuide,
  uploadPath,
  uploadQuotaBytes,
  uploadTools,
} from "../services/uploads.service";

const botId = "up-bot";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let media: ReturnType<typeof mediaTools>;
let warn: Mock<typeof console.warn>;
let fetchSpy: Mock<typeof fetch> | null = null;

function uploadsDir() {
  return join(testDataDir(), "bots", botId, "uploads");
}

function derived(meta: UploadMeta, ...parts: string[]) {
  return join(uploadsDir(), ".derived", meta.uploadId, ...parts);
}

function iso(brand: string) {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}\0\0\0\0${brand}`)]);
}

const magic: Record<string, Buffer> = {
  ".m4a": iso("M4A "),
  ".mov": iso("qt  "),
  ".heic": iso("heic"),
  ".webm": Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("....webm")]),
  ".mp3": Buffer.from("ID3"),
  ".wav": Buffer.from("RIFF\0\0\0\0WAVE"),
  ".ogg": Buffer.from("OggS"),
  ".bmp": Buffer.concat([Buffer.from("BM"), Buffer.alloc(30)]),
};

function outbox(...parts: string[]) {
  return join(testDataDir(), "bots", botId, "outbox", ...parts);
}

function outboxFile(name: string, content: string | Buffer, size?: number) {
  const path = outbox(name);
  mkdirSync(dirname(path), { recursive: true });
  const prefix = typeof content === "string" ? magic[extname(name)] : undefined;
  writeFileSync(path, prefix ? Buffer.concat([prefix, Buffer.from(content)]) : content);
  if (size !== undefined) truncateSync(path, size);
  return path;
}

async function importFixture(name: string, content: string | Buffer, size?: number) {
  return importBotFile(botId, outboxFile(name, content, size));
}

async function craft(fields: Partial<UploadMeta> & Pick<UploadMeta, "name" | "kind" | "mime">, content = "content") {
  const uploadId = ulid();
  const file = `${uploadId}-${fields.name}`;
  const path = join(uploadsDir(), file);
  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, content);
  const meta: UploadMeta = {
    uploadId,
    file,
    size: Buffer.byteLength(content),
    createdAt: new Date().toISOString(),
    source: "user",
    ...fields,
  };
  await storeRow(botId, meta, content);
  return meta;
}

async function storeRow(owner: string, meta: UploadMeta, content: string) {
  const blob = await putBlob(blobKeys(owner).upload(meta.uploadId, meta.name), Buffer.from(content), {
    mime: meta.mime,
    botId: owner,
  });
  await saveUploadRow(owner, meta, { blobKey: blob.key, sha256: blob.sha256, thumbKey: null });
}

function scribeReplies(...replies: Array<Response | Error>) {
  const bodies: FormData[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
    bodies.push(init?.body as FormData);
    const next = replies.shift();
    if (!next) throw new Error("unexpected scribe call");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch);
  return bodies;
}

function ok(text: string) {
  return Response.json({ text });
}

const attachmentRead = () => uploadTools(botId)[1];
const sendFile = () => uploadTools(botId)[0];

beforeEach(async () => {
  await resetData();
  await getDb().delete(tables.uploads);
  await getDb().delete(tables.codeWorkspaces);
  media = mediaTools();
  fakeProcesses(media.handler);
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
  process.env.ELEVENLABS_API_KEY = "test-eleven-key";
});

afterEach(async () => {
  warn.mockRestore();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  delete process.env.ELEVENLABS_API_KEY;
});

describe("helpers", () => {
  test("kindOf classifies by mime and keeps svg as a file", async () => {
    expect(kindOf("image/png", "a.png")).toBe("image");
    expect(kindOf("image/svg+xml", "a.svg")).toBe("file");
    expect(kindOf("image/png", "a.svg")).toBe("file");
    expect(kindOf("video/mp4", "a.mp4")).toBe("video");
    expect(kindOf("audio/mpeg", "a.mp3")).toBe("audio");
    expect(kindOf("application/pdf", "a.pdf")).toBe("file");
  });

  test("attachmentsTitle, fileEventOf and the guide", async () => {
    expect(attachmentsTitle([])).toBe("");
    expect(attachmentsTitle([{ kind: "file", name: "a.txt" }])).toBe("📎 a.txt");
    expect(
      attachmentsTitle([
        { kind: "file", name: "a" },
        { kind: "image", name: "b" },
      ]),
    ).toBe("📎 2 anexos");
    expect(fileEventOf(null)).toBeNull();
    expect(fileEventOf("x")).toBeNull();
    expect(fileEventOf({ other: 1 })).toBeNull();
    const event = { type: "file.sent", data: { attachment: {} } };
    expect(fileEventOf({ fileEvent: event })).toBe(event as never);
    expect(uploadGuide).toContain("send_file");
  });

  test("readUpload rejects bad ids and missing metas; resolveUploads needs all of them", async () => {
    expect(await readUpload(botId, "../etc")).toBeNull();
    expect(await readUpload(botId, ulid())).toBeNull();
    const meta = await craft({ name: "a.txt", kind: "file", mime: "text/plain" });
    expect(await resolveUploads(botId, [meta.uploadId])).toEqual([meta]);
    expect(await resolveUploads(botId, [meta.uploadId, ulid()])).toBeNull();
  });

  test("listUploads sorts newest first and keeps to the bot", async () => {
    expect(await listUploads(botId)).toEqual([]);
    const older = await craft({ name: "a.txt", kind: "file", mime: "text/plain", createdAt: "2026-01-01T00:00:00Z" });
    const newer = await craft({ name: "b.txt", kind: "file", mime: "text/plain", createdAt: "2026-02-01T00:00:00Z" });
    const foreignId = ulid();
    await storeRow(
      "other-bot",
      { ...older, uploadId: foreignId, file: `${foreignId}-a.txt`, createdAt: "2027-01-01T00:00:00Z" },
      "x",
    );
    expect((await listUploads(botId)).map((meta) => meta.uploadId)).toEqual([newer.uploadId, older.uploadId]);
    expect(await readUpload(botId, foreignId)).toBeNull();
  });
});

describe("images", () => {
  test("a rotated large photo gets swapped dimensions, a thumb and a resized model copy", async () => {
    media.options.probe = { streams: [{ codec_type: "video", width: 2000, height: 1000, tags: { rotate: "90" } }] };
    const meta = await importFixture("photo.png", png);
    expect(meta).toMatchObject({ kind: "image", mime: "image/png", width: 1000, height: 2000, thumb: true });
    expect(existsSync(derived(meta, "thumb.jpg"))).toBe(true);
    expect(publicUpload(botId, meta)).toMatchObject({
      thumbUrl: `/bots/${botId}/uploads/${meta.uploadId}/thumb.jpg`,
      width: 1000,
      height: 2000,
      source: "bot",
    });
    const vision = await prepareAttachments(botId, [meta], true);
    expect(vision.images).toEqual([
      { path: derived(meta, "model.jpg"), mime: "image/jpeg", label: "Imagem anexada: photo.png" },
    ]);
    expect(vision.text).toContain(`imagem "photo.png" (1000×2000, 1 KB) vai junto nesta mensagem.`);
    const blind = await prepareAttachments(botId, [meta], false);
    expect(blind.images).toEqual([]);
    expect(blind.text).toContain("Este modelo não recebe a imagem em si");
  });

  test("a small supported image is sent as is and side data rotation also swaps", async () => {
    media.options.probe = {
      streams: [{ codec_type: "video", width: 300, height: 200, side_data_list: [{}, { rotation: -270 }] }],
    };
    const meta = await importFixture("small.jpg", png);
    expect(meta).toMatchObject({ width: 200, height: 300 });
    expect(meta.thumb).toBeUndefined();
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.images).toEqual([{ path: uploadPath(botId, meta), mime: "image/jpeg", label: expect.any(String) }]);
  });

  test("an unreadable heic keeps no dimensions and reports the failed conversion", async () => {
    media.options.failOutput = /(thumb|model)\.jpg$/;
    const meta = await importFixture("scan.heic", "x");
    expect(meta).toMatchObject({ kind: "image", mime: "image/heic" });
    expect(meta.width).toBeUndefined();
    expect(meta.thumb).toBeUndefined();
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.images).toEqual([]);
    expect(prepared.text).toContain("(image/heic, 1 KB) está em");
    expect(prepared.text).toContain("não consegui processar: ffmpeg falhou: ffmpeg failed");
  });

  test("analysis failures are logged and the upload is still registered", async () => {
    await writeData(`bots/${botId}/uploads/.derived`, "blocks the derived dir");
    const meta = await importFixture("old.bmp", "x");
    expect(warn.mock.calls.some((args) => args[0] === "upload analyze failed")).toBe(true);
    expect(await readUpload(botId, meta.uploadId)).toMatchObject({ name: "old.bmp", kind: "image" });
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.text).toContain("não consegui processar");
  });
});

describe("audio", () => {
  test("probes duration, draws a waveform and transcribes with Scribe", async () => {
    media.options.probe = { format: { duration: "65.24" }, streams: [{ codec_type: "audio" }] };
    media.options.pcm = pcmSamples(Array.from({ length: 96 }, (_, index) => (index < 48 ? 20 : 100)));
    const bodies = scribeReplies(ok("  olá mundo  "));
    const meta = await importFixture("voice.m4a", "audio-bytes");
    expect(meta).toMatchObject({ kind: "audio", mime: "audio/mp4", duration: 65.2 });
    expect(meta.waveform).toHaveLength(48);
    expect(Math.max(...(meta.waveform ?? []))).toBe(1);
    expect(publicUpload(botId, meta)).toMatchObject({ duration: 65.2, waveform: meta.waveform });
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.text).toContain(`áudio "voice.m4a" (1:05): [áudio: olá mundo]`);
    expect(bodies[0].get("model_id")).toBe("scribe_v2");
    expect(fetchSpy?.mock.calls[0][0]).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(await readUploadRow(botId, meta.uploadId)).toMatchObject({
      transcript: "olá mundo",
      transcriptSource: "scribe",
    });
    const tool = attachmentRead();
    expect(tool.label({ uploadId: meta.uploadId })).toBe("Ler o áudio de 1:05");
    expect(tool.label({ uploadId: "unknown" })).toBe("Ler o anexo");
    expect(await tool.run({ uploadId: meta.uploadId }, {} as never)).toEqual({
      name: "voice.m4a",
      kind: "audio",
      duration: 65.2,
      transcript: "olá mundo",
    });
  });

  test("silent audio has an empty waveform and a broken decoder has none", async () => {
    media.options.pcm = "";
    scribeReplies(ok(""), ok(""));
    const silent = await importFixture("silent.wav", "a");
    expect(silent.waveform).toEqual([]);
    expect(publicUpload(botId, silent)).not.toHaveProperty("waveform");
    media.options.pcm = null;
    const broken = await importFixture("broken.ogg", "a");
    expect(broken.waveform).toBeUndefined();
    const prepared = await prepareAttachments(botId, [silent, broken], true);
    expect(prepared.text).toContain(`áudio "silent.wav": [áudio sem fala reconhecida]`);
  });

  test("without Scribe and without the Mac the transcription error is reported", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const meta = await importFixture("memo.mp3", "a");
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.text).toContain(
      "não consegui processar: ElevenLabs não está configurado no servidor.; no Mac também falhou: o app do Mac não está aberto",
    );
  });

  test("falls back to the Mac and sends the extracted audio", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const runner = connectFakeRunner([], () => ({ ok: true, result: { text: " pelo mac " } }));
    try {
      const meta = await importFixture("call.mp3", "a");
      const prepared = await prepareAttachments(botId, [meta], true);
      expect(prepared.text).toContain("[áudio: pelo mac]");
      const transcribe = runner.requests.filter((request) => request.op === "transcribe_file");
      expect(transcribe).toHaveLength(1);
      expect(transcribe[0].body).toMatchObject({
        audioBase64: Buffer.from("derived").toString("base64"),
        name: "audio.mp3",
        locale: "pt-BR",
      });
      expect((await readUpload(botId, meta.uploadId))?.transcriptSource).toBe("mac");
    } finally {
      runner.close();
    }
  });

  test("the Mac refuses audio over 25 MB and reports its own failures", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const runner = connectFakeRunner([], () => ({ ok: false, error: "mic busy" }));
    try {
      media.options.outputSize = 26 * 1024 * 1024;
      const big = await importFixture("long.mp3", "a");
      await expect(attachmentRead().run({ uploadId: big.uploadId }, {} as never)).rejects.toThrow(
        "áudio grande demais para mandar ao Mac",
      );
      media.options.outputSize = undefined;
      const small = await importFixture("short.mp3", "a");
      await expect(attachmentRead().run({ uploadId: small.uploadId }, {} as never)).rejects.toThrow("mic busy");
    } finally {
      runner.close();
    }
  });

  test("uses a transcript another reader already saved", async () => {
    const meta = await craft({ name: "saved.mp3", kind: "audio", mime: "audio/mpeg", transcript: "já salvo" });
    const stale = { ...meta, transcript: undefined };
    const prepared = await prepareAttachments(botId, [stale], true);
    expect(prepared.text).toContain("[áudio: já salvo]");
  });

  test("concurrent reads share one transcription and Scribe runs one request at a time", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    let firstCall: () => void = () => undefined;
    const firstCalled = new Promise<void>((resolve) => {
      firstCall = resolve;
    });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      active++;
      peak = Math.max(peak, active);
      firstCall();
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return ok(`texto ${releases.length}`);
    }) as unknown as typeof fetch);
    const one = await craft({ name: "one.mp3", kind: "audio", mime: "audio/mpeg" });
    const two = await craft({ name: "two.mp3", kind: "audio", mime: "audio/mpeg" });
    const tool = attachmentRead();
    const reads = [
      tool.run({ uploadId: one.uploadId }, {} as never),
      tool.run({ uploadId: one.uploadId }, {} as never),
      tool.run({ uploadId: two.uploadId }, {} as never),
    ];
    await firstCalled;
    await waitFor(() => scribeSlots().waiting === 1);
    expect(scribeSlots().active).toBe(1);
    expect(releases).toHaveLength(1);
    releases[0]();
    while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
    releases[1]();
    const results = (await Promise.all(reads)) as Array<{ transcript: string }>;
    expect(results[0].transcript).toBe(results[1].transcript);
    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(peak).toBe(1);
  });
});

describe("scribe retries", () => {
  test("retries network errors and rate limits, then gives up after the last delay", async () => {
    const timers = fastTimers(1000);
    try {
      scribeReplies(
        new Error("socket hang up"),
        new Response("slow down", { status: 429, headers: { "retry-after": "20" } }),
        new Response("busy", { status: 503, headers: { "retry-after": new Date(Date.now() + 60_000).toUTCString() } }),
        new Response("oops", { status: 500, headers: { "retry-after": "soon" } }),
      );
      const meta = await craft({ name: "retry.mp3", kind: "audio", mime: "audio/mpeg" });
      await expect(attachmentRead().run({ uploadId: meta.uploadId }, {} as never)).rejects.toThrow(
        "Scribe não transcreveu: 500 oops",
      );
      expect(timers.delays.filter((ms) => ms < 60_000)).toHaveLength(3);
      expect(timers.delays[1]).toBeGreaterThanOrEqual(20_000);
      expect(timers.delays[2]).toBe(30_000);
    } finally {
      timers.restore();
    }
  });

  test("recovers after a rate limit", async () => {
    const timers = fastTimers(1000);
    try {
      scribeReplies(new Response("wait", { status: 429 }), ok("depois"));
      const meta = await craft({ name: "later.mp3", kind: "audio", mime: "audio/mpeg" });
      expect(await attachmentRead().run({ uploadId: meta.uploadId }, {} as never)).toMatchObject({
        transcript: "depois",
      });
    } finally {
      timers.restore();
    }
  });

  test("moves to the fallback model on a rejected request and fails after both", async () => {
    process.env.UPLOAD_STT_MODEL = "scribe_custom";
    try {
      const bodies = scribeReplies(new Response("bad", { status: 400 }), ok("v1"));
      const meta = await craft({ name: "model.mp3", kind: "audio", mime: "audio/mpeg" });
      expect(await attachmentRead().run({ uploadId: meta.uploadId }, {} as never)).toMatchObject({
        transcript: "v1",
      });
      expect(bodies.map((body) => body.get("model_id"))).toEqual(["scribe_custom", "scribe_v1"]);
    } finally {
      delete process.env.UPLOAD_STT_MODEL;
    }
    scribeReplies(new Response("bad", { status: 422 }), new Response("worse", { status: 422 }));
    const other = await craft({ name: "both.mp3", kind: "audio", mime: "audio/mpeg" });
    await expect(attachmentRead().run({ uploadId: other.uploadId }, {} as never)).rejects.toThrow(
      "Scribe não transcreveu: 422 worse",
    );
  });

  test("does not retry an auth failure", async () => {
    scribeReplies(new Response("nope", { status: 401 }));
    const meta = await craft({ name: "auth.mp3", kind: "audio", mime: "audio/mpeg" });
    await expect(attachmentRead().run({ uploadId: meta.uploadId }, {} as never)).rejects.toThrow(
      "Scribe não transcreveu: 401 nope",
    );
    expect(fetchSpy?.mock.calls).toHaveLength(1);
  });
});

describe("video", () => {
  test("extracts a thumb, key frames and the spoken audio", async () => {
    media.options.probe = {
      format: { duration: "60" },
      streams: [
        { codec_type: "video", width: 1920, height: 1080 },
        { codec_type: "audio", duration: "60" },
      ],
    };
    media.options.pcm = pcmSamples([10, 20, 30]);
    media.options.failOutput = /frames\/03\.jpg$/;
    const bodies = scribeReplies(ok("fala do vídeo"));
    const meta = await importFixture("clip.mov", "video-bytes");
    expect(meta).toMatchObject({ kind: "video", mime: "video/quicktime", width: 1920, height: 1080, duration: 60 });
    expect(meta.thumb).toBe(true);
    const thumbCall = media.calls.find((call) => call.args.at(-1)?.endsWith("thumb.jpg"));
    expect(thumbCall?.args.slice(3, 5)).toEqual(["-ss", "0.5"]);
    const vision = await prepareAttachments(botId, [meta], true);
    expect(vision.images).toHaveLength(9);
    expect(vision.images[0]).toMatchObject({ mime: "image/jpeg", label: `Quadro de "clip.mov" em 0:03` });
    expect(vision.text).toContain(`vídeo "clip.mov", duração 1:00, 1920×1080. Áudio: [áudio: fala do vídeo]`);
    expect(vision.text).toContain("Seguem 9 quadros-chave em ordem");
    expect(bodies).toHaveLength(1);
    expect(existsSync(derived(meta, "audio.mp3"))).toBe(true);
    const blind = await prepareAttachments(botId, [meta], false);
    expect(blind.text).toContain(`Quadros-chave extraídos em ${derived(meta)}/frames`);
  });

  test("a silent clip without duration gets one frame and no audio line", async () => {
    media.options.probe = { streams: [{ codec_type: "video" }] };
    const meta = await importFixture("mute.webm", "v");
    expect(meta.duration).toBeUndefined();
    expect(meta.width).toBeUndefined();
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.images).toHaveLength(1);
    expect(prepared.text).toContain(`vídeo "mute.webm", duração 0:00. Sem faixa de áudio. Seguem 1 quadros-chave`);
  });

  test("a clip whose frames and transcription fail still describes the audio track", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const meta = await craft({
      name: "noisy.mkv",
      kind: "video",
      mime: "video/x-matroska",
      duration: 3,
      waveform: [0.5, 1],
    });
    media.options.failOutput = /\.(jpg|mp3)$/;
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.images).toEqual([]);
    expect(prepared.text).toContain("duração 0:03. Áudio sem fala reconhecida. Arquivo:");
    await expect(attachmentRead().run({ uploadId: meta.uploadId }, {} as never)).rejects.toThrow("ffmpeg falhou");
  });
});

describe("documents", () => {
  test("text files are inlined, normalized and truncated past the limit", async () => {
    const timers = fastTimers(50_000);
    try {
      const notes = await importFixture("notes.md", "linha 1\r\n\n\n\n\n\nlinha 2");
      const long = await importFixture("long.log", "x".repeat(60_010));
      const prepared = await prepareAttachments(botId, [notes, long], true);
      expect(prepared.text).toContain(`arquivo "notes.md" (1 KB). Arquivo: ${uploadPath(botId, notes)}. Conteúdo:`);
      expect(prepared.text).toContain("<<<\nlinha 1\n\n\nlinha 2\n>>>");
      expect(prepared.text).toContain("(cortado em 60000 caracteres; leia o resto com attachment_read)");
      expect(timers.delays).toContain(60_000);
    } finally {
      timers.restore();
    }
  });

  test("attachment_read pages through text and describes files without text", async () => {
    const notes = await importFixture("data.json", '{"a":1,"b":2}');
    const tool = attachmentRead();
    expect(tool.label({ uploadId: notes.uploadId })).toBe("Ler data.json");
    expect(await tool.run({ uploadId: notes.uploadId, offset: 2, limit: 3 }, {} as never)).toEqual({
      name: "data.json",
      offset: 2,
      total: 13,
      truncated: true,
      text: 'a":',
    });
    const zip = await importFixture("bundle.zip", "PK\u0003\u0004zzzz");
    expect(await tool.run({ uploadId: zip.uploadId }, {} as never)).toMatchObject({
      name: "bundle.zip",
      mime: "application/zip",
      kind: "file",
      text: null,
      path: uploadPath(botId, zip),
    });
    const image = await craft({ name: "pic.png", kind: "image", mime: "image/png" });
    expect(await tool.run({ uploadId: image.uploadId }, {} as never)).toMatchObject({ text: null });
    await expect(tool.run({ uploadId: ulid() }, {} as never)).rejects.toThrow("Anexo não encontrado.");
    const prepared = await prepareAttachments(botId, [zip], true);
    expect(prepared.text).toContain(`(application/zip, 1 KB) está em ${uploadPath(botId, zip)}. Use attachment_read`);
  });

  test("office documents become markdown with their images", async () => {
    const toMarkdown = spyOn(anydoc, "toMarkdownBytes").mockResolvedValue("# Relatório");
    const big = (head: Buffer) => Buffer.concat([head, Buffer.alloc(3000, 0)]);
    const toDocument = spyOn(anydoc, "toDocument").mockResolvedValue({
      blocks: [],
      notes: [],
      assets: [
        { id: 0, mediaType: "image/png", originPart: "a", data: big(png) },
        { id: 1, mediaType: "image/webp", originPart: "b", data: big(Buffer.from("RIFF\0\0\0\0WEBP")) },
        { id: 2, mediaType: "image/gif", originPart: "c", data: big(Buffer.from("GIF89a")) },
        { id: 3, mediaType: "image/jpeg", originPart: "d", data: big(Buffer.from([0xff, 0xd8, 0xff])) },
        { id: 4, mediaType: "image/png", originPart: "e", data: Buffer.alloc(10) },
        { id: 5, mediaType: "text/plain", originPart: "f", data: big(png) },
        { id: 6, mediaType: "image/png", originPart: "g", data: Buffer.alloc(3000, 0x41) },
      ],
    });
    try {
      media.options.probe = (path) =>
        path.endsWith("00.src")
          ? { streams: [{ codec_type: "video", width: 800, height: 600 }] }
          : path.endsWith("01.src")
            ? { streams: [{ codec_type: "video", width: 3000, height: 2000 }] }
            : null;
      media.options.failOutput = /doc-images\/03\.jpg$/;
      const meta = await importFixture("report.docx", "PK-docx", 5 * 1024 * 1024);
      const vision = await prepareAttachments(botId, [meta], true);
      expect(toMarkdown.mock.calls[0][1]).toBe("docx" as never);
      expect(vision.text).toContain(`arquivo "report.docx" (5,0 MB). Arquivo: ${uploadPath(botId, meta)}.`);
      expect(vision.text).toContain("As 3 primeiras imagens do documento vão junto, em ordem. Conteúdo em markdown:");
      expect(vision.images).toEqual([
        { path: derived(meta, "doc-images", "00.png"), mime: "image/png", label: `Imagem 1 de "report.docx"` },
        { path: derived(meta, "doc-images", "01.jpg"), mime: "image/jpeg", label: `Imagem 2 de "report.docx"` },
        { path: derived(meta, "doc-images", "02.jpg"), mime: "image/jpeg", label: `Imagem 3 de "report.docx"` },
      ]);
      expect(existsSync(derived(meta, "doc-images", "00.src"))).toBe(false);
      const blind = await prepareAttachments(botId, [meta], false);
      expect(blind.text).toContain(`O documento tem imagens, salvas em ${derived(meta)}/doc-images`);
      expect(blind.images).toEqual([]);
      expect(JSON.parse(await readFile(derived(meta, "prepared.json"), "utf8"))).toMatchObject({
        converter: "anydoc",
      });
    } finally {
      toMarkdown.mockRestore();
      toDocument.mockRestore();
    }
  });

  test("documents without usable images or with unreadable packages keep only the text", async () => {
    const toMarkdown = spyOn(anydoc, "toMarkdownBytes").mockResolvedValue("slides");
    const toDocument = spyOn(anydoc, "toDocument")
      .mockResolvedValueOnce({ blocks: [], notes: [], assets: [] })
      .mockRejectedValueOnce(new Error("bad zip"));
    try {
      const empty = await importFixture("deck.pptx", "x");
      const broken = await importFixture("sheet.xlsx", "x");
      const prepared = await prepareAttachments(botId, [empty, broken], true);
      expect(prepared.images).toEqual([]);
      expect(prepared.text).not.toContain("imagens");
    } finally {
      toMarkdown.mockRestore();
      toDocument.mockRestore();
    }
  });

  test("a PDF that anydoc cannot read falls back to pdftotext, then to nothing", async () => {
    const toMarkdown = spyOn(anydoc, "toMarkdownBytes").mockRejectedValue(
      Object.assign(new Error("pages need OCR"), { code: "needsOcr" }),
    );
    try {
      media.options.pdfText = "texto do pdf";
      const pdf = await importFixture("scan.pdf", "%PDF-1.4 fake");
      const prepared = await prepareAttachments(botId, [pdf], true);
      expect(prepared.text).toContain("Conteúdo:\n<<<\ntexto do pdf\n>>>");
      expect(warn.mock.calls.some((args) => String(args[0]).includes("anydoc failed for scan.pdf: needsOcr"))).toBe(
        true,
      );
      toMarkdown.mockRejectedValue("plain failure");
      media.options.pdfText = null;
      const broken = await importFixture("broken.pdf", "%PDF-1.4 fake");
      const failed = await prepareAttachments(botId, [broken], true);
      expect(failed.text).toContain("Use attachment_read");
      expect(await attachmentRead().run({ uploadId: broken.uploadId }, {} as never)).toMatchObject({
        name: "broken.pdf",
        text: null,
      });
    } finally {
      toMarkdown.mockRestore();
    }
  });

  test("a document whose image folder cannot be created keeps only the text", async () => {
    const toMarkdown = spyOn(anydoc, "toMarkdownBytes").mockResolvedValue("texto");
    const toDocument = spyOn(anydoc, "toDocument").mockResolvedValue({
      blocks: [],
      notes: [],
      assets: [{ id: 0, mediaType: "image/png", originPart: "a", data: Buffer.alloc(3000, 1) }],
    });
    try {
      const meta = await craft({ name: "memo.odt", kind: "file", mime: "application/vnd.oasis.opendocument.text" });
      await writeData(`bots/${botId}/uploads/.derived/${meta.uploadId}/doc-images`, "blocks the folder");
      const prepared = await prepareAttachments(botId, [meta], true);
      expect(prepared.images).toEqual([]);
      expect(prepared.text).toContain("<<<\ntexto\n>>>");
    } finally {
      toMarkdown.mockRestore();
      toDocument.mockRestore();
    }
  });

  test("a csv that converts to nothing is read as plain text", async () => {
    const toMarkdown = spyOn(anydoc, "toMarkdownBytes").mockResolvedValue("   ");
    try {
      const csv = await importFixture("table.csv", "a,b\n1,2");
      const prepared = await prepareAttachments(botId, [csv], true);
      expect(prepared.text).toContain("<<<\na,b\n1,2\n>>>");
      expect(toMarkdown.mock.calls[0][1]).toBe("csv" as never);
    } finally {
      toMarkdown.mockRestore();
    }
  });

  test("a cached preparation is reused", async () => {
    const meta = await craft({ name: "cached.txt", kind: "file", mime: "text/plain" });
    await writeData(`bots/${botId}/uploads/.derived/${meta.uploadId}/prepared.json`, {
      text: "do cache",
      converter: "text",
    });
    const prepared = await prepareAttachments(botId, [meta], true);
    expect(prepared.text).toContain("<<<\ndo cache\n>>>");
    expect(await prepareAttachments(botId, [], true)).toEqual({ text: "", images: [] });
  });
});

describe("importBotFile", () => {
  test("sends a file from the outbox under a chosen name through send_file without approval", async () => {
    const path = outboxFile("out/result.csv", "a,b");
    const tool = sendFile();
    expect(tool.description).toContain(outboxDir(botId));
    expect(tool.label({ path })).toBe("Enviar result.csv");
    expect(tool.label({ path, name: "final.csv" })).toBe("Enviar final.csv");
    expect(tool.label({})).toBe("Enviar arquivo");
    expect(await tool.approval?.({ path })).toBeNull();
    const output = (await tool.run({ path, name: " Relatório: final?.csv " }, {} as never)) as Record<string, unknown>;
    expect(output).toMatchObject({ name: "Relatório- final-.csv", kind: "file", size: 3 });
    expect(fileEventOf(output)?.data.attachment).toMatchObject({ name: "Relatório- final-.csv", source: "bot" });
    const plain = (await tool.run({ path }, {} as never)) as Record<string, unknown>;
    expect(plain.name).toBe("result.csv");
    await prepareAttachments(botId, await listUploads(botId), true);
  });

  test("asks a person before sending anything outside the outbox", async () => {
    const tool = sendFile();
    expect(await tool.approval?.({ path: "/etc/passwd" })).toBe("Posso enviar passwd (/etc/passwd) na conversa?");
    expect(await tool.approval?.({ path: `${outbox()}/../uploads/a.txt` })).toContain("Posso enviar a.txt");
    expect(await tool.approval?.({})).toBe("Posso enviar arquivo () na conversa?");
    expect(tool.humanReason?.({ path: "/etc/passwd" })).toContain("sempre passa por uma pessoa");
    expect(tool.humanReason?.({})).toContain("sempre passa por uma pessoa");
    expect(tool.humanReason?.({ path: `${outbox()}/report.pdf` })).toBeNull();
  });

  test("takes the type from the bytes, not from the name", async () => {
    const page = await importFixture("photo.png", "<!doctype html><script>alert(1)</script>");
    expect(page).toMatchObject({ mime: "text/html", kind: "file" });
    const disguised = await importFixture("notes.txt", png);
    expect(disguised).toMatchObject({ mime: "image/png", kind: "image" });
    const binary = await importFixture("blob.txt", Buffer.from([0, 1, 2, 3]));
    expect(binary).toMatchObject({ mime: "application/octet-stream", kind: "file" });
  });

  test("refuses paths outside the bot areas, protected files, links, folders and huge files", async () => {
    await expect(importBotFile(botId, "/etc/passwd")).rejects.toThrow("/etc/passwd está fora das pastas");
    await expect(importBotFile(botId, fixtureFile("loose.txt", "x"))).rejects.toThrow("está fora das pastas");
    await expect(importBotFile(botId, outboxFile("app/.env", "SECRET=1"))).rejects.toThrow("Esse arquivo é protegido.");
    await expect(importBotFile(botId, outbox("app"))).rejects.toThrow("Isso não é um arquivo.");
    await expect(importBotFile(botId, outboxFile("empty.txt", ""))).rejects.toThrow("O arquivo está vazio.");
    await expect(importBotFile(botId, outboxFile("huge.bin", "", 100 * 1024 * 1024 + 1))).rejects.toThrow(
      "O arquivo passa de 100 MB.",
    );
    symlinkSync("/etc/passwd", outbox("passwd-link"));
    await expect(importBotFile(botId, outbox("passwd-link"))).rejects.toThrow("Esse caminho é um atalho (symlink)");
    symlinkSync("/etc", outbox("etc-dir"));
    await expect(importBotFile(botId, outbox("etc-dir", "hostname"))).rejects.toThrow(
      "O arquivo saiu da pasta de saída do bot por um atalho.",
    );
    await expect(importBotFile(botId, join(outboxFile("plain.txt", "x"), "child"))).rejects.toThrow(
      "Não consegui abrir",
    );
    const foreign = join(botsDir, "other-bot", "uploads", "secret.txt");
    mkdirSync(dirname(foreign), { recursive: true });
    writeFileSync(foreign, "x");
    await expect(importBotFile(botId, foreign)).rejects.toThrow("Esse arquivo é protegido.");
  });

  test("sends from the bot uploads, its live worktrees and its export folder", async () => {
    const live = join(testDataDir(), "wt-live");
    const closed = join(testDataDir(), "wt-closed");
    for (const dir of [live, closed]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(live, "build.txt"), "ok");
    writeFileSync(join(closed, "old.txt"), "ok");
    const base = { repo: "r", repoName: "r", branch: "b", createdAt: new Date().toISOString() };
    await getDb()
      .insert(tables.codeWorkspaces)
      .values([
        { ...base, id: "wt1", botId, path: live, status: "alive" },
        { ...base, id: "wt2", botId, path: closed, status: "closed" },
        { ...base, id: "wt3", botId: "other-bot", path: join(testDataDir(), "fixtures"), status: "alive" },
      ]);
    expect((await importBotFile(botId, join(live, "build.txt"))).name).toBe("build.txt");
    await expect(importBotFile(botId, join(closed, "old.txt"))).rejects.toThrow("está fora das pastas");
    await expect(importBotFile(botId, fixtureFile("theirs.txt", "x"))).rejects.toThrow("está fora das pastas");
    const exported = join(exportsTmpDir(botId), "relatorio.txt");
    mkdirSync(dirname(exported), { recursive: true });
    writeFileSync(exported, "pdf");
    try {
      expect((await importBotFile(botId, exported)).name).toBe("relatorio.txt");
    } finally {
      await rm(exportsTmpDir(botId), { recursive: true, force: true });
    }
    const shot = join(testDataDir(), "bots", botId, "browser", "shots", "a.png");
    mkdirSync(dirname(shot), { recursive: true });
    writeFileSync(shot, png);
    expect((await importBotFile(botId, shot)).mime).toBe("image/png");
    const first = await importFixture("again.txt", "x");
    expect((await importBotFile(botId, uploadPath(botId, first))).name).toBe(first.file);
  });

  test("hard-denies secrets, other bots and system folders", async () => {
    const data = testDataDir();
    expect(await isDenied(botId, join(data, "secrets", "postgres.password"))).toBe(true);
    expect(await isDenied(botId, join(data, "vault.key"))).toBe(true);
    expect(await isDenied(botId, join(data, "runner.token"))).toBe(true);
    expect(await isDenied(botId, join(data, "blobs", "bots", botId, "x"))).toBe(true);
    expect(await isDenied(botId, join(botsDir, "other-bot", "outbox", "a.txt"))).toBe(true);
    expect(await isDenied(botId, "/proc/self/environ")).toBe(true);
    expect(await isDenied(botId, "/backups/dump.sql")).toBe(true);
    expect(await isDenied(botId, join(String(process.env.BOTS_BACKUP_DIR), "x"))).toBe(true);
    expect(await isDenied(botId, "/repo/.git/config")).toBe(true);
    expect(await isDenied(botId, outbox("a.txt"))).toBe(false);
    const saved = process.env.BOTS_BACKUP_DIR;
    delete process.env.BOTS_BACKUP_DIR;
    try {
      expect(await isDenied(botId, "/srv/file.txt")).toBe(false);
    } finally {
      process.env.BOTS_BACKUP_DIR = saved;
    }
  });

  test("refuses when the opened file cannot be traced back to its real path", async () => {
    const path = outboxFile("trace.txt", "x");
    const readlink = spyOn(fsPromises, "readlink").mockRejectedValue(new Error("no proc"));
    try {
      await expect(importBotFile(botId, path)).rejects.toThrow("Não consegui conferir onde o arquivo está.");
    } finally {
      readlink.mockRestore();
    }
  });

  test("keeps each bot inside its upload quota", async () => {
    process.env.BOTS_UPLOAD_QUOTA_MB = "0.00001";
    try {
      expect(uploadQuotaBytes()).toBe(0.00001 * 1024 * 1024);
      await importFixture("small.txt", "1234");
      await expect(importFixture("more.txt", "123456789")).rejects.toThrow("O espaço de anexos deste bot acabou.");
      process.env.BOTS_UPLOAD_QUOTA_MB = "nada";
      expect(uploadQuotaBytes()).toBe(5000 * 1024 * 1024);
    } finally {
      delete process.env.BOTS_UPLOAD_QUOTA_MB;
    }
  });

  test("explains a missing file depending on the Mac connection", async () => {
    const missing = outbox("nope.txt");
    await expect(importBotFile(botId, missing)).rejects.toThrow("e o Mac está desconectado.");
    const runner = connectFakeRunner(["vault"]);
    try {
      await expect(importBotFile(botId, missing)).rejects.toThrow("ainda não sabe enviar arquivos");
    } finally {
      runner.close();
    }
  });

  test("only reads Downloads, Desktop, Documents and /tmp on the Mac", async () => {
    expect(macPathAllowed("~/Downloads/a.pdf")).toBe(true);
    expect(macPathAllowed("/Users/p/Documents/sub/a.pdf")).toBe(true);
    expect(macPathAllowed("/private/tmp/a.txt")).toBe(true);
    expect(macPathAllowed("/Users/p/Library/a.txt")).toBe(false);
    expect(macPathAllowed("/Users/p/Downloads/../.ssh/id_rsa")).toBe(false);
    expect(macPathAllowed("/Users/p/Desktop/./x")).toBe(false);
    expect(macPathAllowed("/Users/p/Desktop/app/.env")).toBe(false);
    expect(macPathAllowed("/Users/p/Desktop")).toBe(false);
  });

  test("pulls a missing file from the Mac when it can send files", async () => {
    const replies = [
      { ok: true, result: { path: "/Users/p/Desktop/foto.txt", name: "foto.txt", base64: "aGVsbG8=" } },
      { ok: true, result: { path: "/Users/p/Desktop/semnome.txt", name: "", base64: "eA==" } },
      { ok: true, result: {} },
      { ok: false, error: "sem permissão" },
      { ok: false },
      { ok: true, result: { path: "/Users/p/Downloads/big.txt", name: "big.txt", base64: "MTIzNDU2Nzg5MA==" } },
    ];
    const runner = connectFakeRunner(["files"], (op) =>
      op === "file.read" ? (replies.shift() ?? { ok: false }) : { ok: true },
    );
    const reads = () => runner.requests.filter((item) => item.op === "file.read");
    try {
      expect(await sendFile().approval?.({ path: "/Users/p/Desktop/foto.txt" })).toContain("Posso enviar foto.txt");
      const first = await importBotFile(botId, "/Users/p/Desktop/foto.txt");
      expect(first).toMatchObject({ name: "foto.txt", size: 5, source: "bot", mime: "text/plain" });
      expect(await readFile(uploadPath(botId, first), "utf8")).toBe("hello");
      expect(reads()[0]).toEqual({
        op: "file.read",
        body: { path: "/Users/p/Desktop/foto.txt", maxBytes: 20 * 1024 * 1024 },
      });
      expect((await importBotFile(botId, "/Users/p/Desktop/semnome.txt")).name).toBe("semnome.txt");
      expect((await importBotFile(botId, "/Users/p/Documents/x.bin", "renomeado.txt")).name).toBe("renomeado.txt");
      await expect(importBotFile(botId, "/Users/p/Downloads/a.txt")).rejects.toThrow("sem permissão");
      await expect(importBotFile(botId, "/tmp/runelay-missing/b.txt")).rejects.toThrow("O Mac não enviou o arquivo.");
      await expect(importBotFile(botId, "/Users/p/.ssh/id_rsa")).rejects.toThrow(
        "No Mac só posso enviar arquivos de Downloads, Mesa, Documentos ou /tmp.",
      );
      expect(reads()).toHaveLength(5);
      process.env.BOTS_UPLOAD_QUOTA_MB = "0.00001";
      try {
        await expect(importBotFile(botId, "/Users/p/Downloads/big.txt")).rejects.toThrow("O espaço de anexos");
      } finally {
        delete process.env.BOTS_UPLOAD_QUOTA_MB;
      }
      await prepareAttachments(botId, await listUploads(botId), true);
    } finally {
      runner.close();
    }
  });
});

describe("storage", () => {
  test("a read whose storage fails is treated as missing and logged", async () => {
    const meta = await craft({ name: "lost.txt", kind: "file", mime: "text/plain" });
    await rm(uploadPath(botId, meta));
    const get = spyOn(getBlobStore(), "get").mockRejectedValue(new Error("storage offline"));
    try {
      expect(await readUpload(botId, meta.uploadId)).toBeNull();
    } finally {
      get.mockRestore();
    }
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes(`upload ${meta.uploadId} could not be fetched`)),
    ).toBe(true);
  });

  test("a stored thumb is brought back with the file", async () => {
    media.options.probe = { streams: [{ codec_type: "video", width: 2000, height: 1000 }] };
    const meta = await importFixture("wide.png", png);
    expect((await readUploadRow(botId, meta.uploadId))?.thumbKey).toBe(
      blobKeys(botId).derived(meta.uploadId, "thumb.jpg"),
    );
    await prepareAttachments(botId, [meta], false);
    await rm(join(uploadsDir(), ".derived"), { recursive: true, force: true });
    await rm(uploadPath(botId, meta));
    expect(await readUpload(botId, meta.uploadId)).toMatchObject({ thumb: true });
    expect(existsSync(derived(meta, "thumb.jpg"))).toBe(true);
    expect(existsSync(uploadPath(botId, meta))).toBe(true);
  });

  test("an upload that cannot be stored is dropped with a retry message", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const put = spyOn(getBlobStore(), "put").mockRejectedValue(new Error("bucket full"));
    try {
      await expect(importFixture("note.txt", "texto")).rejects.toMatchObject({
        message: "Não consegui guardar o arquivo agora. Tente de novo.",
        status: 503,
      });
      expect(error.mock.calls[0][0]).toBe("upload storage failed");
    } finally {
      put.mockRestore();
      error.mockRestore();
    }
    expect(await listUploads(botId)).toEqual([]);
  });
});

describe("serveUpload", () => {
  async function serve(meta: { uploadId: string } | string, variant?: string, headers: Record<string, string> = {}) {
    const id = typeof meta === "string" ? meta : meta.uploadId;
    const method = headers["x-method"] ?? "GET";
    const req = new Req(new Request(`http://gateway.local/bots/${botId}/uploads/${id}`, { method, headers }));
    const res = new Res(new AbortController().signal);
    await serveUpload(req, res, botId, id, variant);
    const response = await res.response;
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  test("serves the file with safe headers, the thumb and the meta", async () => {
    const page = await craft({ name: "page.html", kind: "file", mime: "text/html" }, "<h1>oi</h1>");
    const full = await serve(page);
    expect(full.status).toBe(200);
    expect(full.text).toBe("<h1>oi</h1>");
    expect(full.headers.get("content-type")).toBe("application/octet-stream");
    expect(full.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    );
    expect(full.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    const meta = await serve(page, "meta");
    expect(JSON.parse(meta.text)).toMatchObject({ uploadId: page.uploadId, name: "page.html" });
    expect((await serve(page, "thumb.jpg")).status).toBe(404);
    await writeData(`bots/${botId}/uploads/.derived/${page.uploadId}/thumb.jpg`, "jpeg");
    const thumb = await serve(page, "thumb.jpg");
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(thumb.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''page.html");
    expect(thumb.text).toBe("jpeg");
    expect((await serve(page, "other")).status).toBe(404);
    expect((await serve(ulid())).status).toBe(404);
    const head = await serve(page, undefined, { "x-method": "HEAD" });
    expect(head.headers.get("content-length")).toBe("11");
    expect(head.text).toBe("");
  });

  test("serves only safe media inline and everything else as a download", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["a.png", "image/png", "image/png", "inline"],
      ["a.avif", "image/avif", "image/avif", "inline"],
      ["a.mp3", "audio/mpeg", "audio/mpeg", "inline"],
      ["a.mp4", "video/mp4", "video/mp4", "inline"],
      ["a.pdf", "application/pdf", "application/pdf", "inline"],
      ["a.svg", "image/svg+xml", "application/octet-stream", "attachment"],
      ["a.xhtml", "application/xhtml+xml", "application/octet-stream", "attachment"],
      ["a.xml", "text/xml", "application/octet-stream", "attachment"],
      ["a.js", "text/javascript", "application/octet-stream", "attachment"],
      ["a.css", "text/css", "application/octet-stream", "attachment"],
      ["a.md", "text/markdown", "text/plain; charset=utf-8", "attachment"],
      ["a.json", "application/json", "text/plain; charset=utf-8", "attachment"],
      ["a.bmp", "image/bmp", "image/bmp", "attachment"],
      ["a.zip", "application/zip", "application/zip", "attachment"],
      ["a.bin", "", "application/octet-stream", "attachment"],
    ];
    for (const [name, mime, served, disposition] of cases) {
      const meta = await craft({ name, kind: "file", mime }, "x");
      const sent = await serve(meta);
      expect([name, sent.headers.get("content-type")]).toEqual([name, served]);
      expect(sent.headers.get("content-disposition")).toStartWith(`${disposition};`);
      expect(sent.headers.get("content-security-policy")).toStartWith("sandbox;");
      expect(sent.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("answers byte ranges", async () => {
    const meta = await craft({ name: "digits.txt", kind: "file", mime: "text/plain" }, "0123456789");
    const middle = await serve(meta, undefined, { range: "bytes=2-4" });
    expect(middle.status).toBe(206);
    expect(middle.text).toBe("234");
    expect(middle.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(middle.headers.get("content-length")).toBe("3");
    expect((await serve(meta, undefined, { range: "bytes=-3" })).text).toBe("789");
    expect((await serve(meta, undefined, { range: "bytes=7-" })).text).toBe("789");
    expect((await serve(meta, undefined, { range: "bytes=5-99" })).text).toBe("56789");
    const unsatisfiable = await serve(meta, undefined, { range: "bytes=20-" });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
    const ignored = await serve(meta, undefined, { range: "bytes=-" });
    expect(ignored.status).toBe(200);
    const head = await serve(meta, undefined, { range: "bytes=0-1", "x-method": "HEAD" });
    expect(head.status).toBe(206);
    expect(head.text).toBe("");
  });

  test("restores a missing local copy from storage and 404s when storage lost it too", async () => {
    const meta = await craft({ name: "gone.txt", kind: "file", mime: "text/plain" }, "guardado");
    await rm(uploadPath(botId, meta));
    const restored = await serve(meta);
    expect(restored.status).toBe(200);
    expect(restored.text).toBe("guardado");
    await rm(uploadPath(botId, meta));
    await getBlobStore().delete(blobKeys(botId).upload(meta.uploadId, meta.name));
    expect((await serve(meta)).status).toBe(404);
  });
});

describe("prepare job", () => {
  let jobs: TestJobs;

  beforeAll(async () => {
    jobs = await startTestJobs();
  }, 30_000);

  afterAll(async () => {
    await jobs.stop();
  }, 30_000);

  test("queues the preparation of a new upload and retries it when Scribe fails", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const meta = await importFixture("fila.mp3", "a");
    await waitFor(async () => (await getJobView(`prepare-${botId}-${meta.uploadId}`)) !== null);
    await expect(runPrepareJob({ botId, uploadId: meta.uploadId })).rejects.toThrow("não está configurado");
    process.env.ELEVENLABS_API_KEY = "test-eleven-key";
    scribeReplies(ok("de novo"));
    expect(await runPrepareJob({ botId, uploadId: meta.uploadId })).toEqual({ skipped: false });
    expect(await runPrepareJob({ botId, uploadId: "sumiu" })).toEqual({ skipped: true });
  });

  test("prepares in process when the queue refuses the job", async () => {
    const refused = spyOn(jobsService, "enqueue").mockRejectedValue(new Error("redis caiu"));
    scribeReplies(ok("na hora"));
    try {
      const meta = await importFixture("direto.mp3", "a");
      await waitFor(async () => (await readUploadRow(botId, meta.uploadId))?.transcript === "na hora");
    } finally {
      refused.mockRestore();
    }
  });
});
