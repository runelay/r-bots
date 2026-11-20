import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { makeBot } from "../../../../test/engine-helpers";
import { resetData, testDataDir } from "../../../../test/helpers";
import type { BotDefinition } from "../../bots/services/bots.service";
import * as guard from "../../browser/services/browser-guard.service";
import * as browser from "../../browser/services/browser.service";
import * as control from "../../browser/services/control.service";
import * as desktopService from "../../browser/services/desktop.service";
import { type BotTool, toolsFor } from "../services/bot-tools.service";

const spies: Array<{ mockRestore: () => void }> = [];
let bot: BotDefinition;

function spy<T extends object>(target: T, key: keyof T) {
  const created = spyOn(target, key as never) as unknown as ReturnType<typeof spyOn>;
  spies.push(created as unknown as { mockRestore: () => void });
  return created;
}

function find(tools: BotTool[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

const signal = new AbortController().signal;

beforeEach(async () => {
  await resetData();
  bot = await makeBot();
});

afterEach(() => {
  for (const item of spies.splice(0)) item.mockRestore();
});

describe("toolsFor", () => {
  test("always offers artifact, canvas and upload tools", () => {
    const names = toolsFor(bot).map((tool) => tool.name);
    expect(names).not.toContain("prod_query");
    expect(names).not.toContain("browser_open");
    expect(names).not.toContain("desktop_click");
    expect(names.length).toBeGreaterThan(0);
  });

  test("browser tools call the browser with labels, approvals and page details", async () => {
    bot.capabilities.browser = true;
    const tools = toolsFor(bot);
    spy(browser, "browserOpen").mockResolvedValue("opened" as never);
    spy(browser, "browserSnapshot").mockResolvedValue("snap" as never);
    const click = spy(browser, "browserClick").mockResolvedValue("clicked" as never);
    const fill = spy(browser, "browserFill").mockResolvedValue("filled" as never);
    spy(browser, "browserScreenshot").mockResolvedValue("shot" as never);
    const target = spy(browser, "elementTarget");
    target.mockImplementation(((_: string, ref: string) =>
      ref === "@e1" ? { label: "Salvar", role: "button" } : null) as never);
    const state = spy(browser, "readBrowserState");
    const preview = spy(browser, "elementPreview");
    const open = find(tools, "browser_open");
    expect(open.label({ url: "https://x.com" })).toBe("Abrir https://x.com");
    expect(await open.run({ url: "https://x.com" }, signal)).toBe("opened");
    const openShape = z.object(open.shape);
    for (const url of ["file:///etc/passwd", "view-source:https://x.com", "chrome://settings", "javascript:alert(1)"])
      expect(openShape.safeParse({ url }).success).toBe(false);
    expect(openShape.safeParse({ url: "HTTP://x.com" }).success).toBe(true);
    const snapshot = find(tools, "browser_snapshot");
    expect(snapshot.label({})).toBe("Ler a página");
    expect(await snapshot.run({}, signal)).toBe("snap");
    const clicker = find(tools, "browser_click");
    expect(clicker.approval?.({ ref: "@e1" })).toBe("Posso clicar em “Salvar”?");
    expect(clicker.approval?.({ ref: "@e9" })).toBe("Posso clicar em um elemento da página?");
    expect(clicker.label({ ref: "@e9" })).toBe("Clicar em um elemento");
    expect(await clicker.run({ ref: "@e1" }, signal)).toBe("clicked");
    expect(click).toHaveBeenCalledWith(bot.id, "@e1", signal);
    state.mockResolvedValueOnce({ url: "https://x.com/p", title: "P" } as never);
    preview.mockResolvedValueOnce("data:image/jpeg;base64,AA" as never);
    expect(await clicker.details?.({ ref: "@e1", reason: " salvar " })).toEqual({
      target: { label: "Salvar", role: "button", url: "https://x.com/p" },
      previewImage: "data:image/jpeg;base64,AA",
      reason: "salvar",
    });
    state.mockResolvedValueOnce(null as never);
    preview.mockResolvedValueOnce(null as never);
    expect(await clicker.details?.({ ref: "@e1" })).toEqual({ target: { label: "Salvar", role: "button" } });
    state.mockResolvedValueOnce(null as never);
    preview.mockResolvedValueOnce(null as never);
    expect(await clicker.details?.({})).toEqual({});
    const filler = find(tools, "browser_fill");
    expect(filler.approval?.({ ref: "@e1", text: "oi" })).toBe('Posso preencher “Salvar” com "oi"?');
    expect(filler.label({ ref: "@e2" })).toBe("Preencher um campo");
    await filler.run({ ref: "@e1", text: "oi", secretFill: true }, signal);
    expect(fill).toHaveBeenCalledWith(bot.id, "@e1", "oi", signal, true);
    await filler.run({ ref: "@e1" }, signal);
    expect(fill).toHaveBeenLastCalledWith(bot.id, "@e1", "", signal, false);
    const screenshot = find(tools, "browser_screenshot");
    expect(screenshot.label({})).toBe("Tirar print");
    expect(await screenshot.run({}, signal)).toBe("shot");
  });

  test("desktop tools wait for control and drive the virtual computer", async () => {
    bot.capabilities.desktop = true;
    const ready = spy(control, "waitForBotControl").mockResolvedValue(undefined as never);
    const calls: unknown[][] = [];
    const fakeDesktop = {
      screenshot: async () => Buffer.from("png"),
      state: async () => ({ running: true }),
      click: async (...args: unknown[]) => calls.push(["click", ...args]),
      type: async (...args: unknown[]) => calls.push(["type", ...args]),
      key: async (...args: unknown[]) => calls.push(["key", ...args]),
      scroll: async (...args: unknown[]) => calls.push(["scroll", ...args]),
      openTerminal: async () => calls.push(["terminal"]),
      openBrowser: async (...args: unknown[]) => calls.push(["browser", ...args]),
    };
    spy(desktopService, "getDesktop").mockReturnValue(fakeDesktop as never);
    const browsable = spy(guard, "assertBrowsable");
    browsable.mockResolvedValue(undefined as never);
    const crop = spy(browser, "cropPreview");
    crop.mockResolvedValue("data:image/jpeg;base64,BB" as never);
    const tools = toolsFor(bot);
    const screenshot = find(tools, "desktop_screenshot");
    expect(screenshot.label({})).toBe("Print do computador");
    expect(await screenshot.run({}, signal)).toEqual({
      running: true,
      imageBase64: Buffer.from("png").toString("base64"),
    });
    expect(await readFile(join(testDataDir(), "bots", bot.id, "desktop", "latest.png"), "utf8")).toBe("png");
    const click = find(tools, "desktop_click");
    expect(click.approval?.({})).toBe("Posso clicar neste ponto do computador?");
    expect(click.label({})).toBe("Clicar no computador");
    expect(await click.details?.({ x: 100, y: 50, reason: "abrir" })).toEqual({
      target: { label: "computador do bot", role: "desktop" },
      previewImage: "data:image/jpeg;base64,BB",
      reason: "abrir",
    });
    expect(crop).toHaveBeenCalledWith(Buffer.from("png"), { x: 40, y: 20, width: 120, height: 60 });
    crop.mockResolvedValueOnce(null as never);
    expect(await click.details?.({ x: 1, y: 1 })).toEqual({ target: { label: "computador do bot", role: "desktop" } });
    fakeDesktop.screenshot = async () => {
      throw new Error("off");
    };
    expect(await click.details?.({ x: 1, y: 1 })).toEqual({ target: { label: "computador do bot", role: "desktop" } });
    await click.run({ x: 3, y: 4, button: "right", double: true }, signal);
    await click.run({ x: 3, y: 4 }, signal);
    const type = find(tools, "desktop_type");
    expect(type.approval?.({ text: "olá" })).toBe('Posso digitar no computador: "olá"?');
    expect(type.label({ text: "olá" })).toBe('Digitar "olá"');
    expect(await type.details?.({ text: "x" })).toEqual({ target: { label: "computador do bot", role: "desktop" } });
    await type.run({ text: "olá" }, signal);
    const key = find(tools, "desktop_key");
    expect(key.approval?.({ combo: "Return" })).toBe("Posso apertar Return no computador?");
    expect(key.label({ combo: "Return" })).toBe("Tecla Return");
    expect(await key.details?.({ combo: "x", reason: "r" })).toMatchObject({ reason: "r" });
    await key.run({ combo: "Return" }, signal);
    const scroll = find(tools, "desktop_scroll");
    expect(scroll.label({ direction: "down" })).toBe("Rolar para baixo");
    expect(scroll.label({ direction: "up" })).toBe("Rolar para cima");
    await scroll.run({ x: 1, y: 2, direction: "down", amount: 5 }, signal);
    await scroll.run({ x: 1, y: 2, direction: "up" }, signal);
    const open = find(tools, "desktop_open");
    expect(open.approval?.({ app: "terminal" })).toBe("Posso abrir um terminal no computador?");
    expect(open.approval?.({ app: "browser", url: "https://a.com" })).toBe(
      "Posso abrir o navegador do computador em https://a.com?",
    );
    expect(open.approval?.({ app: "browser" })).toBe("Posso abrir o navegador do computador?");
    expect(open.label({ app: "terminal" })).toBe("Abrir terminal");
    expect(open.label({ app: "browser", url: "https://www.a.com/x" })).toBe("Abrir navegador em a.com");
    expect(open.label({ app: "browser", url: "bad url" })).toBe("Abrir navegador em bad url");
    expect(open.label({ app: "browser" })).toBe("Abrir navegador");
    expect(await open.details?.({ app: "browser", url: "https://a.com" })).toEqual({
      target: { label: "a.com", role: "page", url: "https://a.com" },
    });
    expect(await open.details?.({ app: "terminal" })).toEqual({ target: { label: "Terminal", role: "app" } });
    expect(await open.details?.({ app: "browser" })).toEqual({ target: { label: "Navegador", role: "app" } });
    await open.run({ app: "terminal" }, signal);
    await open.run({ app: "browser", url: "https://a.com" }, signal);
    await open.run({ app: "browser" }, signal);
    expect(calls).toEqual([
      ["click", 3, 4, "right", true],
      ["click", 3, 4, "left", false],
      ["type", "olá"],
      ["key", "Return"],
      ["scroll", 1, 2, "down", 5],
      ["scroll", 1, 2, "up", 3],
      ["terminal"],
      ["browser", "https://a.com"],
      ["browser", "about:blank"],
    ]);
    expect(browsable).toHaveBeenCalledTimes(1);
    expect(browsable).toHaveBeenCalledWith(bot.id, "https://a.com");
    const desktopShape = z.object(open.shape);
    expect(desktopShape.safeParse({ app: "browser", url: "file:///etc/passwd" }).success).toBe(false);
    expect(desktopShape.safeParse({ app: "browser", url: "https://a.com" }).success).toBe(true);
    expect(ready).toHaveBeenCalledTimes(10);
  });
});
