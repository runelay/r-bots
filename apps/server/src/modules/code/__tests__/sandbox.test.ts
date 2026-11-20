import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProcesses } from "../../../../test/helpers";
import {
  killSandboxed,
  resetSandboxProbe,
  sandboxArgv,
  sandboxBootReport,
  sandboxExec,
  sandboxMarker,
  sandboxMissingMessage,
  sandboxMode,
  sandboxProblem,
  sandboxShell,
  sandboxStatus,
  sandboxSudo,
  shellQuote,
  sweepSandboxed,
} from "../services/sandbox.service";

const keys = ["BOTS_TOOL_SANDBOX", "BOTS_SANDBOX_SUDO", "BOTS_SANDBOX_EXEC", "GATEWAY_PORT"] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  resetSandboxProbe();
});

afterEach(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSandboxProbe();
});

describe("configuration", () => {
  test("is off by default and fails closed on unknown values", () => {
    expect(sandboxMode()).toBe("off");
    process.env.BOTS_TOOL_SANDBOX = "off";
    expect(sandboxMode()).toBe("off");
    process.env.BOTS_TOOL_SANDBOX = "uid";
    expect(sandboxMode()).toBe("uid");
    process.env.BOTS_TOOL_SANDBOX = "maybe";
    expect(sandboxMode()).toBe("uid");
  });

  test("uses the fixed sudo and wrapper paths unless overridden", () => {
    expect(sandboxSudo()).toBe("/usr/bin/sudo");
    expect(sandboxExec()).toBe("/usr/local/bin/rb-sandbox-exec");
    process.env.BOTS_SANDBOX_SUDO = "/x/sudo";
    process.env.BOTS_SANDBOX_EXEC = "/x/exec";
    expect(sandboxSudo()).toBe("/x/sudo");
    expect(sandboxExec()).toBe("/x/exec");
  });

  test("markers carry the server scope and only safe characters", () => {
    process.env.GATEWAY_PORT = "2100";
    expect(sandboxMarker("sbx", "turn 1/é")).toBe("rb2100:sbx:turn_1__");
    delete process.env.GATEWAY_PORT;
    expect(sandboxMarker("dev", "a")).toBe("rb0:dev:a");
  });
});

describe("argv", () => {
  test("builds the sudo call with cwd, marker, timeout and allowed env", () => {
    expect(
      sandboxArgv({ cwd: "/w", command: "ls", marker: "rb0:sbx:t", timeoutSec: 1.2, env: { PORT: "3000" } }),
    ).toEqual([
      "/usr/bin/sudo",
      "-n",
      "-u",
      "runelaytool",
      "/usr/local/bin/rb-sandbox-exec",
      "--cwd",
      "/w",
      "--marker",
      "rb0:sbx:t",
      "--timeout",
      "2",
      "--env",
      "PORT=3000",
      "--",
      "ls",
    ]);
    expect(sandboxArgv({ cwd: "/w", command: "ls", timeoutSec: 0 })).toContain("1");
  });

  test("rejects env names outside the allowlist and multiline values", () => {
    expect(() => sandboxArgv({ cwd: "/w", command: "x", env: { LD_PRELOAD: "/x" } })).toThrow("LD_PRELOAD");
    expect(() => sandboxArgv({ cwd: "/w", command: "x", env: { PORT: "1\n2" } })).toThrow("PORT");
  });

  test("shell form quotes every argument and expands only the persistent shell cwd", async () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    const dir = mkdtempSync(join(tmpdir(), "rb-sandbox-"));
    try {
      const sudo = join(dir, "sudo");
      writeFileSync(sudo, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
      chmodSync(sudo, 0o755);
      process.env.BOTS_SANDBOX_SUDO = sudo;
      const command = sandboxShell({ command: `echo "$HOME" 'q' $(id)`, marker: "rb0:sbx:t" });
      const child = Bun.spawn(["bash", "-c", command], { cwd: dir, stdout: "pipe" });
      const out = (await new Response(child.stdout).text()).trim().split("\n");
      await child.exited;
      expect(out).toEqual([
        "-n",
        "-u",
        "runelaytool",
        "/usr/local/bin/rb-sandbox-exec",
        "--cwd",
        dir,
        "--marker",
        "rb0:sbx:t",
        "--",
        `echo "$HOME" 'q' $(id)`,
      ]);
      expect(sandboxShell({ cwd: "/fixed", command: "ls" })).toContain("'--cwd' '/fixed'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("probe and process control", () => {
  test("off mode never calls sudo", async () => {
    const fake = fakeProcesses(() => undefined);
    expect(await sandboxProblem()).toBeNull();
    expect(await killSandboxed("rb0:sbx:t")).toBe(0);
    expect(await sweepSandboxed([])).toBe(0);
    expect(await sandboxBootReport()).toEqual({
      ok: true,
      line: "sandbox de ferramentas: off (comandos dos bots rodam como o usuário do servidor)",
    });
    expect(fake.calls).toHaveLength(0);
    fake.restore();
  });

  test("the boot report names the mode and explains a failed probe in pt-BR", async () => {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    process.env.BOTS_SANDBOX_SUDO = "/fake/sudo";
    let reply: { code: number; stdout?: string; stderr?: string } = { code: 0, stdout: "ok 1502 bwrap=0\n" };
    const fake = fakeProcesses((call) => (call.command === "/fake/sudo" ? reply : undefined));
    expect(await sandboxBootReport()).toEqual({ ok: true, line: "sandbox de ferramentas: uid (runelaytool, bwrap ausente)" });
    resetSandboxProbe();
    reply = { code: 0, stdout: "ok 1502 bwrap=1\n" };
    expect((await sandboxBootReport()).line).toBe("sandbox de ferramentas: uid (runelaytool, bwrap ligado)");
    resetSandboxProbe();
    reply = { code: 1, stderr: "sudo: a password is required\n" };
    const failed = await sandboxBootReport();
    expect(failed.ok).toBe(false);
    expect(failed.line).toStartWith("ERRO: BOTS_TOOL_SANDBOX=uid");
    expect(failed.line).toContain("/usr/local/bin/rb-sandbox-exec --probe");
    fake.restore();
  });

  test("a working wrapper is probed once, sweeps orphans and reports bwrap", async () => {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    process.env.BOTS_SANDBOX_SUDO = "/fake/sudo";
    const fake = fakeProcesses((call) => {
      if (call.command !== "/fake/sudo") return undefined;
      if (call.args.includes("--probe")) return { stdout: "ok 1502 bwrap=1\n" };
      if (call.args.includes("--sweep")) return { stdout: "3\n" };
      if (call.args.includes("--kill")) return { stdout: "2\n" };
      return undefined;
    });
    expect(await sandboxProblem()).toBeNull();
    expect(await sandboxStatus()).toEqual({ ok: true, bwrap: true });
    expect(fake.calls.filter((call) => call.args.includes("--probe"))).toHaveLength(1);
    expect(fake.calls.find((call) => call.args.includes("--sweep"))?.args.slice(-2)).toEqual(["--sweep", "rb0"]);
    expect(await killSandboxed("rb0:sbx:t")).toBe(2);
    expect(await sweepSandboxed(["rb0:dev:a"])).toBe(3);
    expect(fake.calls.at(-1)?.args.slice(-3)).toEqual(["--sweep", "rb0", "rb0:dev:a"]);
    fake.restore();
  });

  test("a missing sudo rule or wrapper fails closed and garbage output counts as zero", async () => {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    process.env.BOTS_SANDBOX_SUDO = "/fake/sudo";
    let reply = { code: 1, stderr: "sudo: a password is required\n" };
    const fake = fakeProcesses((call) => (call.command === "/fake/sudo" ? reply : undefined));
    expect(await sandboxProblem()).toBe(sandboxMissingMessage);
    resetSandboxProbe();
    reply = { code: 0, stderr: "" };
    expect(await sandboxStatus()).toEqual({ ok: false, message: sandboxMissingMessage });
    expect(await killSandboxed("rb0:sbx:t")).toBe(0);
    expect(await sweepSandboxed([])).toBe(0);
    process.env.BOTS_SANDBOX_EXEC = "/other/exec";
    reply = { code: 0, stderr: "" };
    await sandboxStatus();
    expect(fake.calls.filter((call) => call.args.includes("--probe"))).toHaveLength(3);
    fake.restore();
  });
});
