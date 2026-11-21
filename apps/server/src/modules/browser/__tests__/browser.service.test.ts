import { afterEach, beforeEach, describe, expect, jest, type Mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeAgentBrowser, pngBytes, until } from "../../../../test/browser-helpers";
import * as netGuard from "../../../shared/net-guard";
import {
  browserAlive,
  browserClick,
  browserDir,
  browserFill,
  browserHistory,
  browserOpen,
  browserScreenshot,
  browserSnapshot,
  browserStateFile,
  browserText,
  captureAfterAction,
  cdpUrl,
  closeIdleBrowsers,
  cropPreview,
  defaultUserAgent,
  elementPreview,
  elementTarget,
  elementText,
  ensureBrowser,
  fullScreenshot,
  latestScreenshotFile,
  liveCapture,
  markBrowserViewed,
  pageExcerpt,
  readBrowserState,
  snapshotLimit,
  startLiveView,
  viewport,
} from "../services/browser.service";
import { controllerOf, onControllerChange, setController, waitForBotControl } from "../services/control.service";

let counter = 0;
function botId() {
  counter++;
  return `browser-bot-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

let resolved: Mock<typeof netGuard.resolvePublic>;

beforeEach(() => {
  resolved = spyOn(netGuard, "resolvePublic").mockResolvedValue({ address: "93.184.216.34", family: 4 });
});

afterEach(() => {
  resolved.mockRestore();
  jest.useRealTimers();
  setSystemTime();
});

const browsing = (commands: string[][]) => commands.filter((command) => command[0] !== "session");

async function seedState(id: string, state = { url: "https://seed.test/", title: "Seed", updatedAt: "x" }) {
  await mkdir(browserDir(id), { recursive: true });
  await writeFile(browserStateFile(id), JSON.stringify(state));
}

describe("control", () => {
  test("defaults to the bot, notifies listeners and waits for the user to hand back", async () => {
    const id = botId();
    const changes: string[] = [];
    onControllerChange((changed, controller) => {
      if (changed === id) changes.push(controller);
    });
    expect(controllerOf(id)).toBe("bot");
    await waitForBotControl(id);
    setController(id, "user");
    jest.useFakeTimers();
    const waiting = waitForBotControl(id);
    setController(id, "bot");
    jest.advanceTimersByTime(500);
    await waiting;
    expect(changes).toEqual(["user", "bot"]);
  });

  test("gives up when cancelled or after the deadline", async () => {
    const id = botId();
    setController(id, "user");
    const controller = new AbortController();
    controller.abort();
    await expect(waitForBotControl(id, controller.signal)).rejects.toThrow("Cancelado.");
    await expect(waitForBotControl(id, undefined, -1)).rejects.toThrow("O usuário está controlando o navegador.");
    setController(id, "bot");
  });
});

describe("paths and state", () => {
  test("lays out files under the bot dir and reads missing state as null", async () => {
    const id = botId();
    expect(browserStateFile(id)).toBe(join(browserDir(id), "state.json"));
    expect(latestScreenshotFile(id)).toBe(join(browserDir(id), "latest.png"));
    expect(await readBrowserState(id)).toBeNull();
    expect(viewport).toEqual({ width: 1280, height: 800 });
  });
});

describe("open, history and capture", () => {
  test("opens a page, sets the viewport and saves the capture", async () => {
    const fake = fakeAgentBrowser();
    const id = botId();
    const state = await browserOpen(id, "https://a.test/");
    expect(state).toMatchObject({ url: "https://a.test/", title: "Title of https://a.test/" });
    expect(existsSync(state.screenshot)).toBe(true);
    expect(readFileSync(latestScreenshotFile(id))).toEqual(pngBytes);
    expect(await readBrowserState(id)).toMatchObject({ url: "https://a.test/" });
    expect(fake.commands[0]).toEqual(["session", "list", "--json"]);
    expect(browsing(fake.commands).slice(0, 4)).toEqual([
      ["set", "viewport", "1280", "800"],
      ["open", "https://a.test/"],
      ["wait", "500"],
      ["wait", "--fn", "document.readyState === 'complete'"],
    ]);
    const launch = fake.calls[1].args;
    expect(launch.slice(0, 3)).toEqual(["--session", `runelay-${id}`, "--args"]);
    expect(launch[4]).toBe("--json");
    expect(launch[3].split(",")).toEqual([
      "--no-sandbox",
      expect.stringMatching(/^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/),
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]);
  });

  test("navigates history without touching the viewport twice", async () => {
    const fake = fakeAgentBrowser();
    const id = botId();
    await browserOpen(id, "https://a.test/");
    const before = fake.commands.length;
    await browserHistory(id, "back");
    expect(fake.commands.slice(before)[0]).toEqual(["back"]);
  });

  test("keeps going when settling fails and captures without url or title", async () => {
    fakeAgentBrowser((command) => {
      if (command[0] === "wait") return { code: 1, stderr: "timeout" };
      if (command[0] === "get") return { stdout: '{"success":true}\n' };
      return undefined;
    });
    const id = botId();
    const state = await browserOpen(id, "https://b.test/", undefined, true);
    expect(state).toMatchObject({ url: "", title: "" });
  });

  test("raises agent-browser failures with the best message", async () => {
    let reply = { stdout: '{"success":false,"error":"no page"}\n' } as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    fakeAgentBrowser((command) => (command[0] === "open" ? reply : undefined));
    const id = botId();
    await expect(browserOpen(id, "x", undefined, true)).rejects.toThrow("no page");
    reply = { code: 2, stdout: "garbage", stderr: "crashed\n" };
    await expect(browserOpen(id, "x", undefined, true)).rejects.toThrow("crashed");
    reply = { code: 3 };
    await expect(browserOpen(id, "x", undefined, true)).rejects.toThrow("agent-browser saiu com código 3");
  });

  test("waits for the user to hand control back before a bot action", async () => {
    fakeAgentBrowser();
    const id = botId();
    setController(id, "user");
    const controller = new AbortController();
    controller.abort();
    await expect(browserOpen(id, "https://a.test/", controller.signal)).rejects.toThrow("Cancelado.");
    setController(id, "bot");
  });

  test("takes a full page screenshot", async () => {
    const fake = fakeAgentBrowser();
    const id = botId();
    const file = await fullScreenshot(id);
    expect(file).toBe(join(browserDir(id), "full.png"));
    expect(browsing(fake.commands)[0]).toEqual(["screenshot", "--full", file]);
  });

  test("captures after an action into a timestamped shot", async () => {
    fakeAgentBrowser();
    const id = botId();
    const captured = await captureAfterAction(id);
    expect(captured.screenshot).toContain(join(browserDir(id), "shots"));
  });
});

describe("snapshot, click, fill", () => {
  test("snapshots the page and remembers element refs", async () => {
    fakeAgentBrowser();
    const id = botId();
    const snap = await browserSnapshot(id);
    expect(snap.snapshot).toContain("[ref=e1]");
    expect(elementTarget(id, "@e1")).toEqual({ label: "Enviar", role: "button" });
    expect(elementTarget(id, "e2")).toEqual({ label: "Senha", role: "textbox" });
    expect(elementTarget(id, "e9")).toBeNull();
    expect(elementText(id, "e2")).toBe('- textbox "Senha" [ref=e2]');
    expect(elementText("unknown-bot", "e1")).toBe("");
  });

  test("clips a long snapshot, returns a page excerpt and reads the rest in ranges", async () => {
    const long = "Sistema Solar. ".repeat(2000);
    const fake = fakeAgentBrowser((command) =>
      command[0] === "get" && command[1] === "text"
        ? { stdout: `${JSON.stringify({ success: true, data: { text: `${long}  \n\n\n\nfim` } })}\n` }
        : undefined,
    );
    fake.page.snapshot = Array.from({ length: 2000 }, (_, index) => `- link "Item ${index}" [ref=e${index}]`).join(
      "\n",
    );
    const id = botId();
    await browserOpen(id, "https://pt.wikipedia.org/wiki/Sistema_Solar");
    const snap = await browserSnapshot(id);
    expect(snap.snapshot.length).toBeLessThan(snapshotLimit + 200);
    expect(snap.snapshot).toContain("use browser_text");
    expect(snap.page.text.startsWith("Sistema Solar.")).toBe(true);
    expect(snap.page.totalChars).toBe(long.length + 4);
    expect(snap.page.nextOffset).toBe(12_000);
    const rest = await browserText(id, snap.page.nextOffset, 50_000);
    expect(rest).toMatchObject({ url: "https://pt.wikipedia.org/wiki/Sistema_Solar", offset: 12_000 });
    expect(rest.nextOffset).toBe(24_000);
    const last = await browserText(id, 24_000);
    expect(last.text.endsWith("fim")).toBe(true);
    expect(last.more).toBeUndefined();
    const fresh = await browserText(id);
    expect(fresh.offset).toBe(0);
    expect((fake.calls.at(-1)?.options.env as Record<string, string> | undefined)?.AGENT_BROWSER_USER_AGENT).toBe(
      defaultUserAgent,
    );
    expect(
      (fake.calls.at(-1)?.options.env as Record<string, string> | undefined)?.AGENT_BROWSER_USER_AGENT,
    ).not.toContain("Headless");
  });

  test("cuts page excerpts within bounds", () => {
    expect(pageExcerpt("abcdef", -5, 2)).toEqual({
      text: "ab",
      offset: 0,
      totalChars: 6,
      more: "Tem mais texto. Leia o resto com browser_text e offset 2.",
      nextOffset: 2,
    });
    expect(pageExcerpt("abc", 99)).toEqual({ text: "", offset: 3, totalChars: 3 });
  });

  test("handles a snapshot without text or refs", async () => {
    fakeAgentBrowser((command) => (command[0] === "snapshot" ? { stdout: '{"success":true,"data":{}}\n' } : undefined));
    const id = botId();
    expect((await browserSnapshot(id)).snapshot).toBe("");
    expect(elementTarget(id, "e1")).toBeNull();
  });

  test("reads element targets with empty names", async () => {
    const fake = fakeAgentBrowser();
    fake.page.refs = { e1: {} };
    fake.page.snapshot = "- generic [ref=e3]";
    const id = botId();
    await browserSnapshot(id);
    expect(elementTarget(id, "e1")).toEqual({ label: "", role: "" });
    expect(elementTarget(id, "e3")).toEqual({ label: "", role: "generic" });
  });

  test("clicks an element after scrolling to it", async () => {
    const fake = fakeAgentBrowser((command) =>
      command[0] === "scrollintoview" ? { code: 1, stderr: "not found" } : undefined,
    );
    const id = botId();
    await browserClick(id, " e1 ");
    expect(fake.commands).toContainEqual(["click", "@e1"]);
  });

  test("fills plain text and secrets", async () => {
    const fake = fakeAgentBrowser((command) => (command[0] === "scrollintoview" ? { code: 1 } : undefined));
    const id = botId();
    await browserFill(id, "@e2", "oi");
    expect(fake.commands).toContainEqual(["fill", "@e2", "oi"]);
    await browserFill(id, "e2", "s3nh4", undefined, true);
    const batch = fake.calls.find((call) => call.args.includes("batch"));
    expect(batch?.child.written).toContain('["fill","@e2","s3nh4"]');
    expect(batch?.args).not.toContain("s3nh4");
  });

  test("rejects a secret fill that fails", async () => {
    let reply: { code?: number; stdout?: string } = { code: 1 };
    fakeAgentBrowser((command) => (command[0] === "batch" ? reply : undefined));
    const id = botId();
    await expect(browserFill(id, "e2", "x", undefined, true)).rejects.toThrow("Não consegui preencher o campo");
    reply = { stdout: '[{"success":true},{"success":false}]\n' };
    await expect(browserFill(id, "e2", "x", undefined, true)).rejects.toThrow("Não consegui preencher o campo");
    reply = { stdout: '{"success":true}\n' };
    await browserFill(id, "e2", "x", undefined, true);
    reply = { stdout: "[null, 1]\n" };
    await browserFill(id, "e2", "x", undefined, true);
    reply = { stdout: "not json" };
    await browserFill(id, "e2", "x", undefined, true);
    reply = { stdout: "" };
    await browserFill(id, "e2", "x", undefined, true);
  });

  test("screenshots on demand", async () => {
    fakeAgentBrowser();
    const id = botId();
    const shot = await browserScreenshot(id);
    expect(existsSync(shot.screenshot)).toBe(true);
  });
});

describe("element preview", () => {
  test("crops the element box into a jpeg data url", async () => {
    const fake = fakeAgentBrowser();
    const id = botId();
    const preview = await elementPreview(id, "e1");
    expect(preview).toBe(`data:image/jpeg;base64,${Buffer.from("JPEG").toString("base64")}`);
    const ffmpeg = fake.calls.find((call) => call.command === "ffmpeg");
    expect(ffmpeg?.args).toContain(join(browserDir(id), "preview.png"));
    expect(existsSync(join(browserDir(id), "preview.png"))).toBe(false);
  });

  test("returns null for hidden elements, failures and busy browsers", async () => {
    let boxFails = false;
    const fake = fakeAgentBrowser((command) => {
      if (command[0] === "click") return { hang: true };
      if (command[0] === "scrollintoview") return { code: 1 };
      if (command[0] === "get" && boxFails) return { code: 1, stderr: "gone" };
      return undefined;
    });
    const id = botId();
    fake.page.box = { x: 0, y: 0, width: 0, height: 10 };
    expect(await elementPreview(id, "e1")).toBeNull();
    fake.page.box = { x: 0, y: 0, width: 10, height: 0 };
    expect(await elementPreview(id, "e1")).toBeNull();
    const clicking = browserClick(id, "e1");
    await until(() => fake.commands.some((command) => command[0] === "click"));
    expect(await elementPreview(id, "e1")).toBeNull();
    fake.calls.find((call) => agentHead(call.args) === "click")?.child.finish({ code: 0, stdout: '{"success":true}' });
    await clicking;
    boxFails = true;
    expect(await elementPreview(botId(), "e1")).toBeNull();
  });

  test("still answers when the preview file cannot be removed", async () => {
    const fake = fakeAgentBrowser();
    fake.page.box = { x: 0, y: 0, width: 0, height: 0 };
    const id = botId();
    await mkdir(join(browserDir(id), "preview.png", "inner"), { recursive: true });
    expect(await elementPreview(id, "e1")).toBeNull();
    expect(existsSync(join(browserDir(id), "preview.png", "inner"))).toBe(true);
  });

  test("crops from a buffer and reports ffmpeg failures", async () => {
    let reply: { code?: number; stdout?: string } = { stdout: "JPG" };
    const fake = fakeAgentBrowser((command) => (command[0] === "ffmpeg" ? reply : undefined));
    const fromBuffer = await cropPreview(pngBytes, { x: 5, y: 5, width: 20, height: 20 });
    expect(fromBuffer).toStartWith("data:image/jpeg;base64,");
    const call = fake.calls.find((item) => item.command === "ffmpeg");
    expect(call?.args).toContain("pipe:0");
    expect(call?.child.written.length).toBeGreaterThan(0);
    reply = { code: 1 };
    expect(await cropPreview("/x.png", { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    reply = { stdout: "" };
    expect(await cropPreview("/x.png", { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });
});

function agentHead(args: string[]) {
  return args.slice(5)[0];
}

describe("live capture", () => {
  test("captures only while someone is watching an open page", async () => {
    const fake = fakeAgentBrowser();
    const id = botId();
    await liveCapture(id);
    expect(fake.commands).toHaveLength(0);
    markBrowserViewed(id);
    await liveCapture(id);
    expect(fake.commands).toHaveLength(0);
    await seedState(id);
    fake.page.url = "https://live.test/";
    fake.page.title = "Live";
    await liveCapture(id);
    expect(await readBrowserState(id)).toMatchObject({ url: "https://live.test/", title: "Live" });
    expect(existsSync(latestScreenshotFile(id))).toBe(true);
  });

  test("keeps the old url and title when the browser omits them", async () => {
    fakeAgentBrowser((command) => (command[0] === "get" ? { stdout: '{"success":true,"data":{}}\n' } : undefined));
    const id = botId();
    await seedState(id);
    markBrowserViewed(id);
    await liveCapture(id);
    expect(await readBrowserState(id)).toMatchObject({ url: "https://seed.test/", title: "Seed" });
  });

  test("skips while a capture or action is running and swallows failures", async () => {
    let hang = true;
    const fake = fakeAgentBrowser((command) => {
      if (command[0] === "screenshot" && hang) return { hang: true };
      if (command[0] === "screenshot") return { code: 1, stderr: "no display" };
      return undefined;
    });
    const id = botId();
    await seedState(id);
    markBrowserViewed(id);
    const first = liveCapture(id);
    await until(() => browsing(fake.commands).length === 1);
    await liveCapture(id);
    expect(browsing(fake.commands)).toHaveLength(1);
    fake.calls.find((call) => call.args.includes("screenshot"))?.child.finish({ code: 1 });
    await first;
    hang = false;
    await liveCapture(id);
    expect(await readBrowserState(id)).toMatchObject({ url: "https://seed.test/" });
  });

  test("ticks for the given bots and stops", () => {
    expect(startLiveView([])()).toBeUndefined();
    jest.useFakeTimers();
    const fake = fakeAgentBrowser();
    const id = botId();
    const stop = startLiveView([id], 100);
    jest.advanceTimersByTime(100);
    stop();
    expect(fake.commands).toHaveLength(0);
  });
});

describe("sessions", () => {
  test("knows whether the bot browser is alive", async () => {
    let reply: { code?: number; stdout?: string } | undefined;
    const fake = fakeAgentBrowser((command) => (command[0] === "session" ? reply : undefined));
    const id = botId();
    fake.page.sessions = [`runelay-${id}`];
    expect(await browserAlive(id)).toBe(true);
    fake.page.sessions = [];
    expect(await browserAlive(id)).toBe(false);
    reply = { code: 1 };
    expect(await browserAlive(id)).toBe(true);
    reply = { stdout: "oops" };
    expect(await browserAlive(id)).toBe(true);
    reply = { stdout: "{}" };
    expect(await browserAlive(id)).toBe(false);
    reply = { stdout: "" };
    expect(await browserAlive(id)).toBe(true);
  });

  test("opens a blank page when needed and returns the CDP url", async () => {
    const fake = fakeAgentBrowser();
    fake.page.cdpUrl = "ws://127.0.0.1:1/devtools";
    const id = botId();
    expect(await cdpUrl(id)).toBe("ws://127.0.0.1:1/devtools");
    expect(fake.commands).toContainEqual(["open", "about:blank"]);
    const before = fake.commands.length;
    await ensureBrowser(id);
    expect(fake.commands.slice(before)).toEqual([]);
    fake.page.cdpUrl = "http://nope";
    await expect(cdpUrl(id)).rejects.toThrow("agent-browser não devolveu a URL do CDP.");
    fake.page.cdpUrl = undefined as unknown as string;
    await expect(cdpUrl(id)).rejects.toThrow("agent-browser não devolveu a URL do CDP.");
  });

  test("closes idle browsers except the ones in use", async () => {
    const idle = botId();
    const kept = botId();
    const failing = botId();
    const fresh = botId();
    const fake = fakeAgentBrowser((command, call) =>
      command[0] === "close" ? { code: call.args.includes(`runelay-${failing}`) ? 1 : 0 } : undefined,
    );
    await fullScreenshot(idle);
    await fullScreenshot(kept);
    await fullScreenshot(failing);
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    await fullScreenshot(fresh);
    closeIdleBrowsers((id) => id === kept);
    await until(() => logs.includes(`browser ${idle} idle, closed`));
    const closed = fake.calls.filter((call) => call.args.at(-1) === "close").map((call) => call.args);
    expect(closed).toContainEqual(["--session", `runelay-${idle}`, "close"]);
    expect(closed).toContainEqual(["--session", `runelay-${failing}`, "close"]);
    expect(closed.some((args) => args.includes(`runelay-${kept}`))).toBe(false);
    expect(closed.some((args) => args.includes(`runelay-${fresh}`))).toBe(false);
    await until(() => closed.length >= 2);
    expect(logs).not.toContain(`browser ${failing} idle, closed`);
    const count = fake.calls.length;
    closeIdleBrowsers(() => true);
    expect(fake.calls.length).toBe(count);
    log.mockRestore();
  });
});
