import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type Format as AnydocFormat,
  formatFromBytes,
  formatFromExtension,
  toDocument,
  toMarkdownBytes,
} from "@firecrawl/anydoc";
import { runBytes } from "@runelay-bots/providers/proc";
import { ulid } from "ulid";
import { z } from "zod";
import { botDir, dataDir } from "../../../config/env";
import type { Req, Res } from "../../../shared/http";
import {
  macReadFile,
  macRunnerConnected,
  macRunnerSupports,
  macTranscribeFile,
} from "../../accounts/services/mac-runner.service";
import type { BotTool } from "../../engine/services/bot-tools.service";
import { blobKeys, blobToFile, putBlob } from "../../storage/services/storage.service";
import {
  listUploadRows,
  readUploadRow,
  saveUploadRow,
  updateUploadMeta,
  uploadFromRow,
} from "../repositories/uploads.repository";

export type UploadKind = "image" | "video" | "audio" | "file";

export interface UploadMeta {
  uploadId: string;
  name: string;
  mime: string;
  size: number;
  kind: UploadKind;
  file: string;
  createdAt: string;
  source: "user" | "bot";
  width?: number;
  height?: number;
  duration?: number;
  waveform?: number[];
  thumb?: boolean;
  transcript?: string;
  transcriptSource?: "scribe" | "mac";
}

export interface PreparedImage {
  path: string;
  mime: string;
  label: string;
}

interface Prepared {
  transcript?: string | null;
  text?: string | null;
  textTruncated?: boolean;
  image?: string | null;
  frames?: Array<{ path: string; at: number }>;
  docImages?: Array<{ path: string; mime: string }>;
  converter?: "anydoc" | "pdftotext" | "text";
  error?: string;
}

export const maxUploadBytes = 100 * 1024 * 1024;
const maxTextChars = 60_000;
const maxImageSide = 1568;
const idPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const preparing = new Map<string, Promise<Prepared>>();

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const mimeByExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
};

const textExts = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".swift",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".m",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".env.example",
  ".ini",
  ".conf",
  ".log",
  ".vue",
  ".svelte",
  ".php",
  ".lua",
  ".dart",
  ".r",
]);

const claudeImageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const anydocExts = new Set([
  ".doc",
  ".docx",
  ".docm",
  ".dot",
  ".dotx",
  ".ppt",
  ".pps",
  ".pot",
  ".pptx",
  ".pptm",
  ".ppsx",
  ".ppsm",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
  ".epub",
  ".csv",
  ".pdf",
]);
const maxDocImages = 8;

function uploadsDir(botId: string) {
  return join(botDir(botId), "uploads");
}

function derivedDir(botId: string, uploadId: string) {
  return join(uploadsDir(botId), ".derived", uploadId);
}

export function uploadPath(botId: string, meta: UploadMeta) {
  return join(uploadsDir(botId), meta.file);
}

function safeName(raw: string) {
  const cleaned = basename(raw.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f/:*?"<>|]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "arquivo";
}

export function kindOf(mime: string, name: string): UploadKind {
  const ext = extname(name).toLowerCase();
  if (mime.startsWith("image/") && ext !== ".svg" && mime !== "image/svg+xml") return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function mimeOf(declared: string | undefined, name: string) {
  const clean = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (
    clean &&
    !["application/octet-stream", "application/x-www-form-urlencoded", "multipart/form-data"].includes(clean)
  )
    return clean;
  return mimeByExt[extname(name).toLowerCase()] ?? "application/octet-stream";
}

async function run(cmd: string, args: string[], options: { timeout?: number } = {}) {
  const { code, stdout, stderr } = await runBytes(cmd, args, { timeoutMs: options.timeout ?? 120_000 });
  if (code !== 0) throw new Error(`${cmd} falhou: ${stderr.slice(-300) || `saiu com código ${code}`}`);
  return { stdout: Buffer.from(stdout), stderr };
}

async function probe(path: string) {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { timeout: 30_000 },
    );
    return JSON.parse(stdout.toString("utf8")) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        duration?: string;
        tags?: { rotate?: string };
        side_data_list?: Array<{ rotation?: number }>;
      }>;
    };
  } catch {
    return null;
  }
}

async function waveformOf(path: string, bars = 48) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "2000", "-f", "s16le", "-"],
    { timeout: 60_000 },
  );
  const samples = Math.floor(stdout.length / 2);
  if (samples === 0) return [];
  const size = Math.max(1, Math.floor(samples / bars));
  const peaks: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    let sum = 0;
    let count = 0;
    for (let index = bar * size; index < Math.min(samples, (bar + 1) * size); index++) {
      const value = stdout.readInt16LE(index * 2) / 32768;
      sum += value * value;
      count++;
    }
    peaks.push(count ? Math.sqrt(sum / count) : 0);
  }
  const max = Math.max(...peaks, 0.0001);
  return peaks.map((value) => Math.round((value / max) * 100) / 100);
}

async function analyze(botId: string, meta: UploadMeta) {
  const path = uploadPath(botId, meta);
  const info = meta.kind === "file" ? null : await probe(path);
  const video = info?.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(info?.format?.duration ?? video?.duration ?? NaN);
  if (meta.kind === "image" || meta.kind === "video") {
    if (video?.width && video?.height) {
      const rotation = Math.abs(
        Number(video.tags?.rotate ?? video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0),
      );
      const swap = rotation === 90 || rotation === 270;
      meta.width = swap ? video.height : video.width;
      meta.height = swap ? video.width : video.height;
    }
  }
  if ((meta.kind === "video" || meta.kind === "audio") && Number.isFinite(duration))
    meta.duration = Math.round(duration * 10) / 10;
  if (
    meta.kind === "audio" ||
    (meta.kind === "video" && info?.streams?.some((stream) => stream.codec_type === "audio"))
  ) {
    meta.waveform = await waveformOf(path).catch(() => undefined);
  }
  if (
    meta.kind === "video" ||
    (meta.kind === "image" && (Math.max(meta.width ?? 0, meta.height ?? 0) > 640 || !claudeImageMimes.has(meta.mime)))
  ) {
    const dir = derivedDir(botId, meta.uploadId);
    await mkdir(dir, { recursive: true });
    const at = meta.kind === "video" ? ["-ss", String(Math.min(0.5, (meta.duration ?? 1) / 4))] : [];
    try {
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          ...at,
          "-i",
          path,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
          "-q:v",
          "4",
          join(dir, "thumb.jpg"),
        ],
        { timeout: 60_000 },
      );
      meta.thumb = true;
    } catch {}
  }
}

async function materialize(botId: string, meta: UploadMeta, blobKey: string, thumbKey: string | null) {
  const local = uploadPath(botId, meta);
  if (!(await Bun.file(local).exists())) await blobToFile(blobKey, local);
  if (thumbKey) {
    const thumb = join(derivedDir(botId, meta.uploadId), "thumb.jpg");
    if (!(await Bun.file(thumb).exists())) await blobToFile(thumbKey, thumb);
  }
}

export async function readUpload(botId: string, uploadId: string): Promise<UploadMeta | null> {
  if (!idPattern.test(uploadId)) return null;
  const row = readUploadRow(botId, uploadId);
  if (!row) return null;
  const meta = uploadFromRow(row);
  try {
    await materialize(botId, meta, row.blobKey, row.thumbKey);
  } catch (error) {
    console.warn(`upload ${uploadId} could not be fetched from storage`, error);
    return null;
  }
  rememberLabel(meta);
  return meta;
}

async function writeMeta(botId: string, meta: UploadMeta) {
  updateUploadMeta(botId, meta);
}

async function storeUpload(botId: string, meta: UploadMeta) {
  const keys = blobKeys(botId);
  const original = await putBlob(keys.upload(meta.uploadId, meta.name), Bun.file(uploadPath(botId, meta)).stream(), {
    mime: meta.mime,
    botId,
  });
  const thumbPath = join(derivedDir(botId, meta.uploadId), "thumb.jpg");
  const thumb =
    meta.thumb && (await Bun.file(thumbPath).exists())
      ? await putBlob(keys.derived(meta.uploadId, "thumb.jpg"), Bun.file(thumbPath).stream(), {
          mime: "image/jpeg",
          botId,
        })
      : null;
  if (meta.thumb && !thumb) delete meta.thumb;
  saveUploadRow(botId, meta, { blobKey: original.key, sha256: original.sha256, thumbKey: thumb?.key ?? null });
}

export function publicUpload(botId: string, meta: UploadMeta) {
  const base = `/bots/${encodeURIComponent(botId)}/uploads/${meta.uploadId}`;
  return {
    uploadId: meta.uploadId,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    kind: meta.kind,
    url: base,
    ...(meta.thumb ? { thumbUrl: `${base}/thumb.jpg` } : {}),
    ...(meta.width ? { width: meta.width, height: meta.height } : {}),
    ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
    ...(meta.waveform?.length ? { waveform: meta.waveform } : {}),
    ...(meta.source === "bot" ? { source: "bot" } : {}),
  };
}

export type PublicUpload = ReturnType<typeof publicUpload>;

async function register(botId: string, meta: UploadMeta) {
  await analyze(botId, meta).catch((error) => console.warn("upload analyze failed", error));
  try {
    await storeUpload(botId, meta);
  } catch (error) {
    console.error("upload storage failed", error);
    await rm(uploadPath(botId, meta), { force: true });
    throw new UploadError("Não consegui guardar o arquivo agora. Tente de novo.", 503);
  }
  rememberLabel(meta);
  void preparedOf(botId, meta);
  return meta;
}

export async function receiveUpload(botId: string, req: Req) {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > maxUploadBytes) throw new UploadError("O arquivo passa de 100 MB.", 413);
  const rawName = String(req.headers["x-file-name"] ?? "");
  let name = "arquivo";
  try {
    name = safeName(decodeURIComponent(rawName) || "arquivo");
  } catch {
    name = safeName(rawName);
  }
  const mime = mimeOf(String(req.headers["x-file-type"] ?? req.headers["content-type"] ?? ""), name);
  const uploadId = ulid();
  const file = `${uploadId}-${name}`;
  const dir = uploadsDir(botId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, file);
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxUploadBytes) callback(new UploadError("O arquivo passa de 100 MB.", 413));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, createWriteStream(target));
  } catch (error) {
    await rm(target, { force: true });
    if (error instanceof UploadError) throw error;
    throw new UploadError("O envio foi interrompido.", 400);
  }
  if (size === 0) {
    await rm(target, { force: true });
    throw new UploadError("O arquivo está vazio.", 400);
  }
  const meta: UploadMeta = {
    uploadId,
    name,
    mime,
    size,
    kind: kindOf(mime, name),
    file,
    createdAt: new Date().toISOString(),
    source: "user",
  };
  return register(botId, meta);
}

const sendRoots = () =>
  [dataDir, process.env.CODE_WORKTREES_DIR ?? join(homedir(), "projects", "worktrees"), "/home/runelaybot", "/tmp"].map(
    (root) => resolve(root),
  );
const protectedFile = /(^|\/)(\.env[^/]*|\.git|\.ssh|\.claude)(\/|$)/;
const maxMacFileBytes = 20 * 1024 * 1024;

async function importMacFile(botId: string, rawPath: string, name?: string) {
  if (protectedFile.test(rawPath)) throw new Error("Esse arquivo é protegido.");
  const fetched = await macReadFile(rawPath, maxMacFileBytes);
  const finalName = safeName(name?.trim() || fetched.name || basename(fetched.path));
  const mime = mimeOf(undefined, finalName);
  const uploadId = ulid();
  const file = `${uploadId}-${finalName}`;
  await mkdir(uploadsDir(botId), { recursive: true });
  await writeFile(join(uploadsDir(botId), file), fetched.bytes);
  const meta: UploadMeta = {
    uploadId,
    name: finalName,
    mime,
    size: fetched.bytes.length,
    kind: kindOf(mime, finalName),
    file,
    createdAt: new Date().toISOString(),
    source: "bot",
  };
  return register(botId, meta);
}

export async function importBotFile(botId: string, rawPath: string, name?: string) {
  let real: string;
  try {
    real = await realpath(resolve(rawPath));
  } catch {
    if (macRunnerSupports("files")) return importMacFile(botId, rawPath, name);
    throw new Error(
      macRunnerConnected()
        ? `Não achei ${rawPath} no servidor, e o app do Mac ainda não sabe enviar arquivos (atualize o runelay bots).`
        : `Não achei ${rawPath} no servidor, e o Mac está desconectado.`,
    );
  }
  if (!sendRoots().some((root) => real === root || real.startsWith(root + sep))) {
    throw new Error(
      `${real} está fora das pastas que posso enviar: dados do bot, worktrees, computador do bot ou /tmp do servidor.`,
    );
  }
  if (protectedFile.test(real)) throw new Error("Esse arquivo é protegido.");
  const info = await stat(real);
  if (!info.isFile()) throw new Error("Isso não é um arquivo.");
  if (info.size > maxUploadBytes) throw new Error("O arquivo passa de 100 MB.");
  const finalName = safeName(name?.trim() || basename(real));
  const mime = mimeOf(undefined, finalName);
  const uploadId = ulid();
  const file = `${uploadId}-${finalName}`;
  await mkdir(uploadsDir(botId), { recursive: true });
  await copyFile(real, join(uploadsDir(botId), file));
  const meta: UploadMeta = {
    uploadId,
    name: finalName,
    mime,
    size: info.size,
    kind: kindOf(mime, finalName),
    file,
    createdAt: new Date().toISOString(),
    source: "bot",
  };
  return register(botId, meta);
}

const sttConcurrency = Math.max(1, Number(process.env.UPLOAD_STT_CONCURRENCY ?? 1));
const sttDelays = [1000, 3000, 8000];
let sttActive = 0;
const sttWaiting: Array<() => void> = [];
const transcribing = new Map<string, Promise<string>>();
const labels = new Map<string, string>();

async function withSttSlot<T>(work: () => Promise<T>) {
  if (sttActive >= sttConcurrency) await new Promise<void>((resolveSlot) => sttWaiting.push(resolveSlot));
  sttActive++;
  try {
    return await work();
  } finally {
    sttActive--;
    sttWaiting.shift()?.();
  }
}

function retryAfterMs(header: string | null) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(30_000, Math.max(0, date - Date.now())) : null;
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function scribe(path: string) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ElevenLabs não está configurado no servidor.");
  const bytes = await readFile(path);
  let lastError = "";
  for (const model of [process.env.UPLOAD_STT_MODEL ?? "scribe_v2", "scribe_v1"]) {
    for (let attempt = 0; attempt <= sttDelays.length; attempt++) {
      let status = 0;
      let wait: number | null = null;
      try {
        const form = new FormData();
        form.append("model_id", model);
        form.append("file", new Blob([bytes]), basename(path));
        const response = await withSttSlot(() =>
          fetch("https://api.elevenlabs.io/v1/speech-to-text", {
            method: "POST",
            headers: { "xi-api-key": key },
            body: form,
            signal: AbortSignal.timeout(300_000),
          }),
        );
        if (response.ok) {
          const body = (await response.json()) as { text?: string };
          return (body.text ?? "").trim();
        }
        status = response.status;
        wait = retryAfterMs(response.headers.get("retry-after"));
        lastError = `${status} ${(await response.text()).slice(0, 200)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (status === 400 || status === 422) break;
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable) throw new Error(`Scribe não transcreveu: ${lastError}`);
      if (attempt === sttDelays.length) throw new Error(`Scribe não transcreveu: ${lastError}`);
      const base = sttDelays[attempt];
      const delay = Math.max(wait ?? 0, base + Math.round(Math.random() * base * 0.4));
      console.warn(`scribe ${status || "erro"}, nova tentativa em ${delay} ms`);
      await sleep(delay);
    }
  }
  throw new Error(`Scribe não transcreveu: ${lastError}`);
}

async function transcribeOnMac(botId: string, meta: UploadMeta) {
  if (!macRunnerConnected()) throw new Error("o app do Mac não está aberto");
  const audio = await extractAudio(botId, meta);
  const bytes = await readFile(audio);
  if (bytes.length > 25 * 1024 * 1024) throw new Error("áudio grande demais para mandar ao Mac");
  return macTranscribeFile(bytes.toString("base64"), basename(audio));
}

async function transcribeUpload(botId: string, meta: UploadMeta) {
  if (meta.transcript !== undefined) return meta.transcript;
  const key = `${botId}/${meta.uploadId}`;
  let pending = transcribing.get(key);
  if (!pending) {
    pending = (async () => {
      const fresh = await readUpload(botId, meta.uploadId);
      if (fresh?.transcript !== undefined) return fresh.transcript;
      const source = meta.kind === "video" ? await extractAudio(botId, meta) : uploadPath(botId, meta);
      let text: string;
      let via: "scribe" | "mac" = "scribe";
      try {
        text = await scribe(source);
      } catch (scribeError) {
        console.warn(
          `scribe falhou para ${meta.name}: ${scribeError instanceof Error ? scribeError.message : String(scribeError)}; tentando no Mac`,
        );
        try {
          text = await transcribeOnMac(botId, meta);
          via = "mac";
        } catch (macError) {
          throw new Error(
            `${scribeError instanceof Error ? scribeError.message : String(scribeError)}; no Mac também falhou: ${macError instanceof Error ? macError.message : String(macError)}`,
          );
        }
      }
      const latest = (await readUpload(botId, meta.uploadId)) ?? meta;
      latest.transcript = text;
      latest.transcriptSource = via;
      await writeMeta(botId, latest);
      meta.transcript = text;
      meta.transcriptSource = via;
      return text;
    })().finally(() => transcribing.delete(key));
    transcribing.set(key, pending);
  }
  return pending;
}

function rememberLabel(meta: UploadMeta) {
  const word = meta.kind === "audio" ? "o áudio" : meta.kind === "video" ? "o vídeo" : null;
  labels.set(meta.uploadId, word && meta.duration ? `Ler ${word} de ${clock(meta.duration)}` : `Ler ${meta.name}`);
}

async function extractAudio(botId: string, meta: UploadMeta) {
  const out = join(derivedDir(botId, meta.uploadId), "audio.mp3");
  await mkdir(derivedDir(botId, meta.uploadId), { recursive: true });
  await run(
    "ffmpeg",
    ["-v", "error", "-y", "-i", uploadPath(botId, meta), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out],
    { timeout: 300_000 },
  );
  return out;
}

async function resizedImage(botId: string, meta: UploadMeta) {
  const source = uploadPath(botId, meta);
  const big = Math.max(meta.width ?? 0, meta.height ?? 0) > maxImageSide;
  if (!big && claudeImageMimes.has(meta.mime) && meta.size <= 3_500_000 && meta.mime !== "image/gif") return source;
  const out = join(derivedDir(botId, meta.uploadId), "model.jpg");
  await mkdir(derivedDir(botId, meta.uploadId), { recursive: true });
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${maxImageSide},iw)':'min(${maxImageSide},ih)':force_original_aspect_ratio=decrease`,
      "-q:v",
      "3",
      out,
    ],
    { timeout: 60_000 },
  );
  return out;
}

async function videoFrames(botId: string, meta: UploadMeta) {
  const duration = meta.duration ?? 0;
  const count = duration <= 0 ? 1 : Math.max(6, Math.min(10, Math.round(duration / 6)));
  const dir = join(derivedDir(botId, meta.uploadId), "frames");
  await mkdir(dir, { recursive: true });
  const frames: Array<{ path: string; at: number }> = [];
  for (let index = 0; index < count; index++) {
    const at = duration > 0 ? Math.min(duration - 0.05, ((index + 0.5) * duration) / count) : 0;
    const out = join(dir, `${String(index).padStart(2, "0")}.jpg`);
    try {
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-ss",
          at.toFixed(2),
          "-i",
          uploadPath(botId, meta),
          "-frames:v",
          "1",
          "-vf",
          "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease",
          "-q:v",
          "4",
          out,
        ],
        { timeout: 60_000 },
      );
      frames.push({ path: out, at: Math.round(at * 10) / 10 });
    } catch {}
  }
  return frames;
}

function isTextLike(meta: UploadMeta) {
  const ext = extname(meta.name).toLowerCase();
  return (
    meta.mime.startsWith("text/") ||
    meta.mime === "application/json" ||
    meta.mime === "application/xml" ||
    textExts.has(ext)
  );
}

function anydocFormat(meta: UploadMeta, bytes: Buffer): AnydocFormat | null {
  const ext = extname(meta.name).toLowerCase();
  if (!anydocExts.has(ext) && meta.kind !== "file") return null;
  return formatFromBytes(bytes) ?? (anydocExts.has(ext) ? formatFromExtension(ext) : null);
}

async function convertWithAnydoc(meta: UploadMeta, bytes: Buffer) {
  const format = anydocFormat(meta, bytes);
  if (!format) return null;
  try {
    return { text: await toMarkdownBytes(bytes, format, { ocr: "reject" }), format };
  } catch (error) {
    console.warn(
      `anydoc failed for ${meta.name}: ${(error as { code?: string }).code ?? ""} ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        300,
      ),
    );
    return null;
  }
}

async function fullText(
  botId: string,
  meta: UploadMeta,
): Promise<{ text: string; converter: Prepared["converter"]; format?: AnydocFormat } | null> {
  const path = uploadPath(botId, meta);
  const bytes = await readFile(path);
  const converted = await convertWithAnydoc(meta, bytes);
  if (converted && converted.text.trim())
    return { text: converted.text, converter: "anydoc", format: converted.format };
  if (meta.mime === "application/pdf" || extname(meta.name).toLowerCase() === ".pdf") {
    const { stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { timeout: 120_000 });
    return { text: stdout.toString("utf8"), converter: "pdftotext" };
  }
  if (isTextLike(meta)) return { text: bytes.toString("utf8"), converter: "text" };
  return null;
}

async function extractText(botId: string, meta: UploadMeta, limit = maxTextChars, offset = 0) {
  const full = await fullText(botId, meta);
  if (!full) return null;
  const text = full.text.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  return {
    text: text.slice(offset, offset + limit),
    truncated: text.length > offset + limit,
    total: text.length,
    converter: full.converter,
    format: full.format,
  };
}

async function documentImages(botId: string, meta: UploadMeta, format: AnydocFormat | undefined) {
  if (!format || format === "pdf" || format === "csv") return [];
  let assets: Array<{ mediaType: string; data: Buffer }> = [];
  try {
    assets = (await toDocument(await readFile(uploadPath(botId, meta)), format)).assets;
  } catch {
    return [];
  }
  const images = assets
    .filter((asset) => asset.mediaType.startsWith("image/") && asset.data.length > 2_000)
    .slice(0, maxDocImages);
  if (images.length === 0) return [];
  const dir = join(derivedDir(botId, meta.uploadId), "doc-images");
  await mkdir(dir, { recursive: true });
  const out: Array<{ path: string; mime: string }> = [];
  for (const [index, asset] of images.entries()) {
    const source = join(dir, `${String(index).padStart(2, "0")}.src`);
    await writeFile(source, asset.data);
    if (claudeImageMimes.has(asset.mediaType) && asset.mediaType !== "image/gif" && asset.data.length <= 3_500_000) {
      const info = await probe(source);
      const stream = info?.streams?.find((item) => item.codec_type === "video");
      if (stream && Math.max(stream.width ?? 0, stream.height ?? 0) <= maxImageSide) {
        const ext = asset.mediaType === "image/png" ? "png" : asset.mediaType === "image/webp" ? "webp" : "jpg";
        const final = join(dir, `${String(index).padStart(2, "0")}.${ext}`);
        await copyFile(source, final);
        await rm(source, { force: true });
        out.push({ path: final, mime: asset.mediaType });
        continue;
      }
    }
    const final = join(dir, `${String(index).padStart(2, "0")}.jpg`);
    try {
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-i",
          source,
          "-frames:v",
          "1",
          "-vf",
          `scale='min(${maxImageSide},iw)':'min(${maxImageSide},ih)':force_original_aspect_ratio=decrease`,
          "-q:v",
          "3",
          final,
        ],
        { timeout: 60_000 },
      );
      out.push({ path: final, mime: "image/jpeg" });
    } catch {}
    await rm(source, { force: true });
  }
  return out;
}

async function prepare(botId: string, meta: UploadMeta): Promise<Prepared> {
  const cache = join(derivedDir(botId, meta.uploadId), "prepared.json");
  try {
    return JSON.parse(await readFile(cache, "utf8")) as Prepared;
  } catch {}
  const prepared: Prepared = {};
  try {
    if (meta.kind === "image") prepared.image = await resizedImage(botId, meta);
    if (meta.kind === "audio") prepared.transcript = await transcribeUpload(botId, meta);
    if (meta.kind === "video") {
      prepared.frames = await videoFrames(botId, meta);
      if (meta.waveform?.length) prepared.transcript = await transcribeUpload(botId, meta).catch(() => null);
    }
    if (meta.kind === "file") {
      const extracted = await extractText(botId, meta).catch(() => null);
      if (extracted) {
        prepared.text = extracted.text;
        prepared.textTruncated = extracted.truncated;
        prepared.converter = extracted.converter;
        const docImages = await documentImages(botId, meta, extracted.format).catch(() => []);
        if (docImages.length) prepared.docImages = docImages;
      }
    }
  } catch (error) {
    prepared.error = error instanceof Error ? error.message : String(error);
    return prepared;
  }
  await mkdir(derivedDir(botId, meta.uploadId), { recursive: true });
  await writeFile(cache, JSON.stringify(prepared));
  return prepared;
}

function preparedOf(botId: string, meta: UploadMeta) {
  const key = `${botId}/${meta.uploadId}`;
  let pending = preparing.get(key);
  if (!pending) {
    pending = prepare(botId, meta).finally(() => setTimeout(() => preparing.delete(key), 60_000).unref());
    preparing.set(key, pending);
  }
  return pending;
}

export async function resolveUploads(botId: string, ids: string[]) {
  const metas: UploadMeta[] = [];
  for (const id of ids) {
    const meta = await readUpload(botId, id);
    if (!meta) return null;
    metas.push(meta);
  }
  return metas;
}

function clock(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function sizeLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

const kindWord: Record<UploadKind, string> = { image: "imagem", video: "vídeo", audio: "áudio", file: "arquivo" };

export function attachmentsTitle(metas: Array<{ kind: UploadKind; name: string }>) {
  if (metas.length === 0) return "";
  if (metas.length === 1) return `📎 ${metas[0].name}`;
  return `📎 ${metas.length} anexos`;
}

export async function prepareAttachments(botId: string, metas: UploadMeta[], vision: boolean) {
  const lines: string[] = [];
  const images: PreparedImage[] = [];
  for (const meta of metas) {
    const prepared = await preparedOf(botId, meta);
    const path = uploadPath(botId, meta);
    const head = `${kindWord[meta.kind]} "${meta.name}"`;
    const dims = meta.width ? `${meta.width}×${meta.height}` : "";
    const trouble = prepared.error ? ` (não consegui processar: ${prepared.error.slice(0, 200)})` : "";
    if (meta.kind === "image") {
      if (vision && prepared.image) {
        images.push({
          path: prepared.image,
          mime: prepared.image.endsWith(".jpg") ? "image/jpeg" : meta.mime,
          label: `Imagem anexada: ${meta.name}`,
        });
        lines.push(
          `- ${head} (${[dims, sizeLabel(meta.size)].filter(Boolean).join(", ")}) vai junto nesta mensagem. Arquivo: ${path}`,
        );
      } else {
        lines.push(
          `- ${head} (${[meta.mime, dims, sizeLabel(meta.size)].filter(Boolean).join(", ")}) está em ${path}. Este modelo não recebe a imagem em si: se precisar do conteúdo, diga à pessoa o que consegue fazer sem vê-la.${trouble}`,
        );
      }
    } else if (meta.kind === "audio") {
      const transcript = prepared.transcript ? `[áudio: ${prepared.transcript}]` : `[áudio sem fala reconhecida]`;
      lines.push(
        `- ${head}${meta.duration ? ` (${clock(meta.duration)})` : ""}: ${transcript}${trouble} Arquivo: ${path}`,
      );
    } else if (meta.kind === "video") {
      const frames = prepared.frames ?? [];
      const parts = [`- ${head}, duração ${clock(meta.duration ?? 0)}${dims ? `, ${dims}` : ""}.`];
      parts.push(
        prepared.transcript
          ? `Áudio: [áudio: ${prepared.transcript}]`
          : meta.waveform?.length
            ? "Áudio sem fala reconhecida."
            : "Sem faixa de áudio.",
      );
      if (vision && frames.length) {
        parts.push(
          `Seguem ${frames.length} quadros-chave em ordem (${frames.map((frame) => clock(frame.at)).join(", ")}).`,
        );
        for (const frame of frames)
          images.push({
            path: frame.path,
            mime: "image/jpeg",
            label: `Quadro de "${meta.name}" em ${clock(frame.at)}`,
          });
      } else if (frames.length) {
        parts.push(
          `Quadros-chave extraídos em ${derivedDir(botId, meta.uploadId)}/frames (este modelo não recebe imagens).`,
        );
      }
      parts.push(`Arquivo: ${path}${trouble}`);
      lines.push(parts.join(" "));
    } else if (prepared.text) {
      const docImages = prepared.docImages ?? [];
      let imageNote = "";
      if (docImages.length && vision) {
        imageNote = ` As ${docImages.length} primeiras imagens do documento vão junto, em ordem.`;
        docImages.forEach((image, index) => {
          images.push({ path: image.path, mime: image.mime, label: `Imagem ${index + 1} de "${meta.name}"` });
        });
      } else if (docImages.length) {
        imageNote = ` O documento tem imagens, salvas em ${derivedDir(botId, meta.uploadId)}/doc-images (este modelo não recebe imagens).`;
      }
      lines.push(
        `- ${head} (${sizeLabel(meta.size)}). Arquivo: ${path}.${imageNote} Conteúdo${prepared.converter === "anydoc" ? " em markdown" : ""}${prepared.textTruncated ? ` (cortado em ${maxTextChars} caracteres; leia o resto com attachment_read)` : ""}:\n<<<\n${prepared.text}\n>>>`,
      );
    } else {
      lines.push(
        `- ${head} (${meta.mime}, ${sizeLabel(meta.size)}) está em ${path}. Use attachment_read com uploadId ${meta.uploadId} se precisar do conteúdo.${trouble}`,
      );
    }
  }
  return { text: lines.length ? `Anexos da pessoa:\n${lines.join("\n")}` : "", images };
}

export async function serveUpload(req: Req, res: Res, botId: string, uploadId: string, variant: string | undefined) {
  const meta = await readUpload(botId, uploadId);
  const notFound = () => {
    const payload = JSON.stringify({ ok: false, error: "Anexo não encontrado." });
    res.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
  };
  if (!meta) return notFound();
  if (variant === "meta") {
    const payload = JSON.stringify(publicUpload(botId, meta));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
    });
    return res.end(payload);
  }
  const path =
    variant === "thumb.jpg" ? join(derivedDir(botId, uploadId), "thumb.jpg") : variant ? null : uploadPath(botId, meta);
  if (!path) return notFound();
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return notFound();
  }
  const type = variant === "thumb.jpg" ? "image/jpeg" : meta.mime;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
  };
  if (type === "text/html" || type === "image/svg+xml")
    headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    });
    if (req.method === "HEAD") return res.end();
    return res.end(Bun.file(path).slice(start, end + 1));
  }
  res.writeHead(200, { ...headers, "content-length": String(size) });
  if (req.method === "HEAD") return res.end();
  res.end(Bun.file(path));
}

export async function listUploads(botId: string) {
  return listUploadRows(botId).map((row) => {
    const meta = uploadFromRow(row);
    rememberLabel(meta);
    return meta;
  });
}

export interface FileEvent {
  type: "file.sent";
  data: { attachment: PublicUpload };
}

export function fileEventOf(output: unknown): FileEvent | null {
  if (!output || typeof output !== "object" || !("fileEvent" in output)) return null;
  return (output as { fileEvent: FileEvent }).fileEvent;
}

export function uploadTools(botId: string): BotTool[] {
  return [
    {
      name: "send_file",
      description:
        "Anexa na sua resposta um arquivo que você gerou ou baixou (imagem, PDF, planilha, vídeo, áudio…). A pessoa vê como miniatura ou card na conversa. path é absoluto: no servidor (pasta de dados do bot, worktree, computador do bot ou /tmp) ou, quando você roda no Mac, na pasta pessoal ou /tmp do Mac (até 20 MB).",
      shape: { path: z.string().min(1).max(1000), name: z.string().min(1).max(120).optional() },
      approval: null,
      label: (input) => `Enviar ${basename(String(input.name ?? input.path ?? "arquivo"))}`,
      run: async (input) => {
        const meta = await importBotFile(
          botId,
          String(input.path),
          typeof input.name === "string" ? input.name : undefined,
        );
        const attachment = publicUpload(botId, meta);
        return {
          uploadId: meta.uploadId,
          name: meta.name,
          kind: meta.kind,
          size: meta.size,
          fileEvent: { type: "file.sent", data: { attachment } },
        };
      },
    },
    {
      name: "attachment_read",
      description:
        "Lê o conteúdo de um anexo da conversa pelo uploadId: texto de PDF, documento, código ou CSV em pedaços, e a transcrição de áudio e vídeo. Para outros tipos devolve tipo, tamanho e caminho.",
      shape: {
        uploadId: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1000).max(200_000).optional(),
      },
      approval: null,
      label: (input) => labels.get(String(input.uploadId)) ?? "Ler o anexo",
      run: async (input) => {
        const meta = await readUpload(botId, String(input.uploadId));
        if (!meta) throw new Error("Anexo não encontrado.");
        if (meta.kind === "audio" || meta.kind === "video") {
          const transcript = await transcribeUpload(botId, meta);
          return { name: meta.name, kind: meta.kind, duration: meta.duration ?? null, transcript };
        }
        const extracted = await extractText(
          botId,
          meta,
          Number(input.limit ?? 100_000),
          Number(input.offset ?? 0),
        ).catch(() => null);
        if (!extracted)
          return {
            name: meta.name,
            mime: meta.mime,
            size: meta.size,
            kind: meta.kind,
            path: uploadPath(botId, meta),
            text: null,
          };
        return {
          name: meta.name,
          offset: Number(input.offset ?? 0),
          total: extracted.total,
          truncated: extracted.truncated,
          text: extracted.text,
        };
      },
    },
  ];
}

export const uploadGuide =
  '## Arquivos\nA pessoa pode anexar imagem, vídeo, áudio e arquivos. Imagens chegam junto da mensagem; áudio chega transcrito como "[áudio: …]"; vídeo chega com a transcrição e quadros-chave; PDF e texto chegam com o conteúdo extraído. Para devolver um arquivo que você gerou (imagem, PDF, CSV…), use `send_file` com o caminho; não cole o caminho na resposta.';
