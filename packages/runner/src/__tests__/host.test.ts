import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  agentScript,
  bwrapArgv,
  exposedPaths,
  findOnPath,
  hiddenPaths,
  hostAgentArgv,
  hostAgentEnv,
  installedProviders,
  probeHost,
  probeWarnings,
  runQuiet,
  scopeArgv,
  spawnAgent,
  writeLine,
} from "../host";
import { readLines } from "../json";
import { boxSpec, tempDir, turnRequest } from "./helpers";

const home = "/home/u";
const data = "/home/u/.local/share/runelay-bots";

function layout(probe = { scope: true, bwrap: true }, existing = [data, "/home/u/.config/runelay-bots"]) {
  return {
    home,
    dataDir: data,
    agent: ["/usr/bin/bun", "/opt/agent.js"],
    probe,
    exists: (path: string) => existing.includes(path),
  };
}

describe("host probe", () => {
  test("checks systemd-run and bwrap and warns once for each missing piece", async () => {
    const calls: string[][] = [];
    const ok = await probeHost(async (argv) => {
      calls.push(argv);
      return 0;
    });
    expect(ok).toEqual({ scope: true, bwrap: true });
    expect(calls.map(([bin]) => bin).sort()).toEqual(["bwrap", "systemd-run"]);
    expect(probeWarnings(ok)).toEqual([]);
    const none = await probeHost(async () => {
      throw new Error("missing");
    });
    expect(none).toEqual({ scope: false, bwrap: false });
    const warnings = probeWarnings(none);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("sem systemd-run");
    expect(warnings[1]).toContain("AppArmor");
  });
});

describe("runQuiet", () => {
  test("returns the exit code without output", async () => {
    expect(await runQuiet(["true"])).toBe(0);
    expect(await runQuiet(["sh", "-c", "echo x; exit 3"])).toBe(3);
  });
});

describe("host command line", () => {
  test("hides the r/bots data, backups and config", () => {
    expect(hiddenPaths(home, `${data}/`)).toEqual([
      data,
      "/home/u/.local/share/runelay-bots-backups",
      "/home/u/.config/runelay-bots",
    ]);
  });

  test("exposes only what the turn needs back inside the hidden data", () => {
    const request = turnRequest({
      workKey: "bot 1/conv",
      code: { cwd: `${data}/workspaces/bot-1/`, readOnly: true },
      configDir: "/home/u/.claude",
    });
    const exposed = exposedPaths(data, "bot-1", request);
    expect(exposed).toEqual([
      { path: `${data}/work/bot_1`, readOnly: false },
      { path: `${data}/bots/bot-1/uploads`, readOnly: true },
      { path: `${data}/locks`, readOnly: false },
      { path: `${data}/clis`, readOnly: true },
      { path: `${data}/workspaces/bot-1`, readOnly: true },
      { path: "/home/u/.claude", readOnly: false },
    ]);
    expect(exposedPaths(data, "b", turnRequest({ workKey: "" }))[0]).toEqual({ path: `${data}/work`, readOnly: false });
    expect(bwrapArgv([data], exposed)).toEqual([
      "bwrap",
      "--dev-bind",
      "/",
      "/",
      "--die-with-parent",
      "--tmpfs",
      data,
      "--bind-try",
      `${data}/work/bot_1`,
      `${data}/work/bot_1`,
      "--ro-bind-try",
      `${data}/bots/bot-1/uploads`,
      `${data}/bots/bot-1/uploads`,
      "--bind-try",
      `${data}/locks`,
      `${data}/locks`,
      "--ro-bind-try",
      `${data}/clis`,
      `${data}/clis`,
      "--ro-bind-try",
      `${data}/workspaces/bot-1`,
      `${data}/workspaces/bot-1`,
      "--",
    ]);
  });

  test("limits memory and CPU with a user scope", () => {
    expect(scopeArgv({ memMb: 2048, cpus: 1.5 })).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "-q",
      "--collect",
      "-p",
      "MemoryMax=2048M",
      "-p",
      "CPUQuota=150%",
      "--",
    ]);
    expect(scopeArgv({ memMb: 0, cpus: 0 })).toContain("MemoryMax=1M");
  });

  test("wraps the agent with the scope and bwrap only when each works", () => {
    const request = turnRequest();
    const box = boxSpec({ memMb: 512, cpus: 1 });
    const full = hostAgentArgv(layout(), "bot-1", request, box);
    expect(full.slice(0, 2)).toEqual(["systemd-run", "--user"]);
    expect(full).toContain("bwrap");
    expect(full).toContain("/home/u/.config/runelay-bots");
    expect(full).not.toContain("/home/u/.local/share/runelay-bots-backups");
    expect(full.slice(-2)).toEqual(["/usr/bin/bun", "/opt/agent.js"]);
    expect(hostAgentArgv(layout({ scope: false, bwrap: false }), "bot-1", request, box)).toEqual([
      "/usr/bin/bun",
      "/opt/agent.js",
    ]);
    expect(hostAgentArgv(layout({ scope: false, bwrap: true }, []), "bot-1", request, box)).toEqual([
      "/usr/bin/bun",
      "/opt/agent.js",
    ]);
  });
});

describe("host lookup", () => {
  test("prefers the bundled agent and falls back to the source", () => {
    expect(agentScript("/opt/rb", () => true)).toBe("/opt/rb/box-agent.js");
    expect(agentScript("/opt/rb", () => false)).toBe("/opt/rb/box-agent-main.ts");
    expect(agentScript("/opt/rb", () => true, "/x/agent.js")).toBe("/x/agent.js");
  });

  test("finds CLIs on the PATH or in the managed folder", () => {
    const exists = (path: string) => ["/usr/bin/claude", `${data}/clis/codex/current`].includes(path);
    expect(findOnPath(["claude"], "/bin::/usr/bin", exists)).toBe("/usr/bin/claude");
    expect(findOnPath(["codex"], "/bin:/usr/bin", exists)).toBeNull();
    expect(installedProviders("/usr/bin", data, exists)).toEqual(["claude", "codex"]);
    expect(installedProviders("", data, () => false)).toEqual([]);
  });

  test("passes the host env with the data dir and the host claude", () => {
    const exists = (path: string) => path === "/usr/bin/claude";
    expect(hostAgentEnv({ PATH: "/usr/bin", GONE: undefined }, data, exists)).toEqual({
      PATH: "/usr/bin",
      BOTS_DATA_DIR: data,
      CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude",
    });
    expect(hostAgentEnv({ CLAUDE_CODE_EXECUTABLE: "/opt/claude" }, data, exists).CLAUDE_CODE_EXECUTABLE).toBe(
      "/opt/claude",
    );
    expect(hostAgentEnv({}, data, () => false)).toEqual({ BOTS_DATA_DIR: data });
  });
});

describe("writeLine", () => {
  test("writes and flushes, and ignores a closed pipe", async () => {
    const written: string[] = [];
    await writeLine({ write: (text: string) => written.push(text), flush: async () => undefined }, "a\n");
    expect(written).toEqual(["a\n"]);
    await writeLine(
      {
        write: () => undefined,
        flush: async () => {
          throw new Error("EPIPE");
        },
      },
      "b\n",
    );
  });
});

describe("spawnAgent", () => {
  test("runs the command as this user, writes lines to it and reads its output", async () => {
    const temp = tempDir("rb-host-");
    const handle = spawnAgent(["sh", "-c", 'read line; echo "got $line"; echo "$HOST_X" >&2; pwd'], {
      cwd: temp.dir,
      env: { HOST_X: "env-ok", PATH: process.env.PATH ?? "" },
      signal: new AbortController().signal,
    });
    handle.write("ping\n");
    const lines: string[] = [];
    for await (const line of readLines(handle.stdout)) lines.push(line);
    expect(await new Response(handle.stderr).text()).toBe("env-ok\n");
    expect(await handle.exited).toBe(0);
    expect(lines[0]).toBe("got ping");
    expect(lines[1]).toEndWith(temp.dir.split("/").at(-1) ?? "");
    handle.write("late\n");
    temp.remove();
  });

  test("kills the whole group on abort and on kill", async () => {
    const controller = new AbortController();
    const handle = spawnAgent(["sh", "-c", "sleep 30 & wait"], {
      cwd: join("/nonexistent", "dir"),
      env: { PATH: process.env.PATH ?? "" },
      signal: controller.signal,
    });
    controller.abort();
    expect(await handle.exited).not.toBe(0);
    const aborted = new AbortController();
    aborted.abort();
    const early = spawnAgent(["sleep", "30"], {
      cwd: "/",
      env: { PATH: process.env.PATH ?? "" },
      signal: aborted.signal,
    });
    expect(await early.exited).not.toBe(0);
    early.kill();
    const other = spawnAgent(["sleep", "30"], {
      cwd: "/",
      env: { PATH: process.env.PATH ?? "" },
      signal: new AbortController().signal,
    });
    other.kill();
    expect(await other.exited).not.toBe(0);
  });
});
