import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { codeProcesses, gitSync, makeRepo, worktreesDir } from "../../../../test/code-helpers";
import {
  type FakeChild,
  type ProcessCall,
  type ProcessReply,
  request,
  resetData,
  startTestServer,
  type TestServer,
} from "../../../../test/helpers";
import { writeSetting } from "../../../db/settings";
import { ValidationError } from "../../../shared/errors";
import type { BotDefinition } from "../../bots/services/bots.service";
import {
  forgetServer,
  getServer,
  listensEverywhere,
  listServers,
  ServerRunning,
  stopAllDevServers,
  stopDevServer,
  wildcardListeners,
} from "../../code/services/dev-server.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import {
  linkEnvFiles,
  listProjects,
  loadEnv,
  managerOf,
  parseEnv,
  parseWorktrees,
  projectKey,
  readScripts,
  resolveProject,
  scriptCommand,
} from "../services/projects.service";
import { registerServerTools } from "../services/server-tools.service";
import {
  deleteProfile,
  describeProject,
  findProfile,
  forget,
  listProfiles,
  restart,
  saveProfile,
  startProjectServer,
  stopServer,
} from "../services/servers.service";

const listeners: net.Server[] = [];
let server: TestServer;
let counter = 0;

function listen(port: number) {
  return new Promise<void>((done) => {
    const item = net.createServer((socket) => socket.end());
    item.listen({ port, host: "127.0.0.1" }, () => {
      listeners.push(item);
      done();
    });
  });
}

function serving(call: ProcessCall): ProcessReply {
  const env = call.options.env as Record<string, string>;
  void listen(Number(env.PORT));
  call.child.stdout.write(`\u001b[32mready\u001b[0m ${env.API_TOKEN ?? ""}\n`);
  return { hang: true };
}

const children: FakeChild[] = [];

function routeKill() {
  return spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
    const child = children.find((item) => item.pid === Math.abs(pid));
    if (!child) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    child.kill(signal);
    return true;
  }) as typeof process.kill);
}

const fakeKill = () =>
  spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);

function processes(reply: (call: ProcessCall) => ProcessReply | undefined = serving) {
  routeKill();
  return codeProcesses((call) => {
    if (call.command !== "bash") return undefined;
    children.push(call.child);
    return reply(call);
  });
}

async function project(files: Record<string, string> = {}) {
  counter++;
  return makeRepo(`srv-${counter}`, {
    files: {
      "package.json": JSON.stringify({ scripts: { dev: "vite", api: "wrangler dev", bad: 3 } }),
      ".gitignore": ".env.local\n.dev.vars\n",
      "README.md": "x\n",
      ...files,
    },
  });
}

function addWorktree(repo: string, branch: string) {
  const path = join(worktreesDir, `${branch.replace(/\//g, "-")}-${counter}`);
  gitSync(repo, ["worktree", "add", "-q", "-b", branch, path]);
  return path;
}

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
  await writeSetting("servers.profiles", []);
});

afterEach(async () => {
  routeKill();
  stopAllDevServers();
  for (const item of listServers()) {
    const live = getServer(item.id);
    if (!live) continue;
    if (live.child) await stopDevServer(live);
    await live.done;
    forgetServer(live);
  }
  await Promise.all(listeners.splice(0).map((item) => new Promise((done) => item.close(done))));
  children.splice(0);
  spyOn(process, "kill").mockRestore();
});

describe("projects", () => {
  test("parses worktrees, env files and package managers", () => {
    expect(
      parseWorktrees("worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n\nworktree /c\n"),
    ).toEqual([
      { path: "/a", branch: "main", main: true },
      { path: "/b", branch: null, main: false },
      { path: "/c", branch: null, main: false },
    ]);
    expect(parseEnv("# c\n\nexport A=1\nB='two words'\nC=\"q\"\nD=x # note\nbad line\n")).toEqual({
      A: "1",
      B: "two words",
      C: "q",
      D: "x",
    });
    expect(managerOf(["bun.lock"])).toBe("bun");
    expect(managerOf(["bun.lockb"])).toBe("bun");
    expect(managerOf(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(managerOf(["yarn.lock"])).toBe("yarn");
    expect(managerOf([])).toBe("npm");
    expect(scriptCommand("yarn", "dev")).toBe("yarn dev");
    expect(scriptCommand("bun", "dev")).toBe("bun run dev");
    expect(projectKey("/x")).toMatch(/^prj_[0-9a-f]{10}$/);
  });

  test("lists allowed repos with worktrees and resolves by name, branch or path", async () => {
    processes();
    const repo = await project();
    const tree = addWorktree(repo.path, "feat/a");
    const projects = await listProjects();
    const found = projects.find((item) => item.path === repo.path);
    expect(found?.worktrees.map((item) => item.branch)).toEqual(["main", "feat/a"]);
    expect(await resolveProject({ project: repo.name })).toMatchObject({ path: repo.path, branch: "main", cwd: "" });
    expect(await resolveProject({ project: repo.name, branch: "feat/a" })).toMatchObject({
      path: tree,
      repoPath: repo.path,
      branch: "feat/a",
    });
    expect((await resolveProject({ project: `srv-${counter}`.slice(0, 5) })).name).toContain("srv-");
    gitSync(tree, ["checkout", "-q", "--detach"]);
    expect((await resolveProject({ path: tree })).branch).toBeNull();
    await expect(resolveProject({ project: "nope-nope" })).rejects.toBeInstanceOf(ValidationError);
    await expect(resolveProject({ project: repo.name, branch: "x" })).rejects.toThrow("Não achei worktree");
    await expect(resolveProject({})).rejects.toThrow("Diga o projeto");
    await expect(resolveProject({ path: "/etc" })).rejects.toThrow("não está num repositório liberado");
    await expect(resolveProject({ path: join(repo.path, "missing") })).rejects.toThrow("não existe");
    await expect(resolveProject({ path: repo.path, cwd: "../.." })).rejects.toThrow("dentro do projeto");
  });

  test("falls back when git does not answer", async () => {
    codeProcesses((call) => (call.command === "git" ? { code: 1, stderr: "no" } : undefined));
    const repo = await project();
    expect(await resolveProject({ path: repo.path })).toMatchObject({
      path: repo.path,
      repoPath: repo.path,
      branch: null,
    });
    const listed = (await listProjects()).find((item) => item.path === repo.path);
    expect(listed?.worktrees).toEqual([{ path: repo.path, branch: null, main: true }]);
  });

  test("reads scripts, env names, secrets and links env files into worktrees", async () => {
    processes();
    const repo = await project({ "pnpm-lock.yaml": "", "web/package.json": "{", "web/README.md": "" });
    writeFileSync(join(repo.path, ".env.local"), "API_TOKEN=supersecret1\nVITE_URL=http://x\nSHORT_KEY=abc\n");
    writeFileSync(join(repo.path, ".dev.vars"), "X=1\n");
    writeFileSync(join(repo.path, ".tracked-file"), "1\n");
    const tree = addWorktree(repo.path, "feat/env");
    const resolved = await resolveProject({ path: tree });
    const scripts = await readScripts(resolved);
    expect(scripts.manager).toBe("pnpm");
    expect(scripts.scripts.map((item) => item.name)).toEqual(["dev", "api"]);
    expect((await readScripts(await resolveProject({ path: tree, cwd: "web" }))).scripts).toEqual([]);
    const env = await loadEnv(resolved);
    expect(env.keys).toEqual(["API_TOKEN", "SHORT_KEY", "VITE_URL"]);
    expect(env.secrets).toEqual(["supersecret1"]);
    expect(env.files).toEqual([".env.local"]);
    expect(await linkEnvFiles(resolved)).toEqual([".env.local", ".dev.vars"]);
    expect(lstatSync(join(tree, ".env.local")).isSymbolicLink()).toBe(true);
    expect(await linkEnvFiles(resolved)).toEqual([]);
    expect(await linkEnvFiles(await resolveProject({ path: repo.path }))).toEqual([]);
    const described = await describeProject({ path: tree });
    expect(described).toMatchObject({ branch: "feat/env", manager: "pnpm", envFiles: [".env.local"] });
    expect(described.scripts).toEqual([
      { name: "dev", command: "vite", tool: "vite" },
      { name: "api", command: "wrangler dev", tool: "wrangler" },
    ]);
    expect(JSON.stringify(described)).not.toContain("supersecret1");
  });

  test("skips env files that are not ignored or cannot be linked", async () => {
    processes();
    const repo = await project({ ".gitignore": ".dev.vars\n" });
    writeFileSync(join(repo.path, ".env.local"), "A=1\n");
    writeFileSync(join(repo.path, ".dev.vars"), "A=1\n");
    const tree = addWorktree(repo.path, "feat/skip");
    const resolved = await resolveProject({ path: tree });
    const fs = await import("node:fs/promises");
    const link = spyOn(fs, "symlink").mockRejectedValue(new Error("nope"));
    try {
      expect(await linkEnvFiles(resolved)).toEqual([]);
    } finally {
      link.mockRestore();
    }
    expect(existsSync(join(tree, ".env.local"))).toBe(false);
  });
});

describe("profiles", () => {
  test("saves, lists, finds and deletes profiles", async () => {
    processes();
    const repo = await project();
    const saved = await saveProfile({ name: "Whitelabel dev", path: repo.path, script: "dev", port: 5999 });
    expect(saved).toEqual({
      id: "whitelabel-dev",
      name: "Whitelabel dev",
      path: repo.path,
      cwd: "",
      script: "dev",
      cmd: null,
      port: 5999,
    });
    await saveProfile({ id: "api", name: "API dev", path: repo.path, cmd: "wrangler dev", port: null });
    expect((await listProfiles()).map((item) => item.id)).toEqual(["api", "whitelabel-dev"]);
    expect((await findProfile("API DEV"))?.id).toBe("api");
    expect(await findProfile("x")).toBeNull();
    expect(await deleteProfile("api")).toBe(true);
    expect(await deleteProfile("api")).toBe(false);
    expect((await saveProfile({ name: "!!!", path: repo.path, script: "dev" })).id).toMatch(/^perfil-/);
    await expect(saveProfile({ path: repo.path })).rejects.toThrow("Dê um nome");
    await expect(saveProfile({ name: "a" })).rejects.toThrow("Diga a pasta");
    await expect(saveProfile({ name: "a", path: repo.path })).rejects.toThrow("script ou o comando");
    await expect(saveProfile({ name: "a", path: repo.path, script: "dev", port: 80 })).rejects.toThrow("Porta");
    await expect(saveProfile({ name: 3, path: repo.path })).rejects.toThrow("Valor inválido");
  });
});

describe("project servers", () => {
  test("starts from a script with env, hides secrets, restarts, stops and forgets", async () => {
    processes();
    fakeKill();
    const repo = await project();
    writeFileSync(join(repo.path, ".env.local"), "API_TOKEN=supersecret1\n");
    const { server: launched, ready } = await startProjectServer({ path: repo.path, script: "dev", startedBy: "user" });
    expect(launched).toMatchObject({
      kind: "project",
      name: repo.name,
      branch: "main",
      tool: "vite",
      script: "dev",
      envKeys: ["API_TOKEN"],
    });
    expect(launched.command).toBe(`npm run dev -- --port ${launched.port}`);
    const result = await ready;
    expect(result.status).toBe("running");
    expect(result.logs).toContain("ready ••••");
    expect(result.logs).not.toContain("supersecret1");
    const again = await restart(launched.id);
    expect((await again.ready).status).toBe("running");
    expect(again.server.id).toBe(launched.id);
    await expect(Promise.resolve().then(() => forget(launched.id))).rejects.toThrow("Pare o servidor");
    routeKill();
    const stopped = await stopServer(launched.id);
    expect(stopped.status).toBe("stopped");
    await getServer(launched.id)?.done;
    expect(forget(launched.id)).toBe(true);
    expect(() => forget(launched.id)).toThrow("não existe mais");
  });

  test("runs with the host config dir and without the server's native library override", async () => {
    let seen: Record<string, string> = {};
    processes((call) => {
      seen = call.options.env as Record<string, string>;
      return serving(call);
    });
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = "/app/native/x.node";
    process.env.CI = "true";
    try {
      const repo = await project();
      await (await startProjectServer({ path: repo.path, script: "api", startedBy: "user" })).ready;
    } finally {
      delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
      delete process.env.CI;
    }
    expect(seen.CI).toBeUndefined();
    expect(seen.NAPI_RS_NATIVE_LIBRARY_PATH).toBeUndefined();
    expect(seen.XDG_CONFIG_HOME).toBe(join(process.env.HOST_HOME as string, ".config"));
    expect(seen.FORCE_COLOR).toBe("1");
  });

  test("stops a project server that listens on every interface", async () => {
    processes((call) => {
      const env = call.options.env as Record<string, string>;
      const item = net.createServer((socket) => socket.end());
      item.listen({ port: Number(env.PORT), host: "0.0.0.0" }, () => listeners.push(item));
      return { hang: true };
    });
    const repo = await project();
    const result = await (await startProjectServer({ path: repo.path, script: "dev", startedBy: "user" })).ready;
    expect(result.status).toBe("exited");
    expect(result.logs).toContain("para todas as redes");
    expect(
      wildcardListeners(
        "sl local\n 0: 00000000:1F90 00000000:0000 0A\n 1: 0100007F:1F91 00000000:0000 0A\n 2: 00000000:1F92 0:0 01\nshort",
      ),
    ).toEqual(new Set([8080]));
    const fs = await import("node:fs/promises");
    const read = spyOn(fs, "readFile").mockRejectedValue(new Error("no proc"));
    try {
      expect(await listensEverywhere(8080)).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  test("starts from a profile or a command and validates input", async () => {
    processes();
    const repo = await project();
    await saveProfile({ id: "api", name: "API", path: repo.path, script: "api" });
    const viaCmd = await startProjectServer({ path: repo.path, cmd: "npm run api -- --x", startedBy: "user" });
    expect(viaCmd.server.tool).toBe("wrangler");
    expect(viaCmd.server.command).toBe(`npm run api -- --x --port ${viaCmd.server.port} --ip 127.0.0.1`);
    await viaCmd.ready;
    const duplicate = await startProjectServer({ profile: "api", startedBy: "bot" }).catch((error) => error);
    expect(duplicate).toBeInstanceOf(ServerRunning);
    expect(duplicate.server.id).toBe(viaCmd.server.id);
    expect(duplicate.message).toContain(`já está no ar em ${viaCmd.server.url}`);
    await Promise.all(listeners.splice(0).map((item) => new Promise((done) => item.close(done))));
    const fromProfile = await startProjectServer({
      profile: "api",
      replace: true,
      startedBy: "bot",
      botId: "b",
      sessionId: "s",
    });
    expect(fromProfile.server).toMatchObject({
      profileId: "api",
      tool: "wrangler",
      startedBy: "bot",
      botId: "b",
      sessionId: "s",
      port: viaCmd.server.port,
    });
    expect(getServer(viaCmd.server.id)?.status).toBe("stopped");
    await fromProfile.ready;
    const fromCmd = await startProjectServer({
      path: repo.path,
      cmd: "bun x.ts",
      port: 5990,
      replace: true,
      startedBy: "user",
    });
    expect(fromCmd.server).toMatchObject({ tool: "bun", startedBy: "user", botId: null, port: 5990 });
    await fromCmd.ready;
    await expect(startProjectServer({ profile: "zzz", startedBy: "user" })).rejects.toThrow("perfil zzz");
    await expect(startProjectServer({ path: repo.path, script: "nope", startedBy: "user" })).rejects.toThrow(
      "não tem o script",
    );
    await expect(startProjectServer({ path: repo.path, startedBy: "user" })).rejects.toThrow("script ou o comando");
  });
});

describe("routes", () => {
  test("lists, starts, reads logs, restarts, stops and removes servers", async () => {
    processes();
    const repo = await project();
    expect((await request("/servers")).body).toEqual({ servers: [] });
    const projects = await request<{ projects: Array<{ path: string }> }>("/servers/projects");
    expect(projects.body.projects.some((item) => item.path === repo.path)).toBe(true);
    const scripts = await request<{ scripts: unknown[] }>(`/servers/scripts?path=${encodeURIComponent(repo.path)}`);
    expect(scripts.body.scripts).toHaveLength(2);
    expect((await request("/servers/scripts?path=/etc")).status).toBe(400);

    const started = await request<{ server: { id: string; status: string } }>("/servers", {
      method: "POST",
      body: { path: repo.path, script: "dev", port: 5980 },
    });
    expect(started.status).toBe(202);
    const id = started.body.server.id;
    for (let i = 0; i < 100 && getServer(id)?.status !== "running"; i++) await Bun.sleep(20);
    expect((await request<{ status: string }>(`/servers/${id}`)).body.status).toBe("running");
    const logs = await request<{ lines: string[] }>(`/servers/${id}/logs?lines=5&query=ready`);
    expect(logs.body.lines[0]).toContain("\u001b[32mready");
    expect((await request<{ lines: string[] }>(`/servers/${id}/logs?query=zzz`)).body.lines).toEqual([]);
    expect((await request(`/servers/${id}/restart`, { method: "POST" })).status).toBe(202);
    for (let i = 0; i < 100 && getServer(id)?.status !== "running"; i++) await Bun.sleep(20);
    expect(
      (await request<{ server: { status: string } }>(`/servers/${id}/stop`, { method: "POST" })).body.server.status,
    ).toBe("stopped");
    await getServer(id)?.done;
    expect((await request(`/servers/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await request(`/servers/${id}`)).status).toBe(400);
    expect(
      (await request("/servers", { method: "POST", body: { path: repo.path, script: "dev", port: 1 } })).status,
    ).toBe(400);
    expect((await request("/servers", { method: "POST", body: "[1]" })).status).toBe(400);
    expect((await request("/servers", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await request("/servers/x/unknown", { method: "POST" })).status).toBe(404);
    expect((await request("/servers", { method: "POST", body: { path: repo.path, cmd: "x" } })).status).toBe(202);
  });

  test("reports launch failures as 400", async () => {
    processes();
    const repo = await project();
    const create = spyOn(net, "createServer").mockImplementation((() => {
      throw new Error("sem portas");
    }) as unknown as typeof net.createServer);
    try {
      const failed = await request<{ error: string }>("/servers", {
        method: "POST",
        body: { path: repo.path, script: "dev" },
      });
      expect(failed.status).toBe(400);
      expect(failed.body.error).toContain("sem portas");
    } finally {
      create.mockRestore();
    }
  });

  test("manages profiles", async () => {
    processes();
    const repo = await project();
    const saved = await request<{ profile: { id: string } }>("/servers/profiles", {
      method: "POST",
      body: { name: "App expo", path: repo.path, script: "dev" },
    });
    expect(saved.body.profile.id).toBe("app-expo");
    expect((await request<{ profiles: unknown[] }>("/servers/profiles")).body.profiles).toHaveLength(1);
    expect((await request("/servers/profiles/app-expo", { method: "DELETE" })).status).toBe(200);
    expect((await request("/servers/profiles/app-expo", { method: "DELETE" })).status).toBe(404);
    expect((await request("/servers/profiles", { method: "POST", body: {} })).status).toBe(400);
  });

  test("streams logs live", async () => {
    processes((call) => {
      const env = call.options.env as Record<string, string>;
      void listen(Number(env.PORT));
      call.child.stdout.write("first\n");
      setTimeout(() => call.child.stdout.write("second\n"), 150);
      return { hang: true };
    });
    const repo = await project();
    const { server: launched, ready } = await startProjectServer({ path: repo.path, script: "dev", startedBy: "user" });
    await ready;
    const controller = new AbortController();
    const response = await fetch(`${server.url}/servers/${launched.id}/logs/stream?lines=bad`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (reader && !text.includes("second")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain('"type":"snapshot"');
    expect(text).toContain("first");
    await stopServer(launched.id);
    while (reader && !text.includes('"type":"server"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain('"status":"stopped"');
    controller.abort();
    expect(listServers().some((item) => item.id === launched.id)).toBe(true);
  });
});

describe("bot tools", () => {
  function harness(approval: "approve" | "deny" = "approve") {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const context = {
      botId: "bot1",
      sessionId: "s1",
      turnId: "turn1",
      runId: () => "run1",
      log: {
        emit: (event: { type: string; data: Record<string, unknown> }) => events.push(event),
      } as unknown as EventLog,
      origin: null,
      ownerCallId: null,
      signal: new AbortController().signal,
      onCallStart: () => undefined,
      onCallEnd: () => undefined,
      onCallSettled: () => undefined,
      emitDecision: () => undefined,
      requestApproval: async () => ({ choice: approval, interactionId: "i1" }),
      bot: { id: "bot1", name: "Bot", role: "dev" } as BotDefinition,
      decisions: { autoApprove: false, threshold: 0.7 },
      request: "",
      provider: "claude",
    } as unknown as ToolContext;
    const tools = new Map<
      string,
      (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>
    >();
    registerServerTools(
      { registerTool: (name: string, _c: unknown, handler: never) => tools.set(name, handler) } as unknown as McpServer,
      context,
    );
    const call = (name: string, args: Record<string, unknown> = {}) => {
      const handler = tools.get(name);
      if (!handler) throw new Error(name);
      return handler(args);
    };
    return { call, events };
  }

  test("starts, lists, reads logs, restarts and stops with server cards", async () => {
    processes();
    const repo = await project();
    await saveProfile({ name: "Web", path: repo.path, script: "dev" });
    const { call, events } = harness();
    const started = await call("server_start", { project: repo.name, script: "dev" });
    expect(started.isError).toBeUndefined();
    expect(started.content[0].text).toContain("No ar:");
    const id = String(events.find((event) => event.type === "server.card")?.data.serverId);
    const listed = JSON.parse((await call("server_list")).content[0].text);
    expect(listed.servers[0].id).toBe(id);
    expect(listed.profiles[0].id).toBe("web");
    expect(listed.projects.some((item: { name: string }) => item.name === repo.name)).toBe(true);
    expect((await call("server_logs", { id, query: "ready" })).content[0].text).toContain("ready");
    expect((await call("server_logs", { id: "nope" })).isError).toBe(true);
    expect((await call("server_logs", { id, query: "zzz" })).content[0].text).toContain("(sem linhas)");
    expect((await call("server_restart", { id })).content[0].text).toContain("No ar de novo");
    expect((await call("server_stop", { id })).content[0].text).toContain("Parado");
    expect((await call("server_stop", { id: "nope" })).isError).toBe(true);
    expect(events.filter((event) => event.type === "server.card")).toHaveLength(5);
    expect(events.filter((event) => event.type === "call.settled").length).toBeGreaterThanOrEqual(5);
  });

  test("asks before a free command and reports failures", async () => {
    processes(() => ({ code: 2 }));
    const repo = await project();
    const denied = harness("deny");
    expect((await denied.call("server_start", { project: repo.name, cmd: "node x.js" })).isError).toBe(true);
    const approved = harness();
    const exited = await approved.call("server_start", {
      project: repo.name,
      branch: undefined,
      cmd: "node x.js",
      port: 5970,
      cwd: ".",
    });
    expect(exited.isError).toBe(true);
    expect(exited.content[0].text).toContain("saiu antes de responder");
    const id = String(approved.events.find((event) => event.type === "server.card")?.data.serverId);
    await getServer(id)?.done;
    expect((await approved.call("server_restart", { id })).content[0].text).toContain("Saiu");
    expect((await approved.call("server_start", { project: "nope-x", script: "dev" })).isError).toBe(true);
    expect((await approved.call("server_start", { profile: "nope-x", branch: "main" })).isError).toBe(true);
  });
});
