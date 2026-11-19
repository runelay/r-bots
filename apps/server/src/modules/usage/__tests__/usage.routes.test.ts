import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { fakeCodexAppServer, resetUsageTables } from "../../../../test/usage-helpers";
import * as macRunner from "../../accounts/services/mac-runner.service";
import * as botsService from "../../bots/services/bots.service";
import type { LimitAccount } from "../services/usage.service";

const home = await mkdtemp(join(os.tmpdir(), "rb-usage-routes-"));
const restores: Array<() => void> = [];
let server: TestServer;

function track<T extends { mockRestore(): void }>(spy: T) {
  restores.push(() => spy.mockRestore());
  return spy;
}

beforeAll(async () => {
  await resetData();
  await resetUsageTables();
  server = await startTestServer();
});

afterEach(() => {
  jest.useRealTimers();
  jest.setSystemTime();
  for (const restore of restores.splice(0).reverse()) restore();
});

afterAll(async () => {
  await server.close();
  await rm(home, { recursive: true, force: true });
});

function isolate() {
  track(spyOn(os, "homedir").mockReturnValue(home));
  track(spyOn(botsService, "listBots").mockReturnValue([]));
  const codex = fakeCodexAppServer(() => "close");
  restores.push(codex.restore);
}

describe("GET /usage/limits", () => {
  test("returns the accounts with the check time", async () => {
    isolate();
    track(spyOn(macRunner, "macRunnerConnected").mockReturnValue(false));
    const response = await request<{ checkedAt: string; accounts: LimitAccount[] }>("/usage/limits?refresh=1");
    expect(response.status).toBe(200);
    expect(Number.isNaN(Date.parse(response.body.checkedAt))).toBe(false);
    expect(response.body.accounts.map((account) => [account.id, account.ok])).toEqual([
      ["vps:claude", false],
      ["vps:codex", false],
    ]);
  });

  test("answers 500 with the reason when the limits cannot be computed", async () => {
    isolate();
    track(
      spyOn(macRunner, "macRunnerConnected").mockImplementation(() => {
        throw new Error("runner state broken");
      }),
    );
    const response = await request<{ ok: boolean; error: string }>("/usage/limits?refresh=1");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, error: "Não deu para calcular o uso: runner state broken" });
  });

  test("answers 500 for a non-Error failure", async () => {
    isolate();
    track(
      spyOn(macRunner, "macRunnerConnected").mockImplementation(() => {
        throw "plain failure";
      }),
    );
    const response = await request<{ error: string }>("/usage/limits?refresh=1");
    expect(response.body.error).toBe("Não deu para calcular o uso: plain failure");
  });
});

describe("GET /usage/summary", () => {
  test("passes range, provider and environment through", async () => {
    jest.useFakeTimers();
    isolate();
    track(spyOn(macRunner, "macRunnerConnected").mockReturnValue(true));
    track(spyOn(macRunner, "macRunnerSupports").mockReturnValue(true));
    const hour = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
    track(
      spyOn(macRunner, "macUsageBuckets").mockResolvedValue({
        rows: [
          { h: hour, p: "codex", m: "unpriced-model", s: "standard", c: [5, 0, 0, 0, 1, 0, 1] },
          { h: hour, p: "claude", m: "unpriced-model", s: "standard", c: [7, 0, 0, 0, 0, 0, 1] },
        ],
        sessions: [],
        scannedAt: "2026-11-19T00:00:00.000Z",
      }),
    );
    const localFetch = globalThis.fetch;
    const priceCalls: string[] = [];
    track(
      spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith(server.url)) return localFetch(input, init);
        priceCalls.push(url);
        return Promise.reject(new Error("offline"));
      }) as typeof fetch),
    );
    const codex = await request<{ range: string; granularity: string; totals: { input: number } }>(
      "/usage/summary?range=24h&provider=codex&environment=mac",
    );
    expect(codex.status).toBe(200);
    expect([codex.body.range, codex.body.granularity, codex.body.totals.input]).toEqual(["24h", "hour", 5]);
    const any = await request<{ range: string; totals: { input: number } }>(
      "/usage/summary?provider=grok&environment=mac",
    );
    expect([any.body.range, any.body.totals.input]).toEqual(["30d", 12]);
    expect(priceCalls.every((url) => url.includes("litellm"))).toBe(true);
  });
});

test("unknown usage paths answer 404", async () => {
  const response = await request("/usage/other");
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ ok: false, error: "Rota não encontrada." });
});
