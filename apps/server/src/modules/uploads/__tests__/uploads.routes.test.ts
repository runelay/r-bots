import { beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeProcesses, resetData, testDataDir, writeData } from "../../../../test/helpers";
import { mediaTools } from "../../../../test/media-helpers";
import { Req, Res } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { handleUploads } from "../routes/uploads.routes";
import { listUploads, maxUploadBytes, prepareAttachments } from "../services/uploads.service";

const botId = "up-routes";
const bot = { id: botId, deletedAt: null } as unknown as BotDefinition;

interface Sent {
  status: number;
  headers: Headers;
  text: string;
  json: () => Record<string, unknown>;
}

async function call(
  method: string,
  rest: string[],
  init: { body?: Bun.BodyInit | null; headers?: Record<string, string> } = {},
  target: BotDefinition = bot,
): Promise<Sent> {
  const request = new Request(`http://gateway.local/bots/${botId}/uploads/${rest.join("/")}`, {
    method,
    headers: init.headers,
    body: init.body ?? null,
    duplex: "half",
  } as RequestInit);
  const req = new Req(request);
  const res = new Res(new AbortController().signal);
  await handleUploads(req, res, method, target, rest);
  const response = await res.response;
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

function uploadsDir() {
  return join(testDataDir(), "bots", botId, "uploads");
}

async function settle() {
  await prepareAttachments(botId, await listUploads(botId), true);
}

let media: ReturnType<typeof mediaTools>;

beforeEach(async () => {
  await resetData();
  media = mediaTools();
  fakeProcesses(media.handler);
});

describe("POST /bots/:id/uploads", () => {
  test("stores the body with the decoded name and declared type", async () => {
    const sent = await call("POST", [], {
      body: "hello world",
      headers: { "x-file-name": encodeURIComponent("relatório final.txt"), "x-file-type": "text/plain; charset=utf-8" },
    });
    expect(sent.status).toBe(201);
    const body = sent.json();
    expect(body).toMatchObject({ name: "relatório final.txt", mime: "text/plain", size: 11, kind: "file" });
    expect(body.url).toBe(`/bots/${botId}/uploads/${body.uploadId}`);
    const files = await readdir(uploadsDir());
    const stored = files.find((file) => file.endsWith("relatório final.txt")) as string;
    expect(await readFile(join(uploadsDir(), stored), "utf8")).toBe("hello world");
    await settle();
  });

  test("falls back to the raw name when it is not valid percent-encoding and infers the mime", async () => {
    const sent = await call("POST", [], {
      body: "{}",
      headers: { "x-file-name": "bad%E0%A4%A.json", "content-type": "application/octet-stream" },
    });
    expect(sent.json()).toMatchObject({ name: "bad%E0%A4%A.json", mime: "application/json" });
    const unnamed = await call("POST", [], { body: "x" });
    expect(unnamed.json()).toMatchObject({ name: "arquivo", mime: "application/octet-stream" });
    await settle();
  });

  test("rejects a body declared bigger than the limit before reading it", async () => {
    const sent = await call("POST", [], {
      body: "x",
      headers: { "content-length": String(maxUploadBytes + 1), "x-file-name": "big.bin" },
    });
    expect(sent.status).toBe(413);
    expect(sent.json()).toEqual({ ok: false, error: "O arquivo passa de 100 MB." });
    expect(sent.headers.get("connection")).toBe("close");
  });

  test("stops a stream that grows past the limit and removes the partial file", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sentChunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentChunks++ > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const sent = await call("POST", [], { body: stream, headers: { "x-file-name": "huge.bin" } });
    expect(sent.status).toBe(413);
    expect(await readdir(uploadsDir())).toEqual([]);
  });

  test("reports an interrupted body and an empty body", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("socket closed"));
      },
    });
    const interrupted = await call("POST", [], { body: broken, headers: { "x-file-name": "cut.bin" } });
    expect(interrupted.status).toBe(400);
    expect(interrupted.json().error).toBe("O envio foi interrompido.");
    const empty = await call("POST", [], { body: "", headers: { "x-file-name": "empty.txt" } });
    expect(empty.status).toBe(400);
    expect(empty.json().error).toBe("O arquivo está vazio.");
    expect(await readdir(uploadsDir())).toEqual([]);
  });

  test("refuses uploads to a deleted bot", async () => {
    const sent = await call("POST", [], { body: "x" }, { ...bot, deletedAt: "2026-01-01" } as BotDefinition);
    expect(sent.status).toBe(409);
    expect(sent.json()).toMatchObject({ code: "bot_deleted" });
  });

  test("rethrows storage failures that are not upload errors", async () => {
    await writeData(`bots/${botId}/uploads`, "not a directory");
    await expect(call("POST", [], { body: "x", headers: { "x-file-name": "a.txt" } })).rejects.toThrow();
  });
});

describe("GET /bots/:id/uploads/:uploadId", () => {
  test("serves the file, its meta and 404s for other methods", async () => {
    const created = (await call("POST", [], { body: "abcdef", headers: { "x-file-name": "a.txt" } })).json();
    const id = String(created.uploadId);
    const file = await call("GET", [id]);
    expect(file.status).toBe(200);
    expect(file.text).toBe("abcdef");
    const meta = await call("GET", [id, "meta"]);
    expect(meta.json()).toMatchObject({ uploadId: id, name: "a.txt" });
    const head = await call("HEAD", [id]);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    expect((await call("PUT", [id])).status).toBe(404);
    expect((await call("GET", [id, "thumb.jpg", "x"])).status).toBe(404);
    await settle();
  });
});
