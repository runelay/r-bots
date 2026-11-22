import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { toolsDir } from "../../../config/env";
import { withLanguage } from "../../../shared/i18n";
import { requiresOwner } from "../../auth/services/policy.service";
import { cutoutRuntime } from "../../images/services/cutout.service";
import type { SpawnResult } from "../../providers/types/providers.types";
import {
  chromeImagePath,
  chromeSha256,
  chromeUrl,
  chromeVersion,
  cutoutModel,
  cutoutVersion,
  pipWheel,
} from "../constants/tools.constants";
import {
  downloadFile,
  ensureTool,
  installTask,
  isToolName,
  listTools,
  optionalTool,
  requirementsText,
  sha256Of,
  startInstall,
  ToolError,
  useToolDeps,
} from "../services/tools.service";
import type { ToolDeps, ToolState } from "../types/tools.types";

interface Call {
  bin: string;
  args: string[];
}

const expected: Record<string, string> = {
  [chromeUrl]: chromeSha256,
  [pipWheel.url]: pipWheel.sha256,
  [cutoutModel.url]: cutoutModel.sha256,
};

let base = "";
let root = "";
let calls: Call[] = [];
let downloads: string[] = [];
let logs: string[] = [];
let gate: Promise<void> | null = null;
let badHash: string | null = null;
let unzipMode: "ok" | "fail" | "empty" = "ok";
let chromeReply: SpawnResult = { code: 0, stdout: `Google Chrome for Testing ${chromeVersion} \n`, stderr: "" };
let pythonVersion = "1.32.0";
let pipCode = 0;
let venvCode = 0;
let which: Record<string, string | null> = {};

async function fakeSpawn(bin: string, args: string[]): Promise<SpawnResult> {
  calls.push({ bin, args });
  if (bin === "/usr/bin/unzip") {
    if (unzipMode === "fail") return { code: 9, stdout: "", stderr: "bad zip\n" };
    if (unzipMode === "ok") {
      mkdirSync(join(args[3], "chrome-linux64", "locales"), { recursive: true, mode: 0o700 });
      writeFileSync(join(args[3], "chrome-linux64", "chrome"), "binary", { mode: 0o770 });
      writeFileSync(join(args[3], "chrome-linux64", "locales", "pt-BR.pak"), "pak", { mode: 0o600 });
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  if (bin.endsWith("/chrome")) return chromeReply;
  if (bin === "/usr/bin/python3") {
    if (venvCode !== 0) return { code: venvCode, stdout: "", stderr: "" };
    mkdirSync(join(args[3], "bin"), { recursive: true });
    writeFileSync(join(args[3], "bin", "python"), "");
    return { code: 0, stdout: "", stderr: "" };
  }
  if (args[1] === "install") return { code: pipCode, stdout: "", stderr: pipCode ? "no matching hash\n" : "" };
  if (args[1] === "-c") return { code: 0, stdout: `${pythonVersion}\n`, stderr: "" };
  return { code: 1, stdout: "", stderr: "" };
}

async function fakeDownload(url: string, file: string) {
  downloads.push(url);
  await gate;
  writeFileSync(file, url);
}

const fakes = (): Partial<ToolDeps> => ({
  root: () => root,
  arch: () => "x64",
  spawn: fakeSpawn,
  download: fakeDownload,
  hash: async (file) => badHash ?? expected[readFileSync(file, "utf8")] ?? "unknown",
  which: (names) => which[names[0]] ?? null,
  chromeOverride: () => null,
  images: { chrome: join(base, "image", "chrome", "chrome"), cutout: join(base, "image", "cutout") },
  log: (message) => logs.push(message),
});

function fakesWithout(...keys: Array<keyof ToolDeps>) {
  const deps = fakes();
  for (const key of keys) delete deps[key];
  return deps;
}

function stateOf(tool: string) {
  const found = listTools().find((item) => item.tool === tool);
  if (!found) throw new Error(`missing ${tool}`);
  return found;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "rb-tools-"));
  root = join(base, "tools");
  calls = [];
  downloads = [];
  logs = [];
  gate = null;
  badHash = null;
  unzipMode = "ok";
  chromeReply = { code: 0, stdout: `Google Chrome for Testing ${chromeVersion} \n`, stderr: "" };
  pythonVersion = "1.32.0";
  pipCode = 0;
  venvCode = 0;
  which = { unzip: "/usr/bin/unzip", python3: "/usr/bin/python3", chromium: null };
  useToolDeps(fakes());
});

afterEach(() => {
  useToolDeps(null);
  rmSync(base, { recursive: true, force: true });
});

describe("helpers", () => {
  test("hashes files, writes hashed requirements and downloads from a local server", async () => {
    const file = join(base, "x.txt");
    writeFileSync(file, "abc");
    expect(await sha256Of(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const text = requirementsText();
    expect(text).toContain("onnxruntime==1.32.0 --hash=sha256:");
    expect(text.trim().split("\n")).toHaveLength(7);
    expect(isToolName("chrome")).toBe(true);
    expect(isToolName("ffmpeg")).toBe(false);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => (req.url.endsWith("/ok") ? new Response("conteudo") : new Response("nope", { status: 404 })),
    });
    try {
      const target = join(base, "down.bin");
      await downloadFile(`http://127.0.0.1:${server.port}/ok`, target, 5_000);
      expect(readFileSync(target, "utf8")).toBe("conteudo");
      expect(downloadFile(`http://127.0.0.1:${server.port}/missing`, target, 5_000)).rejects.toThrow("status 404");
    } finally {
      await server.stop(true);
    }
  });
});

describe("chrome", () => {
  test("downloads once under a per-tool lock, swaps current atomically and prunes leftovers", async () => {
    mkdirSync(join(root, "chrome", "157.0.1.1"), { recursive: true });
    mkdirSync(join(root, "chrome", `${chromeVersion}.tmp`, "junk"), { recursive: true });
    let release = () => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = ensureTool("chrome");
    const second = ensureTool("chrome");
    expect(stateOf("chrome")).toMatchObject({ installed: false, installing: true });
    expect(startInstall("chrome").started).toBe(true);
    expect(existsSync(join(root, "chrome", chromeVersion))).toBe(false);
    expect(existsSync(join(root, "chrome", "current"))).toBe(false);
    release();
    const [one, two] = await Promise.all([first, second]);
    const target = join(root, "chrome", chromeVersion);
    expect(one).toBe(join(target, "chrome"));
    expect(two).toBe(one);
    expect(downloads).toEqual([chromeUrl]);
    expect(readlinkSync(join(root, "chrome", "current"))).toBe(chromeVersion);
    expect(readdirSync(join(root, "chrome")).sort()).toEqual([chromeVersion, "current"]);
    const modeOf = (path: string) => lstatSync(path).mode & 0o777;
    expect(modeOf(join(root, "chrome"))).toBe(0o755);
    expect(modeOf(target)).toBe(0o755);
    expect(modeOf(join(target, "chrome"))).toBe(0o755);
    expect(modeOf(join(target, "locales"))).toBe(0o755);
    expect(modeOf(join(target, "locales", "pt-BR.pak"))).toBe(0o644);
    expect(logs[0]).toBe("Baixando o navegador (uma vez só, ~200 MB)...");
    expect(calls.find((call) => call.bin === "/usr/bin/unzip")?.args.slice(0, 2)).toEqual([
      "-q",
      join(`${target}.tmp`, "chrome.zip"),
    ]);
    const state = stateOf("chrome");
    expect(state).toMatchObject({ installed: true, source: "managed", version: chromeVersion, installing: false });
    expect(state.sizeBytes).toBeGreaterThan(0);
    expect(await ensureTool("chrome")).toBe(one);
    expect(downloads).toHaveLength(1);
    expect(startInstall("chrome")).toMatchObject({ started: false, tool: { source: "managed" } });
  });

  test("rejects a download with the wrong checksum and retries on the next call", async () => {
    badHash = "0".repeat(64);
    await expect(ensureTool("chrome")).rejects.toThrow("não confere com o checksum esperado");
    expect(readdirSync(join(root, "chrome"))).toEqual([]);
    expect(stateOf("chrome")).toMatchObject({ installed: false, installing: false });
    expect(stateOf("chrome").lastError).toContain("checksum");
    expect(logs.at(-1)).toContain("Não consegui instalar o navegador");
    badHash = null;
    expect(await ensureTool("chrome")).toBe(join(root, "chrome", chromeVersion, "chrome"));
    expect(downloads).toHaveLength(2);
    expect(stateOf("chrome").lastError).toBeNull();
  });

  test("reports unzip failures, empty archives and a Chrome that does not open", async () => {
    unzipMode = "fail";
    await expect(ensureTool("chrome")).rejects.toThrow("Não consegui extrair o Chrome: bad zip");
    unzipMode = "empty";
    await expect(ensureTool("chrome")).rejects.toThrow("O pacote do Chrome veio sem o executável.");
    unzipMode = "ok";
    chromeReply = { code: 127, stdout: "", stderr: "libnss3.so: cannot open shared object file\n" };
    await expect(ensureTool("chrome")).rejects.toThrow("O Chrome baixado não abriu: libnss3.so");
    chromeReply = { code: 1, stdout: "", stderr: "" };
    await expect(ensureTool("chrome")).rejects.toThrow("O Chrome baixado não abriu: código 1");
    which.unzip = null;
    await expect(ensureTool("chrome")).rejects.toThrow("Não consegui extrair o Chrome: código 1");
    expect(calls.some((call) => call.bin === "unzip")).toBe(true);
    expect(readdirSync(join(root, "chrome"))).toEqual([]);
    expect(await optionalTool("chrome")).toBeNull();
  });

  test("a background install that fails records the error", async () => {
    badHash = "1".repeat(64);
    expect(startInstall("chrome").started).toBe(true);
    await installTask("chrome");
    expect(stateOf("chrome")).toMatchObject({ installing: false, installed: false });
    expect(stateOf("chrome").lastError).toContain("checksum");
  });

  test("installs under the configured tools dir by default", async () => {
    useToolDeps(fakesWithout("root"));
    const installed = await ensureTool("chrome");
    try {
      expect(installed).toBe(join(toolsDir, "chrome", chromeVersion, "chrome"));
    } finally {
      rmSync(toolsDir, { recursive: true, force: true });
    }
  });

  test("reuses a verified version left without the current link", async () => {
    const target = join(root, "chrome", chromeVersion);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "chrome"), "binary");
    expect(await ensureTool("chrome")).toBe(join(target, "chrome"));
    expect(downloads).toEqual([]);
    expect(readlinkSync(join(root, "chrome", "current"))).toBe(chromeVersion);
  });

  test("uses the Chrome still in the image and an explicit override", async () => {
    const image = join(base, "image", "chrome");
    mkdirSync(image, { recursive: true });
    writeFileSync(join(image, "chrome"), "binary");
    expect(await ensureTool("chrome")).toBe(join(image, "chrome"));
    expect(stateOf("chrome")).toMatchObject({ source: "image", version: null, path: join(image, "chrome") });
    expect(stateOf("chrome").sizeBytes).toBeGreaterThan(0);
    useToolDeps({ ...fakes(), chromeOverride: () => "/custom/chrome" });
    expect(await ensureTool("chrome")).toBe("/custom/chrome");
    expect(stateOf("chrome")).toMatchObject({ source: "override", sizeBytes: null });
    expect(downloads).toEqual([]);
  });

  test("on arm64 uses the system chromium or fails with a clear message", async () => {
    useToolDeps({ ...fakes(), arch: () => "arm64" });
    await expect(ensureTool("chrome")).rejects.toThrow("Use o chromium do sistema");
    await expect(withLanguage("en", () => ensureTool("chrome"))).rejects.toThrow("Use the system chromium");
    expect(() => startInstall("chrome")).toThrow(ToolError);
    which.chromium = "/usr/bin/chromium";
    expect(await ensureTool("chrome")).toBe("/usr/bin/chromium");
    expect(stateOf("chrome")).toMatchObject({ source: "system", sizeBytes: null });
    expect(downloads).toEqual([]);
  });

  test("default deps honor DESKTOP_CHROME unless it is the old image path", async () => {
    const previous = process.env.DESKTOP_CHROME;
    try {
      useToolDeps(null);
      process.env.DESKTOP_CHROME = "/elsewhere/chrome";
      expect(await ensureTool("chrome")).toBe("/elsewhere/chrome");
      process.env.DESKTOP_CHROME = chromeImagePath;
      useToolDeps(fakesWithout("chromeOverride", "arch", "log"));
      const print = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await ensureTool("chrome")).toBe(join(root, "chrome", chromeVersion, "chrome"));
        expect(print).toHaveBeenCalledWith("Baixando o navegador (uma vez só, ~200 MB)...");
      } finally {
        print.mockRestore();
      }
    } finally {
      process.env.DESKTOP_CHROME = previous;
    }
  });
});

describe("cutout", () => {
  test("builds the venv with hashed pins, downloads the model and leaves no pip behind", async () => {
    const dir = await ensureTool("cutout");
    const target = join(root, "cutout", cutoutVersion);
    expect(dir).toBe(target);
    expect(downloads).toEqual([pipWheel.url, cutoutModel.url]);
    expect(existsSync(join(target, "models", cutoutModel.name))).toBe(true);
    expect(existsSync(join(target, ".download"))).toBe(false);
    expect(readlinkSync(join(root, "cutout", "current"))).toBe(cutoutVersion);
    const venv = calls.find((call) => call.bin === "/usr/bin/python3");
    expect(venv?.args).toEqual(["-m", "venv", "--without-pip", `${target}.tmp`]);
    const pip = calls.find((call) => call.args[1] === "install");
    expect(pip?.args[0]).toBe(join(`${target}.tmp`, ".download", pipWheel.name, "pip"));
    expect(pip?.args).toContain("--require-hashes");
    expect(pip?.args).toContain("--no-deps");
    expect(logs[0]).toBe("Baixando o recorte de imagem (uma vez só, ~260 MB)...");
    expect(stateOf("cutout")).toMatchObject({ installed: true, source: "managed", version: cutoutVersion });
  });

  test("reports a missing python3, venv, pip and import failures", async () => {
    which.python3 = null;
    await expect(ensureTool("cutout")).rejects.toThrow("precisa do python3 do sistema");
    which.python3 = "/usr/bin/python3";
    venvCode = 1;
    await expect(ensureTool("cutout")).rejects.toThrow("Não consegui criar o ambiente Python: código 1");
    venvCode = 0;
    pipCode = 1;
    await expect(ensureTool("cutout")).rejects.toThrow("O pip não instalou o recorte: no matching hash");
    pipCode = 0;
    pythonVersion = "1.0.0";
    await expect(ensureTool("cutout")).rejects.toThrow("O Python do recorte não carregou: 1.0.0");
    expect(readdirSync(join(root, "cutout"))).toEqual([]);
  });

  test("falls back to the venv in the image and feeds the cutout runtime", async () => {
    const image = join(base, "image", "cutout");
    mkdirSync(join(image, "bin"), { recursive: true });
    mkdirSync(join(image, "models"), { recursive: true });
    writeFileSync(join(image, "bin", "python"), "");
    writeFileSync(join(image, "models", cutoutModel.name), "");
    const previous = process.env.IMAGE_CUTOUT_PYTHON;
    delete process.env.IMAGE_CUTOUT_PYTHON;
    try {
      const runtime = await cutoutRuntime();
      expect(runtime.python).toBe(join(image, "bin", "python"));
      expect(runtime.env?.IMAGE_CUTOUT_MODELS).toBe(join(image, "models"));
      process.env.IMAGE_CUTOUT_PYTHON = "/fake/python";
      expect(await cutoutRuntime()).toEqual({ python: "/fake/python", env: undefined });
    } finally {
      if (previous === undefined) delete process.env.IMAGE_CUTOUT_PYTHON;
      else process.env.IMAGE_CUTOUT_PYTHON = previous;
    }
    expect(stateOf("cutout")).toMatchObject({ source: "image" });
    expect(downloads).toEqual([]);
  });

  test("a verified install that fails later checks is rebuilt", async () => {
    const target = join(root, "cutout", cutoutVersion);
    mkdirSync(join(target, "bin"), { recursive: true });
    mkdirSync(join(target, "models"), { recursive: true });
    writeFileSync(join(target, "bin", "python"), "");
    writeFileSync(join(target, "models", cutoutModel.name), "");
    pythonVersion = "0.1.0";
    const pending = ensureTool("cutout");
    pythonVersion = "1.32.0";
    expect(await pending).toBe(target);
    expect(downloads).toEqual([pipWheel.url, cutoutModel.url]);
  });
});

describe("routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  test("lists tools and pre-downloads one on request", async () => {
    expect(requiresOwner("GET", ["tools"])).toBe(true);
    expect(requiresOwner("POST", ["tools", "chrome", "install"])).toBe(true);
    const listed = await request<{ ok: boolean; tools: ToolState[] }>("/tools");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.body.tools.map((item) => item.tool)).toEqual(["chrome", "cutout"]);
    const started = await request<{ started: boolean }>("/tools/cutout/install", { method: "POST" });
    expect(started.status).toBe(202);
    expect(started.body.started).toBe(true);
    await installTask("cutout");
    const again = await request<{ started: boolean; tool: ToolState }>("/tools/cutout/install", { method: "POST" });
    expect(again.status).toBe(200);
    expect(again.body.tool.source).toBe("managed");
    expect((await request("/tools/ffmpeg/install", { method: "POST" })).status).toBe(400);
    expect((await request("/tools/chrome")).status).toBe(404);
    useToolDeps({ ...fakes(), arch: () => "arm64" });
    const blocked = await request<{ ok: boolean; error: string }>("/tools/chrome/install", { method: "POST" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("chromium do sistema");
    await installTask("chrome");
  });
});
