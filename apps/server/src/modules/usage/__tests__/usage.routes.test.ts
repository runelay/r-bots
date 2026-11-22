import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { fakeCodexAppServer, resetUsageTables, writeFixture } from "../../../../test/usage-helpers";
import * as accounts from "../../accounts/services/accounts.service";
import * as botsService from "../../bots/services/bots.service";
import type { LimitAccount } from "../services/usage.service";

const home = await mkdtemp(join(os.tmpdir(), "rb-usage-routes-"));
const restores: Array<() => void> = [];
const previousHome = process.env.HOST_HOME;
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
  process.env.HOST_HOME = previousHome;
  await accounts.refreshAccounts();
  await rm(home, { recursive: true, force: true });
});

async function isolate() {
  process.env.HOST_HOME = home;
  await accounts.refreshAccounts();
  track(spyOn(botsService, "listBots").mockReturnValue([]));
  const codex = fakeCodexAppServer(() => "close");
  restores.push(codex.restore);
}

describe("GET /usage/limits", () => {
  test("returns the accounts with the check time", async () => {
    await isolate();
    const response = await request<{ checkedAt: string; accounts: LimitAccount[] }>("/usage/limits?refresh=1");
    expect(response.status).toBe(200);
    expect(Number.isNaN(Date.parse(response.body.checkedAt))).toBe(false);
    expect(response.body.accounts.map((account) => [account.id, account.ok])).toEqual([
      ["vps:claude", false],
      ["vps:codex", false],
    ]);
  });

  test("answers 500 with the reason when the limits cannot be computed", async () => {
    await isolate();
    track(
      spyOn(accounts, "listAccounts").mockImplementation(() => {
        throw new Error("runner state broken");
      }),
    );
    const response = await request<{ ok: boolean; error: string }>("/usage/limits?refresh=1");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, error: "Não deu para calcular o uso: runner state broken" });
  });

  test("answers 500 for a non-Error failure", async () => {
    await isolate();
    track(
      spyOn(accounts, "listAccounts").mockImplementation(() => {
        throw "plain failure";
      }),
    );
    const response = await request<{ error: string }>("/usage/limits?refresh=1");
    expect(response.body.error).toBe("Não deu para calcular o uso: plain failure");
    const english = await request<{ error: string }>("/usage/limits?refresh=1", {
      headers: { "accept-language": "en" },
    });
    expect(english.body.error).toBe("Couldn't calculate usage: plain failure");
  });
});

describe("GET /usage/summary", () => {
  test("passes range, provider and account through", async () => {
    await resetUsageTables();
    jest.useFakeTimers();
    const at = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 1800_000).toISOString();
    await writeFixture(
      join(home, ".claude", "projects", "p", "a.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        timestamp: at,
        sessionId: "s1",
        requestId: "r1",
        message: { id: "m1", model: "unpriced-model", usage: { input_tokens: 7 } },
      })}\n`,
    );
    await writeFixture(
      join(home, ".codex", "sessions", "r.jsonl"),
      `${JSON.stringify({
        type: "event_msg",
        timestamp: at,
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5, output_tokens: 1 } } },
      })}\n`,
    );
    await isolate();
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
      "/usage/summary?range=24h&provider=codex&account=vps:codex",
    );
    expect(codex.status).toBe(200);
    expect([codex.body.range, codex.body.granularity, codex.body.totals.input]).toEqual(["24h", "hour", 5]);
    const any = await request<{ range: string; totals: { input: number } }>("/usage/summary?provider=grok&account=%20");
    expect([any.body.range, any.body.totals.input]).toEqual(["30d", 12]);
    const claude = await request<{ totals: { input: number } }>("/usage/summary?account=vps:claude");
    expect(claude.body.totals.input).toBe(7);
    expect(priceCalls.every((url) => url.includes("litellm"))).toBe(true);
  });
});

test("unknown usage paths answer 404", async () => {
  const response = await request("/usage/other");
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ ok: false, error: "Rota não encontrada." });
});
