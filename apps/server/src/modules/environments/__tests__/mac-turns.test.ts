import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeToolHooks, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { codeProcesses, gitSync, makeRepo } from "../../../../test/code-helpers";
import { waitFor } from "../../../../test/engine-helpers";
import { fakeProviders, resetData } from "../../../../test/helpers";
import { dropAllRunners, fakeRunner, hostHello, runnerDevice } from "../../../../test/runner-helpers";
import { runOnAccount } from "../../accounts/services/accounts.service";
import * as sync from "../../code/services/mac-sync.service";
import { noGithubMessage, resetMacSync } from "../../code/services/mac-sync.service";
import { updatePreferences } from "../../settings/services/preferences.service";
import { macOfflineMessage } from "../constants/environments.constants";
import { runningOnMac } from "../services/host-turns.service";
import { macTurnOf } from "../services/mac-turns.service";

const account = { id: "vps:claude", provider: "claude" as const };
const github = "https://github.com/acme/app.git";

function turnRequest(turnId: string, cwd: string | null): TurnRequest {
  return {
    turnId,
    provider: "claude",
    model: "m",
    effort: null,
    systemPrompt: "",
    prompt: "oi",
    resume: null,
    mcp: { url: "http://127.0.0.1:2000/mcp/bot-r/s1", token: "tk" },
    workKey: "bot-r/s1",
    code: cwd ? { cwd } : null,
  };
}

async function nextRequest(runner: ReturnType<typeof fakeRunner>) {
  await waitFor(() => runner.sent.some(({ type }) => type === "request"));
  return runner.next("request");
}

function macRunner() {
  const runner = fakeRunner(runnerDevice("mac-1:runner", 5, { deviceId: "mac-1" }));
  runner.say(hostHello({ name: "Mac", environment: "mac" }));
  return runner;
}

async function githubRepo(name: string) {
  const repo = await makeRepo(name, { origin: true });
  gitSync(repo.path, ["remote", "set-url", "origin", github]);
  gitSync(repo.path, ["config", `url.${repo.origin}.insteadOf`, github]);
  gitSync(repo.path, ["checkout", "-q", "-b", "feat/x"]);
  return repo;
}

beforeEach(async () => {
  await resetData();
  codeProcesses();
  await updatePreferences({ environment: "mac" });
});

afterEach(async () => {
  dropAllRunners();
  fakeProviders.reset();
  resetMacSync();
  await updatePreferences({ environment: "vps" });
});

describe("turns on this Mac", () => {
  test("never fall back to the VPS when the Mac is offline", async () => {
    const events: ProviderEvent[] = [];
    await runOnAccount(account, turnRequest("o1", null), new AbortController().signal, (e) => events.push(e));
    expect(events).toEqual([{ type: "done", ok: false, message: macOfflineMessage }]);
    expect(fakeProviders.turns).toEqual([]);
  });

  test("run on the Mac runner without the VPS account and with the hooks marked as Mac", async () => {
    const runner = macRunner();
    const seen: boolean[] = [];
    const hooks: NativeToolHooks = {
      before: async () => {
        seen.push(runningOnMac());
        return { allow: true };
      },
      after: async () => {},
    };
    const events: ProviderEvent[] = [];
    const plain = mkdtempSync(join(tmpdir(), "rb-home-"));
    const finished = runOnAccount(
      account,
      { ...turnRequest("m1", plain), configDir: "/home/vps/.claude" },
      new AbortController().signal,
      (e) => events.push(e),
      hooks,
    );
    const start = await nextRequest(runner);
    expect(start).toMatchObject({ op: "turn.start", hooks: true, request: { configDir: null, code: { cwd: plain } } });
    expect(start).not.toHaveProperty("sync");
    runner.say({
      type: "hook.request",
      id: "h1",
      turnId: "m1",
      phase: "before",
      tool: "Bash",
      input: { command: "ls" },
      toolUseId: "u1",
    });
    await runner.next("hook.response");
    runner.say({ type: "turn.event", id: "m1", event: { type: "done", ok: true } });
    runner.say({ type: "turn.end", id: "m1", ok: true });
    await finished;
    expect(seen).toEqual([true]);
    expect(events).toEqual([{ type: "done", ok: true }]);
    expect(fakeProviders.turns).toEqual([]);
    expect(macTurnOf({ ...turnRequest("x", null), configDir: "/c" }).configDir).toBeNull();
  });

  test("send the task worktree through GitHub and apply what the Mac sends back", async () => {
    const runner = macRunner();
    const repo = await githubRepo("mac-turn");
    const finished = runOnAccount(account, turnRequest("s1", repo.path), new AbortController().signal, () => {});
    const start = await nextRequest(runner);
    expect(start.sync).toMatchObject({ repo: "acme/app", branch: "feat/x", cwd: repo.path });
    const snapshot = start.sync as { ref: string; commit: string };
    runner.say({ type: "turn.end", id: "s1", ok: true, sync: { ref: snapshot.ref, commit: snapshot.commit } });
    await finished;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const failed = runOnAccount(account, turnRequest("s2", repo.path), new AbortController().signal, () => {});
    await nextRequest(runner);
    runner.say({ type: "turn.end", id: "s2", ok: false, syncError: "sem rede" });
    await failed;
    const broken = runOnAccount(account, turnRequest("s3", repo.path), new AbortController().signal, () => {});
    await nextRequest(runner);
    runner.say({ type: "turn.end", id: "s3", ok: true, sync: { ref: snapshot.ref, commit: "f".repeat(40) } });
    await broken;
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining("mac sync s2: sem rede"),
      expect.stringContaining("mac sync s3: O código do Mac chegou incompleto."),
    ]);
    await updatePreferences({ environment: "vps" });
    await runOnAccount(account, turnRequest("v1", repo.path), new AbortController().signal, () => {});
    expect(warn.mock.calls.at(-1)?.[0]).toContain("mac sync: O código do Mac chegou incompleto.");
    expect(fakeProviders.turns.map(({ request }) => request.turnId)).toEqual(["v1"]);
    warn.mockRestore();
  });

  test("explain why a workspace cannot go to the Mac and when the runner refuses", async () => {
    const runner = macRunner();
    const local = await makeRepo("mac-local", { origin: true });
    const events: ProviderEvent[] = [];
    await runOnAccount(account, turnRequest("r1", local.path), new AbortController().signal, (e) => events.push(e));
    expect(events).toEqual([{ type: "done", ok: false, message: noGithubMessage }]);
    const prepare = spyOn(sync, "prepareMacSync").mockRejectedValue(new Error("disco cheio"));
    await runOnAccount(account, turnRequest("r2", local.path), new AbortController().signal, (e) => events.push(e));
    expect(events.at(-1)).toEqual({
      type: "done",
      ok: false,
      message: "Não consegui preparar o código para o Mac: disco cheio",
    });
    prepare.mockRestore();
    const refused = runOnAccount(account, turnRequest("r3", null), new AbortController().signal, (e) => events.push(e));
    await nextRequest(runner);
    runner.say({ type: "response", id: "r3", ok: false, error: "box.capacity" });
    await refused;
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: macOfflineMessage });
  });
});
