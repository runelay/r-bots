import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resetData, testDataDir } from "../../../test/helpers";
import * as env from "../../config/env";
import { blobDriver, blobsDir, s3Settings } from "../../config/storage";
import { ValidationError } from "../errors";
import { notFound, Req, Res, readBody, runelayFailure, sendFile, sendJson, validationResponse } from "../http";
import { readJson, updateJson, writeJson } from "../json-file";
import {
  forgetSecretValue,
  installConsoleRedaction,
  redactDeep,
  redactionActive,
  redactText,
  rememberSecretValue,
  variantsOf,
} from "../redact";
import { socketOpen } from "../ws";

function newRes() {
  const controller = new AbortController();
  const res = new Res(controller.signal);
  let closes = 0;
  res.on("close", () => closes++);
  return { res, controller, closes: () => closes };
}

describe("config", () => {
  test("env reads the test data dir and derives every path from it", () => {
    expect(env.dataDir).toBe(testDataDir());
    expect(env.rootDir).toBe(resolve(import.meta.dir, "..", "..", ".."));
    expect(env.repoDir).toBe(resolve(env.rootDir, "..", ".."));
    expect(env.host).toBe("127.0.0.1");
    expect(env.port).toBe(Number(process.env.GATEWAY_PORT));
    expect(env.botsDir).toBe(join(testDataDir(), "bots"));
    expect(env.sessionsDir).toBe(join(testDataDir(), "sessions"));
    expect(env.threadsDir).toBe(join(testDataDir(), "threads"));
    expect(env.botDir("b1")).toBe(join(testDataDir(), "bots", "b1"));
    expect(env.botFile("b1")).toBe(join(testDataDir(), "bots", "b1.json"));
    expect(env.workspaceDir("b1")).toBe(join(testDataDir(), "workspaces", "b1"));
  });

  test("env parses the typed configuration from the environment", () => {
    expect(env.env.BOTS_SCHEDULES).toBe("off");
    expect(env.env.BOTS_MAX_TURNS).toBe(3);
    expect(env.env.RUNELAY_MCP_URL).toBe(process.env.RUNELAY_MCP_URL as string);
    expect(env.env.JEV_API_KEY).toBeUndefined();
  });

  async function loadEnv(overrides: Record<string, string | undefined>, tag: string) {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await import(`../../config/env.ts?${tag}`);
    } finally {
      for (const key of Object.keys(overrides)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("env falls back to production defaults when values are missing or blank", async () => {
    const defaults = await loadEnv(
      {
        BOTS_DATA_DIR: undefined,
        BOTS_APP_DIR: undefined,
        GATEWAY_HOST: "   ",
        GATEWAY_PORT: undefined,
        BOTS_MODEL: undefined,
        BOTS_SCHEDULES: undefined,
      },
      "defaults",
    );
    expect(defaults.dataDir).toBe(join(homedir(), ".local", "share", "runelay-bots"));
    expect(defaults.host).toBe("127.0.0.1");
    expect(defaults.port).toBe(2000);
    expect(defaults.model).toBe("claude-sonnet-5-5");
    expect(defaults.env.BOTS_SCHEDULES).toBe("on");
    expect(defaults.env.CODE_PR_AUTOCLOSE_HOURS).toBe(24);
  });

  test("env honors BOTS_APP_DIR for the app and repo roots", async () => {
    const custom = await loadEnv({ BOTS_APP_DIR: "/srv/app/apps/server", BOTS_DATA_DIR: undefined }, "app-dir");
    expect(custom.rootDir).toBe("/srv/app/apps/server");
    expect(custom.repoDir).toBe("/srv/app");
    expect(custom.dataDir).toBe(join(homedir(), ".local", "share", "runelay-bots"));
  });

  test("env rejects invalid values with every problem listed", async () => {
    await expect(loadEnv({ GATEWAY_PORT: "abc", RUNELAY_MCP_URL: "not a url" }, "invalid")).rejects.toThrow(
      /^Configuração inválida: .*GATEWAY_PORT: .*RUNELAY_MCP_URL: /,
    );
  });

  test("storage paths follow the test env and drivers parse their settings", () => {
    expect(blobsDir).toBe(process.env.BLOB_FS_DIR as string);
    expect(blobDriver()).toBe("fs");
    expect(blobDriver({})).toBe("s3");
    expect(s3Settings({})).toEqual({
      endpoint: "http://127.0.0.1:3900",
      bucket: "runelay-bots",
      region: "garage",
      accessKeyId: "",
      secretAccessKey: "",
      forcePathStyle: true,
    });
    expect(
      s3Settings({
        S3_ENDPOINT: "http://127.0.0.1:1",
        S3_BUCKET: "b",
        S3_REGION: "r",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        S3_FORCE_PATH_STYLE: "false",
      }),
    ).toEqual({
      endpoint: "http://127.0.0.1:1",
      bucket: "b",
      region: "r",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: false,
    });
    expect(s3Settings().endpoint).toBeString();
  });

  test("socketOpen matches the WebSocket OPEN state", () => {
    expect(socketOpen).toBe(WebSocket.OPEN);
  });
});

describe("errors", () => {
  test("ValidationError keeps the field", () => {
    const error = new ValidationError("bad name", "name");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("bad name");
    expect(error.field).toBe("name");
  });
});

describe("Req", () => {
  test("exposes method, path with query and lowercase headers", () => {
    const req = new Req(new Request("http://x.local/a/b?c=1", { method: "PUT", headers: { "X-Thing": "v" } }));
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("/a/b?c=1");
    expect(req.headers["x-thing"]).toBe("v");
  });

  test("iterates the body once as buffers", async () => {
    const req = new Req(new Request("http://x.local/", { method: "POST", body: "hello" }));
    const first: string[] = [];
    for await (const chunk of req) first.push(chunk.toString());
    const second: string[] = [];
    for await (const chunk of req) second.push(chunk.toString());
    expect(first.join("")).toBe("hello");
    expect(second).toEqual([]);
  });

  test("resume discards an unread body and ignores consumed or empty ones", async () => {
    const req = new Req(new Request("http://x.local/", { method: "POST", body: "drop" }));
    req.resume();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    expect(chunks).toEqual([]);
    req.resume();
    const empty = new Req(new Request("http://x.local/"));
    empty.resume();
    const none: Buffer[] = [];
    for await (const chunk of empty) none.push(chunk);
    expect(none).toEqual([]);
  });

  test("resume tolerates a body already locked by another reader", async () => {
    const req = new Req(new Request("http://x.local/", { method: "POST", body: "locked" }));
    const reader = req.raw.body?.getReader();
    expect(() => req.resume()).not.toThrow();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("locked");
  });

  test("emits close when the request aborts", () => {
    const controller = new AbortController();
    const req = new Req(new Request("http://x.local/", { signal: controller.signal }));
    let closed = 0;
    req.on("close", () => closed++);
    controller.abort();
    expect(closed).toBe(1);
  });
});

describe("Res", () => {
  test("end sends a buffered response with merged headers and closes once", async () => {
    const { res, closes } = newRes();
    res.writeHead(201, { "x-a": "1", "x-skip": undefined });
    res.setHeader("X-B", "2");
    res.end("done");
    res.end("again");
    const response = await res.response;
    expect(response.status).toBe(201);
    expect(response.headers.get("x-a")).toBe("1");
    expect(response.headers.get("x-b")).toBe("2");
    expect(response.headers.has("x-skip")).toBe(false);
    expect(await response.text()).toBe("done");
    expect(res.headersSent).toBe(true);
    expect(closes()).toBe(1);
  });

  test("end without body sends an empty response", async () => {
    const { res } = newRes();
    res.end();
    const response = await res.response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("write streams chunks until end", async () => {
    const { res, closes } = newRes();
    res.writeHead(200, { "content-type": "text/plain" });
    expect(res.write("a")).toBe(true);
    expect(res.write(new TextEncoder().encode("b"))).toBe(true);
    res.end("c");
    const response = await res.response;
    expect(await response.text()).toBe("abc");
    expect(res.write("late")).toBe(false);
    expect(closes()).toBe(1);
  });

  test("end with a non-text body after streaming only closes the stream", async () => {
    const { res } = newRes();
    res.write("x");
    res.end(new Blob(["ignored"]));
    expect(await (await res.response).text()).toBe("x");
  });

  test("a cancelled stream closes the response", async () => {
    const { res, closes } = newRes();
    res.write("x");
    const response = await res.response;
    await response.body?.cancel();
    expect(closes()).toBe(1);
    expect(res.write("y")).toBe(false);
  });

  test("a broken stream stops writes and end without throwing", async () => {
    const { res, closes } = newRes();
    res.write("x");
    const response = await res.response;
    const reader = response.body?.getReader();
    (res as unknown as { controller: ReadableStreamDefaultController }).controller.error(new Error("socket gone"));
    expect(() => res.end("tail")).not.toThrow();
    expect(closes()).toBe(1);
    await expect(reader?.read()).rejects.toThrow("socket gone");
  });

  test("an aborted request closes the response", () => {
    const { res, controller, closes } = newRes();
    controller.abort();
    expect(closes()).toBe(1);
    expect(res.write("late")).toBe(false);
  });

  test("respond forwards a streamed response and closes after it is read", async () => {
    const { res, closes } = newRes();
    res.respond(new Response("body", { status: 202, statusText: "Accepted", headers: { "x-r": "1" } }));
    res.respond(new Response("ignored"));
    const response = await res.response;
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted");
    expect(response.headers.get("x-r")).toBe("1");
    expect(closes()).toBe(0);
    expect(await response.text()).toBe("body");
    expect(closes()).toBe(1);
  });

  test("respond with an empty response closes right away", async () => {
    const { res, closes } = newRes();
    res.respond(new Response(null, { status: 204 }));
    expect((await res.response).status).toBe(204);
    expect(closes()).toBe(1);
  });
});

describe("http helpers", () => {
  test("sendJson writes status, json headers and payload", async () => {
    const { res } = newRes();
    sendJson(res, 207, { ok: "ç" }, { "x-extra": "1" });
    const response = await res.response;
    expect(response.status).toBe(207);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength('{"ok":"ç"}')));
    expect(response.headers.get("x-extra")).toBe("1");
    expect(await response.json()).toEqual({ ok: "ç" });
  });

  test("readBody parses json, returns undefined for blank bodies and throws on bad json", async () => {
    const post = (body?: string) => new Req(new Request("http://x.local/", { method: "POST", body }));
    expect(await readBody(post(' {"a":1} '))).toEqual({ a: 1 });
    expect(await readBody(post("   "))).toBeUndefined();
    expect(await readBody(post())).toBeUndefined();
    await expect(readBody(post("{"))).rejects.toBeInstanceOf(SyntaxError);
  });

  test("sendFile streams a blob with headers and status", async () => {
    const { res } = newRes();
    sendFile(res, new Blob(["file"]), { "content-type": "text/plain" }, 206);
    const response = await res.response;
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("file");
    const second = newRes();
    sendFile(second.res, new Blob(["x"]), {});
    expect((await second.res.response).status).toBe(200);
  });

  test("notFound answers 404 in pt-BR", async () => {
    const { res } = newRes();
    notFound(res);
    const response = await res.response;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Rota não encontrada." });
  });

  test("validationResponse maps validation and syntax errors to 400 and rethrows others", async () => {
    const invalid = newRes();
    validationResponse(invalid.res, new ValidationError("Nome obrigatório.", "name"));
    expect(await (await invalid.res.response).json()).toEqual({ ok: false, error: "Nome obrigatório.", field: "name" });
    const syntax = newRes();
    validationResponse(syntax.res, new SyntaxError("x"));
    const response = await syntax.res.response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "JSON inválido.", field: "body" });
    expect(() => validationResponse(newRes().res, new Error("boom"))).toThrow("boom");
  });

  test("runelayFailure answers 502 with a truncated message", async () => {
    const fromError = newRes();
    runelayFailure(fromError.res, new Error("timeout"));
    const response = await fromError.res.response;
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "runelay não respondeu: timeout" });
    const fromString = newRes();
    runelayFailure(fromString.res, "x".repeat(400));
    const body = (await (await fromString.res.response).json()) as { error: string };
    expect(body.error).toHaveLength(300);
    expect(body.error.startsWith("runelay não respondeu: xxx")).toBe(true);
  });
});

describe("json-file", () => {
  beforeEach(resetData);

  test("readJson returns the fallback for missing or invalid files", async () => {
    const path = join(testDataDir(), "missing.json");
    expect(await readJson(path, { a: 1 })).toEqual({ a: 1 });
    await writeFile(path, "{nope");
    expect(await readJson(path, [])).toEqual([]);
  });

  test("writeJson creates parent dirs, pretty prints and leaves no temp file", async () => {
    const path = join(testDataDir(), "deep", "dir", "file.json");
    await writeJson(path, { a: [1] });
    expect(await readFile(path, "utf8")).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(await readdir(join(testDataDir(), "deep", "dir"))).toEqual(["file.json"]);
  });

  test("updateJson serializes concurrent updates and skips writes on undefined", async () => {
    const path = join(testDataDir(), "counter.json");
    await Promise.all(Array.from({ length: 5 }, () => updateJson(path, { n: 0 }, (value) => ({ n: value.n + 1 }))));
    expect(await readJson(path, { n: -1 })).toEqual({ n: 5 });
    await updateJson(path, { n: 0 }, () => undefined);
    expect(await readJson(path, { n: -1 })).toEqual({ n: 5 });
    const untouched = join(testDataDir(), "untouched.json");
    await updateJson(untouched, {}, () => undefined);
    expect(existsSync(untouched)).toBe(false);
  });

  test("a failing update rejects without blocking the next one", async () => {
    const path = join(testDataDir(), "queue.json");
    const failing = updateJson(path, { n: 0 }, () => {
      throw new Error("update failed");
    });
    const next = updateJson(path, { n: 0 }, (value) => ({ n: value.n + 1 }));
    await expect(failing).rejects.toThrow("update failed");
    await next;
    expect(await readJson(path, { n: -1 })).toEqual({ n: 1 });
  });
});

describe("redact", () => {
  afterEach(() => {
    forgetSecretValue("api");
    forgetSecretValue("other");
    forgetSecretValue("old");
    setSystemTime();
  });

  test("variantsOf covers raw, json, url and base64 forms and skips short values", () => {
    expect(variantsOf("abc")).toEqual([]);
    const value = 'p"ss wörd';
    const variants = variantsOf(value);
    expect(variants).toContain(value);
    expect(variants).toContain(JSON.stringify(value).slice(1, -1));
    expect(variants).toContain(encodeURIComponent(value));
    expect(variants).toContain(Buffer.from(value).toString("base64"));
    expect(variants).toContain(Buffer.from(value).toString("base64url"));
    expect(new Set(variants).size).toBe(variants.length);
  });

  test("remembered secrets are masked in text and nested values until forgotten", () => {
    expect(redactionActive()).toBe(false);
    expect(redactText("token-123456")).toBe("token-123456");
    const plain = { a: "token-123456" };
    expect(redactDeep(plain)).toBe(plain);
    expect(rememberSecretValue("api", "abc")).toEqual([]);
    expect(rememberSecretValue("api", "token-123456")).toContain("token-123456");
    rememberSecretValue("api", "second-secret");
    expect(redactionActive()).toBe(true);
    expect(redactText("x token-123456 y second-secret")).toBe("x •••• y ••••");
    expect(redactText("")).toBe("");
    expect(redactText("nothing here")).toBe("nothing here");
    expect(
      redactDeep({ list: ["token-123456", 3, null], nested: { key: Buffer.from("token-123456").toString("base64") } }),
    ).toEqual({ list: ["••••", 3, null], nested: { key: "••••" } });
    forgetSecretValue("api");
    forgetSecretValue("api");
    expect(redactionActive()).toBe(false);
  });

  test("secrets expire after their ttl", () => {
    const now = Date.now();
    rememberSecretValue("old", "expiring-secret");
    setSystemTime(new Date(now + 31 * 60_000));
    rememberSecretValue("other", "fresh-secret");
    expect(redactText("expiring-secret fresh-secret")).toBe("expiring-secret ••••");
  });

  test("console redaction masks string and buffer writes on stdout and stderr", () => {
    const original = { stdout: process.stdout.write, stderr: process.stderr.write };
    const written: unknown[] = [];
    const capture = ((chunk: unknown) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      installConsoleRedaction();
      installConsoleRedaction();
      process.stdout.write("before token-123456");
      rememberSecretValue("api", "token-123456");
      process.stdout.write("out token-123456");
      process.stderr.write(Buffer.from("err token-123456"));
      const bytes = new Uint8Array([1, 2]);
      process.stdout.write(bytes);
    } finally {
      process.stdout.write = original.stdout;
      process.stderr.write = original.stderr;
    }
    expect(written).toEqual(["before token-123456", "out ••••", "err ••••", new Uint8Array([1, 2])]);
  });
});
