import type http from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { writeJson } from "../../../shared/json-file";
import { browserStateFile, cdpUrl, markBrowserViewed } from "./browser.service";
import { controllerOf, onControllerChange } from "./control.service";

type Json = Record<string, unknown>;

interface PageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const lives = new Map<string, LiveBrowser>();

const mouseTypes: Record<string, string> = {
  move: "mouseMoved",
  down: "mousePressed",
  up: "mouseReleased",
  wheel: "mouseWheel",
};
const keyTypes: Record<string, string> = { down: "keyDown", up: "keyUp" };

class LiveBrowser {
  readonly clients = new Set<WebSocket>();
  private cdp: WebSocket | globalThis.WebSocket | null = null;
  private sessionId: string | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private connecting: Promise<void> | null = null;
  private casting = false;
  lastFrame: Json | null = null;
  private state: PageState = { url: "", title: "", canGoBack: false, canGoForward: false, loading: false };

  constructor(readonly botId: string) {}

  private broadcast(message: Json) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) if (client.readyState === client.OPEN) client.send(payload);
  }

  stateMessage() {
    return { type: "state", ...this.state, controller: controllerOf(this.botId) };
  }

  publishState() {
    this.broadcast(this.stateMessage());
  }

  private send(method: string, params: Json = {}, withSession = true): Promise<Json> {
    const socket = this.cdp as globalThis.WebSocket | null;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error("CDP desconectado."));
    const id = this.nextId++;
    const message: Json = { id, method, params };
    if (withSession && this.sessionId) message.sessionId = this.sessionId;
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(message));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} sem resposta.`));
      }, 15_000).unref();
    });
  }

  private handle(raw: string) {
    let message: Json;
    try {
      message = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(String((message.error as Json).message ?? "erro CDP")));
      else waiter.resolve((message.result as Json) ?? {});
      return;
    }
    if (message.sessionId && message.sessionId !== this.sessionId) return;
    const params = (message.params ?? {}) as Json;
    switch (message.method) {
      case "Page.screencastFrame": {
        void this.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
        const meta = (params.metadata ?? {}) as Json;
        this.lastFrame = {
          type: "frame",
          data: params.data,
          width: meta.deviceWidth,
          height: meta.deviceHeight,
          ts: Date.now(),
        };
        this.broadcast(this.lastFrame);
        break;
      }
      case "Page.frameNavigated":
        if (!(params.frame as Json | undefined)?.parentId) void this.refreshState();
        break;
      case "Page.loadEventFired":
      case "Page.navigatedWithinDocument":
        void this.refreshState();
        break;
      case "Page.frameStartedLoading":
        this.state.loading = true;
        this.publishState();
        break;
      case "Page.frameStoppedLoading":
        this.state.loading = false;
        void this.refreshState();
        break;
      case "Target.detachedFromTarget":
        if (params.sessionId === this.sessionId) this.reset();
        break;
    }
  }

  private reset() {
    this.sessionId = null;
    this.casting = false;
    for (const waiter of this.pending.values()) waiter.reject(new Error("CDP desconectado."));
    this.pending.clear();
    const socket = this.cdp as globalThis.WebSocket | null;
    this.cdp = null;
    try {
      socket?.close();
    } catch {}
  }

  async ensure() {
    const socket = this.cdp as globalThis.WebSocket | null;
    if (socket && socket.readyState === 1 && this.sessionId) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.reset();
      const url = await cdpUrl(this.botId);
      const ws = new globalThis.WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("Não consegui abrir o CDP.")), { once: true });
      });
      this.cdp = ws;
      ws.addEventListener("message", (event) => this.handle(String(event.data)));
      ws.addEventListener("close", () => {
        if (this.cdp === ws) this.reset();
      });
      const targets = (await this.send("Target.getTargets", {}, false)).targetInfos as Array<{
        targetId: string;
        type: string;
        url: string;
        attached: boolean;
      }>;
      const pages = targets.filter((target) => target.type === "page");
      const page = pages.find((target) => target.attached) ?? pages[0];
      if (!page) throw new Error("Nenhuma aba aberta no navegador do bot.");
      const attached = await this.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false);
      this.sessionId = String(attached.sessionId);
      await this.send("Page.enable");
      await this.refreshState();
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async refreshState() {
    try {
      const history = await this.send("Page.getNavigationHistory");
      const entries = (history.entries ?? []) as Array<{ url: string; title: string }>;
      const index = Number(history.currentIndex ?? 0);
      const current = entries[index] ?? { url: "", title: "" };
      this.state = {
        ...this.state,
        url: current.url,
        title: current.title,
        canGoBack: index > 0,
        canGoForward: index < entries.length - 1,
      };
      this.publishState();
      if (current.url)
        await writeJson(browserStateFile(this.botId), {
          url: current.url,
          title: current.title,
          updatedAt: new Date().toISOString(),
        });
    } catch {}
  }

  async startCast() {
    await this.ensure();
    if (this.casting) return;
    await this.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    this.casting = true;
  }

  async stopCast() {
    if (!this.casting) return;
    this.casting = false;
    this.lastFrame = null;
    await this.send("Page.stopScreencast").catch(() => undefined);
  }

  private async history(delta: number) {
    const history = await this.send("Page.getNavigationHistory");
    const entries = (history.entries ?? []) as Array<{ id: number }>;
    const target = entries[Number(history.currentIndex ?? 0) + delta];
    if (target) await this.send("Page.navigateToHistoryEntry", { entryId: target.id });
  }

  async command(message: Json) {
    await this.ensure();
    const modifiers = Number(message.modifiers ?? 0);
    switch (message.type) {
      case "mouse": {
        const type = mouseTypes[String(message.event)];
        if (!type) throw new Error("Evento de mouse inválido.");
        await this.send("Input.dispatchMouseEvent", {
          type,
          x: Number(message.x ?? 0),
          y: Number(message.y ?? 0),
          button:
            type === "mouseMoved" || type === "mouseWheel"
              ? String(message.button ?? "none")
              : String(message.button ?? "left"),
          clickCount: Number(message.clickCount ?? (type === "mousePressed" || type === "mouseReleased" ? 1 : 0)),
          deltaX: Number(message.deltaX ?? 0),
          deltaY: Number(message.deltaY ?? 0),
          modifiers,
        });
        return;
      }
      case "key": {
        if (message.event === "char") {
          await this.send("Input.insertText", { text: String(message.text ?? "") });
          return;
        }
        const type = keyTypes[String(message.event)];
        if (!type) throw new Error("Evento de teclado inválido.");
        await this.send("Input.dispatchKeyEvent", {
          type: type === "keyDown" && message.text ? "keyDown" : type === "keyDown" ? "rawKeyDown" : "keyUp",
          key: message.key,
          code: message.code,
          text: type === "keyDown" ? message.text : undefined,
          modifiers,
        });
        return;
      }
      case "navigate": {
        const url = new URL(String(message.url ?? ""));
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use uma URL http ou https.");
        await this.send("Page.navigate", { url: url.toString() });
        return;
      }
      case "back":
        return this.history(-1);
      case "forward":
        return this.history(1);
      case "reload":
        await this.send("Page.reload", {});
        return;
      default:
        throw new Error("Mensagem desconhecida.");
    }
  }
}

function liveOf(botId: string) {
  let live = lives.get(botId);
  if (!live) {
    live = new LiveBrowser(botId);
    lives.set(botId, live);
  }
  return live;
}

onControllerChange((botId) => lives.get(botId)?.publishState());

export function isLiveUpgrade(pathname: string) {
  return /^\/bots\/[^/]+\/browser\/live$/.test(pathname);
}

export function handleLiveUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, botId: string) {
  wss.handleUpgrade(req, socket, head, (client) => {
    const live = liveOf(botId);
    live.clients.add(client);
    markBrowserViewed(botId);
    const fail = (error: unknown) => {
      if (client.readyState === client.OPEN)
        client.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
    };
    live
      .startCast()
      .then(() => {
        client.send(JSON.stringify(live.stateMessage()));
        if (live.lastFrame && client.readyState === client.OPEN) client.send(JSON.stringify(live.lastFrame));
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
      if (controllerOf(botId) !== "user") return fail(new Error("Assuma o controle do navegador antes de interagir."));
      live.command(message).catch(fail);
    });
    client.on("close", () => {
      live.clients.delete(client);
      if (live.clients.size === 0) void live.stopCast();
    });
  });
}

export function hasLiveClients(botId: string) {
  return (lives.get(botId)?.clients.size ?? 0) > 0;
}

export function publishLiveState(botId: string) {
  void lives.get(botId)?.refreshState();
}
