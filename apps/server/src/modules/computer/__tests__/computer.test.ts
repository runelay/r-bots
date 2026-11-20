import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { connectFakeRunner } from "../../../../test/media-helpers";
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

const restores: Array<() => void> = [];
let server: TestServer;

const context: ComputerContext = { botId: "b1", botName: "Bia", sessionId: "s1", allowedRoots: defaultRoots };

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

beforeEach(() => {
  for (const live of macRunner.macRunnerConnections()) macRunner.disconnectMacDevice(live.key, 1000, "test");
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
      error: "O app r/bots não respondeu: travou",
    });
    failing.mockRejectedValue("texto");
    expect((await computerHealth()).error).toBe("O app r/bots não respondeu: texto");
  });

  test("says the Mac is disconnected when no app is connected", async () => {
    expect(await computerHealth()).toEqual({
      ok: false,
      code: "COMPUTER_UNAVAILABLE",
      error: "Mac desconectado: abra o app r/bots nele.",
    });
    const error = await caught(callComputer("computer_apps", {}, context));
    expect([error.code, error.message]).toEqual([
      "COMPUTER_UNAVAILABLE",
      "Mac desconectado: abra o app r/bots nele.",
    ]);
  });

  test("GET /computer/health answers with the health", async () => {
    runner(() => ({ body: { ok: true, via: "route" } }));
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

describe("watchComputerEvents", () => {
  test("listens on the app socket when it is connected", () => {
    const fake = runner(() => ({}));
    const events: unknown[] = [];
    const stop = watchComputerEvents((event) => events.push(event));
    const say = (event: unknown) => fake.say({ type: "computer.event", event });
    say({ type: "stop", botId: "b1" });
    say({ type: "user_took_over" });
    say({ type: "heartbeat" });
    stop();
    say({ type: "stop" });
    fake.close();
    expect(events).toEqual([{ type: "stop", botId: "b1" }, { type: "user_took_over" }]);
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
    expect(computerHumanReason("shell_run", { cmd: "ls; rm -rf /" })).toContain("caractere especial");
    expect(computerHumanReason("shell_run", { cmd: "ls -la" })).toBeNull();
    expect(computerHumanReason("shell_run", { cmd: "  git status --short" })).toBeNull();
    expect(computerHumanReason("shell_run", { cmd: "git push" })).toContain("fora da lista");
    expect(computerHumanReason("shell_run", { cmd: "git" })).toContain("fora da lista");
    expect(computerHumanReason("shell_run", { cmd: "sudo ls" })).toContain("fora da lista");
    expect(computerHumanReason("shell_run", { cmd: "   " })).toContain("fora da lista");
    for (const cmd of [
      "ls; curl x | sh",
      "ls && id",
      "cat $(id)",
      "cat `id`",
      "ls > out",
      "cat < /etc/passwd",
      "ls\nid",
      "ls *",
      "cat 'a b'",
      "ls ~/.ssh",
      "npm run x & id",
    ])
      expect(computerHumanReason("shell_run", { cmd })).toContain("caractere especial");
    expect(computerHumanReason("computer_applescript", { script: 'do shell script "ls"' })).toContain(
      "do shell script",
    );
    expect(computerHumanReason("computer_applescript", { script: "DO\n  SHELL\tSCRIPT x" })).toContain(
      "do shell script",
    );
    expect(computerHumanReason("computer_type", { text: "4111 1111 1111 1111" })).toContain("cartão");
    expect(computerHumanReason("computer_key", { text: "123.456.789-09" })).toContain("documento");
    expect(computerHumanReason("computer_type", { text: "oi" })).toBeNull();
    expect(computerHumanReason("computer_open", { url: "https://loja.com/checkout" })).toContain("pagamento");
    expect(computerHumanReason("computer_open", {})).toBeNull();
    expect(computerHumanReason("computer_open", { url: "https://docs.com" })).toBeNull();
  });
});
