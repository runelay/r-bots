import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { env } from "../../../config/env";
import { redactText } from "../../../shared/redact";
import type { Principal } from "../../auth/services/auth.middleware";
import { authorize } from "../../auth/services/policy.service";
import { latestFailureTtlMs } from "../../providers/constants/providers.constants";
import { notesLimit, releaseTtlMs, updatePickupMs, updateStaleMs } from "../constants/server-version.constants";
import {
  parseUpdateStatus,
  readServerUpdate,
  requestServerUpdate,
  useServerUpdateDeps,
} from "../services/server-update.service";
import { ghAuthToken, normalizeVersion, serverVersion, useServerVersionDeps } from "../services/server-version.service";
import type { ReleaseSettings, ServerUpdate, ServerVersion, ServerVersionDeps } from "../types/server-version.types";

interface Call {
  url: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];
let clock = 1_000_000;
let reply: () => Response | Promise<Response> = () => Response.json({});
let updateDir = "";
let runningTurns = 0;

const stableSettings: ReleaseSettings = { version: "0.2.0", channel: "stable", token: null, repo: "runelay/r-bots" };

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/runelay/r-bots/releases/tag/${tag}`,
    published_at: "2026-11-20T12:00:00Z",
    body: `notas de ${tag}`,
    draft: false,
    prerelease: tag.includes("-"),
    ...extra,
  };
}

function useFakes(settings: Partial<ReleaseSettings> = {}, overrides: Partial<ServerVersionDeps> = {}) {
  useServerVersionDeps({
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return reply();
    },
    now: () => clock,
    settings: () => ({ ...stableSettings, ...settings }),
    ghToken: async () => null,
    ...overrides,
  });
}

async function useUpdateDir() {
  updateDir = await mkdtemp(join(tmpdir(), "rbots-update-"));
  runningTurns = 0;
  let ids = 0;
  useServerUpdateDeps({
    dir: () => updateDir,
    runningTurns: async () => runningTurns,
    now: () => clock,
    newId: () => `req-${++ids}`,
  });
}

async function writeUpdate(file: string, value: unknown) {
  await writeFile(join(updateDir, file), typeof value === "string" ? value : JSON.stringify(value));
}

async function readUpdate<T>(file: string) {
  return JSON.parse(await readFile(join(updateDir, file), "utf8")) as T;
}

const agent = { version: "0.2.0", installedAt: "2026-11-21T10:00:00Z" };

afterEach(async () => {
  calls = [];
  clock = 1_000_000;
  reply = () => Response.json({});
  useServerVersionDeps(null);
  useServerUpdateDeps(null);
  if (updateDir) await rm(updateDir, { recursive: true, force: true });
  updateDir = "";
});

describe("server version", () => {
  test("reads the stable latest release and offers the update", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes();
    await useUpdateDir();
    expect(await serverVersion()).toEqual({
      current: "0.2.0",
      channel: "stable",
      latest: "0.3.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/runelay/r-bots/releases/tag/v0.3.0",
      publishedAt: "2026-11-20T12:00:00Z",
      notes: "notas de v0.3.0",
      updateCommand: "rbots update",
      update: { available: false, state: "idle" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/runelay/r-bots/releases/latest");
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  test("the same or an older release is not an update", async () => {
    reply = () => Response.json(release("v0.2.0"));
    useFakes();
    expect(await serverVersion()).toMatchObject({ latest: "0.2.0", updateAvailable: false });
    useFakes({ version: "v0.4.0", repo: "acme/fork" });
    expect(await serverVersion()).toMatchObject({ current: "0.4.0", latest: "0.2.0", updateAvailable: false });
    expect(calls.at(-1)?.url).toBe("https://api.github.com/repos/acme/fork/releases/latest");
  });

  test("sends the token as a bearer and keeps it out of the logs", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({ token: "ghp_releasetoken123456" });
    await serverVersion();
    expect(calls[0].headers.authorization).toBe("Bearer ghp_releasetoken123456");
    expect(redactText("token ghp_releasetoken123456")).not.toContain("ghp_releasetoken123456");
  });

  test("falls back to the gh login when no token is configured", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({}, { ghToken: async () => "gho_fromghlogin123456" });
    await serverVersion();
    expect(calls[0].headers.authorization).toBe("Bearer gho_fromghlogin123456");
  });

  test("reads the gh token and ignores a missing or failing gh", async () => {
    const reply = (code: number, stdout: string) => async () => ({ code, stdout, stderr: "" });
    expect(await ghAuthToken(reply(0, "gho_token\n"))).toBe("gho_token");
    expect(await ghAuthToken(reply(0, "  "))).toBeNull();
    expect(await ghAuthToken(reply(1, "gho_token"))).toBeNull();
    expect(
      await ghAuthToken(async () => {
        throw new Error("gh not found");
      }),
    ).toBeNull();
  });

  test("dev never has an update", async () => {
    reply = () => Response.json(release("v9.0.0"));
    useFakes({ version: null });
    expect(await serverVersion()).toMatchObject({ current: "dev", latest: "9.0.0", updateAvailable: false });
    useFakes({ version: "dev" });
    expect(await serverVersion()).toMatchObject({ current: "dev", updateAvailable: false });
    useFakes({ version: "nightly" });
    expect(await serverVersion()).toMatchObject({ current: "nightly", updateAvailable: false });
  });

  test("the beta channel picks the newest release including pre-releases", async () => {
    reply = () =>
      Response.json([
        release("v0.3.0"),
        release("v0.4.0-beta.2"),
        release("v0.4.0-beta.10"),
        release("v0.9.0", { draft: true }),
        release("latest"),
        "garbage",
        null,
      ]);
    useFakes({ channel: "beta", version: "0.4.0-beta.2" });
    const version = await serverVersion();
    expect(version).toMatchObject({ channel: "beta", latest: "0.4.0-beta.10", updateAvailable: true });
    expect(calls[0].url).toBe("https://api.github.com/repos/runelay/r-bots/releases?per_page=30");
    useFakes({ channel: "beta", version: "0.4.0" });
    expect(await serverVersion()).toMatchObject({ latest: "0.4.0-beta.10", updateAvailable: false });
  });

  test("a beta answer that is not a list has no latest", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({ channel: "beta" });
    expect((await serverVersion()).latest).toBeNull();
  });

  test("cuts the notes and drops empty fields", async () => {
    reply = () => Response.json(release("v0.3.0", { body: "é".repeat(notesLimit + 500) }));
    useFakes();
    const notes = (await serverVersion()).notes ?? "";
    expect(Array.from(notes)).toHaveLength(notesLimit);
    reply = () => Response.json(release("v0.3.1", { body: "  ", html_url: 1, published_at: null }));
    useFakes();
    expect(await serverVersion()).toMatchObject({ latest: "0.3.1", notes: null, releaseUrl: null, publishedAt: null });
  });

  test("caches the release for 10 minutes", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes();
    await serverVersion();
    clock += releaseTtlMs - 1;
    await serverVersion();
    expect(calls).toHaveLength(1);
    reply = () => Response.json(release("v0.3.1"));
    clock += 1;
    expect((await serverVersion()).latest).toBe("0.3.1");
    expect(calls).toHaveLength(2);
  });

  test("caches a failure for 10 minutes and then asks again", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("Not Found", { status: 404 }),
      () => Promise.reject(new TypeError("fetch failed")),
      () => Response.json(["x"]),
      () => new Response("{", { status: 200 }),
    ];
    for (const failure of failures) {
      reply = failure;
      useFakes();
      expect(await serverVersion()).toMatchObject({
        latest: null,
        updateAvailable: false,
        releaseUrl: null,
        notes: null,
      });
      clock += latestFailureTtlMs - 1;
      await serverVersion();
      expect(calls).toHaveLength(1);
      reply = () => Response.json(release("v0.3.0"));
      clock += 1;
      expect((await serverVersion()).latest).toBe("0.3.0");
      expect(calls).toHaveLength(2);
      calls = [];
    }
  });

  test("gives up on GitHub after the deadline", async () => {
    let signal: AbortSignal | null = null;
    useFakes(
      {},
      {
        timeoutMs: 5,
        fetch: (_url, init) => {
          signal = init.signal;
          return new Promise<Response>((_resolve, reject) =>
            init.signal.addEventListener("abort", () => reject(init.signal.reason)),
          );
        },
      },
    );
    expect((await serverVersion()).latest).toBeNull();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  test("BOTS_UPDATE_CHECKS=off skips GitHub", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({}, { checks: () => false });
    expect(await serverVersion()).toMatchObject({ current: "0.2.0", latest: null, updateAvailable: false });
    expect(calls).toEqual([]);
  });

  test("normalizes tags and the defaults read the environment without leaving the machine", async () => {
    expect(normalizeVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(normalizeVersion(" 1.2.3 ")).toBe("1.2.3");
    expect(normalizeVersion("1.2")).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
    const version = await serverVersion();
    expect(version).toMatchObject({
      current: normalizeVersion(env.RBOTS_VERSION) ?? env.RBOTS_VERSION?.trim() ?? "dev",
      channel: env.RBOTS_CHANNEL,
      latest: null,
      updateCommand: "rbots update",
    });
  });
});

describe("server update", () => {
  test("without the host agent the update is not available and the request is refused", async () => {
    await useUpdateDir();
    expect(await readServerUpdate()).toEqual({ available: false, state: "idle" });
    expect(await requestServerUpdate(false)).toEqual({ ok: false, status: 422, code: "agent_missing" });
    expect(await readdir(updateDir)).toEqual([]);
  });

  test("writes the request atomically and reports it as queued", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    expect(await readServerUpdate()).toEqual({ available: true, state: "idle" });
    expect(await requestServerUpdate(false)).toEqual({ ok: true, update: { available: true, state: "queued" } });
    expect(await readUpdate("request.json")).toEqual({
      id: "req-1",
      requestedAt: new Date(clock).toISOString(),
      force: false,
    });
    expect((await readdir(updateDir)).sort()).toEqual(["agent.json", "request.json"]);
    expect(await readServerUpdate()).toEqual({ available: true, state: "queued" });
  });

  test("refuses a second request while one is queued or running", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    const [first, second] = await Promise.all([requestServerUpdate(false), requestServerUpdate(false)]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, status: 409, code: "update_in_progress" });
    await rm(join(updateDir, "request.json"));
    await writeUpdate("status.json", {
      id: "req-1",
      state: "running",
      step: "Baixando a 0.3.0",
      from: "0.2.0",
      to: "0.3.0",
      updatedAt: new Date(clock).toISOString(),
    });
    expect(await readServerUpdate()).toEqual({
      available: true,
      state: "running",
      step: "Baixando a 0.3.0",
      from: "0.2.0",
      to: "0.3.0",
    });
    expect(await requestServerUpdate(true)).toEqual({ ok: false, status: 409, code: "update_in_progress" });
  });

  test("refuses with running turns unless forced", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    runningTurns = 2;
    expect(await requestServerUpdate(false)).toEqual({ ok: false, status: 409, code: "turns_running", running: 2 });
    expect(await readdir(updateDir)).toEqual(["agent.json"]);
    expect(await requestServerUpdate(true)).toMatchObject({ ok: true });
    expect(await readUpdate("request.json")).toMatchObject({ force: true });
  });

  test("a finished run allows a new request and a new request outranks the old status", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    await writeUpdate("status.json", {
      id: "old",
      state: "failed",
      message: "não deu para baixar a imagem",
      from: "0.2.0",
      to: "0.3.0",
      finishedAt: "2026-11-21T10:05:00Z",
      updatedAt: "2026-11-21T10:05:00Z",
    });
    expect(await readServerUpdate()).toEqual({
      available: true,
      state: "failed",
      message: "não deu para baixar a imagem",
      from: "0.2.0",
      to: "0.3.0",
      finishedAt: "2026-11-21T10:05:00Z",
    });
    expect(await requestServerUpdate(false)).toMatchObject({ ok: true });
    expect(await readServerUpdate()).toEqual({ available: true, state: "queued" });
  });

  test("a running status that stopped updating counts as failed and does not block", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    await writeUpdate("status.json", {
      id: "x",
      state: "running",
      step: "Subindo",
      updatedAt: new Date(clock).toISOString(),
    });
    clock += updateStaleMs + 1;
    const update = await readServerUpdate();
    expect(update).toMatchObject({ available: true, state: "failed", step: "Subindo" });
    expect(update.message).toContain("vigia");
    expect(await requestServerUpdate(false)).toMatchObject({ ok: true });
  });

  test("a request the agent never picked up turns into a failure and can be sent again", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    expect(await requestServerUpdate(false)).toMatchObject({ ok: true });
    clock += updatePickupMs;
    expect(await readServerUpdate()).toEqual({ available: true, state: "queued" });
    clock += 1;
    expect(await readServerUpdate()).toMatchObject({ available: true, state: "failed" });
    expect(await requestServerUpdate(false)).toMatchObject({ ok: true });
    expect(await readUpdate("request.json")).toMatchObject({ id: "req-2" });
  });

  test("a failed request does not jam the next one", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    useServerUpdateDeps({
      dir: () => updateDir,
      runningTurns: async () => {
        throw new Error("redis fora");
      },
    });
    await expect(requestServerUpdate(false)).rejects.toThrow("redis fora");
    expect(await requestServerUpdate(true)).toMatchObject({ ok: true });
  });

  test("the defaults count the real turns, stamp the clock and use a random id", async () => {
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    useServerUpdateDeps({ dir: () => updateDir });
    await writeUpdate("status.json", { id: "x", state: "running", updatedAt: new Date(Date.now()).toISOString() });
    expect(await readServerUpdate()).toMatchObject({ state: "running" });
    await rm(join(updateDir, "status.json"));
    expect(await requestServerUpdate(false)).toMatchObject({ ok: true });
    const written = await readUpdate<{ id: string; requestedAt: string }>("request.json");
    expect(written.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(Date.parse(written.requestedAt) - Date.now())).toBeLessThan(60_000);
  });

  test("parses the status written by the host and ignores garbage", async () => {
    expect(parseUpdateStatus(null)).toBeNull();
    expect(parseUpdateStatus([])).toBeNull();
    expect(parseUpdateStatus({ state: "exploding" })).toBeNull();
    expect(
      parseUpdateStatus({ state: "succeeded", step: "  ", message: 3, to: " 0.3.0 ", updatedAt: "ontem" }),
    ).toEqual({
      id: null,
      state: "succeeded",
      to: "0.3.0",
      updatedAt: null,
    });
    expect(parseUpdateStatus({ state: "failed", message: "x".repeat(900) })?.message).toHaveLength(500);
    await useUpdateDir();
    await writeUpdate("agent.json", agent);
    await writeUpdate("status.json", "{ not json");
    expect(await readServerUpdate()).toEqual({ available: true, state: "idle" });
  });
});

describe("server version route", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  test("answers GET /server/version for the owner only", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes();
    const response = await request<ServerVersion>("/server/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toMatchObject({ current: "0.2.0", latest: "0.3.0", updateAvailable: true });
    expect((await request("/server/version", { method: "POST" })).status).toBe(404);
    expect((await request("/server/other")).status).toBe(404);
    const owner: Principal = { userId: "o", email: "o@x.co", name: "O", role: "owner", method: "session" };
    expect(authorize("GET", ["server", "version"], owner)).toBe("allow");
    expect(authorize("GET", ["server", "version"], { ...owner, role: "member" })).toBe("owner");
    expect(authorize("GET", ["server", "version"], { ...owner, method: "internal" })).toBe("deny-internal");
  });

  test("answers POST /server/update with the refusals and the queued request", async () => {
    await useUpdateDir();
    const missing = await request<{ code: string }>("/server/update", { method: "POST" });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ ok: false, code: "agent_missing" });
    const english = await request<{ error: string }>("/server/update", {
      method: "POST",
      headers: { "accept-language": "en" },
    });
    expect(english.body.error).toBe(
      "The update watcher is not installed on this server. Run rbots update on the server.",
    );
    await writeUpdate("agent.json", agent);
    runningTurns = 1;
    const busy = await request("/server/update", { method: "POST", body: {} });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ ok: false, code: "turns_running", running: 1 });
    expect((await request("/server/update", { method: "POST", body: { force: "yes" } })).status).toBe(400);
    expect((await request("/server/update", { method: "POST", body: [true] })).status).toBe(400);
    expect((await request("/server/update", { method: "POST", body: "{" })).status).toBe(400);
    const queued = await request<{ update: ServerUpdate }>("/server/update", { method: "POST", body: { force: true } });
    expect(queued.status).toBe(202);
    expect(queued.body.update).toEqual({ available: true, state: "queued" });
    const again = await request("/server/update", { method: "POST", body: { force: true } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "update_in_progress" });
    reply = () => Response.json(release("v0.3.0"));
    useFakes();
    expect((await request<ServerVersion>("/server/version")).body.update).toEqual({ available: true, state: "queued" });
    const owner: Principal = { userId: "o", email: "o@x.co", name: "O", role: "owner", method: "session" };
    expect(authorize("POST", ["server", "update"], { ...owner, role: "member" })).toBe("owner");
    expect(authorize("POST", ["server", "update"], { ...owner, method: "internal" })).toBe("deny-internal");
  });
});
