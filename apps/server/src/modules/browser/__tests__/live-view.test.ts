import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  type CdpCall,
  type CdpReply,
  fakeAgentBrowser,
  fakeCdp,
  fakeClient,
  until,
} from "../../../../test/browser-helpers";
import { readBrowserState } from "../services/browser.service";
import { setController } from "../services/control.service";
import { hasLiveClients, isLiveUpgrade, liveSocket, publishLiveState } from "../services/live-view.service";

const cleanups: Array<() => unknown> = [];
let counter = 0;

function botId() {
  counter++;
  return `live-bot-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

async function setup(handler?: (call: CdpCall) => CdpReply) {
  const cdp = fakeCdp(handler);
  const browser = fakeAgentBrowser();
  browser.page.cdpUrl = cdp.url;
  const id = botId();
  cleanups.push(() => cdp.stop());
  return { cdp, browser, id };
}

function openClient(id: string) {
  const client = fakeClient(id);
  liveSocket.open(client.socket);
  cleanups.push(() => liveSocket.close(client.socket, 1000, ""));
  return client;
}

async function ready(client: ReturnType<typeof fakeClient>) {
  await until(() => client.sent.filter((message) => message.type === "state").length >= 2, "screencast start");
  const states = client.sent.filter((message) => message.type === "state");
  for (const message of states) await client.next("state");
  return states.at(-1) as Record<string, unknown>;
}

function say(client: ReturnType<typeof fakeClient>, message: unknown) {
  liveSocket.message(client.socket, typeof message === "string" ? message : JSON.stringify(message));
}

function methods(calls: CdpCall[]) {
  return calls.map((call) => call.method);
}

afterEach(async () => {
  jest.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("connecting", () => {
  test("attaches to the page, starts the screencast and sends the state", async () => {
    const { cdp, id } = await setup();
    const client = openClient(id);
    const state = await ready(client);
    expect(state).toEqual({
      type: "state",
      url: "https://a.test/",
      title: "A",
      canGoBack: false,
      canGoForward: false,
      loading: false,
      controller: "bot",
    });
    expect(methods(cdp.calls)).toEqual([
      "Target.getTargets",
      "Target.attachToTarget",
      "Page.enable",
      "Page.getNavigationHistory",
      "Page.startScreencast",
    ]);
    expect(cdp.calls[1].params).toEqual({ targetId: "p1", flatten: true });
    expect(cdp.calls[0].sessionId).toBeUndefined();
    expect(cdp.calls[2].sessionId).toBe("S1");
    expect(hasLiveClients(id)).toBe(true);
    expect(await readBrowserState(id)).toMatchObject({ url: "https://a.test/", title: "A" });
  });

  test("shares one connection between clients and replays the last frame", async () => {
    const { cdp, id } = await setup();
    const first = openClient(id);
    const second = openClient(id);
    await ready(first);
    await ready(second);
    expect(methods(cdp.calls).filter((method) => method === "Target.getTargets")).toHaveLength(1);
    cdp.emit({
      method: "Page.screencastFrame",
      sessionId: "S1",
      params: { sessionId: 9, data: "AAA", metadata: { deviceWidth: 1280, deviceHeight: 800 } },
    });
    const frame = await first.next("frame");
    expect(frame).toMatchObject({ data: "AAA", width: 1280, height: 800 });
    await until(() => cdp.calls.some((call) => call.method === "Page.screencastFrameAck"));
    expect(cdp.calls.find((call) => call.method === "Page.screencastFrameAck")?.params).toEqual({ sessionId: 9 });
    const third = openClient(id);
    await third.next("state");
    expect(await third.next("frame")).toMatchObject({ data: "AAA" });
    const closedClient = fakeClient(id);
    closedClient.setOpen(false);
    liveSocket.open(closedClient.socket);
    await closedClient.next("state");
    expect(closedClient.sent.some((message) => message.type === "frame")).toBe(false);
    liveSocket.close(closedClient.socket, 1000, "");
  });

  test("uses the first page when none is attached and a frame without metadata", async () => {
    const { cdp, id } = await setup((call) => {
      if (call.method === "Target.getTargets")
        return { result: { targetInfos: [{ targetId: "p9", type: "page", url: "", attached: false }] } };
      if (call.method === "Page.screencastFrameAck") return { error: { message: "late ack" } };
      return undefined;
    });
    const client = openClient(id);
    await ready(client);
    expect(cdp.calls[1].params).toEqual({ targetId: "p9", flatten: true });
    cdp.emit({ method: "Page.screencastFrame", params: { data: "B" } });
    expect(await client.next("frame")).toMatchObject({ data: "B" });
  });

  test("reports a browser without pages or an unreachable CDP", async () => {
    const { id } = await setup((call) =>
      call.method === "Target.getTargets" ? { result: { targetInfos: [] } } : undefined,
    );
    const client = openClient(id);
    expect(await client.next("error")).toEqual({ type: "error", message: "Nenhuma aba aberta no navegador do bot." });

    const dead = fakeCdp();
    const url = dead.url;
    await dead.stop();
    const browser = fakeAgentBrowser();
    browser.page.cdpUrl = url;
    const other = openClient(botId());
    expect(await other.next("error")).toEqual({ type: "error", message: "Não consegui abrir o CDP." });
  });

  test("does not write an error to a client that already left", async () => {
    const { id } = await setup((call) =>
      call.method === "Target.getTargets" ? { error: { message: "denied" } } : undefined,
    );
    const client = fakeClient(id);
    client.setOpen(false);
    liveSocket.open(client.socket);
    await until(() => !hasLiveClients(id) || client.sent.length === 0);
    liveSocket.close(client.socket, 1000, "");
    expect(client.sent).toEqual([]);
  });
});

describe("page events", () => {
  test("tracks navigation and loading", async () => {
    const { cdp, id } = await setup();
    const client = openClient(id);
    await ready(client);
    cdp.setHistory({
      entries: [
        { id: 1, url: "https://a.test/", title: "A" },
        { id: 2, url: "https://b.test/", title: "B" },
      ],
      currentIndex: 1,
    });
    cdp.emit({ method: "Page.frameStartedLoading", params: {} });
    expect(await client.next("state")).toMatchObject({ loading: true });
    cdp.emit({ method: "Page.frameNavigated", params: { frame: { parentId: "x" } } });
    cdp.emit({ method: "Page.frameNavigated", params: { frame: {} } });
    expect(await client.next("state")).toMatchObject({ url: "https://b.test/", canGoBack: true, canGoForward: false });
    cdp.emit({ method: "Page.loadEventFired" });
    await client.next("state");
    cdp.emit({ method: "Page.navigatedWithinDocument", params: {} });
    await client.next("state");
    cdp.emit({ method: "Page.frameStoppedLoading", params: {} });
    expect(await client.next("state")).toMatchObject({ loading: false });
    cdp.setHistory({ entries: [], currentIndex: 3 } as never);
    cdp.emit({ method: "Page.loadEventFired" });
    expect(await client.next("state")).toMatchObject({ url: "", title: "" });
    cdp.setHistory({} as never);
    cdp.emit({ method: "Page.loadEventFired" });
    expect(await client.next("state")).toMatchObject({ url: "", canGoBack: false });
  });

  test("ignores noise from the CDP socket", async () => {
    const { cdp, id } = await setup();
    const client = openClient(id);
    await ready(client);
    const before = client.sent.length;
    cdp.raw("not json");
    cdp.emit({ id: 9999, result: {} });
    cdp.emit({ method: "Page.frameStartedLoading", sessionId: "OTHER" });
    cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "OTHER" } });
    cdp.emit({ method: "Unknown.event" });
    say(client, { type: "ping" });
    await client.next("pong");
    expect(client.sent.slice(before).map((message) => message.type)).toEqual(["pong"]);
  });

  test("reconnects after the target detaches", async () => {
    const { cdp, id } = await setup();
    const client = openClient(id);
    await ready(client);
    cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });
    await until(() => cdp.connections === 0);
    setController(id, "user");
    say(client, { type: "reload" });
    await until(() => cdp.calls.some((call) => call.method === "Page.reload"));
    expect(methods(cdp.calls).filter((method) => method === "Target.getTargets")).toHaveLength(2);
    setController(id, "bot");
  });

  test("drops pending calls when the CDP socket closes", async () => {
    const { cdp, id } = await setup((call) => (call.method === "Page.navigate" ? "silent" : undefined));
    const client = openClient(id);
    await ready(client);
    setController(id, "user");
    say(client, { type: "navigate", url: "https://c.test/" });
    await until(() => cdp.calls.some((call) => call.method === "Page.navigate"));
    cdp.dropAll();
    expect(await client.next("error")).toEqual({ type: "error", message: "CDP desconectado." });
    setController(id, "bot");
  });

  test("times out a call the browser never answers", async () => {
    const { cdp, id } = await setup((call) => (call.method === "Page.reload" ? "silent" : undefined));
    const client = openClient(id);
    await ready(client);
    setController(id, "user");
    jest.useFakeTimers();
    say(client, { type: "reload" });
    await until(() => cdp.calls.some((call) => call.method === "Page.reload"));
    jest.advanceTimersByTime(15_000);
    expect(await client.next("error")).toEqual({ type: "error", message: "CDP Page.reload sem resposta." });
    setController(id, "bot");
  });
});

describe("user input", () => {
  test("refuses input while the bot is in control and guards the payload", async () => {
    const { id } = await setup();
    const client = openClient(id);
    await ready(client);
    say(client, "{bad");
    expect(await client.next("error")).toEqual({ type: "error", message: "JSON inválido." });
    say(client, { type: "mouse", event: "move" });
    expect(await client.next("error")).toEqual({
      type: "error",
      message: "Assuma o controle do navegador antes de interagir.",
    });
    liveSocket.message(client.socket, "x".repeat(1024 * 1024 + 1));
    expect(client.closed).toEqual([[1009, "Message too big"]]);
  });

  test("dispatches mouse, keyboard, navigation and history commands", async () => {
    const { cdp, id } = await setup();
    const client = openClient(id);
    await ready(client);
    setController(id, "user");
    expect(await client.next("state")).toMatchObject({ controller: "user" });
    cdp.setHistory({
      entries: [
        { id: 1, url: "https://a.test/", title: "A" },
        { id: 2, url: "https://b.test/", title: "B" },
      ],
      currentIndex: 1,
    });
    const inputs = [
      { type: "mouse", event: "move", x: 1, y: 2 },
      { type: "mouse", event: "down", x: 1, y: 2, modifiers: 2 },
      { type: "mouse", event: "up" },
      { type: "mouse", event: "wheel", deltaX: 1, deltaY: 5, button: "middle", clickCount: 3 },
      { type: "key", event: "char", text: "oi" },
      { type: "key", event: "char" },
      { type: "key", event: "down", key: "a", code: "KeyA", text: "a" },
      { type: "key", event: "down", key: "Enter", code: "Enter" },
      { type: "key", event: "up", key: "a", code: "KeyA" },
      { type: "navigate", url: "https://c.test/path" },
      { type: "back" },
      { type: "forward" },
      { type: "reload" },
    ];
    for (const input of inputs) say(client, input);
    await until(() => cdp.calls.some((call) => call.method === "Page.reload"));
    await until(() => cdp.calls.filter((call) => call.method === "Page.navigateToHistoryEntry").length === 1);
    const sent = cdp.calls.filter((call) => call.method.startsWith("Input.") || call.method.startsWith("Page.nav"));
    const mouse = sent.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params);
    expect(mouse).toEqual([
      { type: "mouseMoved", x: 1, y: 2, button: "none", clickCount: 0, deltaX: 0, deltaY: 0, modifiers: 0 },
      { type: "mousePressed", x: 1, y: 2, button: "left", clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 2 },
      { type: "mouseReleased", x: 0, y: 0, button: "left", clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 },
      { type: "mouseWheel", x: 0, y: 0, button: "middle", clickCount: 3, deltaX: 1, deltaY: 5, modifiers: 0 },
    ]);
    expect(sent.filter((call) => call.method === "Input.insertText").map((call) => call.params)).toEqual([
      { text: "oi" },
      { text: "" },
    ]);
    expect(sent.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.params)).toEqual([
      { type: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: 0 },
      { type: "rawKeyDown", key: "Enter", code: "Enter", modifiers: 0 },
      { type: "keyUp", key: "a", code: "KeyA", modifiers: 0 },
    ]);
    expect(sent.find((call) => call.method === "Page.navigate")?.params).toEqual({ url: "https://c.test/path" });
    expect(sent.find((call) => call.method === "Page.navigateToHistoryEntry")?.params).toEqual({ entryId: 1 });
    setController(id, "bot");
  });

  test("rejects invalid commands", async () => {
    const { id } = await setup();
    const client = openClient(id);
    await ready(client);
    setController(id, "user");
    await client.next("state");
    const cases: Array<[unknown, string]> = [
      [{ type: "mouse", event: "hover" }, "Evento de mouse inválido."],
      [{ type: "key", event: "press" }, "Evento de teclado inválido."],
      [{ type: "navigate", url: "file:///etc/passwd" }, "Use uma URL http ou https."],
      [{ type: "dance" }, "Mensagem desconhecida."],
    ];
    for (const [input, message] of cases) {
      say(client, input);
      expect(await client.next("error")).toEqual({ type: "error", message });
    }
    say(client, { type: "navigate" });
    expect((await client.next("error")).message).toBeString();
    setController(id, "bot");
  });

  test("reports CDP errors back to the client", async () => {
    const { id } = await setup((call) =>
      call.method === "Page.reload"
        ? { error: { message: "page crashed" } }
        : call.method === "Page.navigate"
          ? { error: {} }
          : undefined,
    );
    const client = openClient(id);
    await ready(client);
    setController(id, "user");
    say(client, { type: "reload" });
    expect(await client.next("error")).toEqual({ type: "error", message: "page crashed" });
    say(client, { type: "navigate", url: "https://x.test/" });
    expect(await client.next("error")).toEqual({ type: "error", message: "erro CDP" });
    setController(id, "bot");
  });
});

describe("lifecycle", () => {
  test("stops the screencast when the last client leaves and ignores unknown bots", async () => {
    const { cdp, id } = await setup();
    const client = fakeClient(id);
    liveSocket.open(client.socket);
    await ready(client);
    liveSocket.close(client.socket, 1000, "");
    await until(() => cdp.calls.some((call) => call.method === "Page.stopScreencast"));
    expect(hasLiveClients(id)).toBe(false);
    liveSocket.close(fakeClient("never-opened").socket, 1000, "");
    expect(hasLiveClients("never-opened")).toBe(false);
    const again = openClient(id);
    await again.next("state");
    expect(methods(cdp.calls).filter((method) => method === "Page.startScreencast")).toHaveLength(2);
  });

  test("closing twice and refreshing on demand", async () => {
    const { cdp, id } = await setup();
    const client = fakeClient(id);
    liveSocket.open(client.socket);
    await ready(client);
    publishLiveState(id);
    await client.next("state");
    publishLiveState("nobody");
    liveSocket.close(client.socket, 1000, "");
    liveSocket.close(client.socket, 1000, "");
    await until(() => cdp.calls.some((call) => call.method === "Page.stopScreencast"));
    expect(methods(cdp.calls).filter((method) => method === "Page.stopScreencast")).toHaveLength(1);
    cdp.dropAll();
    await until(() => cdp.connections === 0);
    publishLiveState(id);
  });

  test("ignores a screencast stop the browser refuses", async () => {
    const { cdp, id } = await setup((call) =>
      call.method === "Page.stopScreencast" ? { error: { message: "already stopped" } } : undefined,
    );
    const client = fakeClient(id);
    liveSocket.open(client.socket);
    await ready(client);
    liveSocket.close(client.socket, 1000, "");
    await until(() => cdp.calls.some((call) => call.method === "Page.stopScreencast"));
    expect(hasLiveClients(id)).toBe(false);
    const again = openClient(id);
    expect(await again.next("state")).toMatchObject({ type: "state" });
  });

  test("recognizes live upgrade paths", () => {
    expect(isLiveUpgrade("/bots/abc/browser/live")).toBe(true);
    expect(isLiveUpgrade("/bots/abc/browser")).toBe(false);
    expect(isLiveUpgrade("/bots/a/b/browser/live")).toBe(false);
  });
});
