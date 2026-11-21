import { randomUUID } from "node:crypto";
import type { NativeToolGate, NativeToolHooks, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { hookTimeoutMessage, mcpForwardedHeaders } from "./constants";
import { isToolGate, isTurnRequest } from "./guards";
import { line, parseRecord, readLines, stringMap, stringOf } from "./json";
import type { AgentOutbound, AgentStart, Clock, JsonRecord, RunTurnFn } from "./types";

export interface BoxAgentOptions {
  input: ReadableStream<Uint8Array>;
  write: (text: string) => void;
  runTurn: RunTurnFn;
  dataDir: string;
  hookTimeoutMs: number;
  clock: Clock;
}

const invalidGate: NativeToolGate = { allow: false, message: "O servidor respondeu ao hook sem decisão." };

export function proxiedMcp(request: TurnRequest, port: number): TurnRequest {
  const { mcp } = request;
  if (!mcp) return request;
  const path = mcp.url.startsWith("/") ? mcp.url : (({ pathname, search }) => pathname + search)(new URL(mcp.url));
  return { ...request, mcp: { ...mcp, url: `http://127.0.0.1:${port}${path}` } };
}

export async function runBoxAgent({ input, write, runTurn, dataDir, hookTimeoutMs, clock }: BoxAgentOptions) {
  const controller = new AbortController();
  const waiting = new Map<string, (reply: JsonRecord | null) => void>();
  const out = (message: AgentOutbound) => write(line(message));
  const { promise: started, resolve: onStart } = Promise.withResolvers<AgentStart | null>();

  const ask = (id: string, timeoutMs: number | null) =>
    new Promise<JsonRecord | null>((resolve) => {
      const timer = timeoutMs === null ? null : clock.after(timeoutMs, () => settle(null));
      const settle = (reply: JsonRecord | null) => {
        timer?.cancel();
        waiting.delete(id);
        controller.signal.removeEventListener("abort", abandon);
        resolve(reply);
      };
      const abandon = () => settle(null);
      waiting.set(id, settle);
      controller.signal.addEventListener("abort", abandon, { once: true });
    });

  void (async () => {
    for await (const raw of readLines(input)) {
      const message = parseRecord(raw);
      if (!message) continue;
      const { type } = message;
      if (type === "start" && isTurnRequest(message.request))
        onStart({ type: "start", request: message.request, hooks: message.hooks === true });
      if (type === "cancel") controller.abort();
      if (type === "hook.response" || type === "mcp.response") waiting.get(stringOf(message.id))?.(message);
    }
    onStart(null);
    controller.abort();
  })();

  const proxy = async (req: Request) => {
    const id = randomUUID();
    const headers = Object.fromEntries(
      mcpForwardedHeaders.flatMap((name) => {
        const value = req.headers.get(name);
        return value === null ? [] : [[name, value]];
      }),
    );
    const { pathname, search } = new URL(req.url);
    const reply = ask(id, null);
    out({ type: "mcp.request", id, method: req.method, path: pathname + search, headers, body: await req.text() });
    const answer = await reply;
    if (!answer) return Response.json({ ok: false, error: "O runner não respondeu ao MCP." }, { status: 502 });
    const status = typeof answer.status === "number" ? answer.status : 502;
    return new Response(stringOf(answer.body), { status, headers: stringMap(answer.headers) });
  };

  const hooks: NativeToolHooks = {
    async before(tool, input, toolUseId) {
      const id = randomUUID();
      const reply = ask(id, hookTimeoutMs);
      out({ type: "hook.request", id, phase: "before", tool, input, toolUseId });
      const answer = await reply;
      if (!answer) return { allow: false, message: hookTimeoutMessage };
      return isToolGate(answer.gate) ? answer.gate : invalidGate;
    },
    async after(tool, input, response, toolUseId, failed) {
      const id = randomUUID();
      const reply = ask(id, hookTimeoutMs);
      out({ type: "hook.request", id, phase: "after", tool, input, toolUseId, response, failed });
      await reply;
    },
  };

  const start = await started;
  if (!start) return 1;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: proxy });
  let ok = false;
  try {
    const emit = (event: ProviderEvent) => {
      if (event.type === "done") ok = event.ok;
      out({ type: "event", event });
    };
    await runTurn(
      proxiedMcp(start.request, server.port ?? 0),
      dataDir,
      controller.signal,
      emit,
      start.hooks ? hooks : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ok = false;
    out({ type: "event", event: { type: "done", ok, message } });
  } finally {
    server.stop(true);
  }
  out({ type: "end", ok });
  return ok ? 0 : 1;
}
