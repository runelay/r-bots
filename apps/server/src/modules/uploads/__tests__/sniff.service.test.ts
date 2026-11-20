import { describe, expect, test } from "bun:test";
import {
  demuxerOf,
  isUtf8Text,
  mediaInput,
  probeFormatAllowed,
  servedContentType,
  servesInline,
  sniffMime,
} from "../services/sniff.service";

function iso(major: string, ...compatible: string[]) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(16 + compatible.length * 4);
  return Buffer.concat([size, Buffer.from(`ftyp${major}\0\0\0\0${compatible.join("")}`)]);
}

const bytes = (...values: number[]) => Buffer.from(values);

describe("sniffMime", () => {
  test("recognizes images by their signature", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), "a.txt")).toBe("image/png");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0), "a")).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("GIF87a..."), "a")).toBe("image/gif");
    expect(sniffMime(Buffer.from("GIF89a..."), "a")).toBe("image/gif");
    expect(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "a")).toBe("image/webp");
    expect(sniffMime(Buffer.concat([Buffer.from("BM"), Buffer.alloc(30)]), "a")).toBe("image/bmp");
    expect(sniffMime(bytes(0x49, 0x49, 0x2a, 0x00, 1), "a")).toBe("image/tiff");
    expect(sniffMime(bytes(0x4d, 0x4d, 0x00, 0x2a, 1), "a")).toBe("image/tiff");
    expect(sniffMime(iso("heic"), "a")).toBe("image/heic");
    expect(sniffMime(iso("mif1", "heic"), "a")).toBe("image/heic");
    expect(sniffMime(iso("mif1"), "a")).toBe("image/heif");
    expect(sniffMime(iso("avif"), "a")).toBe("image/avif");
  });

  test("recognizes audio and video containers", () => {
    expect(sniffMime(Buffer.from("RIFF\0\0\0\0WAVEfmt "), "a")).toBe("audio/wav");
    expect(sniffMime(Buffer.from("RIFF\0\0\0\0AVI LIST"), "a")).toBe("application/octet-stream");
    expect(sniffMime(Buffer.from("FORM\0\0\0\0AIFFCOMM"), "a")).toBe("audio/aiff");
    expect(sniffMime(Buffer.from("FORM\0\0\0\0AIFCCOMM"), "a")).toBe("audio/aiff");
    expect(sniffMime(iso("M4A "), "a")).toBe("audio/mp4");
    expect(sniffMime(iso("M4B "), "a")).toBe("audio/mp4");
    expect(sniffMime(iso("qt  "), "a")).toBe("video/quicktime");
    expect(sniffMime(iso("M4V "), "a")).toBe("video/x-m4v");
    expect(sniffMime(iso("isom", "mp41"), "a")).toBe("video/mp4");
    expect(sniffMime(Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), Buffer.from("..webm")]), "a")).toBe("video/webm");
    expect(sniffMime(Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), Buffer.from("matroska")]), "a")).toBe(
      "video/x-matroska",
    );
    expect(sniffMime(Buffer.from("OggS\0"), "a")).toBe("audio/ogg");
    expect(sniffMime(Buffer.from("fLaC\0"), "a")).toBe("audio/flac");
    expect(sniffMime(Buffer.from("ID3\u0004"), "a")).toBe("audio/mpeg");
    expect(sniffMime(bytes(0xff, 0xfb, 0x90), "a")).toBe("audio/mpeg");
    expect(sniffMime(bytes(0xff, 0xf1, 0x50), "a")).toBe("audio/aac");
    expect(sniffMime(bytes(0xff, 0x00, 0x00), "a")).toBe("application/octet-stream");
    expect(sniffMime(bytes(0xff), "a")).toBe("application/octet-stream");
  });

  test("recognizes documents and refines zip and OLE containers by extension", () => {
    expect(sniffMime(Buffer.from("%PDF-1.7"), "a")).toBe("application/pdf");
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0);
    expect(sniffMime(zip, "a.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(sniffMime(zip, "a.epub")).toBe("application/epub+zip");
    expect(sniffMime(zip, "a.html")).toBe("application/zip");
    const ole = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0);
    expect(sniffMime(ole, "a.xls")).toBe("application/vnd.ms-excel");
    expect(sniffMime(ole, "a.bin")).toBe("application/octet-stream");
    expect(sniffMime(Buffer.from("{\\rtf1 oi}"), "a")).toBe("application/rtf");
  });

  test("text is valid UTF-8 without NUL, typed by extension or by its first tag", () => {
    expect(sniffMime(Buffer.from("olá"), "a.png")).toBe("text/plain");
    expect(sniffMime(Buffer.from("# título"), "a.md")).toBe("text/markdown");
    expect(sniffMime(Buffer.from("<svg/>"), "a.svg")).toBe("image/svg+xml");
    expect(sniffMime(Buffer.from("  <svg xmlns='x'/>"), "a.txt")).toBe("image/svg+xml");
    expect(sniffMime(Buffer.from("<?xml version='1.0'?><svg/>"), "a")).toBe("image/svg+xml");
    expect(sniffMime(Buffer.from("<?xml version='1.0'?><a/>"), "a")).toBe("text/plain");
    expect(sniffMime(Buffer.from("<!DOCTYPE html><p>"), "a.jpg")).toBe("text/html");
    expect(sniffMime(Buffer.from("<html><p>"), "a")).toBe("text/html");
    expect(sniffMime(Buffer.from("a\0b"), "a.txt")).toBe("application/octet-stream");
    expect(sniffMime(bytes(0xc3, 0x28), "a.txt")).toBe("application/octet-stream");
  });

  test("a head cut in the middle of a character is still text", () => {
    const cut = Buffer.from("aé€😀").subarray(0, 9);
    expect(isUtf8Text(cut, false)).toBe(true);
    expect(isUtf8Text(cut, true)).toBe(false);
    expect(isUtf8Text(Buffer.from("aé").subarray(0, 2), false)).toBe(true);
    expect(isUtf8Text(Buffer.from("abc"), false)).toBe(true);
    expect(isUtf8Text(bytes(0x80, 0x80, 0x80, 0x80), false)).toBe(false);
    expect(sniffMime(cut, "a.txt", false)).toBe("text/plain");
  });
});

describe("ffmpeg inputs", () => {
  test("maps media types to a fixed demuxer and refuses the rest", () => {
    expect(demuxerOf("video/mp4")).toBe("mov");
    expect(demuxerOf("text/html")).toBeNull();
    expect(mediaInput("audio/ogg", "/x/a.ogg")).toEqual(["-protocol_whitelist", "file", "-f", "ogg", "-i", "/x/a.ogg"]);
    expect(() => mediaInput("application/pdf", "/x/a.pdf")).toThrow("o tipo application/pdf não passa pelo ffmpeg");
    expect(probeFormatAllowed("mov,mp4,m4a,3gp,3g2,mj2")).toBe(true);
    expect(probeFormatAllowed("hls")).toBe(false);
    expect(probeFormatAllowed("concat")).toBe(false);
    expect(probeFormatAllowed(undefined)).toBe(false);
  });
});

describe("serving", () => {
  test("inline only for safe media; active content becomes a binary download", () => {
    expect(servesInline("image/webp")).toBe(true);
    expect(servesInline("image/svg+xml")).toBe(false);
    expect(servedContentType("image/svg+xml")).toBe("application/octet-stream");
    expect(servedContentType("text/plain")).toBe("text/plain; charset=utf-8");
    expect(servedContentType("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
    expect(servedContentType("")).toBe("application/octet-stream");
  });
});
