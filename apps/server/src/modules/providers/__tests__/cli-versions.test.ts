import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { clisDir } from "../../../config/env";
import { latestFailureTtlMs, latestTtlMs } from "../constants/providers.constants";
import {
  compareVersions,
  listVersions,
  parseVersion,
  spawnCli,
  updateTask,
  useCliDeps,
} from "../services/cli-versions.service";
import type { CliDeps, CliVersion, SpawnResult } from "../types/providers.types";

interface Call {
  bin: string;
  args: string[];
  timeoutMs: number;
}

const imageReplies: Record<string, string> = {
  "/img/claude": "2.1.300 (Claude Code)\n",
  "/img/codex": "codex-cli 0.160.0\n",
  "/img/cursor-agent": "2026.11.01-abc\n",
};

let calls: Call[] = [];
let npmGate: Promise<void> | null = null;
let npmReply: SpawnResult = { code: 0, stdout: "", stderr: "" };
let wrongVersion: string | null = null;
let registry: Record<string, string> = {};
let fetches: string[] = [];
let clock = 1_000_000;

async function fakeSpawn(bin: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  calls.push({ bin, args, timeoutMs });
  if (bin === "/img/broken") throw new Error("spawn failed");
  if (bin in imageReplies) return { code: 0, stdout: imageReplies[bin], stderr: "" };
  if (bin === "/usr/bin/npm") {
    await npmGate;
    if (npmReply.code !== 0) return npmReply;
    const staging = args[args.indexOf("--prefix") + 1];
    const pkg = args.at(-1) ?? "";
    mkdirSync(join(staging, "bin"), { recursive: true });
    writeFileSync(join(staging, "bin", pkg.includes("codex") ? "codex" : "claude"), "");
    return npmReply;
  }
  if (args[0] === "--version" && existsSync(bin)) {
    const version = basename(dirname(dirname(bin))).replace(/\.tmp$/, "");
    return { code: 0, stdout: `${wrongVersion ?? version} (Claude Code)\n`, stderr: "" };
  }
  return { code: 1, stdout: "", stderr: "missing" };
}

const fakeWhich = (names: string[]) => {
  if (names.includes("npm")) return "/usr/bin/npm";
  if (names.includes("grok")) return null;
  return `/img/${names[0]}`;
};

async function fakeFetch(url: string) {
  fetches.push(url);
  const pkg = url.replace("https://registry.npmjs.org/-/package/", "").replace("/dist-tags", "");
  const latest = registry[pkg];
  if (latest === "down") throw new TypeError("fetch failed");
  if (latest === "500") return new Response("nope", { status: 500 });
  if (latest === "garbage") return Response.json(["x"]);
  return Response.json(latest ? { latest } : {});
}

function useFakes(overrides: Partial<CliDeps> = {}) {
  useCliDeps({ spawn: fakeSpawn, which: fakeWhich, fetch: fakeFetch, now: () => clock, ...overrides });
}

function byProvider(list: CliVersion[], provider: string) {
  const found = list.find((item) => item.provider === provider);
  if (!found) throw new Error(`missing ${provider}`);
  return found;
}

function link(provider: string, name: string) {
  return readlinkSync(join(clisDir, provider, name));
}

beforeEach(() => {
  calls = [];
  fetches = [];
  npmGate = null;
  npmReply = { code: 0, stdout: "", stderr: "" };
  wrongVersion = null;
  registry = { "@anthropic-ai/claude-code": "2.1.330", "@openai/codex": "0.171.0" };
  clock = 1_000_000;
  useFakes();
});

afterEach(() => {
  useCliDeps(null);
  rmSync(clisDir, { recursive: true, force: true });
});

describe("versions", () => {
  test("parses and compares versions", () => {
    expect(parseVersion("2.1.330 (Claude Code)")).toBe("2.1.330");
    expect(parseVersion("codex-cli 0.171.0-alpha.2")).toBe("0.171.0-alpha.2");
    expect(parseVersion("nothing")).toBeNull();
    expect(compareVersions("2.1.330", "2.1.330")).toBe(0);
    expect(compareVersions("2.1.340", "2.1.330")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("3.0.0", "2.9.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
  });

  test("lists image versions once per boot and the registry latest for managed clis", async () => {
    const first = await listVersions();
    expect(first.map(({ provider }) => provider).sort()).toEqual(["claude", "codex", "cursor", "grok"]);
    expect(byProvider(first, "claude")).toEqual({
      provider: "claude",
      installed: "2.1.300",
      source: "image",
      latest: "2.1.330",
      updateAvailable: true,
      updating: false,
      lastError: null,
      previous: null,
    });
    expect(byProvider(first, "codex")).toMatchObject({
      installed: "0.160.0",
      latest: "0.171.0",
      updateAvailable: true,
    });
    expect(byProvider(first, "cursor")).toMatchObject({ source: "image", latest: null, updateAvailable: false });
    expect(byProvider(first, "grok")).toMatchObject({ installed: null, source: "image", latest: null });
    await listVersions();
    expect(calls.filter(({ args }) => args[0] === "--version").map(({ bin }) => bin)).toEqual([
      "/img/claude",
      "/img/codex",
      "/img/cursor-agent",
    ]);
    expect(fetches).toEqual([
      "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags",
      "https://registry.npmjs.org/-/package/@openai/codex/dist-tags",
    ]);
  });

  test("an image binary that fails to run reports no version", async () => {
    useFakes({ which: (names) => (names.includes("claude") ? "/img/broken" : null) });
    expect(byProvider(await listVersions(), "claude")).toMatchObject({ installed: null, updateAvailable: false });
  });

  test("caches the latest version for 6 hours and failures for less", async () => {
    await listVersions();
    clock += latestTtlMs - 1;
    await listVersions();
    expect(fetches).toHaveLength(2);
    clock += 1;
    registry["@anthropic-ai/claude-code"] = "down";
    registry["@openai/codex"] = "500";
    const failed = await listVersions();
    expect(byProvider(failed, "claude").latest).toBeNull();
    expect(byProvider(failed, "codex").latest).toBeNull();
    expect(fetches).toHaveLength(4);
    registry["@anthropic-ai/claude-code"] = "garbage";
    registry["@openai/codex"] = "";
    await listVersions();
    expect(fetches).toHaveLength(4);
    clock += latestFailureTtlMs;
    const retried = await listVersions();
    expect(fetches).toHaveLength(6);
    expect(byProvider(retried, "claude").latest).toBeNull();
    expect(byProvider(retried, "codex").latest).toBeNull();
  });

  test("gives up on the registry after the deadline", async () => {
    let signal: AbortSignal | null = null;
    useFakes({
      registryTimeoutMs: 5,
      fetch: (_url, init) => {
        signal = init.signal;
        return new Promise<Response>((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason)),
        );
      },
    });
    expect(byProvider(await listVersions(), "claude").latest).toBeNull();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  test("BOTS_UPDATE_CHECKS=off skips the registry", async () => {
    useFakes({ checks: () => false });
    const list = await listVersions();
    expect(byProvider(list, "claude")).toMatchObject({ latest: null, updateAvailable: false });
    expect(fetches).toEqual([]);
  });

  test("the default fetch never leaves the machine in tests and the default spawn runs a process", async () => {
    useCliDeps({ spawn: fakeSpawn, which: fakeWhich });
    expect(byProvider(await listVersions(), "claude").latest).toBeNull();
    const result = await spawnCli(process.execPath, ["--version"], 10_000);
    expect(result.code).toBe(0);
    expect(parseVersion(result.stdout)).not.toBeNull();
  });
});

describe("provider routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  async function versions() {
    const response = await request<{ ok: boolean; providers: CliVersion[] }>("/providers/versions");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.body.providers;
  }

  async function update(provider: string, body?: unknown) {
    return request<Record<string, unknown>>(`/providers/${provider}/update`, { method: "POST", body });
  }

  async function updated(provider: string, version: string) {
    const response = await update(provider, { version });
    expect(response.status).toBe(202);
    await updateTask(provider);
  }

  test("installs a version into its own folder and points current at it", async () => {
    let release = () => {};
    npmGate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const started = await update("claude", { version: "2.1.330" });
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ ok: true, provider: "claude", version: "2.1.330" });
    const busy = await update("claude", { version: "2.1.331" });
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ ok: false, error: "Já tem uma atualização rodando para esse CLI." });
    const rollbackBusy = await request("/providers/claude/rollback", { method: "POST" });
    expect(rollbackBusy.status).toBe(409);
    expect(byProvider(await versions(), "claude")).toMatchObject({ updating: true, source: "image" });
    release();
    await updateTask("claude");
    const npm = calls.find(({ bin }) => bin === "/usr/bin/npm");
    expect(npm?.args).toEqual([
      "install",
      "-g",
      "--prefix",
      join(clisDir, "claude", "2.1.330.tmp"),
      "--no-audit",
      "--no-fund",
      "@anthropic-ai/claude-code@2.1.330",
    ]);
    expect(npm?.timeoutMs).toBe(600_000);
    expect(lstatSync(join(clisDir, "claude", "current")).isSymbolicLink()).toBe(true);
    expect(link("claude", "current")).toBe("2.1.330");
    expect(readdirSync(join(clisDir, "claude")).sort()).toEqual(["2.1.330", "current"]);
    expect(byProvider(await versions(), "claude")).toEqual({
      provider: "claude",
      installed: "2.1.330",
      source: "managed",
      latest: "2.1.330",
      updateAvailable: false,
      updating: false,
      lastError: null,
      previous: null,
    });
  });

  test("keeps the current and the previous version, rolls back and reuses a kept folder", async () => {
    await updated("claude", "2.1.330");
    await updated("claude", "2.1.340");
    expect(link("claude", "current")).toBe("2.1.340");
    expect(link("claude", "previous")).toBe("2.1.330");
    await updated("claude", "2.1.350");
    expect(readdirSync(join(clisDir, "claude")).sort()).toEqual(["2.1.340", "2.1.350", "current", "previous"]);
    expect(byProvider(await versions(), "claude")).toMatchObject({ installed: "2.1.350", previous: "2.1.340" });
    const back = await request<{ ok: boolean; version: CliVersion }>("/providers/claude/rollback", { method: "POST" });
    expect(back.status).toBe(200);
    expect(back.body.version).toMatchObject({ installed: "2.1.340", previous: "2.1.350", source: "managed" });
    expect(link("claude", "current")).toBe("2.1.340");
    expect(link("claude", "previous")).toBe("2.1.350");
    const npmCalls = calls.filter(({ bin }) => bin === "/usr/bin/npm").length;
    await updated("claude", "2.1.350");
    expect(calls.filter(({ bin }) => bin === "/usr/bin/npm")).toHaveLength(npmCalls);
    expect(link("claude", "current")).toBe("2.1.350");
    expect(link("claude", "previous")).toBe("2.1.340");
    await updated("claude", "2.1.350");
    expect(link("claude", "current")).toBe("2.1.350");
    expect(readdirSync(join(clisDir, "claude")).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  test("a failed verification removes the staging folder and keeps the current version", async () => {
    await updated("codex", "0.171.0");
    wrongVersion = "0.170.0";
    await updated("codex", "0.172.0");
    expect(existsSync(join(clisDir, "codex", "0.172.0.tmp"))).toBe(false);
    expect(existsSync(join(clisDir, "codex", "0.172.0"))).toBe(false);
    expect(link("codex", "current")).toBe("0.171.0");
    expect(byProvider(await versions(), "codex")).toMatchObject({
      installed: "0.171.0",
      updating: false,
      lastError: "A versão instalada não confere: esperava 0.172.0 e o CLI respondeu 0.170.0.",
    });
    wrongVersion = null;
    npmReply = { code: 1, stdout: "", stderr: "npm ERR! 404\nnpm ERR! not found" };
    await updated("codex", "0.173.0");
    expect(existsSync(join(clisDir, "codex", "0.173.0.tmp"))).toBe(false);
    expect(byProvider(await versions(), "codex").lastError).toBe(
      "O npm não instalou @openai/codex@0.173.0: npm ERR! 404 npm ERR! not found",
    );
    npmReply = { code: 1, stdout: "plain failure", stderr: "" };
    await updated("codex", "0.173.0");
    expect(byProvider(await versions(), "codex").lastError).toContain("plain failure");
    const back = await request("/providers/codex/rollback", { method: "POST" });
    expect(back.status).toBe(409);
    expect(back.body).toEqual({ ok: false, error: "Não há versão anterior para voltar." });
  });

  test("a kept folder whose binary stopped answering is not linked", async () => {
    await updated("claude", "2.1.330");
    mkdirSync(join(clisDir, "claude", "2.1.320"), { recursive: true });
    await updated("claude", "2.1.320");
    expect(link("claude", "current")).toBe("2.1.330");
    expect(byProvider(await versions(), "claude").lastError).toBe(
      "A versão instalada não confere: esperava 2.1.320 e o CLI respondeu com erro.",
    );
  });

  test("without a version the update goes to the latest, and fails when nobody knows it", async () => {
    const response = await update("claude");
    expect(response.body).toEqual({ ok: true, provider: "claude", version: "2.1.330" });
    await updateTask("claude");
    expect(link("claude", "current")).toBe("2.1.330");
    useFakes({ checks: () => false });
    const unknown = await update("codex", {});
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ field: "version" });
    expect((await update("codex", { version: "0.171.0" })).status).toBe(202);
    await updateTask("codex");
  });

  test("rejects other providers, bad versions, bad bodies and unknown routes", async () => {
    const cursor = await update("cursor", {});
    expect(cursor.status).toBe(400);
    expect(cursor.body).toEqual({
      ok: false,
      error: "Só o Claude Code e o Codex são atualizados por aqui.",
      field: "provider",
    });
    expect((await request("/providers/grok/rollback", { method: "POST" })).status).toBe(400);
    expect((await update("claude", { version: "../../etc" })).body).toMatchObject({ field: "version" });
    expect((await update("claude", { version: 2 })).status).toBe(400);
    expect((await update("claude", ["2.1.330"])).body).toMatchObject({ field: "body" });
    expect((await update("claude", "{")).body).toMatchObject({ field: "body" });
    expect((await request("/providers/claude")).status).toBe(404);
    expect((await request("/providers/versions", { method: "POST" })).status).toBe(404);
    expect(await updateTask("claude")).toBeUndefined();
  });
});
