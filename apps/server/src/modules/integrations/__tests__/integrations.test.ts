import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeRunelay, request, startTestServer, type TestServer, testDataDir } from "../../../../test/helpers";
import { readOrCreateSecret, rotateRunnerToken, runnerToken, runnerTokenFile } from "../../../config/runtime-secrets";
import { getDb } from "../../../db";
import { readSetting, writeSetting } from "../../../db/settings";
import { settings } from "../../../db/tables";
import { jevEnabled } from "../../approvals/services/jev.service";
import { listConnections, runelayEnabled } from "../../connectors/services/runelay.service";
import { voiceEnabled } from "../../voice/services/voice.service";
import {
  clearStored,
  integrationSecret,
  integrationSource,
  integrationUrl,
  onIntegrationChange,
  readStored,
  resetIntegrationCache,
  writeStored,
} from "../services/integration-store.service";
import { integrationFlags, setProbeLoopbackPorts, trustedServiceUrl } from "../services/integrations.service";

const goodKey = "sk_good_key_1234";
const seen: Array<{ path: string; key: string | null; body: string }> = [];
let services: ReturnType<typeof Bun.serve>;
let server: TestServer;
const saved = { ...process.env };
const vaultKeyFile = process.env.VAULT_KEY_FILE as string;
const createdVaultKey = !existsSync(vaultKeyFile);

beforeAll(async () => {
  if (createdVaultKey) writeFileSync(vaultKeyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  setProbeLoopbackPorts([Number(new URL(fakeRunelay.mcpUrl).port), 9]);
  services = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = req.headers.get("xi-api-key") ?? req.headers.get("authorization")?.replace("Bearer ", "") ?? null;
      seen.push({ path: url.pathname, key, body: await req.text() });
      if (url.pathname === "/eleven/v1/user")
        return key === goodKey ? Response.json({ subscription: {} }) : new Response("no", { status: 401 });
      if (url.pathname === "/jev") {
        if (key === "sk_down_key_9999") return new Response("down", { status: 503 });
        return key === goodKey
          ? Response.json({ answers: { ping: { type: "noul", noul: 1 } } })
          : new Response("no", { status: 403 });
      }
      return new Response("nope", { status: 404 });
    },
  });
  process.env.ELEVENLABS_API_URL = `http://127.0.0.1:${services.port}/eleven`;
  process.env.JEV_URL = `http://127.0.0.1:${services.port}/jev`;
  server = await startTestServer();
});

afterEach(async () => {
  for (const id of ["elevenlabs", "jev", "runelay"] as const) await clearStored(id);
  process.env.RUNELAY_MCP_URL = saved.RUNELAY_MCP_URL;
  process.env.RUNELAY_MCP_TOKEN = saved.RUNELAY_MCP_TOKEN;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.JEV_API_KEY;
  seen.length = 0;
});

afterAll(async () => {
  if (createdVaultKey) rmSync(vaultKeyFile, { force: true });
  await server.close();
  await services.stop(true);
  process.env.ELEVENLABS_API_URL = saved.ELEVENLABS_API_URL;
  process.env.JEV_URL = saved.JEV_URL;
});

type Item = {
  id: string;
  status: string;
  configured: boolean;
  source: string | null;
  last4: string;
  validatedAt: string | null;
  url: string | null;
};

async function list() {
  const response = await request<{ integrations: Item[] }>("/integrations");
  expect(response.status).toBe(200);
  return Object.fromEntries(response.body.integrations.map((item) => [item.id, item]));
}

describe("integrations", () => {
  test("lists every integration off when nothing is set", async () => {
    delete process.env.RUNELAY_MCP_TOKEN;
    const items = await list();
    expect(Object.keys(items)).toEqual(["elevenlabs", "jev", "runelay"]);
    for (const item of Object.values(items)) {
      expect(item.status).toBe("not_configured");
      expect(item.configured).toBe(false);
      expect(item.last4).toBe("");
    }
    expect(voiceEnabled()).toBe(false);
    expect(jevEnabled()).toBe(false);
    expect(runelayEnabled()).toBe(false);
    const meta = await request<{ integrations: Record<string, boolean> }>("/meta");
    expect(meta.body.integrations).toEqual({ elevenlabs: false, jev: false, runelay: false });
  });

  test("falls back to env and reports the source", async () => {
    process.env.ELEVENLABS_API_KEY = "env_eleven_abcd";
    const items = await list();
    expect(items.elevenlabs).toMatchObject({ status: "connected", source: "env", last4: "abcd", validatedAt: null });
    expect(items.runelay).toMatchObject({ source: "env", url: fakeRunelay.mcpUrl });
    expect(integrationFlags()).toEqual({ elevenlabs: true, jev: false, runelay: true });
  });

  test("validates, saves encrypted and never returns the key", async () => {
    const before = await request("/integrations/elevenlabs", { method: "PUT", body: { key: "sk_bad_key_0000" } });
    expect(before.status).toBe(422);
    expect(before.body).toMatchObject({
      code: "invalid_key",
      status: "invalid",
      error: "O ElevenLabs recusou essa chave.",
    });
    expect(voiceEnabled()).toBe(false);

    const changes: string[] = [];
    const off = onIntegrationChange((id) => changes.push(id));
    const response = await request<Item>("/integrations/elevenlabs", { method: "PUT", body: { key: goodKey } });
    off();
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(goodKey);
    expect(response.body).toMatchObject({ status: "connected", source: "app", last4: "1234", configured: true });
    expect(response.body.validatedAt).toBeString();
    expect(changes).toEqual(["elevenlabs"]);
    expect(seen.at(-1)).toMatchObject({ path: "/eleven/v1/user", key: goodKey });

    const row = await readSetting<Record<string, string>>("integration:elevenlabs", {}, getDb());
    expect(JSON.stringify(row)).not.toContain(goodKey);
    expect(row.keyRef).toBe("vault");
    await resetIntegrationCache();
    expect(integrationSecret("elevenlabs")).toBe(goodKey);
    expect(voiceEnabled()).toBe(true);

    process.env.ELEVENLABS_API_KEY = "env_wins_never";
    expect(integrationSecret("elevenlabs")).toBe(goodKey);

    const removed = await request<Item>("/integrations/elevenlabs", { method: "DELETE" });
    expect(removed.body).toMatchObject({ source: "env", status: "connected" });
    delete process.env.ELEVENLABS_API_KEY;
    expect(voiceEnabled()).toBe(false);
  });

  test("clearing a saved key deletes its settings row", async () => {
    await writeStored("jev", goodKey, null);
    expect(readStored("jev")?.last4).toBe("1234");
    expect(await clearStored("jev")).toBe(true);
    const rows = await getDb().select({ key: settings.key }).from(settings);
    expect(rows.map((row) => row.key)).not.toContain("integration:jev");
    expect(readStored("jev")).toBeNull();
    expect(integrationSecret("jev")).toBeNull();
    expect(await clearStored("jev")).toBe(false);
    await writeStored("jev", goodKey, null);
    const removed = await request<Item>("/integrations/jev", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ configured: false, source: null });
    expect(readStored("jev")).toBeNull();
  });

  test("validates jev with a tiny question and reports outages", async () => {
    const down = await request<{ error: string }>("/integrations/jev", {
      method: "PUT",
      body: { key: "sk_down_key_9999" },
    });
    expect(down.status).toBe(422);
    expect(down.body.error).toBe("O Jev respondeu 503. Tente de novo em instantes.");
    const bad = await request<{ error: string }>("/integrations/jev", {
      method: "PUT",
      body: { key: "sk_bad_key_0000" },
    });
    expect(bad.body.error).toBe("O Jev recusou essa chave.");
    const good = await request<Item>("/integrations/jev", { method: "PUT", body: { key: goodKey } });
    expect(good.body.status).toBe("connected");
    expect(JSON.parse(seen.at(-1)?.body ?? "{}").questions.ping.type).toBe("noul");
    expect(jevEnabled()).toBe(true);
  });

  test("validates runelay with list_connections and reconnects", async () => {
    fakeRunelay.tool("list_connections", () => []);
    delete process.env.RUNELAY_MCP_TOKEN;
    delete process.env.RUNELAY_MCP_URL;
    const noUrl = await request<{ field: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: "whatever-key" },
    });
    expect(noUrl.status).toBe(400);
    expect(noUrl.body.field).toBe("url");
    const badUrl = await request<{ field: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: "whatever-key", url: "ftp://x" },
    });
    expect(badUrl.body.field).toBe("url");
    const wrongType = await request<{ field: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: "whatever-key", url: 12 },
    });
    expect(wrongType.body.field).toBe("url");
    const refused = await request<{ error: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: "wrong-runelay-token", url: fakeRunelay.mcpUrl },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("O runelay recusou essa chave.");
    const unreachable = await request<{ error: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: "wrong-runelay-token", url: "http://127.0.0.1:9/mcp" },
    });
    expect(unreachable.body.error).toBe("Não consegui falar com o runelay nesse endereço.");
    const ok = await request<Item>("/integrations/runelay", {
      method: "PUT",
      body: { key: fakeRunelay.token, url: fakeRunelay.mcpUrl },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ source: "app", url: fakeRunelay.mcpUrl });
    expect(integrationUrl("runelay")).toBe(fakeRunelay.mcpUrl);
    expect(runelayEnabled()).toBe(true);
    expect(await listConnections(true)).toEqual([]);
  });

  test("runelay needs https outside loopback and the probe refuses internal hosts", async () => {
    const insecure = await request<{ field: string; error: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: "whatever-key", url: "http://runelay.example.com/mcp" },
    });
    expect(insecure.status).toBe(400);
    expect(insecure.body.error).toContain("https");
    const userinfo = await request<{ field: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: "whatever-key", url: "https://u:p@runelay.example.com/mcp" },
    });
    expect(userinfo.body.field).toBe("url");
    const internal = await request<{ error: string }>("/integrations/runelay", {
      method: "PUT",
      body: { key: fakeRunelay.token, url: "https://10.1.2.3/mcp" },
    });
    expect(internal.body.error).toBe("Não consegui falar com o runelay nesse endereço.");
    setProbeLoopbackPorts([]);
    try {
      const blocked = await request<{ error: string }>("/integrations/runelay", {
        method: "PUT",
        body: { key: fakeRunelay.token, url: fakeRunelay.mcpUrl },
      });
      expect(blocked.status).toBe(422);
      process.env.RUNELAY_ALLOW_LOOPBACK = "1";
      fakeRunelay.tool("list_connections", () => []);
      const allowed = await request<Item>("/integrations/runelay", {
        method: "PUT",
        body: { key: fakeRunelay.token, url: fakeRunelay.mcpUrl },
      });
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.RUNELAY_ALLOW_LOOPBACK;
      setProbeLoopbackPorts([Number(new URL(fakeRunelay.mcpUrl).port), 9]);
    }
  });

  test("service urls must be https unless they point at loopback", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(trustedServiceUrl(undefined, "https://fallback")).toBe("https://fallback");
      expect(trustedServiceUrl(" ", "https://fallback")).toBe("https://fallback");
      expect(trustedServiceUrl("https://api.example.com", "https://fallback")).toBe("https://api.example.com");
      expect(trustedServiceUrl("http://127.0.0.1:9/x", "https://fallback")).toBe("http://127.0.0.1:9/x");
      expect(trustedServiceUrl("http://api.example.com", "https://fallback")).toBe("https://fallback");
      expect(trustedServiceUrl("https://u:p@api.example.com", "https://fallback")).toBe("https://fallback");
      expect(trustedServiceUrl("not a url", "https://fallback")).toBe("https://fallback");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("v1 integration keys are re-encrypted to v2 at load and bound to their url", async () => {
    const master = Buffer.from(readFileSync(vaultKeyFile, "utf8").trim(), "hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", master, iv);
    cipher.setAAD(Buffer.from("runelay-bots:integration:v1:jev", "utf8"));
    const ct = Buffer.concat([cipher.update(goodKey, "utf8"), cipher.final()]);
    const legacy = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
      keyRef: "vault",
      last4: "1234",
      url: null,
      validatedAt: "2026-11-01T00:00:00.000Z",
      savedAt: "2026-11-01T00:00:00.000Z",
    };
    await writeSetting("integration:jev", legacy, getDb());
    await writeSetting("integration:elevenlabs", { ...legacy, tag: Buffer.alloc(16).toString("base64") }, getDb());
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await resetIntegrationCache();
      expect(log).toHaveBeenCalledWith("integrations: re-encrypted 1 keys to v2");
    } finally {
      log.mockRestore();
    }
    const row = await readSetting<Record<string, string>>("integration:jev", {}, getDb());
    expect(Buffer.from(row.iv, "base64")[0]).toBe(2);
    expect(integrationSecret("jev")).toBe(goodKey);
    await writeSetting("integration:jev", { ...row, url: "https://evil.example.com" }, getDb());
    await resetIntegrationCache();
    expect(integrationSecret("jev")).toBeNull();
  });

  test("rejects bad input and unknown routes", async () => {
    const empty = await request<{ field: string }>("/integrations/jev", { method: "PUT", body: { key: "short" } });
    expect(empty.status).toBe(400);
    expect(empty.body.field).toBe("key");
    const array = await request("/integrations/jev", { method: "PUT", body: [] });
    expect(array.status).toBe(400);
    const broken = await request("/integrations/jev", { method: "PUT", body: "{" });
    expect(broken.status).toBe(400);
    expect((await request("/integrations/nope", { method: "PUT" })).status).toBe(404);
    expect((await request("/integrations/jev", { method: "POST" })).status).toBe(404);
  });

  test("a stored key that no longer opens shows as invalid", async () => {
    await request("/integrations/jev", { method: "PUT", body: { key: goodKey } });
    const row = await readSetting<Record<string, string>>("integration:jev", {}, getDb());
    await writeSetting("integration:jev", { ...row, tag: Buffer.alloc(16).toString("base64") }, getDb());
    await resetIntegrationCache();
    expect(integrationSource("jev")).toBeNull();
    const items = await list();
    expect(items.jev.status).toBe("invalid");
  });

  test("reads a hex vault key, survives a throwing listener and network failures", async () => {
    const vaultKey = process.env.VAULT_KEY_FILE;
    const hexFile = join(testDataDir(), "hex.key");
    writeFileSync(hexFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    process.env.VAULT_KEY_FILE = hexFile;
    const off = onIntegrationChange(() => {
      throw new Error("listener broke");
    });
    try {
      const saved = await request<Item>("/integrations/jev", { method: "PUT", body: { key: goodKey } });
      expect(saved.body.status).toBe("connected");
      expect((await readSetting<Record<string, string>>("integration:jev", {}, getDb())).keyRef).toBe("vault");
      await resetIntegrationCache();
      expect(integrationSecret("jev")).toBe(goodKey);
    } finally {
      off();
      process.env.VAULT_KEY_FILE = vaultKey;
    }
    const base = process.env.ELEVENLABS_API_URL;
    process.env.ELEVENLABS_API_URL = "http://127.0.0.1:9";
    try {
      const failed = await request<{ error: string }>("/integrations/elevenlabs", {
        method: "PUT",
        body: { key: goodKey },
      });
      expect(failed.status).toBe(422);
      expect(failed.body.error).toBe("Não consegui falar com o ElevenLabs agora. Tente de novo em instantes.");
    } finally {
      process.env.ELEVENLABS_API_URL = base;
    }
  });

  test("uses a data key when the vault key is missing", async () => {
    const vaultKey = process.env.VAULT_KEY_FILE;
    process.env.VAULT_KEY_FILE = join(testDataDir(), "missing.key");
    try {
      await request("/integrations/jev", { method: "PUT", body: { key: goodKey } });
      const row = await readSetting<Record<string, string>>("integration:jev", {}, getDb());
      expect(row.keyRef).toBe("data");
      await resetIntegrationCache();
      expect(integrationSecret("jev")).toBe(goodKey);
      expect(statSync(join(testDataDir(), "integrations.key")).mode & 0o777).toBe(0o600);
    } finally {
      process.env.VAULT_KEY_FILE = vaultKey;
    }
  });
});

describe("runtime secrets", () => {
  test("runner token is generated in the data dir and ignores the old env variable", async () => {
    process.env.RUNNER_TOKEN = "from-env-token-0123456789abcdef";
    const token = runnerToken();
    delete process.env.RUNNER_TOKEN;
    expect(token).not.toBe("from-env-token-0123456789abcdef");
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(readFileSync(join(testDataDir(), "runner.token"), "utf8").trim()).toBe(token);
    expect(runnerToken()).toBe(token);
  });

  test("runner token rotates on demand and is rewritten if its file disappears", async () => {
    const first = runnerToken();
    const rotated = rotateRunnerToken();
    expect(rotated).not.toBe(first);
    expect(runnerToken()).toBe(rotated);
    expect(statSync(runnerTokenFile()).mode & 0o777).toBe(0o600);
    rmSync(runnerTokenFile());
    expect(runnerToken()).toBe(rotated);
    expect(readFileSync(runnerTokenFile(), "utf8").trim()).toBe(rotated);
  });

  test("writes a cached secret back when its file was removed", async () => {
    const dir = join(testDataDir(), "secrets-restored");
    const value = readOrCreateSecret("restored", 32, dir);
    rmSync(dir, { recursive: true, force: true });
    expect(readOrCreateSecret("restored", 32, dir)).toBe(value);
    expect(readFileSync(join(dir, "restored"), "utf8").trim()).toBe(value);
  });

  test("reuses a stored secret and replaces one that is too short", async () => {
    const dir = join(testDataDir(), "secrets");
    rmSync(dir, { recursive: true, force: true });
    readOrCreateSecret("seed", 32, dir);
    writeFileSync(join(dir, "kept"), "a-stored-secret-long-enough-1234\n");
    expect(readOrCreateSecret("kept", 32, dir)).toBe("a-stored-secret-long-enough-1234");
    expect(runnerTokenFile()).toBe(join(testDataDir(), "runner.token"));
    writeFileSync(join(dir, "short"), "abc\n");
    const value = readOrCreateSecret("short", 32, dir);
    expect(value.length).toBeGreaterThanOrEqual(24);
  });
});
