import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as anydoc from "@firecrawl/anydoc";
import { ulid } from "ulid";
import { fakeProcesses, readData, resetData, testDataDir, writeData } from "../../../../test/helpers";
import { connectFakeRunner, fastTimers, fixtureFile, mediaTools, pcmSamples } from "../../../../test/media-helpers";
import { getDb, tables } from "../../../db";
import { Req, Res } from "../../../shared/http";
import { blobKeys, getBlobStore, putBlob } from "../../storage/services/storage.service";
import { readUploadRow, saveUploadRow } from "../repositories/uploads.repository";
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
  serveUpload,
  type UploadMeta,
  uploadGuide,
  uploadPath,
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

async function importFixture(name: string, content: string | Buffer, size?: number) {
  return importBotFile(botId, fixtureFile(name, content, size));
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
  saveUploadRow(owner, meta, { blobKey: blob.key, sha256: blob.sha256, thumbKey: null });
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
  getDb().delete(tables.uploads).run();
  media = mediaTools();
  fakeProcesses(media.handler);
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
  process.env.ELEVENLABS_API_KEY = "test-eleven-key";
});

afterEach(() => {
  warn.mockRestore();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  delete process.env.ELEVENLABS_API_KEY;
});

describe("helpers", () => {
  test("kindOf classifies by mime and keeps svg as a file", () => {
    expect(kindOf("image/png", "a.png")).toBe("image");
    expect(kindOf("image/svg+xml", "a.svg")).toBe("file");
    expect(kindOf("image/png", "a.svg")).toBe("file");
    expect(kindOf("video/mp4", "a.mp4")).toBe("video");
    expect(kindOf("audio/mpeg", "a.mp3")).toBe("audio");
    expect(kindOf("application/pdf", "a.pdf")).toBe("file");
  });

  test("attachmentsTitle, fileEventOf and the guide", () => {
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
    const meta = await importFixture("scan.heic", png);
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
    const meta = await importFixture("old.bmp", png);
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
    expect(readUploadRow(botId, meta.uploadId)).toMatchObject({
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
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
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
    const big = Buffer.alloc(3000, 1);
    const toDocument = spyOn(anydoc, "toDocument").mockResolvedValue({
      blocks: [],
      notes: [],
      assets: [
        { id: 0, mediaType: "image/png", originPart: "a", data: big },
        { id: 1, mediaType: "image/webp", originPart: "b", data: big },
        { id: 2, mediaType: "image/gif", originPart: "c", data: big },
        { id: 3, mediaType: "image/jpeg", originPart: "d", data: big },
        { id: 4, mediaType: "image/png", originPart: "e", data: Buffer.alloc(10) },
        { id: 5, mediaType: "text/plain", originPart: "f", data: big },
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
  test("sends a server file under a chosen name through send_file", async () => {
    const path = fixtureFile("out/result.csv", "a,b");
    const tool = sendFile();
    expect(tool.label({ path })).toBe("Enviar result.csv");
    expect(tool.label({ path, name: "final.csv" })).toBe("Enviar final.csv");
    expect(tool.label({})).toBe("Enviar arquivo");
    const output = (await tool.run({ path, name: " Relatório: final?.csv " }, {} as never)) as Record<string, unknown>;
    expect(output).toMatchObject({ name: "Relatório- final-.csv", kind: "file", size: 3 });
    expect(fileEventOf(output)?.data.attachment).toMatchObject({ name: "Relatório- final-.csv", source: "bot" });
    const plain = (await tool.run({ path }, {} as never)) as Record<string, unknown>;
    expect(plain.name).toBe("result.csv");
    await prepareAttachments(botId, await listUploads(botId), true);
  });

  test("refuses files outside the allowed roots, protected files, folders and huge files", async () => {
    await expect(importBotFile(botId, "/etc/passwd")).rejects.toThrow("/etc/passwd está fora das pastas");
    await expect(importBotFile(botId, fixtureFile("app/.env", "SECRET=1"))).rejects.toThrow(
      "Esse arquivo é protegido.",
    );
    await expect(importBotFile(botId, join(testDataDir(), "fixtures", "app"))).rejects.toThrow(
      "Isso não é um arquivo.",
    );
    await expect(importBotFile(botId, fixtureFile("huge.bin", "", 100 * 1024 * 1024 + 1))).rejects.toThrow(
      "O arquivo passa de 100 MB.",
    );
  });

  test("explains a missing file depending on the Mac connection", async () => {
    const missing = join(testDataDir(), "nope.txt");
    await expect(importBotFile(botId, missing)).rejects.toThrow("e o Mac está desconectado.");
    const runner = connectFakeRunner(["vault"]);
    try {
      await expect(importBotFile(botId, missing)).rejects.toThrow("ainda não sabe enviar arquivos");
    } finally {
      runner.close();
    }
  });

  test("pulls a missing file from the Mac when it can send files", async () => {
    const replies = [
      { ok: true, result: { path: "/Users/p/Desktop/foto.txt", name: "foto.txt", base64: "aGVsbG8=" } },
      { ok: true, result: { path: "/Users/p/Desktop/semnome.txt", name: "", base64: "eA==" } },
      { ok: true, result: {} },
      { ok: false, error: "sem permissão" },
      { ok: false },
    ];
    const runner = connectFakeRunner(["files"], (op) => (op === "file.read" ? (replies.shift() ?? { ok: false }) : { ok: true }));
    const reads = () => runner.requests.filter((item) => item.op === "file.read");
    try {
      const first = await importBotFile(botId, "/Users/p/Desktop/foto.txt");
      expect(first).toMatchObject({ name: "foto.txt", size: 5, source: "bot", mime: "text/plain" });
      expect(await readFile(uploadPath(botId, first), "utf8")).toBe("hello");
      expect(reads()[0]).toEqual({
        op: "file.read",
        body: { path: "/Users/p/Desktop/foto.txt", maxBytes: 20 * 1024 * 1024 },
      });
      expect((await importBotFile(botId, "/Users/p/Desktop/semnome.txt")).name).toBe("semnome.txt");
      expect((await importBotFile(botId, "/Users/p/x.bin", "renomeado.txt")).name).toBe("renomeado.txt");
      await expect(importBotFile(botId, "/Users/p/a.txt")).rejects.toThrow("sem permissão");
      await expect(importBotFile(botId, "/Users/p/b.txt")).rejects.toThrow("O Mac não enviou o arquivo.");
      await expect(importBotFile(botId, "/Users/p/.ssh/id_rsa")).rejects.toThrow("Esse arquivo é protegido.");
      expect(reads()).toHaveLength(5);
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
    expect(warn.mock.calls.some((args) => String(args[0]).includes(`upload ${meta.uploadId} could not be fetched`))).toBe(
      true,
    );
  });

  test("a stored thumb is brought back with the file", async () => {
    media.options.probe = { streams: [{ codec_type: "video", width: 2000, height: 1000 }] };
    const meta = await importFixture("wide.png", png);
    expect(readUploadRow(botId, meta.uploadId)?.thumbKey).toBe(blobKeys(botId).derived(meta.uploadId, "thumb.jpg"));
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
    expect(full.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(full.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''page.html");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    const meta = await serve(page, "meta");
    expect(JSON.parse(meta.text)).toMatchObject({ uploadId: page.uploadId, name: "page.html" });
    expect((await serve(page, "thumb.jpg")).status).toBe(404);
    await writeData(`bots/${botId}/uploads/.derived/${page.uploadId}/thumb.jpg`, "jpeg");
    const thumb = await serve(page, "thumb.jpg");
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(thumb.headers.get("content-security-policy")).toBeNull();
    expect(thumb.text).toBe("jpeg");
    expect((await serve(page, "other")).status).toBe(404);
    expect((await serve(ulid())).status).toBe(404);
    const head = await serve(page, undefined, { "x-method": "HEAD" });
    expect(head.headers.get("content-length")).toBe("11");
    expect(head.text).toBe("");
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
