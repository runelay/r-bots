import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { controllerOf, onControllerChange, waitForBotControl } from "./control";

const width = 1280;
const height = 800;
const fps = Number(process.env.DESKTOP_FPS ?? 8);
const idleMs = 10 * 60_000;
const desktopUser = process.env.DESKTOP_USER ?? "runelaybot";
const desktopHome = process.env.DESKTOP_HOME ?? `/home/${desktopUser}`;
const chromeBinary = process.env.DESKTOP_CHROME ?? "/opt/runelay-chrome/chrome";

type Json = Record<string, unknown>;

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const desktops = new Map<string, Desktop>();

function asUser(display: number, args: string[]) {
  return spawn("sudo", ["-n", "-u", desktopUser, "env", `DISPLAY=:${display}`, `HOME=${desktopHome}`, ...args], {
    stdio: "ignore",
    detached: true,
    cwd: "/tmp",
  });
}

function x(display: number, args: string[], timeoutMs = 10_000) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "xdotool",
      args,
      { env: { ...process.env, DISPLAY: `:${display}` }, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout.trim());
      },
    );
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freeDisplay() {
  const used = new Set([...desktops.values()].map((desktop) => desktop.display));
  for (let display = 90; display < 140; display++) {
    if (!used.has(display) && !existsSync(`/tmp/.X11-unix/X${display}`)) return display;
  }
  throw new Error("Nenhum display livre.");
}

const keyNames: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  " ": "space",
  Shift: "Shift_L",
  Control: "Control_L",
  Alt: "Alt_L",
  Meta: "Super_L",
};

function keysym(key: string) {
  if (keyNames[key]) return keyNames[key];
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key.length === 1) return key;
  return key;
}

function withModifiers(key: string, modifiers: number) {
  const parts: string[] = [];
  if (modifiers & 2) parts.push("ctrl");
  if (modifiers & 1) parts.push("alt");
  if (modifiers & 8) parts.push("shift");
  if (modifiers & 4) parts.push("super");
  return [...parts, keysym(key)].join("+");
}

class Desktop {
  readonly clients = new Set<WebSocket>();
  display = 0;
  private procs: ChildProcess[] = [];
  private streamer: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private lastFrame: Json | null = null;
  lastUsed = Date.now();
  title = "";

  constructor(readonly botId: string) {}

  get running() {
    return this.procs.length > 0;
  }

  async ensure() {
    this.lastUsed = Date.now();
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.display = freeDisplay();
      const xvfb = asUser(this.display, [
        "Xvfb",
        `:${this.display}`,
        "-screen",
        "0",
        `${width}x${height}x24`,
        "-nolisten",
        "tcp",
        "-ac",
      ]);
      this.procs.push(xvfb);
      for (let attempt = 0; attempt < 50 && !existsSync(`/tmp/.X11-unix/X${this.display}`); attempt++) await sleep(100);
      if (!existsSync(`/tmp/.X11-unix/X${this.display}`)) throw new Error("O Xvfb não subiu.");
      this.procs.push(asUser(this.display, ["openbox"]));
      await sleep(300);
      this.procs.push(this.launchChrome("about:blank"));
      await sleep(1500);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private launchChrome(url: string) {
    return asUser(this.display, [
      chromeBinary,
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      `--user-data-dir=${desktopHome}/chrome-${this.botId}`,
      `--window-size=${width},${height}`,
      "--window-position=0,0",
      url,
    ]);
  }

  async openBrowser(url: string) {
    await this.ensure();
    this.procs.push(this.launchChrome(url));
    await sleep(1500);
    return this.state();
  }

  async openTerminal() {
    await this.ensure();
    this.procs.push(
      asUser(this.display, ["sh", "-c", `cd ${desktopHome} && exec xterm -geometry 120x36+60+60 -fa Monospace -fs 11`]),
    );
    await sleep(800);
    return this.state();
  }

  async state() {
    try {
      this.title = await x(this.display, ["getactivewindow", "getwindowname"], 3000);
    } catch {
      this.title = "";
    }
    return { title: this.title, display: this.display, width, height };
  }

  stateMessage() {
    return {
      type: "state",
      url: "",
      title: this.title,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      controller: controllerOf(this.botId),
      surface: "desktop",
    };
  }

  private broadcast(message: Json) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) if (client.readyState === client.OPEN) client.send(payload);
  }

  publishState() {
    void this.state().then(() => this.broadcast(this.stateMessage()));
  }

  startStream() {
    if (this.streamer) return;
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-draw_mouse",
        "1",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        String(fps),
        "-i",
        `:${this.display}`,
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-q:v",
        "7",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.streamer = ffmpeg;
    let buffer = Buffer.alloc(0);
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) {
          buffer = Buffer.alloc(0);
          break;
        }
        const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) {
          if (start > 0) buffer = buffer.subarray(start);
          break;
        }
        const frame = buffer.subarray(start, end + 2);
        buffer = buffer.subarray(end + 2);
        this.lastFrame = { type: "frame", data: frame.toString("base64"), width, height, ts: Date.now() };
        this.broadcast(this.lastFrame);
      }
    });
    ffmpeg.on("close", () => {
      if (this.streamer === ffmpeg) this.streamer = null;
    });
  }

  stopStream() {
    this.streamer?.kill("SIGTERM");
    this.streamer = null;
    this.lastFrame = null;
  }

  async screenshot() {
    await this.ensure();
    return new Promise<Buffer>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-loglevel",
          "error",
          "-f",
          "x11grab",
          "-video_size",
          `${width}x${height}`,
          "-i",
          `:${this.display}`,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-c:v",
          "png",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 20 * 1024 * 1024, timeout: 15_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  }

  async input(message: Json) {
    await this.ensure();
    this.lastUsed = Date.now();
    const d = this.display;
    const px = String(Math.round(Number(message.x ?? 0)));
    const py = String(Math.round(Number(message.y ?? 0)));
    const button = message.button === "right" ? "3" : message.button === "middle" ? "2" : "1";
    switch (message.type) {
      case "mouse":
        if (message.event === "move") return x(d, ["mousemove", px, py]);
        if (message.event === "down") return x(d, ["mousemove", px, py, "mousedown", button]);
        if (message.event === "up") return x(d, ["mousemove", px, py, "mouseup", button]);
        if (message.event === "wheel") {
          const dy = Number(message.deltaY ?? 0);
          const steps = String(Math.max(1, Math.min(10, Math.round(Math.abs(dy) / 60))));
          return x(d, ["mousemove", px, py, "click", "--repeat", steps, dy > 0 ? "5" : "4"]);
        }
        throw new Error("Evento de mouse inválido.");
      case "key": {
        const modifiers = Number(message.modifiers ?? 0);
        if (message.event === "char") return x(d, ["type", "--delay", "8", "--", String(message.text ?? "")]);
        if (message.event === "down") return x(d, ["keydown", withModifiers(String(message.key ?? ""), modifiers)]);
        if (message.event === "up") return x(d, ["keyup", withModifiers(String(message.key ?? ""), modifiers)]);
        throw new Error("Evento de teclado inválido.");
      }
      case "navigate": {
        const url = new URL(String(message.url ?? ""));
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use uma URL http ou https.");
        await this.openBrowser(url.toString());
        return;
      }
      case "back":
        return x(d, ["key", "alt+Left"]);
      case "forward":
        return x(d, ["key", "alt+Right"]);
      case "reload":
        return x(d, ["key", "F5"]);
      case "terminal":
        await this.openTerminal();
        return;
      default:
        throw new Error("Mensagem desconhecida.");
    }
  }

  async click(px: number, py: number, button: "left" | "right" = "left", double = false) {
    await this.ensure();
    this.lastUsed = Date.now();
    await x(this.display, [
      "mousemove",
      String(Math.round(px)),
      String(Math.round(py)),
      "click",
      ...(double ? ["--repeat", "2"] : []),
      button === "right" ? "3" : "1",
    ]);
    await sleep(600);
    return this.state();
  }

  async type(text: string) {
    await this.ensure();
    this.lastUsed = Date.now();
    await x(this.display, ["type", "--delay", "12", "--", text], 60_000);
    await sleep(300);
    return this.state();
  }

  async key(combo: string) {
    await this.ensure();
    this.lastUsed = Date.now();
    await x(this.display, ["key", combo]);
    await sleep(400);
    return this.state();
  }

  async scroll(px: number, py: number, direction: "up" | "down", amount: number) {
    await this.ensure();
    this.lastUsed = Date.now();
    await x(this.display, [
      "mousemove",
      String(Math.round(px)),
      String(Math.round(py)),
      "click",
      "--repeat",
      String(Math.max(1, Math.min(20, amount))),
      direction === "down" ? "5" : "4",
    ]);
    await sleep(300);
    return this.state();
  }

  stop() {
    this.stopStream();
    for (const proc of this.procs.reverse()) {
      try {
        if (proc.pid) process.kill(proc.pid, "SIGTERM");
      } catch {}
    }
    this.procs = [];
    const display = this.display;
    if (display) {
      execFile(
        "sudo",
        ["-n", "-u", desktopUser, "pkill", "-TERM", "-f", `chrome-${this.botId}|Xvfb :${display} |DISPLAY=:${display}`],
        () => undefined,
      );
    }
  }
}

function desktopOf(botId: string) {
  let desktop = desktops.get(botId);
  if (!desktop) {
    desktop = new Desktop(botId);
    desktops.set(botId, desktop);
  }
  return desktop;
}

export function getDesktop(botId: string) {
  return desktopOf(botId);
}

onControllerChange((botId) => desktops.get(botId)?.publishState());

setInterval(() => {
  for (const desktop of desktops.values()) {
    if (desktop.running && desktop.clients.size === 0 && Date.now() - desktop.lastUsed > idleMs) {
      console.log(`desktop ${desktop.botId} idle, stopping`);
      desktop.stop();
    }
  }
}, 60_000).unref();

export function stopDesktop(botId: string) {
  const desktop = desktops.get(botId);
  if (desktop?.running) desktop.stop();
}

export function stopAllDesktops() {
  for (const desktop of desktops.values()) desktop.stop();
}

export function isDesktopUpgrade(pathname: string) {
  return /^\/bots\/[^/]+\/desktop\/live$/.test(pathname);
}

export function handleDesktopUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, botId: string) {
  wss.handleUpgrade(req, socket, head, (client) => {
    const desktop = desktopOf(botId);
    desktop.clients.add(client);
    const fail = (error: unknown) => {
      if (client.readyState === client.OPEN)
        client.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
    };
    desktop
      .ensure()
      .then(async () => {
        desktop.startStream();
        await desktop.state();
        client.send(JSON.stringify(desktop.stateMessage()));
      })
      .catch(fail);
    client.on("message", (data) => {
      let message: Json;
      try {
        message = JSON.parse(String(data)) as Json;
      } catch {
        return fail(new Error("JSON inválido."));
      }
      if (message.type === "ping") return client.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      if (controllerOf(botId) !== "user") return fail(new Error("Assuma o controle do computador antes de interagir."));
      desktop
        .input(message)
        .then(() => {
          if (message.type !== "mouse" || message.event === "up") desktop.publishState();
        })
        .catch(fail);
    });
    client.on("close", () => {
      desktop.clients.delete(client);
      desktop.lastUsed = Date.now();
      if (desktop.clients.size === 0) desktop.stopStream();
    });
  });
}

export async function desktopGuard(botId: string, signal?: AbortSignal) {
  await waitForBotControl(botId, signal);
}
