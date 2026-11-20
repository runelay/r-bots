import { spyOn } from "bun:test";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as sdk from "@anthropic-ai/claude-agent-sdk";

export type FastReply = string | { error: string } | { hold: true };
export type FastResponder = (prompt: string, query: FakeFastQuery) => FastReply;

export class FakeFastQuery {
  readonly prompts: string[] = [];
  interrupts = 0;
  closed = false;
  failInterrupt = false;
  failClose = false;
  private queue: unknown[] = [];
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;
  private ended = false;

  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
    private responder: () => FastResponder,
  ) {
    void this.consume(prompt);
  }

  private async consume(prompt: AsyncIterable<SDKUserMessage>) {
    await Promise.resolve();
    for await (const message of prompt) {
      const text = String(message.message.content);
      this.prompts.push(text);
      this.answer(this.responder()(text, this));
    }
  }

  answer(reply: FastReply) {
    if (typeof reply === "string") {
      const middle = Math.ceil(reply.length / 2);
      for (const part of [reply.slice(0, middle), reply.slice(middle)]) if (part) this.delta(part);
      this.result();
    } else if ("error" in reply) this.result(true, reply.error);
  }

  delta(text: string) {
    this.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  }

  result(isError = false, result?: string) {
    this.push({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: isError, result });
  }

  push(message: unknown) {
    this.queue.push(message);
    this.wake();
  }

  fail(error: Error) {
    this.failure = error;
    this.wake();
  }

  close() {
    this.closed = true;
    this.ended = true;
    this.wake();
    if (this.failClose) throw new Error("already closed");
  }

  interrupt() {
    this.interrupts++;
    this.result(true);
    return this.failInterrupt ? Promise.reject(new Error("not running")) : Promise.resolve();
  }

  private wake() {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

const defaultResponder: FastResponder = (prompt) => (prompt.startsWith("CLASSIFIQUE") ? "OUTRO" : "Beleza, entendi.");

export function fakeFastLayer() {
  const state = {
    queries: [] as FakeFastQuery[],
    responder: defaultResponder,
    last() {
      const query = state.queries.at(-1);
      if (!query) throw new Error("no fast query opened");
      return query;
    },
    prompts() {
      return state.queries.flatMap((query) => query.prompts);
    },
    reset() {
      state.queries.length = 0;
      state.responder = defaultResponder;
    },
    restore() {
      spy.mockRestore();
    },
  };
  const spy = spyOn(sdk, "query").mockImplementation((({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => {
    const query = new FakeFastQuery(options, prompt, () => state.responder);
    state.queries.push(query);
    return query as unknown as Query;
  }) as unknown as typeof sdk.query);
  return state;
}

export function fakeElevenLabs() {
  const calls: Array<{ method: string; path: string; key: string | null }> = [];
  const replies = new Map<string, (url: URL) => Response | Promise<Response>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        key: request.headers.get("xi-api-key"),
      });
      const handler = replies.get(`${request.method} ${url.pathname}`);
      return handler ? handler(url) : Response.json({ detail: "not found" }, { status: 404 });
    },
  });
  return {
    calls,
    url: `http://127.0.0.1:${server.port}`,
    on(method: string, path: string, handler: (url: URL) => Response | Promise<Response>) {
      replies.set(`${method} ${path}`, handler);
    },
    reset() {
      calls.length = 0;
      replies.clear();
    },
    stop() {
      return server.stop(true);
    },
  };
}

export async function until(check: () => boolean, label = "condition") {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}
