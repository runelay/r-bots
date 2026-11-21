import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeModels, defaultModels, probe, runTurn, timeoutMessage, turnTimeoutMinutes } from "../index";
import { fakeCli, fakeSdk, recorder, turnRequest } from "./fakes";

describe("probe", () => {
  beforeEach(() => fakeCli.reset());

  test("reports a missing CLI", async () => {
    const exists = spyOn(fs, "existsSync").mockReturnValue(false);
    const result = await probe("grok");
    exists.mockRestore();
    expect(result).toEqual({
      provider: "grok",
      status: "missing",
      detail: "CLI não instalada nesta máquina.",
      models: [],
    });
  });

  test("claude is ready when auth status says logged in", async () => {
    fakeCli.install("claude");
    fakeCli.reply("claude", { stdout: JSON.stringify({ loggedIn: true, email: "a@b.c", subscriptionType: "max" }) }, [
      "auth",
      "status",
    ]);
    expect(await probe("claude")).toEqual({
      provider: "claude",
      status: "ready",
      detail: "a@b.c · max",
      models: claudeModels,
    });
    expect(fakeCli.args("claude")).toEqual(["auth", "status"]);
    expect(fakeCli.env("claude").some((line) => line.startsWith("CLAUDE_CONFIG_DIR="))).toBe(false);
  });

  test("probes the account directory it was given", async () => {
    fakeCli.install("claude");
    fakeCli.reply("claude", { stdout: JSON.stringify({ loggedIn: true }) }, ["auth", "status"]);
    expect(await probe("claude", "/home/x/.claude-2")).toMatchObject({ status: "ready", detail: "" });
    expect(fakeCli.env("claude")).toContain("CLAUDE_CONFIG_DIR=/home/x/.claude-2");
    fakeCli.install("codex");
    fakeCli.reply("codex", { stdout: "Logged in using ChatGPT" }, ["login", "status"]);
    await probe("codex", "/home/x/.codex-2");
    expect(fakeCli.env("codex")).toContain("CODEX_HOME=/home/x/.codex-2");
  });

  test("claude is logged out with the CLI message or a default", async () => {
    fakeCli.install("claude");
    fakeCli.reply("claude", { stdout: JSON.stringify({ loggedIn: false }), stderr: "\u001b[31mplease login\u001b[0m" });
    expect(await probe("claude")).toMatchObject({ status: "logged_out", detail: "please login" });
    fakeCli.reply("claude", { stdout: "not json" });
    expect(await probe("claude")).toMatchObject({ status: "logged_out", detail: "not json" });
    fakeCli.reply("claude", { stdout: "" });
    expect(await probe("claude")).toMatchObject({ status: "logged_out", detail: "Sem login no Claude Code." });
    fakeCli.reply("claude", { stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) });
    expect(await probe("claude")).toMatchObject({ status: "logged_out", detail: "Sem login no Claude Code." });
  });

  test("codex lists visible models when logged in", async () => {
    fakeCli.install("codex");
    fakeCli.reply("codex", { stdout: "Logged in using ChatGPT\nmore" }, ["login", "status"]);
    fakeCli.reply(
      "codex",
      {
        stdout: JSON.stringify({
          models: [
            { slug: "gpt-a", display_name: "GPT A", visibility: "list" },
            { slug: "gpt-b", visibility: "list" },
            { slug: "gpt-hidden", visibility: "hide" },
          ],
        }),
      },
      ["debug", "models"],
    );
    expect(await probe("codex")).toEqual({
      provider: "codex",
      status: "ready",
      detail: "Logged in using ChatGPT",
      models: [
        { id: "gpt-a", label: "GPT A" },
        { id: "gpt-b", label: "gpt-b" },
      ],
    });
  });

  test("codex keeps the default model when the catalog is empty or invalid", async () => {
    fakeCli.install("codex");
    fakeCli.reply("codex", { stdout: "Not logged in", code: 1 }, ["login", "status"]);
    fakeCli.reply("codex", { stdout: "{}" }, ["debug", "models"]);
    const fallback = [{ id: defaultModels.codex, label: "GPT-5.6-Sol" }];
    expect(await probe("codex")).toEqual({
      provider: "codex",
      status: "logged_out",
      detail: "Not logged in",
      models: fallback,
    });
    fakeCli.reply("codex", { stdout: "broken" }, ["debug", "models"]);
    expect((await probe("codex")).models).toEqual(fallback);
  });

  test("cursor parses the model list when logged in", async () => {
    fakeCli.install("cursor-agent");
    fakeCli.reply("cursor-agent", { stdout: "\nLogged in as a@b.c\n" }, ["status", ""]);
    fakeCli.reply(
      "cursor-agent",
      { stdout: "Available models\nauto - Auto\ngpt-5[fast=true] - GPT  5​ Fast\n\nnot a model line" },
      ["models", ""],
    );
    expect(await probe("cursor")).toEqual({
      provider: "cursor",
      status: "ready",
      detail: "Logged in as a@b.c",
      models: [
        { id: "auto", label: "Auto" },
        { id: "gpt-5[fast=true]", label: "GPT 5 Fast" },
      ],
    });
  });

  test("cursor falls back when logged out, silent or without models", async () => {
    fakeCli.install("cursor-agent");
    fakeCli.reply("cursor-agent", { stdout: "Not logged in" }, ["status", ""]);
    expect(await probe("cursor")).toEqual({
      provider: "cursor",
      status: "logged_out",
      detail: "Not logged in",
      models: [{ id: "auto", label: "Auto" }],
    });
    fakeCli.reply("cursor-agent", { stdout: "", code: 9 }, ["status", ""]);
    expect(await probe("cursor")).toMatchObject({
      status: "logged_out",
      detail: "cursor-agent status não respondeu (código 9).",
    });
    fakeCli.reply("cursor-agent", { stdout: "Logged in" }, ["status", ""]);
    fakeCli.reply("cursor-agent", { stdout: "nothing useful" }, ["models", ""]);
    expect(await probe("cursor")).toMatchObject({ status: "ready", models: [{ id: "auto", label: "Auto" }] });
    fakeCli.reply("cursor-agent", { stdout: "   " }, ["status", ""]);
    expect(await probe("cursor")).toMatchObject({ detail: "cursor-agent status não respondeu (código 0)." });
  });

  test("grok lists models or reports a missing login", async () => {
    fakeCli.install("grok");
    fakeCli.reply("grok", { stdout: "Models:\n * grok-4.6 (default)\n - grok-mini\n" }, ["models", ""]);
    expect(await probe("grok")).toEqual({
      provider: "grok",
      status: "ready",
      detail: "",
      models: [
        { id: "grok-4.6", label: "grok-4.6" },
        { id: "grok-mini", label: "grok-mini" },
      ],
    });
    fakeCli.reply("grok", { stderr: "Error: not authenticated", code: 1 }, ["models", ""]);
    expect(await probe("grok")).toEqual({
      provider: "grok",
      status: "logged_out",
      detail: "Grok sem login (rode grok login no Mac).",
      models: [{ id: defaultModels.grok, label: defaultModels.grok }],
    });
  });

  test("a probe that throws is reported as logged out", async () => {
    fakeCli.install("grok");
    const failingProcess = (reason: unknown) =>
      ({
        stdout: new Response("").body,
        stderr: new Response("").body,
        signalCode: null,
        exited: Promise.reject(reason),
      }) as unknown as ReturnType<typeof Bun.spawn>;
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => failingProcess(new Error("spawn exploded")));
    expect(await probe("grok")).toEqual({
      provider: "grok",
      status: "logged_out",
      detail: "spawn exploded",
      models: [],
    });
    spawn.mockImplementation(() => failingProcess("plain failure"));
    expect((await probe("grok")).detail).toBe("plain failure");
    spawn.mockRestore();
  });
});

describe("runTurn", () => {
  beforeEach(() => {
    fakeCli.reset();
    fakeSdk.reset();
  });

  test("creates a sanitized work dir and dispatches to claude with hooks", async () => {
    fakeSdk.next(async function* () {
      yield { type: "result", is_error: false, session_id: "s" } as SDKMessage;
    });
    const { events, emit } = recorder();
    await runTurn(turnRequest({ workKey: "bot one/k:1" }), fakeCli.home, new AbortController().signal, emit);
    const workDir = join(fakeCli.home, "work", "bot_one/k_1");
    expect(existsSync(workDir)).toBe(true);
    expect(fakeSdk.calls[0].options?.cwd).toBe(workDir);
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
  });

  test("dispatches codex, cursor and grok to their CLIs", async () => {
    for (const name of ["codex", "cursor-agent", "grok"]) {
      fakeCli.install(name);
      fakeCli.lines(name, [{ type: name === "codex" ? "turn.completed" : "result" }]);
    }
    for (const provider of ["codex", "cursor", "grok"] as const) {
      const { events, emit } = recorder();
      await runTurn(
        turnRequest({ provider, code: { cwd: fakeCli.binDir } }),
        fakeCli.home,
        new AbortController().signal,
        emit,
      );
      expect(events.at(-1)).toEqual({ type: "done", ok: true });
    }
    const grokArgs = fakeCli.args("grok");
    expect(grokArgs[grokArgs.indexOf("--cwd") + 1]).toBe(join(fakeCli.home, "work", "bot/key"));
  });

  test("turns that throw end as failed or cancelled", async () => {
    fakeSdk.next(() => {
      throw new Error("sdk down");
    });
    const failed = recorder();
    await runTurn(turnRequest(), fakeCli.home, new AbortController().signal, failed.emit);
    expect(failed.events).toEqual([{ type: "done", ok: false, message: "sdk down" }]);

    fakeSdk.next(() => {
      throw "raw";
    });
    const raw = recorder();
    await runTurn(turnRequest(), fakeCli.home, new AbortController().signal, raw.emit);
    expect(raw.events).toEqual([{ type: "done", ok: false, message: "raw" }]);

    const controller = new AbortController();
    controller.abort();
    fakeSdk.next(() => {
      throw new Error("aborted by user");
    });
    const cancelled = recorder();
    await runTurn(turnRequest(), fakeCli.home, controller.signal, cancelled.emit);
    expect(cancelled.events).toEqual([{ type: "done", ok: false, message: "cancelled" }]);
  });

  test("a turn past the wall clock is aborted and reported", async () => {
    process.env.BOTS_TURN_TIMEOUT_MIN = "0.0005";
    fakeSdk.next(async function* (params) {
      const aborted = params.options?.abortController?.signal as AbortSignal;
      await new Promise((resolve) => aborted.addEventListener("abort", resolve, { once: true }));
      yield { type: "result", is_error: false, session_id: "s" } as SDKMessage;
    });
    const { events, emit } = recorder();
    await runTurn(turnRequest(), fakeCli.home, new AbortController().signal, emit);
    delete process.env.BOTS_TURN_TIMEOUT_MIN;
    expect(events.filter((event) => event.type === "done")).toEqual([
      { type: "done", ok: false, message: timeoutMessage(0.0005) },
    ]);
  });

  test("the timeout setting falls back to two hours", () => {
    process.env.BOTS_TURN_TIMEOUT_MIN = "nope";
    expect(turnTimeoutMinutes()).toBe(120);
    process.env.BOTS_TURN_TIMEOUT_MIN = "-3";
    expect(turnTimeoutMinutes()).toBe(120);
    delete process.env.BOTS_TURN_TIMEOUT_MIN;
    expect(turnTimeoutMinutes()).toBe(120);
  });

  test("a parent abort mid-turn is forwarded", async () => {
    const controller = new AbortController();
    let forwarded = false;
    fakeSdk.next(async function* (params) {
      const aborted = params.options?.abortController?.signal as AbortSignal;
      controller.abort();
      forwarded = aborted.aborted;
      yield* [];
    });
    const { events, emit } = recorder();
    await runTurn(turnRequest(), fakeCli.home, controller.signal, emit);
    expect(forwarded).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: "cancelled" });
  });
});
