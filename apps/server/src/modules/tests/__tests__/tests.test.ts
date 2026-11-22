import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { codeProcesses, makeRepo } from "../../../../test/code-helpers";
import { type ProcessCall, request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import * as macRunner from "../../accounts/services/mac-runner.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import { forgetServer, getServer, listServers, stopAllDevServers } from "../../code/services/dev-server.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import * as workspaces from "../../code/services/workspace.service";
import * as sessions from "../../conversations/services/sessions.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { startProjectServer } from "../../servers/services/servers.service";
import {
  agentBrowserChrome,
  getRun,
  installPlaywright,
  isLocalUrl,
  maestroSteps,
  onTestRun,
  playwrightConfig,
  playwrightDir,
  playwrightInstalled,
  playwrightSteps,
  publicRun,
  rerun,
  runFile,
  startRun,
  type TestRun,
} from "../services/test-runs.service";
import {
  playwrightBudgetMessage,
  playwrightRunsPerTurn,
  registerTestTools,
  runSummary,
  takePlaywrightRun,
} from "../services/test-tools.service";

let server: TestServer;
const spies: Mock<(...args: never[]) => unknown>[] = [];
const listeners: net.Server[] = [];
let counter = 0;

function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const created = spyOn(target, key as never) as unknown as Mock<(...args: never[]) => unknown>;
  spies.push(created);
  return created;
}

function maestroReply(result: Record<string, unknown>) {
  spy(macRunner, "macDeviceCall").mockImplementation((async () => result) as never);
}

async function repo(files: Record<string, string> = {}) {
  counter++;
  return makeRepo(`tests-${counter}`, {
    files: {
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      ".maestro/home.yaml": "appId: com.x\n---\n- launchApp\n",
      "e2e/login.spec.ts": 'import { test } from "@playwright/test";\ntest("abre", async () => {});\n',
      ...files,
    },
  });
}

async function webServer(path: string) {
  const { server: launched, ready } = await startProjectServer({ path, script: "dev", startedBy: "user" });
  await ready;
  return launched.id;
}

const passingReport = {
  suites: [
    {
      specs: [
        {
          title: "login",
          tests: [
            {
              results: [
                {
                  status: "passed",
                  duration: 900,
                  steps: [
                    { title: "abre a página", duration: 400 },
                    { title: "vê o formulário", duration: 500 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function installReply(call: ProcessCall) {
  if (call.command === "npm") {
    mkdirSync(join(playwrightDir, "node_modules", "@playwright", "test"), { recursive: true });
    writeFileSync(join(playwrightDir, "node_modules", "@playwright", "test", "package.json"), "{}");
    return { code: 0, stdout: "added 3 packages" };
  }
  if (call.command === "npx" && call.args[1] === "install") {
    expect((call.options.env as Record<string, string>).PLAYWRIGHT_BROWSERS_PATH).toBe(join(playwrightDir, "browsers"));
    mkdirSync(join(playwrightDir, "browsers", "ffmpeg-1013"), { recursive: true });
    return { code: 0 };
  }
  return undefined;
}

function playwrightProcesses(report: unknown, attachments: Record<string, string> = {}) {
  return codeProcesses((call: ProcessCall) => {
    if (call.command === "bash") {
      const env = call.options.env as Record<string, string>;
      const item = net.createServer((socket) => socket.end());
      item.listen({ port: Number(env.PORT), host: "127.0.0.1" }, () => listeners.push(item));
      return { hang: true };
    }
    const installed = installReply(call);
    if (installed) return installed;
    if (call.command === "npx") {
      const config = call.args[call.args.indexOf("--config") + 1];
      const source = Bun.file(config);
      void source.text().then(async (text) => {
        const output = JSON.parse(text.match(/outputDir: (".*?"),/)?.[1] ?? '""') as string;
        await mkdir(output, { recursive: true });
        for (const [name, content] of Object.entries(attachments)) await writeFile(join(output, name), content);
        if (report !== null) await writeFile(join(output, "report.json"), JSON.stringify(report));
        call.child.finish({ code: 0, stdout: "1 passed" });
      });
      return { hang: true };
    }
    return undefined;
  });
}

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
  await rm(playwrightDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const item of spies.splice(0)) item.mockRestore();
  spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  stopAllDevServers();
  for (const item of listServers()) {
    const live = getServer(item.id);
    if (live?.child) live.child.kill();
    if (live) {
      await live.done;
      forgetServer(live);
    }
  }
  spyOn(process, "kill").mockRestore();
  await Promise.all(listeners.splice(0).map((item) => new Promise((done) => item.close(done))));
});

describe("parsers", () => {
  test("reads Maestro steps, Playwright reports and local URLs", () => {
    expect(
      maestroSteps({
        steps: [
          { name: "Tocar “Entrar”", status: "passed", durationMs: 120 },
          { name: "Ver", status: "failed", error: "não achei" },
          { status: "skipped" },
          null,
        ],
      }),
    ).toEqual([
      { name: "Tocar “Entrar”", status: "passed", durationMs: 120 },
      { name: "Ver", status: "failed", durationMs: null, error: "não achei" },
      { name: "passo", status: "skipped", durationMs: null },
    ]);
    expect(maestroSteps({})).toEqual([]);
    expect(playwrightSteps(passingReport).steps.map((step) => step.name)).toEqual([
      "login › abre a página",
      "login › vê o formulário",
    ]);
    const failing = playwrightSteps({
      errors: [{ message: "\u001b[31mconfig quebrada\u001b[0m" }],
      suites: [
        {
          suites: [
            {
              specs: [
                {
                  title: "a",
                  tests: [
                    {
                      results: [
                        {
                          status: "failed",
                          duration: 5,
                          errors: [{ message: "boom" }],
                          steps: [{ title: "passo", duration: 3 }],
                          attachments: [{ name: "screenshot", path: "/x.png" }, { name: "trace" }],
                        },
                      ],
                    },
                    { results: [] },
                  ],
                },
                { title: "b", tests: [{ results: [{ status: "failed", errors: [] }] }] },
                { title: "c", tests: [{ results: [{ status: "skipped" }] }] },
                {
                  tests: [{ results: [{ status: "timedOut", steps: [{ title: "s", error: { message: "lento" } }] }] }],
                },
                {},
              ],
            },
          ],
        },
      ],
    });
    expect(failing.error).toBe("config quebrada");
    expect(failing.steps.map((step) => [step.name, step.status, step.error ?? ""])).toEqual([
      ["a › passo", "passed", ""],
      ["a", "failed", "boom"],
      ["b", "failed", "falhou"],
      ["c", "skipped", ""],
      ["undefined › s", "failed", "lento"],
    ]);
    expect(failing.attachments).toEqual([{ name: "screenshot", path: "/x.png" }]);
    expect(playwrightSteps({}).error).toBeNull();
    expect(isLocalUrl("http://localhost:5310")).toBe(true);
    expect(isLocalUrl("https://app.example.com")).toBe(false);
    expect(isLocalUrl("nada")).toBe(false);
    expect(playwrightConfig("/t", "http://localhost:1", "/o", null)).toContain("launchOptions: {}");
    expect(playwrightConfig("/t", "http://localhost:1", "/o", "/c")).toContain(
      '"executablePath":'.replace(":", "") === "" ? "" : "executablePath",
    );
  });

  test("finds the agent-browser Chrome", async () => {
    const home = join(process.env.HOST_HOME as string, `home-${++counter}`);
    expect(await agentBrowserChrome(home)).toBeNull();
    mkdirSync(join(home, ".agent-browser", "browsers", "chrome-1"), { recursive: true });
    mkdirSync(join(home, ".agent-browser", "browsers", "chrome-2"), { recursive: true });
    mkdirSync(join(home, ".agent-browser", "browsers", "firefox"), { recursive: true });
    expect(await agentBrowserChrome(home)).toBe(join(home, ".agent-browser", "browsers", "chrome-2", "chrome"));
    const fakeHome = spyOn(os, "homedir").mockReturnValue(home);
    try {
      expect(await agentBrowserChrome()).toBe(join(home, ".agent-browser", "browsers", "chrome-2", "chrome"));
    } finally {
      fakeHome.mockRestore();
    }
  });
});

describe("runs", () => {
  test("runs a Maestro flow, stores the result and reruns it", async () => {
    codeProcesses();
    const project = await repo();
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    spy(sessions, "getStoredSession").mockImplementation((() => ({
      log: { emit: (event: { type: string; data: Record<string, unknown> }) => emitted.push(event) },
    })) as never);
    const seen: string[] = [];
    const off = onTestRun((run) => seen.push(run.status));
    maestroReply({
      passed: true,
      device: "iPhone 17 Pro · iOS 26.5",
      steps: [{ name: "Abrir o app", status: "passed", durationMs: 800 }],
      screenshot: Buffer.from("jpg").toString("base64"),
      log: "ok",
    });
    const { run, done } = await startRun(
      { kind: "maestro", path: ".maestro/home.yaml", project: project.name },
      { botId: "b", sessionId: "s" },
    );
    expect(run.status).toBe("running");
    const finished = await done;
    expect(finished).toMatchObject({ status: "passed", target: "iPhone 17 Pro · iOS 26.5", screenshot: true });
    expect(emitted.map((event) => event.data.status)).toEqual(["running", "passed"]);
    expect(publicRun(finished)).toMatchObject({ path: ".maestro/home.yaml" });
    expect(publicRun(finished)).not.toHaveProperty("input");
    expect((await getRun(finished.id))?.status).toBe("passed");
    expect(await getRun("bad")).toBeNull();
    expect(await getRun("tst_0000000000")).toBeNull();
    const stored = join(process.env.BOTS_DATA_DIR as string, "tests", "tst_abcdefabcd");
    mkdirSync(stored, { recursive: true });
    writeFileSync(join(stored, "run.json"), JSON.stringify({ ...finished, id: "tst_abcdefabcd" }));
    expect((await getRun("tst_abcdefabcd"))?.title).toBe("home.yaml");
    expect(runFile(finished.id, "../x")).toBeNull();
    expect(runFile(finished.id, "log.txt")).toContain(finished.id);

    for (const item of spies.splice(0)) item.mockRestore();
    maestroReply({ passed: false, steps: [{ name: "Ver", status: "failed", error: "sumiu" }], error: "sumiu" });
    const again = await rerun(finished.id);
    expect(again?.run.attempt).toBe(2);
    await expect(rerun(finished.id)).rejects.toThrow("ainda está rodando");
    const failed = await again?.done;
    expect(failed).toMatchObject({
      status: "failed",
      error: "sumiu",
      screenshot: false,
      target: "iPhone 17 Pro · iOS 26.5",
    });
    expect(await rerun("tst_ffffffffff")).toBeNull();
    off();
    expect(seen).toEqual(["running", "passed", "running", "failed"]);
  });

  test("reports a run that cannot start", async () => {
    codeProcesses();
    const project = await repo();
    const { done } = await startRun(
      { kind: "maestro", path: "../fora.yaml", project: project.name },
      { botId: null, sessionId: null },
    );
    expect((await done).error).toContain("dentro do projeto");
    spy(macRunner, "macDeviceCall").mockImplementation((async () => {
      throw "sem mac";
    }) as never);
    const second = await startRun({ kind: "maestro", path: ".maestro/home.yaml", path2: 1 } as never, {
      botId: null,
      sessionId: null,
    });
    expect((await second.done).status).toBe("error");
  });

  test("installs Playwright and runs a spec against a local server", async () => {
    playwrightProcesses(passingReport);
    const project = await repo();
    const id = await webServer(project.path);
    const notInstalled = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name },
      { botId: null, sessionId: null },
    );
    expect((await notInstalled.done).error).toContain("playwright_install");
    expect(await playwrightInstalled()).toBe(false);
    expect(await installPlaywright()).toBe(true);
    expect(await playwrightInstalled()).toBe(true);
    const { done } = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name, server: id, grep: "abre" },
      { botId: null, sessionId: null },
    );
    const finished = await done;
    expect(finished.status).toBe("passed");
    expect(finished.target).toBe(`http://localhost:${getServer(id)?.port}`);
    const fallback = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name },
      { botId: null, sessionId: null },
    );
    expect((await fallback.done).status).toBe("passed");
    const explicit = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name, baseUrl: "http://localhost:9" },
      { botId: null, sessionId: null },
    );
    expect((await explicit.done).target).toBe("http://localhost:9");
    const gone = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name, server: "nope" },
      { botId: null, sessionId: null },
    );
    expect((await gone.done).error).toContain("não está no ar");
  });

  test("keeps failure artifacts and reports empty runs", async () => {
    const failing = {
      suites: [
        {
          specs: [
            {
              title: "login",
              tests: [{ results: [{ status: "failed", errors: [{ message: "sem formulário" }], attachments: [] }] }],
            },
          ],
        },
      ],
    };
    const fake = playwrightProcesses(failing, { "shot.png": "png", "video.webm": "vid", "trace.zip": "zip" });
    const project = await repo();
    await installPlaywright();
    const output = join(process.env.HOST_HOME as string, "attachments");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "shot.png"), "png");
    writeFileSync(join(output, "video.webm"), "vid");
    failing.suites[0].specs[0].tests[0].results[0].attachments = [
      { name: "screenshot", path: join(output, "shot.png") },
      { name: "video", path: join(output, "video.webm") },
      { name: "trace", path: join(output, "missing.zip") },
      { name: "outro", path: join(output, "shot.png") },
    ] as never;
    const { done } = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name, baseUrl: "http://localhost:9" },
      { botId: null, sessionId: null },
    );
    const finished = (await done) as TestRun;
    expect(finished).toMatchObject({ status: "failed", screenshot: true });
    expect(finished.artifacts).toEqual(["log.txt", "screenshot.png", "video.webm"]);
    fake.restore();
    playwrightProcesses(null);
    const empty = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name, baseUrl: "http://localhost:9" },
      { botId: null, sessionId: null },
    );
    expect((await empty.done).error).toBe("1 passed");
  });

  test("stops a Playwright run on abort and survives a deleted run folder", async () => {
    let child: ProcessCall["child"] | null = null;
    codeProcesses((call) => {
      const installed = installReply(call);
      if (installed) return installed;
      if (call.command === "npx") {
        child = call.child;
        return { hang: true };
      }
      return undefined;
    });
    const project = await repo();
    await installPlaywright();
    const controller = new AbortController();
    const { run, done } = await startRun(
      { kind: "playwright", path: "e2e/login.spec.ts", project: project.name, baseUrl: "http://localhost:9" },
      { botId: null, sessionId: null },
      controller.signal,
    );
    for (let i = 0; i < 200 && !child; i++) await Bun.sleep(5);
    await rm(join(process.env.BOTS_DATA_DIR as string, "tests", run.id), { recursive: true, force: true });
    controller.abort();
    const finished = await done;
    expect((child as unknown as { signals: string[] }).signals).toContain("SIGTERM");
    expect(finished.status).not.toBe("running");
  });

  test("fails the install when npm or the ffmpeg download fails", async () => {
    codeProcesses((call) => (call.command === "npm" ? { code: 1, stderr: "sem rede" } : undefined));
    await expect(installPlaywright()).rejects.toThrow("sem rede");
    codeProcesses((call) =>
      call.command === "npm"
        ? installReply(call)
        : call.command === "npx"
          ? { code: 1, stdout: "sem ffmpeg" }
          : undefined,
    );
    await expect(installPlaywright()).rejects.toThrow("npx playwright install falhou: sem ffmpeg");
    expect(await playwrightInstalled()).toBe(false);
  });
});

describe("routes", () => {
  test("serves the run, its files and reruns it", async () => {
    codeProcesses();
    const project = await repo();
    maestroReply({ passed: true, steps: [], screenshot: Buffer.from("jpg").toString("base64"), log: "linha" });
    const { done } = await startRun(
      { kind: "maestro", path: ".maestro/home.yaml", project: project.name },
      { botId: null, sessionId: null },
    );
    const run = await done;
    expect((await request<{ id: string }>(`/tests/${run.id}`)).body.id).toBe(run.id);
    const log = await request(`/tests/${run.id}/files/log.txt`);
    expect(log.text).toBe("linha");
    expect((await request(`/tests/${run.id}/files/screenshot.jpg`)).headers.get("content-type")).toBe("image/jpeg");
    expect((await request(`/tests/${run.id}/files/video.webm`)).status).toBe(404);
    expect((await request(`/tests/${run.id}/files/x.sh`)).status).toBe(404);
    expect((await request("/tests/tst_0000000000")).status).toBe(404);
    const again = await request<{ run: { attempt: number } }>(`/tests/${run.id}/rerun`, { method: "POST" });
    expect(again.status).toBe(202);
    expect(again.body.run.attempt).toBe(2);
    expect((await request(`/tests/${run.id}/rerun`, { method: "POST" })).status).toBe(409);
    for (let i = 0; i < 200 && (await getRun(run.id))?.status === "running"; i++) await Bun.sleep(5);
    expect((await request(`/tests/${run.id}/nada`, { method: "PUT" })).status).toBe(404);
  });
});

describe("tools", () => {
  function harness(choice: "approve" | "deny" = "approve", turnId = "turn1") {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const prompts: string[] = [];
    const context = {
      botId: "bot1",
      sessionId: "s1",
      turnId,
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
      requestApproval: async (prompt: string) => {
        prompts.push(prompt);
        return { choice, interactionId: "i1" };
      },
      bot: { id: "bot1", name: "Bot", role: "dev" } as BotDefinition,
      decisions: { autoApprove: false, threshold: 0.7 },
      request: "",
      provider: "claude",
    } as unknown as ToolContext;
    const tools = new Map<
      string,
      (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    >();
    registerTestTools(
      { registerTool: (name: string, _c: unknown, handler: never) => tools.set(name, handler) } as unknown as McpServer,
      context,
    );
    return {
      events,
      prompts,
      call: (name: string, args: Record<string, unknown> = {}) =>
        (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>)(args),
    };
  }

  test("runs Maestro and Playwright with the right approvals", async () => {
    playwrightProcesses(passingReport);
    const project = await repo();
    maestroReply({ passed: true, steps: [{ name: "Abrir o app", status: "passed" }], log: "" });
    const tools = harness();
    const maestro = await tools.call("test_maestro", {
      path: ".maestro/home.yaml",
      project: project.name,
      branch: "main",
      udid: "U1",
    });
    expect(maestro.content[0].text).toContain("Passou (1 passos");
    expect(tools.prompts).toEqual([]);
    const real = await tools.call("test_maestro", {
      path: ".maestro/home.yaml",
      project: project.name,
      writesRealData: true,
    });
    expect(real.isError).toBeUndefined();
    expect(tools.prompts).toHaveLength(1);
    await tools.call("playwright_install");
    expect(tools.prompts).toHaveLength(2);
    const web = await tools.call("test_playwright", {
      path: "e2e/login.spec.ts",
      project: project.name,
      baseUrl: "http://localhost:9",
      grep: "abre",
      branch: "main",
      server: undefined,
    });
    expect(web.content[0].text).toContain("Passou");
    expect(tools.prompts).toHaveLength(2);
    await tools.call("test_playwright", {
      path: "e2e/login.spec.ts",
      project: project.name,
      baseUrl: "https://app.example.com",
    });
    expect(tools.prompts.at(-1)).toContain("https://app.example.com");
    spy(workspaces, "activeWorkspace").mockImplementation((() => ({ path: project.path })) as never);
    const relative = await harness("approve", "turn-relative").call("test_playwright", {
      path: "e2e/login.spec.ts",
      baseUrl: "http://localhost:9",
    });
    expect(relative.content[0].text).toContain("Passou");
    expect(tools.events.some((event) => event.type === "call.settled")).toBe(true);

    for (const item of spies.splice(0)) item.mockRestore();
    spy(macRunner, "macDeviceCall").mockImplementation((async (op: string) =>
      op === "maestro.install" ? { installed: true } : {}) as never);
    expect((await tools.call("maestro_install")).content[0].text).toContain("Instalado");
    const denied = harness("deny");
    expect((await denied.call("maestro_install")).isError).toBe(true);
    expect(
      (
        await denied.call("test_playwright", {
          path: "e2e/login.spec.ts",
          project: project.name,
          server: "x",
          writesRealData: true,
        })
      ).isError,
    ).toBe(true);
    spy(macRunner, "macDeviceCall").mockImplementation((async () => {
      throw new Error("sem java");
    }) as never);
    expect((await tools.call("maestro_install")).content[0].text).toBe("sem java");
    const broken = await tools.call("test_maestro", { path: "../fora.yaml", project: project.name });
    expect(broken.isError).toBe(true);
    for (const item of spies.splice(0)) item.mockRestore();
    spy(macRunner, "macDeviceCall").mockImplementation((async () => {
      throw new Error("x");
    }) as never);
    const startFails = spy(await import("../services/test-runs.service"), "startRun").mockImplementation((async () => {
      throw new Error("disco cheio");
    }) as never);
    expect((await tools.call("test_maestro", { path: "a.yaml" })).content[0].text).toBe("disco cheio");
    startFails.mockRestore();
  });

  test("caps Playwright runs per turn and tells the bot to stop", async () => {
    expect(playwrightRunsPerTurn).toBe(3);
    expect(takePlaywrightRun("s9:turn1", 2)).toBe(true);
    expect(takePlaywrightRun("s9:turn1", 2)).toBe(true);
    expect(takePlaywrightRun("s9:turn1", 2)).toBe(false);
    expect(takePlaywrightRun("s9:turn2", 2)).toBe(true);
    for (let index = 0; index < 510; index++) takePlaywrightRun(`fill:${index}`, 1);
    expect(takePlaywrightRun("s9:turn1", 2)).toBe(true);
    for (let used = 0; used < playwrightRunsPerTurn; used++) expect(takePlaywrightRun("s1:turn-cap")).toBe(true);
    const tools = harness("approve", "turn-cap");
    const blocked = await tools.call("test_playwright", { path: "e2e/login.spec.ts" });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toBe(playwrightBudgetMessage());
    expect(blocked.content[0].text).toContain("3 vezes neste pedido");
    expect(tools.events).toEqual([]);
  });

  test("summarizes runs for the bot", () => {
    const base = { id: "tst_1", steps: [], durationMs: 1500, error: null } as unknown as TestRun;
    expect(runSummary({ ...base, status: "passed" })).toContain("Passou (0 passos, 2 s)");
    expect(
      runSummary({
        ...base,
        status: "failed",
        error: "sumiu",
        steps: [
          { name: "a", status: "passed", durationMs: 1 },
          { name: "b", status: "failed", durationMs: 1, error: "x" },
          { name: "c", status: "skipped", durationMs: null },
        ],
      }),
    ).toContain("✗ b — x\n– c\nErro: sumiu");
    expect(runSummary({ ...base, status: "error", error: null })).toContain("Não rodou: erro");
    expect(runSummary({ ...base, status: "passed", durationMs: null })).toContain("0 s");
  });
});
