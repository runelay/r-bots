import { extname } from "node:path";

export const sniffBytes = 64 * 1024;

const containerByExt: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".epub": "application/epub+zip",
};

const legacyOfficeByExt: Record<string, string> = {
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

const textByExt: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xhtml": "application/xhtml+xml",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
};

function ascii(bytes: Uint8Array, start: number, length: number) {
  return Buffer.from(bytes.subarray(start, start + length)).toString("latin1");
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function isoMediaType(bytes: Buffer) {
  if (ascii(bytes, 4, 4) !== "ftyp") return null;
  const brands = [ascii(bytes, 8, 4)];
  const boxSize = Math.min(bytes.readUInt32BE(0), 64);
  for (let at = 16; at + 4 <= boxSize; at += 4) brands.push(ascii(bytes, at, 4));
  const has = (...wanted: string[]) => brands.some((brand) => wanted.includes(brand));
  if (has("avif", "avis")) return "image/avif";
  if (has("heic", "heix", "hevc", "hevx", "heim", "heis")) return "image/heic";
  if (has("mif1", "msf1")) return "image/heif";
  if (brands[0] === "M4A " || brands[0] === "M4B ") return "audio/mp4";
  if (brands[0] === "qt  ") return "video/quicktime";
  if (brands[0] === "M4V " || brands[0] === "M4VH" || brands[0] === "M4VP") return "video/x-m4v";
  return "video/mp4";
}

export function isUtf8Text(bytes: Uint8Array, complete = true) {
  if (bytes.includes(0)) return false;
  let end = bytes.length;
  if (!complete) {
    let back = 0;
    while (back < 3 && end - back - 1 >= 0 && (bytes[end - back - 1] & 0xc0) === 0x80) back++;
    const lead = bytes[end - back - 1];
    if (lead !== undefined && lead >= 0xc0) {
      const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : 1;
      if (back < need) end = end - back - 1;
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

export function sniffMime(head: Uint8Array, name: string, complete = true) {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const ext = extname(name).toLowerCase();
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF") {
    const form = ascii(bytes, 8, 4);
    if (form === "WEBP") return "image/webp";
    if (form === "WAVE") return "audio/wav";
  }
  if (ascii(bytes, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(bytes, 8, 4))) return "audio/aiff";
  if (bytes.length >= 12) {
    const iso = isoMediaType(bytes);
    if (iso) return iso;
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]))
    return ascii(bytes, 0, 64).includes("webm") ? "video/webm" : "video/x-matroska";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && bytes.length > 1) {
    if ((bytes[1] & 0xf6) === 0xf0) return "audio/aac";
    if ((bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  }
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return containerByExt[ext] ?? "application/zip";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return legacyOfficeByExt[ext] ?? "application/octet-stream";
  if (ascii(bytes, 0, 2) === "BM" && bytes.length >= 26) return "image/bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (ascii(bytes, 0, 5) === "{\\rtf") return "application/rtf";
  if (isUtf8Text(bytes, complete)) {
    if (textByExt[ext]) return textByExt[ext];
    const start = Buffer.from(bytes.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
    if (start.startsWith("<svg") || (start.startsWith("<?xml") && start.includes("<svg"))) return "image/svg+xml";
    if (start.startsWith("<!doctype html") || start.startsWith("<html")) return "text/html";
    return "text/plain";
  }
  return "application/octet-stream";
}

const demuxers: Record<string, string> = {
  "image/png": "png_pipe",
  "image/jpeg": "jpeg_pipe",
  "image/gif": "gif",
  "image/webp": "webp_pipe",
  "image/bmp": "bmp_pipe",
  "image/tiff": "tiff_pipe",
  "image/heic": "mov",
  "image/heif": "mov",
  "image/avif": "mov",
  "video/mp4": "mov",
  "video/quicktime": "mov",
  "video/x-m4v": "mov",
  "audio/mp4": "mov",
  "video/webm": "matroska",
  "video/x-matroska": "matroska",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/aiff": "aiff",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

const probeFormats = new Set([
  "png_pipe",
  "jpeg_pipe",
  "gif",
  "webp_pipe",
  "bmp_pipe",
  "tiff_pipe",
  "mov,mp4,m4a,3gp,3g2,mj2",
  "matroska,webm",
  "mp3",
  "aac",
  "wav",
  "aiff",
  "ogg",
  "flac",
]);

export function demuxerOf(mime: string) {
  return demuxers[mime] ?? null;
}

export function probeFormatAllowed(formatName: unknown) {
  return typeof formatName === "string" && probeFormats.has(formatName);
}

export function mediaInput(mime: string, path: string) {
  const demuxer = demuxerOf(mime);
  if (!demuxer) throw new Error(`o tipo ${mime} não passa pelo ffmpeg`);
  return ["-protocol_whitelist", "file", "-f", demuxer, "-i", path];
}

const inlineImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export function servesInline(mime: string) {
  return inlineImages.has(mime) || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf";
}

const activeContent = /html|xml|svg|javascript|ecmascript|css/;

export function servedContentType(mime: string) {
  if (servesInline(mime)) return mime;
  if (activeContent.test(mime)) return "application/octet-stream";
  if (mime.startsWith("text/") || mime === "application/json") return "text/plain; charset=utf-8";
  return mime || "application/octet-stream";
}

export const userContentCsp =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
