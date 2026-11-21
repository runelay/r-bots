import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { childEnv } from "@runelay-bots/providers/proc";
import { dataDir } from "../../../config/env";
import { redactText } from "../../../shared/redact";
import { macDeviceCall } from "../../accounts/services/mac-runner.service";
import { getServer, listServers } from "../../code/services/dev-server.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { resolveProject } from "../../servers/services/projects.service";
import { optionalTool } from "../../tools/services/tools.service";

export type TestKind = "maestro" | "playwright";
export type TestStatus = "running" | "passed" | "failed" | "error";

export interface TestStep {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number | null;
  error?: string;
}

export interface TestInput {
  kind: TestKind;
  path: string;
  project?: string;
  branch?: string;
  udid?: string;
  server?: string;
  baseUrl?: string;
  grep?: string;
}

export interface TestRun {
  id: string;
  kind: TestKind;
  title: string;
  target: string;
  status: TestStatus;
  attempt: number;
  startedAt: string;
  durationMs: number | null;
  steps: TestStep[];
  error: string | null;
  screenshot: boolean;
  artifacts: string[];
  botId: string | null;
  sessionId: string | null;
  input: TestInput;
}

type Listener = (run: TestRun) => void;

const runs = new Map<string, TestRun>();
const listeners = new Set<Listener>();
export const testsDir = join(dataDir, "tests");
export const playwrightDir = join(dataDir, "tools", "playwright");
const browsersDir = join(playwrightDir, "browsers");
const playwrightVersion = "1.64.1";

function runDir(id: string) {
  return join(testsDir, id);
}

export function onTestRun(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(run: TestRun) {
  runs.set(run.id, run);
  void writeFile(join(runDir(run.id), "run.json"), JSON.stringify(run)).catch(() => undefined);
  if (run.sessionId) getStoredSession(run.sessionId)?.log.emit({ type: "test.result", data: publicRun(run) });
  for (const listener of listeners) listener(run);
}

export function publicRun(run: TestRun) {
  const { input, ...rest } = run;
  return { ...rest, path: input.path };
}

export async function getRun(id: string) {
  if (!/^tst_[a-f0-9]{10}$/.test(id)) return null;
  const cached = runs.get(id);
  if (cached) return cached;
  try {
    const run = JSON.parse(await readFile(join(runDir(id), "run.json"), "utf8")) as TestRun;
    runs.set(id, run);
    return run;
  } catch {
    return null;
  }
}

export function runFile(id: string, name: string) {
  const path = resolve(runDir(id), name);
  return relative(runDir(id), path).startsWith("..") || isAbsolute(relative(runDir(id), path)) ? null : path;
}

export function isLocalUrl(url: string) {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function readTarget(input: TestInput) {
  const project = await resolveProject({
    ...(input.project ? { project: input.project } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(!input.project ? { path: dirname(input.path) } : {}),
  });
  const file = isAbsolute(input.path) ? input.path : join(project.path, input.path);
  if (relative(project.path, file).startsWith("..")) throw new Error("O arquivo precisa ficar dentro do projeto.");
  return { project, file };
}

export function maestroSteps(result: Record<string, unknown>): TestStep[] {
  return (Array.isArray(result.steps) ? result.steps : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      name: String(item.name ?? "passo"),
      status:
        item.status === "failed"
          ? ("failed" as const)
          : item.status === "skipped"
            ? ("skipped" as const)
            : ("passed" as const),
      durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
      ...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
    }));
}

async function runMaestro(run: TestRun, signal?: AbortSignal) {
  const { file } = await readTarget(run.input);
  const flow = await readFile(file, "utf8");
  const result = await macDeviceCall(
    "maestro.run",
    { flow, name: basename(file), ...(run.input.udid ? { udid: run.input.udid } : {}) },
    15 * 60_000,
    signal,
  );
  run.steps = maestroSteps(result);
  run.target = String(result.device ?? run.target);
  if (typeof result.screenshot === "string" && result.screenshot) {
    await writeFile(join(runDir(run.id), "screenshot.jpg"), Buffer.from(result.screenshot, "base64"));
    run.screenshot = true;
  }
  await writeFile(join(runDir(run.id), "log.txt"), redactText(String(result.log ?? "")));
  run.artifacts = ["log.txt"];
  run.error = typeof result.error === "string" && result.error ? result.error : null;
  return result.passed === true;
}

export function playwrightConfig(testDir: string, baseURL: string, outputDir: string, chrome: string | null) {
  return `export default {
  testDir: ${JSON.stringify(testDir)},
  outputDir: ${JSON.stringify(outputDir)},
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [["json", { outputFile: ${JSON.stringify(join(outputDir, "report.json"))} }]],
  use: {
    baseURL: ${JSON.stringify(baseURL)},
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: { mode: "retain-on-failure", size: { width: 960, height: 600 } },
    launchOptions: ${chrome ? `{ executablePath: ${JSON.stringify(chrome)}, args: ["--no-sandbox"] }` : "{}"},
  },
};
`;
}

interface PlaywrightResult {
  status?: string;
  duration?: number;
  errors?: Array<{ message?: string }>;
  attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
  steps?: Array<{ title?: string; duration?: number; error?: { message?: string } }>;
}

interface PlaywrightSuite {
  title?: string;
  specs?: Array<{ title?: string; tests?: Array<{ results?: PlaywrightResult[] }> }>;
  suites?: PlaywrightSuite[];
}

export function playwrightSteps(report: { suites?: PlaywrightSuite[]; errors?: Array<{ message?: string }> }) {
  const steps: TestStep[] = [];
  const attachments: Array<{ name: string; path: string }> = [];
  const strip = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const visit = (suite: PlaywrightSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const result = test.results?.at(-1);
        if (!result) continue;
        const failed = result.status !== "passed" && result.status !== "skipped";
        const inner = (result.steps ?? []).filter((step) => step.title);
        if (inner.length > 0) {
          for (const step of inner)
            steps.push({
              name: `${spec.title} › ${step.title}`,
              status: step.error ? "failed" : "passed",
              durationMs: step.duration ?? null,
              ...(step.error?.message ? { error: strip(step.error.message).slice(0, 600) } : {}),
            });
          if (failed && !inner.some((step) => step.error))
            steps.push({
              name: String(spec.title ?? "teste"),
              status: "failed",
              durationMs: result.duration ?? null,
              error: strip(result.errors?.[0]?.message ?? "falhou").slice(0, 600),
            });
        } else {
          steps.push({
            name: String(spec.title ?? "teste"),
            status: result.status === "skipped" ? "skipped" : failed ? "failed" : "passed",
            durationMs: result.duration ?? null,
            ...(failed ? { error: strip(result.errors?.[0]?.message ?? "falhou").slice(0, 600) } : {}),
          });
        }
        for (const item of result.attachments ?? [])
          if (item.path && item.name) attachments.push({ name: item.name, path: item.path });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const error = report.errors?.[0]?.message ? strip(report.errors[0].message).slice(0, 600) : null;
  return { steps, attachments, error };
}

export async function agentBrowserChrome(home = homedir()) {
  const root = join(home, ".agent-browser", "browsers");
  const entries = await readdir(root).catch(() => [] as string[]);
  const chrome = entries
    .filter((name) => name.startsWith("chrome-"))
    .sort()
    .at(-1);
  return chrome ? join(root, chrome, "chrome") : null;
}

export async function playwrightInstalled() {
  try {
    await readFile(join(playwrightDir, "node_modules", "@playwright", "test", "package.json"), "utf8");
  } catch {
    return false;
  }
  return (await readdir(browsersDir).catch(() => [] as string[])).some((name) => name.startsWith("ffmpeg"));
}

async function quiet(argv: string[], spawn: typeof Bun.spawn) {
  const child = spawn(argv, {
    cwd: playwrightDir,
    env: childEnv({ PLAYWRIGHT_BROWSERS_PATH: browsersDir }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} falhou: ${(err || out).slice(-600)}`);
}

export async function installPlaywright(spawn = Bun.spawn) {
  await mkdir(playwrightDir, { recursive: true });
  await writeFile(
    join(playwrightDir, "package.json"),
    JSON.stringify({ name: "runelay-playwright", private: true, type: "module" }),
  );
  await quiet(["npm", "install", "--no-audit", "--no-fund", `@playwright/test@${playwrightVersion}`], spawn);
  await quiet(["npx", "playwright", "install", "ffmpeg"], spawn);
  return true;
}

function baseUrlOf(input: TestInput) {
  if (input.server) {
    const server = getServer(input.server);
    if (server?.status !== "running") throw new Error("Esse servidor não está no ar.");
    return `http://localhost:${server.port}`;
  }
  if (input.baseUrl) return input.baseUrl;
  const web = listServers().find((item) => item.status === "running" && item.tool !== "expo");
  if (!web) throw new Error("Diga o servidor (server) ou a URL base (baseUrl).");
  return `http://localhost:${web.port}`;
}

async function runPlaywright(run: TestRun, signal?: AbortSignal) {
  if (!(await playwrightInstalled())) throw new Error("O Playwright ainda não está instalado. Use playwright_install.");
  const { file } = await readTarget(run.input);
  const baseURL = baseUrlOf(run.input);
  run.target = baseURL;
  const work = join(playwrightDir, "runs", run.id);
  const output = join(runDir(run.id), "output");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(work, basename(file)), await readFile(file, "utf8"));
  await writeFile(
    join(work, "playwright.config.mjs"),
    playwrightConfig(work, baseURL, output, (await optionalTool("chrome")) ?? (await agentBrowserChrome())),
  );
  const args = ["playwright", "test", "--config", join(work, "playwright.config.mjs")];
  if (run.input.grep) args.push("--grep", run.input.grep);
  const child = Bun.spawn(["npx", ...args], {
    cwd: playwrightDir,
    env: childEnv({ CI: "1", FORCE_COLOR: "0", PLAYWRIGHT_BROWSERS_PATH: browsersDir }),
    stdout: "pipe",
    stderr: "pipe",
  });
  signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  const [out, err] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  await writeFile(join(runDir(run.id), "log.txt"), redactText(`${out}\n${err}`));
  const report = JSON.parse(await readFile(join(output, "report.json"), "utf8").catch(() => "{}")) as Parameters<
    typeof playwrightSteps
  >[0];
  const parsed = playwrightSteps(report);
  run.steps = parsed.steps;
  run.error =
    parsed.error ?? (parsed.steps.length === 0 ? (err || out).trim().slice(-600) || "Nenhum teste rodou." : null);
  run.artifacts = ["log.txt"];
  for (const item of parsed.attachments) {
    const name =
      item.name === "screenshot"
        ? "screenshot.png"
        : item.name === "video"
          ? "video.webm"
          : item.name === "trace"
            ? "trace.zip"
            : null;
    if (!name) continue;
    const copied = await readFile(item.path)
      .then((data) => writeFile(join(runDir(run.id), name), data))
      .then(
        () => true,
        () => false,
      );
    if (!copied) continue;
    if (name === "screenshot.png") run.screenshot = true;
    run.artifacts.push(name);
  }
  await rm(work, { recursive: true, force: true });
  return parsed.steps.length > 0 && parsed.steps.every((step) => step.status !== "failed") && !parsed.error;
}

export async function execute(run: TestRun, signal?: AbortSignal) {
  const started = Date.now();
  try {
    const passed = run.kind === "maestro" ? await runMaestro(run, signal) : await runPlaywright(run, signal);
    run.status = passed ? "passed" : "failed";
  } catch (error) {
    run.status = "error";
    run.error = error instanceof Error ? error.message : String(error);
  }
  run.durationMs = Date.now() - started;
  publish(run);
  return run;
}

export async function startRun(
  input: TestInput,
  owner: { botId: string | null; sessionId: string | null },
  signal?: AbortSignal,
) {
  const id = `tst_${randomBytes(5).toString("hex")}`;
  await mkdir(runDir(id), { recursive: true });
  const run: TestRun = {
    id,
    kind: input.kind,
    title: basename(input.path),
    target: input.kind === "maestro" ? "simulador" : (input.baseUrl ?? input.server ?? "prévia local"),
    status: "running",
    attempt: 1,
    startedAt: new Date().toISOString(),
    durationMs: null,
    steps: [],
    error: null,
    screenshot: false,
    artifacts: [],
    botId: owner.botId,
    sessionId: owner.sessionId,
    input,
  };
  publish(run);
  return { run, done: execute(run, signal) };
}

export async function rerun(id: string) {
  const run = await getRun(id);
  if (!run) return null;
  if (run.status === "running") throw new Error("Esse teste ainda está rodando.");
  await rm(runDir(id), { recursive: true, force: true });
  await mkdir(runDir(id), { recursive: true });
  Object.assign(run, {
    status: "running",
    attempt: run.attempt + 1,
    startedAt: new Date().toISOString(),
    durationMs: null,
    steps: [],
    error: null,
    screenshot: false,
    artifacts: [],
  });
  publish(run);
  return { run, done: execute(run) };
}
