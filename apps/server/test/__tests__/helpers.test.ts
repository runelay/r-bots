import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEvent } from "@runelay-bots/protocol";
import { probe, runTurn } from "@runelay-bots/providers";
import { runelayApi, runelayCall } from "../../src/modules/connectors/services/runelay.service";
import {
  fakeProcesses,
  fakeProviders,
  fakeRunelay,
  readData,
  replyWith,
  request,
  resetData,
  startTestServer,
  type TestServer,
  testDataDir,
  writeData,
} from "../helpers";

describe("network guard", () => {
  test("external hosts are blocked and loopback is allowed", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow("external network is blocked in tests");
    await expect(fetch(new Request("http://10.0.0.1/"))).rejects.toThrow("(10.0.0.1)");
    expect((await fetch(`${fakeRunelay.url}/v1/x`)).status).toBe(401);
  });
});

describe("fake runelay", () => {
  test("serves MCP tools to the real client", async () => {
    fakeRunelay.tool("echo", (args) => ({ got: args }));
    fakeRunelay.tool("text", () => "plain");
    fakeRunelay.tool("fail", () => {
      throw new Error("tool broke");
    });
    expect(await runelayCall("echo", { a: 1 })).toEqual({ got: { a: 1 } });
    expect(await runelayCall("text", {})).toBe("plain");
    await expect(runelayCall("fail", {})).rejects.toThrow("tool broke");
    await expect(runelayCall("missing", {})).rejects.toThrow("unknown tool missing");
    expect(fakeRunelay.toolCalls.map((call) => call.name)).toEqual(["echo", "text", "fail", "missing"]);
  });

  test("serves REST routes and records calls", async () => {
    fakeRunelay.route("POST", "/sources/x/reconnect", (call) => ({ data: { echoed: call.body } }));
    fakeRunelay.route("GET", "/catalog", { status: 200, body: { data: { sections: [] } } });
    fakeRunelay.route("DELETE", "/sources/y", { status: 409, body: { error: { message: "busy" } } });
    expect(await runelayApi("POST", "/sources/x/reconnect", { a: 1 })).toEqual({ echoed: { a: 1 } });
    expect(await runelayApi("GET", "/catalog")).toEqual({ sections: [] });
    await expect(runelayApi("DELETE", "/sources/y")).rejects.toThrow("busy");
    await expect(runelayApi("GET", "/nope")).rejects.toThrow("no fake route GET /nope");
    expect(fakeRunelay.apiCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /sources/x/reconnect",
      "GET /catalog",
      "DELETE /sources/y",
      "GET /nope",
    ]);
  });
});

describe("fake providers", () => {
  test("probe and runTurn are replaced by the fakes", async () => {
    expect(await probe("codex")).toMatchObject({ provider: "codex", status: "ready" });
    fakeProviders.probes.grok = { provider: "grok", status: "logged_out", detail: "x", models: [] };
    expect((await probe("grok")).status).toBe("logged_out");
    fakeProviders.next(replyWith("hi"));
    const events: ProviderEvent[] = [];
    await runTurn(
      {
        turnId: "t1",
        provider: "claude",
        model: "m",
        effort: null,
        systemPrompt: "",
        prompt: "p",
        resume: null,
        mcp: null,
        workKey: "k",
      },
      testDataDir(),
      new AbortController().signal,
      (event) => events.push(event),
    );
    expect(fakeProviders.turns).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["session", "text", "usage", "done"]);
    expect(events[1]).toEqual({ type: "text", part: "t1:0", text: "hi" });
  });
});

describe("fake processes", () => {
  test("execFile callbacks receive stdout, stderr and exit errors", async () => {
    const fake = fakeProcesses((call) =>
      call.command === "git" ? { stdout: `git ${call.args.join(" ")}`, stderr: "w" } : { code: 2, stderr: "bad" },
    );
    const ok = await new Promise<[unknown, string, string]>((resolve) =>
      childProcess.execFile("git", ["status"], { cwd: "/" }, (error, stdout, stderr) =>
        resolve([error, String(stdout), String(stderr)]),
      ),
    );
    expect(ok).toEqual([null, "git status", "w"]);
    const failed = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      childProcess.execFile("gh", (error) => resolve(error)),
    );
    expect(failed?.code).toBe(2);
    expect(fake.calls.map((call) => [call.kind, call.command, call.args])).toEqual([
      ["execFile", "git", ["status"]],
      ["execFile", "gh", []],
    ]);
  });

  test("spawn children stream output, record stdin and can hang until killed", async () => {
    const fake = fakeProcesses((call) => (call.args[0] === "hang" ? { hang: true } : { stdout: "line\n", code: 3 }));
    const child = childProcess.spawn("tool", ["run"]);
    child.stdin?.end("input");
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(3);
    expect(out).toBe("line\n");
    expect(fake.calls[0].child.written).toBe("input");
    const hanging = childProcess.spawn("tool", ["hang"]);
    const killed = new Promise((resolve) => hanging.on("exit", (_code, signal) => resolve(signal)));
    hanging.kill("SIGKILL");
    expect(await killed).toBe("SIGKILL");
  });

  test("unknown commands fail like a missing binary", async () => {
    fakeProcesses(() => undefined);
    const error = await new Promise<Error>((resolve) => childProcess.spawn("nope").on("error", resolve));
    expect(error.message).toContain("no handler for nope");
  });

  test("Bun.spawn returns a subprocess with web streams and exit promise", async () => {
    const fake = fakeProcesses(() => ({ stdout: "bun out", stderr: "bun err", code: 4 }));
    const proc = Bun.spawn(["claude", "auth", "status"], { stdin: Buffer.from("in"), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect([stdout, stderr, code]).toEqual(["bun out", "bun err", 4]);
    expect(fake.calls[0]).toMatchObject({ kind: "Bun.spawn", command: "claude", args: ["auth", "status"] });
    expect(fake.calls[0].child.written).toBe("in");
  });

  test("Bun.spawn honors an abort signal", async () => {
    fakeProcesses(() => ({ hang: true }));
    const controller = new AbortController();
    const proc = Bun.spawn({ cmd: ["sleepy"], signal: controller.signal });
    controller.abort();
    expect(await proc.exited).toBe(1);
    expect(proc.signalCode).toBe("SIGTERM");
  });
});

describe("data dir helpers", () => {
  test("writeData, readData and resetData work inside the temporary data dir", async () => {
    expect(testDataDir()).not.toContain("runelay-bots/data");
    const path = await writeData("bots/b1.json", { id: "b1" });
    expect(await readData("bots/b1.json")).toEqual({ id: "b1" });
    await resetData();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(testDataDir())).toBe(true);
    expect(join(testDataDir(), "x")).toStartWith(testDataDir());
  });
});

describe("test server", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.close());

  test("routes requests and exposes the port to the app", async () => {
    expect(process.env.GATEWAY_PORT).toBe(String(server.port));
    const health = await request("/health");
    expect(health).toMatchObject({ status: 200, body: { ok: true } });
    const missing = await request<{ ok: boolean }>("/sections/x/y/z", { method: "PATCH", body: { a: 1 } });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });
});
