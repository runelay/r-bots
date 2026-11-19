import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { Socket } from "../src/shared/ws";
import { fakeProcesses, type ProcessCall, type ProcessReply } from "./fake-process";

export const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

export interface BrowserPage {
  url: string;
  title: string;
  sessions: string[];
  cdpUrl: string;
  box: Record<string, number>;
  snapshot: string;
  refs: Record<string, { name?: string; role?: string }>;
}

export type BrowserOverride = (command: string[], call: ProcessCall) => ProcessReply | undefined;

function ok(data: Record<string, unknown> = {}): ProcessReply {
  return { stdout: `${JSON.stringify({ success: true, data })}\n` };
}

export function agentCommand(call: ProcessCall) {
  const args = [...call.args];
  if (args[0] === "--session") args.splice(0, 2);
  if (args[0] === "--args") args.splice(0, 2);
  if (args[0] === "--json") args.shift();
  return args;
}

export function fakeAgentBrowser(override: BrowserOverride = () => undefined) {
  const page: BrowserPage = {
    url: "about:blank",
    title: "",
    sessions: [],
    cdpUrl: "",
    box: { x: 10, y: 20, width: 100, height: 30 },
    snapshot: '- button "Enviar" [ref=e1]\n- textbox "Senha" [ref=e2]',
    refs: { e1: { name: "Enviar", role: "button" } },
  };
  const commands: string[][] = [];
  const fake = fakeProcesses((call) => {
    if (call.command === "ffmpeg") {
      const custom = override([call.command, ...call.args], call);
      return custom ?? { stdout: "JPEG" };
    }
    if (call.command !== "agent-browser") return undefined;
    const command = agentCommand(call);
    commands.push(command);
    const custom = override(command, call);
    if (custom) return custom;
    const [head, second] = command;
    if (head === "session") return ok({ sessions: page.sessions });
    if (head === "screenshot") {
      const file = command.at(-1) as string;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, pngBytes);
      return ok({ path: file });
    }
    if (head === "open") {
      page.url = command[1];
      page.title = `Title of ${command[1]}`;
      return ok();
    }
    if (head === "get" && second === "url") return ok({ url: page.url });
    if (head === "get" && second === "title") return ok({ title: page.title });
    if (head === "get" && second === "box") return ok(page.box);
    if (head === "get" && second === "cdp-url") return ok({ cdpUrl: page.cdpUrl });
    if (head === "snapshot") return ok({ snapshot: page.snapshot, refs: page.refs });
    if (head === "batch") return { stdout: `${JSON.stringify([{ success: true }, { success: true }])}\n` };
    return ok();
  });
  return { page, commands, calls: fake.calls, restore: fake.restore };
}

export interface ClientSocket {
  socket: Socket;
  sent: Array<Record<string, unknown>>;
  closed: Array<[number, string]>;
  next(type: string): Promise<Record<string, unknown>>;
  setOpen(open: boolean): void;
}

export function fakeClient(botId: string, kind = "live"): ClientSocket {
  const sent: Array<Record<string, unknown>> = [];
  const closed: Array<[number, string]> = [];
  const waiters: Array<{ type: string; resolve: (message: Record<string, unknown>) => void }> = [];
  const raw = {
    readyState: 1,
    data: { kind, botId },
    send(payload: string) {
      const message = JSON.parse(payload) as Record<string, unknown>;
      sent.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.type !== message.type) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    },
    close(code: number, reason: string) {
      closed.push([code, reason]);
    },
  };
  return {
    socket: raw as unknown as Socket,
    sent,
    closed,
    next(type) {
      const seen = sent.find((message) => message.type === type && !(message as { taken?: boolean }).taken);
      if (seen) {
        Object.defineProperty(seen, "taken", { value: true, enumerable: false });
        return Promise.resolve(seen);
      }
      return new Promise((resolve) =>
        waiters.push({
          type,
          resolve: (message) => {
            Object.defineProperty(message, "taken", { value: true, enumerable: false });
            resolve(message);
          },
        }),
      );
    },
    setOpen(open) {
      raw.readyState = open ? 1 : 3;
    },
  };
}

export type CdpReply = { result?: Record<string, unknown>; error?: { message?: string } } | "silent" | undefined;

export interface CdpCall {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export function fakeCdp(handler: (call: CdpCall) => CdpReply = () => undefined) {
  const calls: CdpCall[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let history = { entries: [{ id: 1, url: "https://a.test/", title: "A" }], currentIndex: 0 };
  const defaults = (call: CdpCall): Record<string, unknown> => {
    if (call.method === "Target.getTargets")
      return {
        targetInfos: [
          { targetId: "w1", type: "worker", url: "", attached: false },
          { targetId: "p1", type: "page", url: "https://a.test/", attached: true },
        ],
      };
    if (call.method === "Target.attachToTarget") return { sessionId: "S1" };
    if (call.method === "Page.getNavigationHistory") return history;
    return {};
  };
  const server: Server<unknown> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: {} })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws, raw) {
        const call = JSON.parse(String(raw)) as CdpCall;
        calls.push(call);
        const reply = handler(call);
        if (reply === "silent") return;
        if (reply?.error) ws.send(JSON.stringify({ id: call.id, error: reply.error }));
        else ws.send(JSON.stringify({ id: call.id, result: reply?.result ?? defaults(call) }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/x`,
    calls,
    setHistory(next: typeof history) {
      history = next;
    },
    emit(message: Record<string, unknown>) {
      for (const ws of sockets) ws.send(JSON.stringify(message));
    },
    raw(text: string) {
      for (const ws of sockets) ws.send(text);
    },
    dropAll() {
      for (const ws of sockets) ws.close();
    },
    get connections() {
      return sockets.size;
    },
    async stop() {
      await server.stop(true);
    },
  };
}

export async function until(check: () => boolean | Promise<boolean>, label = "condition") {
  const deadline = Date.now() + 5000;
  for (let attempt = 0; attempt < 50_000 && Date.now() < deadline; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`${label} never became true`);
}
