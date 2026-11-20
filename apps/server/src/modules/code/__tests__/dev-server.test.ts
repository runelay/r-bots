import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
  type FakeChild,
  fakeProcesses,
  type ProcessCall,
  type ProcessReply,
  resetData,
} from "../../../../test/helpers";
import {
  devLimits,
  devServerLogs,
  devServersOf,
  findPreviewByToken,
  getServer,
  launchServer,
  listServers,
  onServerChange,
  onServerLog,
  type PublicDevServer,
  portOwner,
  previewTarget,
  rawLines,
  serverLogs,
  serversOf,
  startDevServer,
  stopAllDevServers,
  stopDevServer,
  stopDevServers,
  toolOf,
  viewServer,
  withHost,
} from "../services/dev-server.service";
import { resetSandboxProbe, sandboxMissingMessage } from "../services/sandbox.service";
import { codeDataDir, type WorkspaceState } from "../services/workspace.service";

const portBase = 5310;
const listeners: net.Server[] = [];
let counter = 0;

function workspace(): WorkspaceState {
  counter++;
  return {
    id: `dev-ws-${counter}`,
    repo: "/repo",
    repoName: "repo",
    path: `/work/dev-${counter}`,
    branch: "feat/x",
    base: "main",
    baseCommit: "abc",
    task: "t",
    openedAt: "",
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null },
  };
}

function listen(port: number) {
  return new Promise<net.Server>((done) => {
    const server = net.createServer((socket) => socket.end());
    server.listen({ port, host: "127.0.0.1" }, () => {
      listeners.push(server);
      done(server);
    });
  });
}

function closeAll() {
  return Promise.all(listeners.splice(0).map((server) => new Promise((done) => server.close(done))));
}

function bash(reply: (call: ProcessCall) => ProcessReply) {
  const children: FakeChild[] = [];
  const fake = fakeProcesses((call) => {
    if (call.command !== "bash") return undefined;
    children.push(call.child);
    return reply(call);
  });
  const kill = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
    const child = children.find((item) => item.pid === -pid);
    if (!child) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    child.kill(signal);
    return true;
  }) as typeof process.kill);
  return { fake, children, kill };
}

function serving(call: ProcessCall): ProcessReply {
  const port = Number((call.options.env as Record<string, string>).PORT);
  void listen(port);
  call.child.stdout.write("\u001b[32mready\u001b[0m on port\n\n");
  call.child.stderr.write("warning\n");
  return { hang: true };
}

beforeEach(async () => {
  await resetData();
});

afterEach(async () => {
  stopAllDevServers();
  spyOn(process, "kill").mockRestore();
  await closeAll();
});

describe("starting dev servers", () => {
  test("starts, reports running once the port opens, and stops the process group", async () => {
    const { fake, kill } = bash(serving);
    const ws = workspace();
    const exits: PublicDevServer[] = [];
    const started = await startDevServer(ws, { cmd: "  npm run dev  ", port: portBase + 50 }, (server) =>
      exits.push(server),
    );
    expect(started.status).toBe("running");
    expect(started.port).toBe(portBase + 50);
    expect(started.command).toBe(`npm run dev -- --port ${portBase + 50}`);
    expect(started.url).toBe(`http://localhost:${portBase + 50}`);
    expect(started.previewPath).toMatch(new RegExp(`^/preview/${ws.id}/${portBase + 50}/\\?t=`));
    expect(started.logs).toContain("ready on port");
    expect(started.logs).toContain("warning");
    const call = fake.calls.find((item) => item.command === "bash");
    expect(call?.args).toEqual(["-lc", `npm run dev -- --port ${portBase + 50}`]);
    expect(call?.options.cwd).toBe(ws.path);
    expect((call?.options.env as Record<string, string> | undefined)?.HOST).toBe("127.0.0.1");

    const token = started.previewPath.split("?t=")[1];
    expect(devServersOf(ws).map((item) => item.id)).toEqual([started.id]);
    expect(previewTarget(ws.id, started.port)).toEqual({ port: started.port, token });
    expect(previewTarget(ws.id, 1)).toBeNull();
    expect(findPreviewByToken(token)).toEqual({ port: started.port, workspaceId: ws.id, token });
    expect(findPreviewByToken("nope")).toBeNull();

    const logs = await devServerLogs(ws, undefined, 1);
    expect(logs.logs).toBe("warning");

    const [stopped] = await stopDevServers(ws);
    expect(stopped.status).toBe("stopped");
    expect(kill).toHaveBeenCalledWith(-(call?.child.pid as number), "SIGTERM");
    for (let attempt = 0; attempt < 100 && exits.length === 0; attempt++) await Bun.sleep(2);
    expect(exits[0]).toMatchObject({ status: "stopped", id: started.id });
    expect(devServersOf(ws)).toEqual([]);
    expect(previewTarget(ws.id, started.port)).toBeNull();
    expect(await stopDevServer(serversOf(ws)[0])).toMatchObject({ status: "stopped" });
    expect(readFileSync(join(codeDataDir, ws.id, "dev", `${started.port}.log`), "utf8")).toContain("$ npm run dev");
  });

  test("rewrites the command to pass the port when it can", async () => {
    bash(serving);
    const cases: Array<[string, (port: number) => string]> = [
      ["serve --listen {port}", (port) => `serve --listen ${port}`],
      ["PORT=1 node app.js", () => "PORT=1 node app.js"],
      ["node app.js --port 9", () => "node app.js --port 9"],
      ["npm start", (port) => `npm start -- --port ${port}`],
      ["npm run dev -- --enable-containers=false", (port) => `npm run dev -- --enable-containers=false --port ${port}`],
      ["pnpm dev", (port) => `pnpm dev --port ${port}`],
      ["bun run dev", (port) => `bun run dev --port ${port}`],
      ["npx vite", (port) => `npx vite --host 127.0.0.1 --port ${port}`],
      ["wrangler dev", (port) => `wrangler dev --ip 127.0.0.1 --port ${port}`],
      ["wrangler dev --ip 0 --port 9", () => "wrangler dev --ip 0 --port 9"],
      ["next dev", (port) => `next dev -H 127.0.0.1 --port ${port}`],
      ["npx expo start", (port) => `npx expo start --port ${port} --localhost`],
      ["expo start {port}", (port) => `expo start ${port} --localhost`],
      ["npx expo start --lan", (port) => `npx expo start --lan --port ${port}`],
      ["astro dev --host 127.0.0.1", (port) => `astro dev --host 127.0.0.1 --port ${port}`],
    ];
    for (const [cmd, expected] of cases) {
      const started = await startDevServer(workspace(), { cmd }, () => undefined);
      expect(started.command).toBe(expected(started.port));
    }
  });

  test("reports a server that exits before opening the port", async () => {
    bash(() => ({ code: 0 }));
    let exited: PublicDevServer | null = null;
    const started = await startDevServer(workspace(), { cmd: "python -m http.server" }, (server) => {
      exited = server;
    });
    expect(started.command).toBe("python -m http.server");
    expect(started.status).toBe("exited");
    expect(exited).toMatchObject({ status: "exited", exitCode: 0 });
  });

  test("validates the command and the folder", async () => {
    const ws = workspace();
    await expect(startDevServer(ws, { cmd: "  " }, () => undefined)).rejects.toThrow("Diga o comando");
    await expect(startDevServer(ws, { cmd: "npm run dev", cwd: "../../etc" }, () => undefined)).rejects.toThrow(
      "A pasta do servidor precisa ficar dentro da tarefa.",
    );
  });

  test("skips busy and reserved ports and fails when none is free", async () => {
    await listen(portBase);
    bash(serving);
    const ws = workspace();
    const first = await startDevServer(ws, { cmd: "node a.js", port: portBase }, () => undefined);
    expect(first.port).toBe(portBase + 1);
    const second = await startDevServer(ws, { cmd: "node b.js", port: portBase + 1 }, () => undefined);
    expect(second.port).toBe(portBase + 2);
    expect(serversOf(ws, portBase + 2).map((item) => item.port)).toEqual([portBase + 2]);
    const newest = serversOf(ws).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    expect((await devServerLogs(ws, undefined, 5)).id).toBe(newest.id);
    expect((await stopDevServers(ws, portBase + 1)).map((item) => item.port)).toEqual([portBase + 1]);

    const create = spyOn(net, "createServer").mockImplementation((() => {
      const fake = new EventEmitter() as EventEmitter & { listen: () => void };
      fake.listen = () => queueMicrotask(() => fake.emit("error", new Error("EADDRINUSE")));
      return fake;
    }) as unknown as typeof net.createServer);
    try {
      await expect(startDevServer(workspace(), { cmd: "node c.js" }, () => undefined)).rejects.toThrow(
        "Não achei porta livre para o servidor.",
      );
    } finally {
      create.mockRestore();
    }
  });

  test("gives up waiting for the port after the deadline", async () => {
    bash((call) => {
      call.child.stdout.destroy(new Error("pipe broke"));
      return { hang: true };
    });
    const probes: string[] = [];
    const connect = spyOn(net, "connect").mockImplementation(((options: { host: string }) => {
      probes.push(options.host);
      const socket = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number, done: () => void) => void;
        destroy: () => void;
      };
      socket.setTimeout = (_ms, done) => queueMicrotask(done);
      socket.destroy = () => undefined;
      return socket;
    }) as unknown as typeof net.connect);
    const realNow = Date.now.bind(Date);
    let calls = 0;
    const now = spyOn(Date, "now").mockImplementation(() => realNow() + (++calls > 2 ? 200_000 : 0));
    try {
      const started = await startDevServer(workspace(), { cmd: "node slow.js" }, () => undefined);
      expect(started.status).toBe("running");
      expect(probes).toEqual(["127.0.0.1", "::1", "127.0.0.1", "::1"]);
    } finally {
      now.mockRestore();
      connect.mockRestore();
    }
  });
});

describe("stopping and logs", () => {
  test("escalates to SIGKILL and falls back to killing the child directly", async () => {
    const { children, kill } = bash(serving);
    const ws = workspace();
    await startDevServer(ws, { cmd: "node keep.js" }, () => undefined);
    const child = children[0];
    kill.mockImplementation(((_pid: number, signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") child.kill("SIGKILL");
      return true;
    }) as typeof process.kill);
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    try {
      const result = await stopDevServer(serversOf(ws)[0]);
      expect(result.status).toBe("stopped");
      expect(kill.mock.calls.map((args) => args[1])).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      sleep.mockRestore();
    }

    const other = workspace();
    await startDevServer(other, { cmd: "node other.js" }, () => undefined);
    kill.mockImplementation((() => {
      throw new Error("EPERM");
    }) as typeof process.kill);
    const [stopped] = await stopDevServers(other);
    expect(stopped.status).toBe("stopped");
    expect(children[1].signals).toEqual(["SIGTERM"]);

    const third = workspace();
    await startDevServer(third, { cmd: "node third.js" }, () => undefined);
    children[2].kill = () => {
      throw new Error("gone");
    };
    stopAllDevServers();
    children[2].finish({ code: 0 });
  });

  test("reads logs from the tail or the log file and caps the tail", async () => {
    await expect(devServerLogs(workspace(), undefined, 10)).rejects.toThrow("Nenhum servidor desta tarefa ainda.");
    bash((call) => {
      call.child.stdout.write(`${Array.from({ length: 450 }, (_, index) => `line ${index}`).join("\n")}\n`);
      return { code: 0 };
    });
    const ws = workspace();
    const started = await startDevServer(ws, { cmd: "node noisy.js" }, () => undefined);
    const logs = await devServerLogs(ws, started.port, 1000);
    const lines = logs.logs.split("\n");
    expect(lines).toHaveLength(400);
    expect(lines[0]).toBe("line 50");

    const quiet = workspace();
    bash(() => ({ code: 0 }));
    const silent = await startDevServer(quiet, { cmd: "node quiet.js" }, () => undefined);
    for (let attempt = 0; attempt < 100 && serversOf(quiet)[0].status !== "exited"; attempt++) await Bun.sleep(2);
    writeFileSync(join(codeDataDir, quiet.id, "dev", `${silent.port}.log`), "from file\nsecond\n");
    expect((await devServerLogs(quiet, undefined, 2)).logs).toBe("second\n");
    const vanished = workspace();
    const gone = await startDevServer(vanished, { cmd: "node vanish.js" }, () => undefined);
    for (let attempt = 0; attempt < 100 && serversOf(vanished)[0].status !== "exited"; attempt++) await Bun.sleep(2);
    await resetData();
    expect((await devServerLogs(vanished, gone.port, 5)).logs).toBe("");
  });
});

describe("registry", () => {
  test("notifies changes and logs, finds port owners and prunes old stopped servers", async () => {
    bash(serving);
    const changes: Array<[string, boolean]> = [];
    const offChange = onServerChange((server, removed) => changes.push([server.status, removed]));
    const target = { key: "prj_reg", kind: "project" as const, path: "/work/reg", name: "reg", branch: null };
    await expect(launchServer(target, { cmd: "vite", cwd: "../x" })).rejects.toThrow("dentro do projeto");
    const { server, ready } = await launchServer(target, { cmd: "npx expo start", secrets: ["ready"] });
    const lines: string[][] = [];
    const offLog = onServerLog(server.id, (batch) => lines.push(batch));
    const second = onServerLog(server.id, () => undefined);
    second();
    await ready;
    expect(viewServer(server)).toMatchObject({ tool: "expo", kind: "project", cwd: "" });
    expect(portOwner(server.port)?.id).toBe(server.id);
    expect(portOwner(1)).toBeNull();
    expect(rawLines(server, 10, "on")).toEqual(["\u001b[32m••••\u001b[0m on port"]);
    expect((await serverLogs(server, 10, "warn")).logs).toBe("warning");
    expect((await serverLogs(server, 10, "zzz")).logs).toBe("");
    offLog();
    expect(lines.flat()).toContain("warning");
    await stopDevServer(server);
    await server.done;
    server.endedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(listServers().some((item) => item.id === server.id)).toBe(false);
    expect(getServer(server.id)).toBeNull();
    offChange();
    expect(changes.map(([status]) => status)).toEqual(["starting", "running", "stopped", "stopped"]);
    expect(changes.at(-1)?.[1]).toBe(true);
    expect(toolOf(null, "cargo run")).toBe("rust");
    expect(toolOf("echo")).toBe("process");
  });
});

describe("loopback and limits", () => {
  test("refuses public binds and keeps explicit loopback hosts", () => {
    expect(() => withHost("vite --host 0.0.0.0")).toThrow("só pode ouvir em 127.0.0.1");
    expect(() => withHost("vite --host")).toThrow("só pode ouvir em 127.0.0.1");
    expect(() => withHost("next dev -H 0.0.0.0")).toThrow("só pode ouvir em 127.0.0.1");
    expect(() => withHost("HOST=0.0.0.0 node app.js")).toThrow("só pode ouvir em 127.0.0.1");
    expect(withHost("vite --host=127.0.0.1")).toBe("vite --host=127.0.0.1");
    expect(withHost("node app.js")).toBe("node app.js");
  });

  test("caps the servers of one workspace and expires them after the lifetime", async () => {
    bash(serving);
    const ws = workspace();
    const limit = devLimits.perWorkspace;
    const minutes = devLimits.maxMinutes;
    devLimits.perWorkspace = 1;
    devLimits.maxMinutes = 0.0005;
    try {
      const first = await startDevServer(ws, { cmd: "node a.js" }, () => undefined);
      await expect(startDevServer(ws, { cmd: "node b.js" }, () => undefined)).rejects.toThrow(
        "Já há 1 servidores rodando nesta tarefa.",
      );
      for (let attempt = 0; attempt < 200 && serversOf(ws)[0].status !== "stopped"; attempt++) await Bun.sleep(2);
      expect(serversOf(ws).find((item) => item.id === first.id)?.status).toBe("stopped");
    } finally {
      devLimits.perWorkspace = limit;
      devLimits.maxMinutes = minutes;
    }
  });
});

describe("dev servers in the tool sandbox", () => {
  const saved = { mode: process.env.BOTS_TOOL_SANDBOX, sudo: process.env.BOTS_SANDBOX_SUDO };

  beforeEach(() => {
    process.env.BOTS_TOOL_SANDBOX = "uid";
    process.env.BOTS_SANDBOX_SUDO = "/fake/sudo";
    resetSandboxProbe();
  });

  afterEach(() => {
    if (saved.mode === undefined) delete process.env.BOTS_TOOL_SANDBOX;
    else process.env.BOTS_TOOL_SANDBOX = saved.mode;
    if (saved.sudo === undefined) delete process.env.BOTS_SANDBOX_SUDO;
    else process.env.BOTS_SANDBOX_SUDO = saved.sudo;
    resetSandboxProbe();
  });

  test("runs through sudo and the wrapper and is killed by its marker", async () => {
    const servers: FakeChild[] = [];
    const fake = fakeProcesses((call) => {
      if (call.command !== "/fake/sudo") return undefined;
      if (call.args.includes("--probe")) return { stdout: "ok 1502 bwrap=0\n" };
      if (call.args.includes("--sweep")) return { stdout: "0\n" };
      if (call.args.includes("--kill")) {
        for (const child of servers) child.finish({ code: 143 });
        return { stdout: "1\n" };
      }
      servers.push(call.child);
      const port = Number(call.args.find((arg) => arg.startsWith("PORT="))?.slice(5));
      void listen(port);
      return { hang: true };
    });
    spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const ws = workspace();
    const started = await startDevServer(ws, { cmd: "npx vite" }, () => undefined);
    expect(started.status).toBe("running");
    const spawn = fake.calls.find((call) => call.args.includes("--cwd"));
    const args = spawn?.args ?? [];
    expect(args.slice(0, 4)).toEqual(["-n", "-u", "runelaytool", "/usr/local/bin/rb-sandbox-exec"]);
    expect(args).toContain("HOST=127.0.0.1");
    expect(args[args.indexOf("--marker") + 1]).toMatch(/^rb\d+:dev:dev_[0-9a-f]+$/);
    expect(args.at(-1)).toBe(`npx vite --host 127.0.0.1 --port ${started.port}`);
    await stopDevServers(ws);
    const kill = fake.calls.find((call) => call.args.includes("--kill"));
    expect(kill?.args.at(-1)).toBe(args[args.indexOf("--marker") + 1]);
    await startDevServer(workspace(), { cmd: "node x.js" }, () => undefined);
    stopAllDevServers();
    fake.restore();
  });

  test("refuses to start when sudo or the wrapper are missing", async () => {
    const fake = fakeProcesses((call) =>
      call.command === "/fake/sudo" ? { code: 1, stderr: "sudo: a password is required" } : undefined,
    );
    await expect(startDevServer(workspace(), { cmd: "npm run dev" }, () => undefined)).rejects.toThrow(
      sandboxMissingMessage,
    );
    expect(fake.calls.some((call) => call.args.includes("--cwd"))).toBe(false);
    fake.restore();
  });
});
