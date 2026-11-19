import { afterAll, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreProcessFakes } from "./fake-process";
import { fakeProviders } from "./fake-providers";
import { fakeRunelay } from "./fake-runelay";

const root = mkdtempSync(join(tmpdir(), "rb-server-test-"));
const dataDir = join(root, "data");
const unreachable = "http://127.0.0.1:9";
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(root, "vault.key"), `${"ab".repeat(32)}\n`, { mode: 0o600 });

fakeRunelay.start();

const testEnv: Record<string, string> = {
  BOTS_DATA_DIR: dataDir,
  BOTS_DB_FILE: join(root, "db", "runelay-bots.db"),
  BOTS_BACKUP_DIR: join(root, "backups"),
  BLOB_DRIVER: "fs",
  BLOB_FS_DIR: join(root, "blobs"),
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://127.0.0.1:2999",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: String(40_000 + (process.pid % 20_000)),
  BOTS_SCHEDULES: "off",
  BOTS_MAX_TURNS: "3",
  JEV_URL: `${unreachable}/jev`,
  JEV_TIMEOUT_MS: "200",
  VAULT_KEY_FILE: join(root, "vault.key"),
  MAC_RUNNER_URL: unreachable,
  RUNNER_TOKEN: "test-runner-token",
  PUBLIC_MCP_BASE: unreachable,
  RUNELAY_MCP_URL: fakeRunelay.mcpUrl,
  RUNELAY_MCP_TOKEN: fakeRunelay.token,
  RUNELAY_API_URL: fakeRunelay.url,
  RUNELAY_RECONNECT_URL: `${fakeRunelay.url}/reconnect`,
  DESKTOP_HOME: join(root, "desktop"),
  DESKTOP_CHROME: join(root, "bin", "chrome"),
  HOST_HOME: root,
  CODE_TEST_LOCK: join(root, "tests.lock"),
  CODE_GH_BIN: join(root, "bin", "gh"),
};

for (const key of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CURSOR_API_KEY",
  "XAI_API_KEY",
  "JEV_API_KEY",
  "ELEVENLABS_API_KEY",
  "BOTS_FAULTS_FILE",
  "BOTS_MODEL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "CLAUDE_CONFIG_DIR",
  "BOTS_AUTH",
  "BOTS_APP_DIR",
])
  delete process.env[key];
Object.assign(process.env, testEnv);

const realFetch = globalThis.fetch;
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function targetOf(input: Parameters<typeof fetch>[0]) {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

const guardedFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const target = targetOf(input);
  if (!localHosts.has(target.hostname))
    return Promise.reject(new TypeError(`fetch failed: external network is blocked in tests (${target.host})`));
  return realFetch(input, init);
};
globalThis.fetch = Object.assign(guardedFetch, { preconnect: realFetch.preconnect }) as typeof fetch;

const realProviders = await import("@runelay-bots/providers");
mock.module("@runelay-bots/providers", () => ({
  ...realProviders,
  probe: fakeProviders.probe,
  runTurn: fakeProviders.runTurn,
}));

afterEach(() => {
  restoreProcessFakes();
  fakeProviders.reset();
  fakeRunelay.reset();
});

afterAll(async () => {
  await fakeRunelay.stop();
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});
