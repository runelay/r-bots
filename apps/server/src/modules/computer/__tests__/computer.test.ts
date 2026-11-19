import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { connectFakeRunner } from "../../../../test/media-helpers";
import type { Socket } from "../../../shared/ws";
import * as macRunner from "../../accounts/services/mac-runner.service";
import {
  type ComputerContext,
  ComputerError,
  callComputer,
  computerHealth,
  computerHumanReason,
  defaultRoots,
  watchComputerEvents,
} from "../services/computer.service";

const macUrl = process.env.MAC_RUNNER_URL ?? "";
const realFetch = globalThis.fetch;
const restores: Array<() => void> = [];
let server: TestServer;

const context: ComputerContext = { botId: "b1", botName: "Bia", sessionId: "s1", allowedRoots: defaultRoots };

type MacCall = { path: string; init?: RequestInit };

function stubMac(handler: (call: MacCall) => Response | Promise<Response>) {
  const calls: MacCall[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith(macUrl)) return realFetch(input, init);
    const call = { path: target.slice(macUrl.length), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch);
  restores.push(() => spy.mockRestore());
  return calls;
}

function runner(reply: Parameters<typeof connectFakeRunner>[1]) {
  const fake = connectFakeRunner([], reply);
  restores.push(fake.close);
  return fake;
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as ComputerError;
  }
  throw new Error("expected a rejection");
}

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

afterAll(async () => {
  await server.close();
});

describe("computerHealth", () => {
  test("asks the connected app", async () => {
    runner(() => ({ body: { ok: true, screen: "unlocked" } }));
    expect(await computerHealth()).toEqual({ ok: true, screen: "unlocked" });
  });

  test("reports the connected app failing", async () => {
    const connected = spyOn(macRunner, "macRunnerConnected").mockReturnValue(true);
    restores.push(() => connected.mockRestore());
    const failing = spyOn(macRunner, "macComputerHealth").mockRejectedValue(new Error("travou"));
    restores.push(() => failing.mockRestore());
    expect(await computerHealth()).toEqual({
      ok: false,
      code: "COMPUTER_UNAVAILABLE",
      error: "O app runelay bots não respondeu: travou",
    });
    failing.mockRejectedValue("texto");
    expect((await computerHealth()).error).toBe("O app runelay bots não respondeu: texto");
  });

  test("falls back to the HTTP runner", async () => {
    const calls = stubMac(() => Response.json({ ok: true, via: "http" }));
    expect(await computerHealth()).toEqual({ ok: true, via: "http" });
    expect(calls[0].path).toBe("/computer/health");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(`Bearer ${process.env.RUNNER_TOKEN}`);
  });

  test("reports the HTTP runner down", async () => {
    stubMac(() => {
      throw new TypeError("refused");
    });
    expect(await computerHealth()).toEqual({
      ok: false,
      code: "COMPUTER_UNAVAILABLE",
      error: "Runner do Mac fora do ar: refused",
    });
    for (const restore of restores.splice(0)) restore();
    stubMac(() => Promise.reject("plain"));
    expect((await computerHealth()).error).toBe("Runner do Mac fora do ar: plain");
  });

  test("GET /computer/health answers with the health", async () => {
    stubMac(() => Response.json({ ok: true, via: "route" }));
    const response = await request("/computer/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, via: "route" });
  });
});

describe("callComputer over the app socket", () => {
  test("returns the result and sends the context", async () => {
    const fake = runner(() => ({ status: 200, body: { ok: true, result: { clicked: true } } }));
    expect(await callComputer("computer_click", { x: 1 }, context)).toEqual({ clicked: true });
    expect(fake.requests.find((item) => item.op === "computer.tool")?.body).toEqual({ args: { x: 1 }, context });
  });

  test("maps failures to computer errors", async () => {
    let reply: Record<string, unknown> = { status: 400, body: { ok: false, code: "BAD", error: "ruim" } };
    runner(() => reply);
    let error = await caught(callComputer("t", {}, context));
    expect(error).toBeInstanceOf(ComputerError);
    expect([error.code, error.message]).toEqual(["BAD", "ruim"]);
    reply = { status: 503, body: {} };
    error = await caught(callComputer("t", {}, context));
    expect([error.code, error.message]).toEqual(["COMPUTER_UNAVAILABLE", "O computador respondeu 503."]);
    reply = { status: 200, body: { ok: false } };
    error = await caught(callComputer("t", {}, context));
    expect([error.code, error.message]).toEqual(["COMPUTER_ERROR", "O computador respondeu 200."]);
  });

  test("maps an unavailable app and rethrows other errors", async () => {
    const connected = spyOn(macRunner, "macRunnerConnected").mockReturnValue(true);
    restores.push(() => connected.mockRestore());
    const call = spyOn(macRunner, "macComputerCall").mockRejectedValue(new macRunner.MacRunnerUnavailable("saiu"));
    restores.push(() => call.mockRestore());
    const error = await caught(callComputer("t", {}, context));
    expect([error.code, error.message]).toEqual(["COMPUTER_UNAVAILABLE", "saiu"]);
    call.mockRejectedValue(new Error("outro"));
    await expect(callComputer("t", {}, context)).rejects.toThrow("outro");
  });
});

describe("callComputer over HTTP", () => {
  test("posts the call and returns the result", async () => {
    const calls = stubMac(() => Response.json({ ok: true, result: 42 }));
    expect(await callComputer("files list", { path: "~" }, context, new AbortController().signal)).toBe(42);
    expect(calls[0].path).toBe("/computer/files%20list");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ args: { path: "~" }, context });
    expect(await callComputer("files", {}, context)).toBe(42);
  });

  test("maps network, body and status failures", async () => {
    let reply: () => Response | Promise<Response> = () => {
      throw new TypeError("refused");
    };
    stubMac(() => reply());
    let error = await caught(callComputer("t", {}, context));
    expect([error.code, error.message]).toEqual(["COMPUTER_UNAVAILABLE", "O Mac não respondeu: refused"]);
    reply = () => Promise.reject("plain");
    error = await caught(callComputer("t", {}, context));
    expect(error.message).toBe("O Mac não respondeu: plain");
    reply = () => new Response("not json", { status: 503 });
    error = await caught(callComputer("t", {}, context));
    expect([error.code, error.message]).toEqual(["COMPUTER_UNAVAILABLE", "O computador respondeu 503."]);
    reply = () => Response.json({ ok: false, code: "DENIED", error: "negado" }, { status: 403 });
    error = await caught(callComputer("t", {}, context));
    expect([error.code, error.message]).toEqual(["DENIED", "negado"]);
    reply = () => Response.json({ ok: false });
    error = await caught(callComputer("t", {}, context));
    expect([error.code, error.message]).toEqual(["COMPUTER_ERROR", "O computador respondeu 200."]);
  });
});

describe("watchComputerEvents", () => {
  test("listens on the app socket when it is connected", () => {
    const fake = runner(() => ({}));
    const events: unknown[] = [];
    const stop = watchComputerEvents((event) => events.push(event));
    const socket = { readyState: 1 } as unknown as Socket;
    const say = (event: unknown) =>
      macRunner.runnerSocket.message(socket, JSON.stringify({ type: "computer.event", event }));
    say({ type: "stop", botId: "b1" });
    say({ type: "user_took_over" });
    say({ type: "heartbeat" });
    stop();
    say({ type: "stop" });
    fake.close();
    expect(events).toEqual([{ type: "stop", botId: "b1" }, { type: "user_took_over" }]);
  });

  test("streams events over HTTP and stops on demand", async () => {
    let signal: AbortSignal | undefined;
    let push!: (text: string) => void;
    stubMac(({ init }) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
            signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
      );
    });
    const events: unknown[] = [];
    let seen!: () => void;
    const second = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const stop = watchComputerEvents((event) => {
      events.push(event);
      if (events.length === 2) seen();
    });
    for (let attempt = 0; !push && attempt < 1000; attempt++) await new Promise((resolve) => setImmediate(resolve));
    push('{"type":"stop","botId":"b1"}\n\nnot json\n{"type":"ping"}\n{"type":"user_');
    push('took_over"}\n');
    await second;
    stop();
    expect(signal?.aborted).toBe(true);
    expect(events).toEqual([{ type: "stop", botId: "b1" }, { type: "user_took_over" }]);
  });

  test("gives up quietly on a refused or bodiless HTTP stream", async () => {
    let calls = 0;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    stubMac(() => {
      calls++;
      queueMicrotask(done);
      return new Response("no", { status: 401 });
    });
    const stop = watchComputerEvents(() => undefined);
    await finished;
    stop();
    expect(calls).toBe(1);
  });
});

describe("computerHumanReason", () => {
  test("sends risky computer actions to a person", () => {
    expect(computerHumanReason("computer_applescript", { script: 'tell application "Mail" to send' })).toContain(
      "AppleScript",
    );
    expect(computerHumanReason("computer_applescript", { script: "get name" })).toBeNull();
    expect(computerHumanReason("computer_applescript", {})).toBeNull();
    expect(computerHumanReason("files_trash", { paths: Array.from({ length: 11 }, (_, i) => `f${i}`) })).toContain(
      "10 itens",
    );
    expect(computerHumanReason("files_trash", { paths: ["a"] })).toBeNull();
    expect(computerHumanReason("shell_run", { cmd: "curl x" })).toContain("fora da lista");
    expect(computerHumanReason("shell_run", {})).toContain("fora da lista");
    expect(computerHumanReason("shell_run", { cmd: "ls; rm -rf /" })).toContain("perigoso");
    expect(computerHumanReason("shell_run", { cmd: "ls -la" })).toBeNull();
    expect(computerHumanReason("computer_type", { text: "4111 1111 1111 1111" })).toContain("cartão");
    expect(computerHumanReason("computer_key", { text: "123.456.789-09" })).toContain("documento");
    expect(computerHumanReason("computer_type", { text: "oi" })).toBeNull();
    expect(computerHumanReason("computer_open", { url: "https://loja.com/checkout" })).toContain("pagamento");
    expect(computerHumanReason("computer_open", {})).toBeNull();
    expect(computerHumanReason("computer_open", { url: "https://docs.com" })).toBeNull();
  });
});
