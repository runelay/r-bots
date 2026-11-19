import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { fakeClient } from "../../../../test/browser-helpers";
import { fakeProcesses, type ProcessCall, type ProcessReply } from "../../../../test/fake-process";
import { fastTimers } from "../../../../test/media-helpers";
import { setController } from "../services/control.service";
import {
  desktopGuard,
  desktopSocket,
  getDesktop,
  isDesktopUpgrade,
  stopAllDesktops,
  stopDesktop,
  stopIdleDesktops,
} from "../services/desktop.service";

const realExists = fs.existsSync;
const ready = new Set<number>();
let allTaken = false;
let xvfbStarts = true;
let xdotool: (args: string[]) => ProcessReply = () => ({ stdout: "Janela\n" });
let ffmpegShot: ProcessReply = { stdout: "PNGDATA" };
let calls: ProcessCall[] = [];
let killed: Array<[number, string]> = [];
let counter = 0;
const restores: Array<() => void> = [];

function botId() {
  counter++;
  return `desk-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

function displayOf(call: ProcessCall) {
  const env = call.args.find((arg) => arg.startsWith("DISPLAY=:"));
  return env ? Number(env.slice("DISPLAY=:".length)) : null;
}

beforeEach(() => {
  ready.clear();
  allTaken = false;
  xvfbStarts = true;
  xdotool = () => ({ stdout: "Janela\n" });
  ffmpegShot = { stdout: "PNGDATA" };
  killed = [];
  const timers = fastTimers(1);
  const exists = spyOn(fs, "existsSync").mockImplementation(((path: fs.PathLike) => {
    const match = /^\/tmp\/\.X11-unix\/X(\d+)$/.exec(String(path));
    if (!match) return realExists(path);
    return allTaken || ready.has(Number(match[1]));
  }) as typeof fs.existsSync);
  const kill = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    killed.push([pid, String(signal)]);
    if (killed.length === 1) throw new Error("ESRCH");
    return true;
  }) as typeof process.kill);
  const fake = fakeProcesses((call) => {
    if (call.command === "sudo" && call.args.includes("Xvfb")) {
      const display = displayOf(call);
      if (display !== null && xvfbStarts) ready.add(display);
      return { hang: true };
    }
    if (call.command === "sudo" && call.args.includes("pkill")) return { code: 0 };
    if (call.command === "sudo") return { hang: true };
    if (call.command === "xdotool") return xdotool(call.args);
    if (call.command === "ffmpeg" && call.args.includes("image2pipe") && call.args.includes("mjpeg"))
      return { hang: true };
    if (call.command === "ffmpeg") return ffmpegShot;
    return undefined;
  });
  calls = fake.calls;
  restores.push(
    timers.restore,
    () => exists.mockRestore(),
    () => kill.mockRestore(),
  );
});

afterEach(() => {
  stopAllDesktops();
  for (const restore of restores.splice(0).reverse()) restore();
  setSystemTime();
});

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

function spawned(name: string) {
  return calls.filter((call) => call.command === "sudo" && call.args.includes(name));
}

function lastX() {
  return calls.filter((call) => call.command === "xdotool").at(-1)?.args;
}

function streamer() {
  return calls.filter((call) => call.command === "ffmpeg" && call.args.includes("mjpeg")).at(-1);
}

describe("starting the desktop", () => {
  test("boots Xvfb, openbox and Chrome as the desktop user", async () => {
    const id = botId();
    const desktop = getDesktop(id);
    expect(desktop.running).toBe(false);
    await desktop.ensure();
    expect(desktop.running).toBe(true);
    const xvfb = spawned("Xvfb")[0];
    expect(xvfb.args.slice(0, 4)).toEqual(["-n", "-u", process.env.DESKTOP_USER ?? "runelaybot", "env"]);
    expect(xvfb.args).toContain(`HOME=${process.env.DESKTOP_HOME}`);
    expect(xvfb.options.cwd).toBe("/tmp");
    expect(spawned("openbox")).toHaveLength(1);
    const chrome = spawned(process.env.DESKTOP_CHROME as string)[0];
    expect(chrome.args).toContain(`--user-data-dir=${process.env.DESKTOP_HOME}/chrome-${id}`);
    expect(chrome.args.at(-1)).toBe("about:blank");
    await desktop.ensure();
    expect(spawned("Xvfb")).toHaveLength(1);
  });

  test("shares a start in progress", async () => {
    const desktop = getDesktop(botId());
    const first = desktop.ensure();
    const second = desktop.ensure();
    await Promise.all([first, second]);
    expect(spawned("Xvfb")).toHaveLength(1);
  });

  test("fails when Xvfb never comes up or no display is free", async () => {
    xvfbStarts = false;
    await expect(getDesktop(botId()).ensure()).rejects.toThrow("O Xvfb não subiu.");
    allTaken = true;
    await expect(getDesktop(botId()).ensure()).rejects.toThrow("Nenhum display livre.");
  });
});

describe("desktop actions", () => {
  test("clicks, types, presses keys and scrolls", async () => {
    const desktop = getDesktop(botId());
    await desktop.ensure();
    expect(await desktop.click(10.4, 20.6)).toMatchObject({ title: "Janela", width: 1280, height: 800 });
    expect(calls.filter((call) => call.command === "xdotool").at(-2)?.args).toEqual([
      "mousemove",
      "10",
      "21",
      "click",
      "1",
    ]);
    await desktop.click(1, 2, "right", true);
    expect(calls.filter((call) => call.command === "xdotool").at(-2)?.args).toEqual([
      "mousemove",
      "1",
      "2",
      "click",
      "--repeat",
      "2",
      "3",
    ]);
    await desktop.type("olá");
    expect(calls.filter((call) => call.command === "xdotool").at(-2)?.args).toEqual([
      "type",
      "--delay",
      "12",
      "--",
      "olá",
    ]);
    await desktop.key("ctrl+l");
    expect(calls.filter((call) => call.command === "xdotool").at(-2)?.args).toEqual(["key", "ctrl+l"]);
    await desktop.scroll(5, 6, "down", 50);
    expect(calls.filter((call) => call.command === "xdotool").at(-2)?.args).toEqual([
      "mousemove",
      "5",
      "6",
      "click",
      "--repeat",
      "20",
      "5",
    ]);
    await desktop.scroll(5, 6, "up", 0);
    expect(
      calls
        .filter((call) => call.command === "xdotool")
        .at(-2)
        ?.args.slice(-2),
    ).toEqual(["1", "4"]);
    const xcall = calls.find((call) => call.command === "xdotool");
    expect((xcall?.options.env as Record<string, string>).DISPLAY).toBe(`:${desktop.display}`);
  });

  test("opens a browser and a terminal", async () => {
    const desktop = getDesktop(botId());
    await desktop.openBrowser("https://a.test/");
    expect(
      spawned(process.env.DESKTOP_CHROME as string)
        .at(-1)
        ?.args.at(-1),
    ).toBe("https://a.test/");
    await desktop.openTerminal();
    expect(spawned("sh").at(-1)?.args.at(-1)).toContain("exec xterm");
  });

  test("reads an empty title when xdotool fails", async () => {
    const desktop = getDesktop(botId());
    await desktop.ensure();
    xdotool = () => ({ code: 1 });
    expect(await desktop.state()).toMatchObject({ title: "" });
  });

  test("takes a screenshot or reports ffmpeg failures", async () => {
    const desktop = getDesktop(botId());
    expect((await desktop.screenshot()).toString()).toBe("PNGDATA");
    ffmpegShot = { code: 1, stderr: "x11grab failed\n" };
    await expect(desktop.screenshot()).rejects.toThrow("x11grab failed");
    ffmpegShot = { code: 2 };
    await expect(desktop.screenshot()).rejects.toThrow("ffmpeg saiu com código 2");
  });

  test("stops every process and cleans up stray ones", async () => {
    const id = botId();
    const desktop = getDesktop(id);
    await desktop.ensure();
    desktop.startStream();
    stopDesktop(id);
    expect(desktop.running).toBe(false);
    expect(killed).toHaveLength(3);
    expect(killed.every(([, signal]) => signal === "SIGTERM")).toBe(true);
    const pkill = calls.find((call) => call.args.includes("pkill"));
    expect(pkill?.args.at(-1)).toBe(`chrome-${id}|Xvfb :${desktop.display} |DISPLAY=:${desktop.display}`);
    expect(streamer()?.child.signals).toEqual(["SIGTERM"]);
    stopDesktop(id);
    stopDesktop("never-started");
    expect(killed).toHaveLength(3);
    const fresh = getDesktop(botId());
    fresh.stop();
    expect(calls.filter((call) => call.args.includes("pkill"))).toHaveLength(1);
  });

  test("stops idle desktops without viewers", async () => {
    const idle = getDesktop(botId());
    const watched = getDesktop(botId());
    const recent = getDesktop(botId());
    await idle.ensure();
    await watched.ensure();
    await recent.ensure();
    watched.clients.add(fakeClient(watched.botId, "desktop").socket);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    recent.lastUsed = Date.now();
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    stopIdleDesktops();
    log.mockRestore();
    expect(logs).toEqual([`desktop ${idle.botId} idle, stopping`]);
    expect([idle.running, watched.running, recent.running]).toEqual([false, true, true]);
    watched.clients.clear();
  });

  test("waits for bot control and recognizes upgrade paths", async () => {
    await desktopGuard(botId());
    expect(isDesktopUpgrade("/bots/a/desktop/live")).toBe(true);
    expect(isDesktopUpgrade("/bots/a/browser/live")).toBe(false);
  });
});

describe("desktop socket", () => {
  async function connect() {
    const id = botId();
    const client = fakeClient(id, "desktop");
    desktopSocket.open(client.socket);
    restores.push(() => desktopSocket.close(client.socket, 1000, ""));
    const state = await client.next("state");
    return { id, client, state, desktop: getDesktop(id) };
  }

  function say(client: ReturnType<typeof fakeClient>, message: unknown) {
    desktopSocket.message(client.socket, typeof message === "string" ? message : JSON.stringify(message));
  }

  test("starts streaming and sends the state", async () => {
    const { state } = await connect();
    expect(state).toEqual({
      type: "state",
      url: "",
      title: "Janela",
      canGoBack: false,
      canGoForward: false,
      loading: false,
      controller: "bot",
      surface: "desktop",
    });
    expect(streamer()?.args).toContain("x11grab");
  });

  test("splits the ffmpeg stream into frames", async () => {
    const { client, desktop } = await connect();
    desktop.startStream();
    expect(calls.filter((call) => call.command === "ffmpeg" && call.args.includes("mjpeg"))).toHaveLength(1);
    const child = streamer()?.child;
    const frame = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    child?.stdout.write(Buffer.from([7, 7, 7]));
    child?.stdout.write(Buffer.concat([Buffer.from([9]), frame.subarray(0, 3)]));
    child?.stdout.write(Buffer.concat([frame.subarray(3), frame]));
    await until(() => client.sent.filter((message) => message.type === "frame").length === 2);
    const frames = client.sent.filter((message) => message.type === "frame");
    expect(frames[0]).toMatchObject({ data: frame.toString("base64"), width: 1280, height: 800 });
    child?.finish({ code: 0 });
    await until(() => {
      desktop.startStream();
      return calls.filter((call) => call.command === "ffmpeg" && call.args.includes("mjpeg")).length === 2;
    });
    streamer()?.child.stdout.destroy(new Error("pipe broke"));
    await until(() => {
      desktop.startStream();
      return calls.filter((call) => call.command === "ffmpeg" && call.args.includes("mjpeg")).length === 3;
    });
  });

  test("guards the payload and the controller", async () => {
    const { id, client } = await connect();
    say(client, "{bad");
    expect(await client.next("error")).toEqual({ type: "error", message: "JSON inválido." });
    say(client, { type: "ping" });
    expect(await client.next("pong")).toMatchObject({ type: "pong" });
    say(client, { type: "mouse", event: "move" });
    expect(await client.next("error")).toEqual({
      type: "error",
      message: "Assuma o controle do computador antes de interagir.",
    });
    desktopSocket.message(client.socket, "x".repeat(1024 * 1024 + 1));
    expect(client.closed).toEqual([[1009, "Message too big"]]);
    setController(id, "user");
    expect(await client.next("state")).toMatchObject({ controller: "user" });
    setController(id, "bot");
  });

  test("turns user input into xdotool commands", async () => {
    const { id, client } = await connect();
    setController(id, "user");
    await client.next("state");
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ type: "mouse", event: "move", x: 1.2, y: 2.8 }, ["mousemove", "1", "3"]],
      [{ type: "mouse", event: "down", button: "right" }, ["mousemove", "0", "0", "mousedown", "3"]],
      [{ type: "mouse", event: "up", button: "middle" }, ["mousemove", "0", "0", "mouseup", "2"]],
      [{ type: "mouse", event: "wheel", deltaY: 600 }, ["mousemove", "0", "0", "click", "--repeat", "10", "5"]],
      [{ type: "mouse", event: "wheel" }, ["mousemove", "0", "0", "click", "--repeat", "1", "4"]],
      [{ type: "key", event: "char", text: "oi" }, ["type", "--delay", "8", "--", "oi"]],
      [{ type: "key", event: "char" }, ["type", "--delay", "8", "--", ""]],
      [{ type: "key", event: "down", key: "Enter", modifiers: 15 }, ["keydown", "ctrl+alt+shift+super+Return"]],
      [{ type: "key", event: "up", key: "F5" }, ["keyup", "F5"]],
      [{ type: "key", event: "down", key: "a" }, ["keydown", "a"]],
      [{ type: "key", event: "up", key: "Unidentified" }, ["keyup", "Unidentified"]],
      [{ type: "key", event: "down" }, ["keydown", ""]],
      [{ type: "back" }, ["key", "alt+Left"]],
      [{ type: "forward" }, ["key", "alt+Right"]],
      [{ type: "reload" }, ["key", "F5"]],
    ];
    for (const [input, expected] of cases) {
      const before = calls.length;
      say(client, input);
      await until(() =>
        calls.slice(before).some((call) => call.command === "xdotool" && call.args[0] !== "getactivewindow"),
      );
      expect(
        calls.slice(before).find((call) => call.command === "xdotool" && call.args[0] !== "getactivewindow")?.args,
      ).toEqual(expected);
    }
    setController(id, "bot");
  });

  test("publishes the state after anything but mouse moves", async () => {
    const { id, client } = await connect();
    setController(id, "user");
    await client.next("state");
    say(client, { type: "mouse", event: "move" });
    say(client, { type: "mouse", event: "up" });
    await client.next("state");
    const before = client.sent.filter((message) => message.type === "state").length;
    say(client, { type: "key", event: "char", text: "a" });
    await until(() => client.sent.filter((message) => message.type === "state").length === before + 1);
    setController(id, "bot");
  });

  test("navigates, opens a terminal and reports bad input", async () => {
    const { id, client } = await connect();
    setController(id, "user");
    await client.next("state");
    say(client, { type: "navigate", url: "https://b.test/" });
    await until(() =>
      spawned(process.env.DESKTOP_CHROME as string).some((call) => call.args.at(-1) === "https://b.test/"),
    );
    say(client, { type: "terminal" });
    await until(() => spawned("sh").length === 1);
    const cases: Array<[unknown, string]> = [
      [{ type: "navigate", url: "javascript:alert(1)" }, "Use uma URL http ou https."],
      [{ type: "mouse", event: "hover" }, "Evento de mouse inválido."],
      [{ type: "key", event: "press" }, "Evento de teclado inválido."],
      [{ type: "dance" }, "Mensagem desconhecida."],
    ];
    for (const [input, message] of cases) {
      say(client, input);
      expect(await client.next("error")).toEqual({ type: "error", message });
    }
    xdotool = (args) => (args[0] === "key" ? { code: 1, stderr: "no window\n" } : { stdout: "J" });
    say(client, { type: "back" });
    expect(await client.next("error")).toEqual({ type: "error", message: "no window" });
    xdotool = (args) => (args[0] === "key" ? { code: 4 } : { stdout: "J" });
    say(client, { type: "back" });
    expect(await client.next("error")).toEqual({ type: "error", message: "xdotool saiu com código 4" });
    setController(id, "bot");
  });

  test("reports a failed start and stays quiet for a closed client", async () => {
    allTaken = true;
    const client = fakeClient(botId(), "desktop");
    desktopSocket.open(client.socket);
    expect(await client.next("error")).toEqual({ type: "error", message: "Nenhum display livre." });
    desktopSocket.close(client.socket, 1000, "");
    const closed = fakeClient(botId(), "desktop");
    closed.setOpen(false);
    desktopSocket.open(closed.socket);
    await new Promise((resolve) => setImmediate(resolve));
    desktopSocket.close(closed.socket, 1000, "");
    expect(closed.sent).toEqual([]);
  });

  test("stops the stream when the last viewer leaves", async () => {
    const { client, desktop } = await connect();
    const second = fakeClient(desktop.botId, "desktop");
    desktopSocket.open(second.socket);
    await second.next("state");
    desktopSocket.close(second.socket, 1000, "");
    expect(streamer()?.child.signals).toEqual([]);
    desktopSocket.close(client.socket, 1000, "");
    expect(streamer()?.child.signals).toEqual(["SIGTERM"]);
    desktopSocket.close(fakeClient("nobody", "desktop").socket, 1000, "");
    expect(desktop.clients.size).toBe(0);
  });
});
