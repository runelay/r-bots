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
  devServerLogs,
  devServersOf,
  findPreviewByToken,
  type PublicDevServer,
  previewTarget,
  serversOf,
  startDevServer,
  stopAllDevServers,
  stopDevServer,
  stopDevServers,
} from "../services/dev-server.service";
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
    expect((call?.options.env as Record<string, string>).HOST).toBe("127.0.0.1");

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
      ["pnpm dev", (port) => `pnpm dev --port ${port}`],
      ["bun run dev", (port) => `bun run dev --port ${port}`],
      ["npx vite", (port) => `npx vite --port ${port}`],
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
      expect(probes).toEqual(["127.0.0.1", "::1"]);
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
    kill.mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
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
