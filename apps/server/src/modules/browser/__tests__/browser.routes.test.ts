import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeAgentBrowser, pngBytes } from "../../../../test/browser-helpers";
import { makeBot } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer, testDataDir } from "../../../../test/helpers";
import type { BotDefinition } from "../../bots/services/bots.service";
import * as botCode from "../../code/services/bot-code.service";
import { browserDir, browserStateFile } from "../services/browser.service";
import { controllerOf, setController } from "../services/control.service";

let server: TestServer;
let bot: BotDefinition;
const restores: Array<() => void> = [];

beforeAll(async () => {
  server = await startTestServer();
});

beforeEach(async () => {
  bot = await makeBot();
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

afterAll(async () => {
  await server.close();
});

function path(tail: string) {
  return `/bots/${bot.id}/${tail}`;
}

function withBrowser() {
  bot.capabilities = { ...bot.capabilities, browser: true };
}

function codingFails() {
  const spy = spyOn(botCode, "botIsCoding").mockRejectedValue(new Error("no sessions"));
  restores.push(() => spy.mockRestore());
}

async function seedState() {
  await mkdir(browserDir(bot.id), { recursive: true });
  await writeFile(browserStateFile(bot.id), JSON.stringify({ url: "https://s.test/", title: "S", updatedAt: "t" }));
}

describe("GET browser state and screenshots", () => {
  test("answers 404 before the first page and the state after", async () => {
    const fake = fakeAgentBrowser();
    const missing = await request<{ error: string }>(path("browser"));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Esse bot ainda não abriu nenhuma página.");
    await seedState();
    fake.page.sessions = [`runelay-${bot.id}`];
    const found = await request(path("browser"));
    expect(found.status).toBe(200);
    expect(found.body).toEqual({
      url: "https://s.test/",
      title: "S",
      updatedAt: "t",
      screenshotPath: `/bots/${bot.id}/browser/latest.png`,
      controller: "bot",
      alive: true,
    });
  });

  test("serves the latest screenshot and saved shots", async () => {
    const missing = await request<{ error: string }>(path("browser/latest.png"));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Nenhum print ainda.");
    await mkdir(join(browserDir(bot.id), "shots"), { recursive: true });
    await writeFile(join(browserDir(bot.id), "latest.png"), pngBytes);
    await writeFile(join(browserDir(bot.id), "shots", "a-1.png"), pngBytes);
    const latest = await request(path("browser/latest.png"));
    expect(latest.status).toBe(200);
    expect(latest.headers.get("content-type")).toBe("image/png");
    expect(latest.headers.get("content-length")).toBe(String(pngBytes.length));
    expect(latest.headers.get("cache-control")).toBe("no-store");
    expect((await request(path("browser/shots/a-1.png"))).status).toBe(200);
    expect((await request(path("browser/screenshots/a-1.png"))).status).toBe(200);
    expect((await request(path("browser/shots/missing.png"))).status).toBe(404);
    expect((await request(path("browser/shots/..png"))).status).toBe(404);
  });

  test("takes a full page screenshot or explains why not", async () => {
    let fail: { code: number; stderr: string } | undefined;
    fakeAgentBrowser((command) => (command[0] === "screenshot" && fail ? fail : undefined));
    expect((await request(path("browser/full.png"))).status).toBe(404);
    await seedState();
    const full = await request(path("browser/full.png"));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/png");
    fail = { code: 1, stderr: "sem aba" };
    const failed = await request<{ error: string }>(path("browser/full.png"));
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("Não consegui tirar o print: sem aba");
  });

  test("serves the desktop screenshot", async () => {
    const missing = await request<{ error: string }>(path("desktop/latest.png"));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Nenhum print do computador ainda.");
    const dir = join(testDataDir(), "bots", bot.id, "desktop");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "latest.png"), pngBytes);
    const found = await request(path("desktop/latest.png"));
    expect(found.status).toBe(200);
    expect(found.headers.get("content-length")).toBe(String(pngBytes.length));
  });

  test("answers 404 for unknown browser routes", async () => {
    expect((await request(path("browser/nope"))).status).toBe(404);
    expect((await request(path("browser/open"))).status).toBe(404);
  });
});

describe("POST browser/open", () => {
  test("validates the body, the capability and the URL", async () => {
    const badJson = await request<{ field: string }>(path("browser/open"), { method: "POST", body: "{x" });
    expect([badJson.status, badJson.body.field]).toEqual([400, "body"]);
    codingFails();
    const noBrowser = await request<{ code: string }>(path("browser/open"), {
      method: "POST",
      body: { url: "https://a.test" },
    });
    expect([noBrowser.status, noBrowser.body.code]).toEqual([409, "no_browser"]);
    withBrowser();
    for (const url of [undefined, 3, "not a url", "ftp://a.test/"]) {
      const response = await request<{ field: string }>(path("browser/open"), { method: "POST", body: { url } });
      expect([response.status, response.body.field]).toEqual([400, "url"]);
    }
    const empty = await request(path("browser/open"), { method: "POST" });
    expect(empty.status).toBe(400);
  });

  test("opens the page as the user", async () => {
    fakeAgentBrowser();
    withBrowser();
    setController(bot.id, "user");
    const opened = await request(path("browser/open"), { method: "POST", body: { url: "https://a.test/x" } });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      url: "https://a.test/x",
      title: "Title of https://a.test/x",
      screenshotPath: `/bots/${bot.id}/browser/latest.png`,
    });
    setController(bot.id, "bot");
  });

  test("reports a browser failure", async () => {
    fakeAgentBrowser((command) => (command[0] === "open" ? { code: 1, stderr: "crash" } : undefined));
    withBrowser();
    const failed = await request<{ error: string }>(path("browser/open"), {
      method: "POST",
      body: { url: "https://a.test/" },
    });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("Não consegui abrir a página: crash");
  });
});

describe("POST browser/control", () => {
  test("validates and hands control over", async () => {
    const badJson = await request(path("browser/control"), { method: "POST", body: "{x" });
    expect(badJson.status).toBe(400);
    const badMode = await request<{ field: string }>(path("browser/control"), {
      method: "POST",
      body: { mode: "admin" },
    });
    expect([badMode.status, badMode.body.field]).toEqual([400, "mode"]);
    const noMode = await request(path("browser/control"), { method: "POST" });
    expect(noMode.status).toBe(400);
    codingFails();
    const none = await request<{ error: string }>(path("browser/control"), { method: "POST", body: { mode: "user" } });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe("Esse bot não tem navegador nem computador.");
    bot.capabilities = { ...bot.capabilities, desktop: true };
    const taken = await request(path("browser/control"), { method: "POST", body: { mode: "user" } });
    expect(taken.body).toEqual({ ok: true, controller: "user" });
    expect(controllerOf(bot.id)).toBe("user");
    bot.capabilities = { ...bot.capabilities, desktop: false, browser: true };
    const back = await request(path("browser/control"), { method: "POST", body: { mode: "bot" } });
    expect(back.body).toEqual({ ok: true, controller: "bot" });
  });
});

describe("POST browser history", () => {
  test("needs a browser, navigates and reports failures", async () => {
    let fail = false;
    fakeAgentBrowser((command) =>
      fail && command[0] === "forward" ? { code: 1, stderr: "sem histórico" } : undefined,
    );
    codingFails();
    const none = await request(path("browser/back"), { method: "POST", body: "ignored" });
    expect(none.status).toBe(409);
    withBrowser();
    const back = await request(path("browser/back"), { method: "POST" });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ controller: "bot", screenshotPath: `/bots/${bot.id}/browser/latest.png` });
    expect((await request(path("browser/reload"), { method: "POST" })).status).toBe(200);
    fail = true;
    const failed = await request<{ error: string }>(path("browser/forward"), { method: "POST" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("Falha no navegador: sem histórico");
  });
});
