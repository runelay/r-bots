import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { findBinary } from "@runelay-bots/providers/proc";
import { toolsDir } from "../../../config/env";
import { ValidationError } from "../../../shared/errors";
import { currentLink, tmpSuffix } from "../../providers/constants/providers.constants";
import { pointLink, spawnCli } from "../../providers/services/cli-versions.service";
import {
  checkTimeoutMs,
  chromeDownloadMb,
  chromeImagePath,
  chromeSha256,
  chromeUrl,
  chromeVersion,
  cutoutDownloadMb,
  cutoutImageDir,
  cutoutImports,
  cutoutModel,
  cutoutRequirements,
  cutoutVersion,
  downloadTimeoutMs,
  installTimeoutMs,
  pipWheel,
  systemChromium,
  toolNames,
} from "../constants/tools.constants";
import type { ToolDeps, ToolName, ToolSource, ToolState } from "../types/tools.types";

export class ToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface InstallState {
  task: Promise<string> | null;
  lastError: string | null;
}

interface Located {
  source: ToolSource;
  path: string;
  base: string | null;
}

export async function downloadFile(url: string, file: string, timeoutMs: number) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`O download de ${url} falhou com status ${response.status}.`);
  await Bun.write(file, response);
}

const defaults: ToolDeps = {
  root: () => toolsDir,
  arch: () => process.arch,
  spawn: spawnCli,
  download: downloadFile,
  hash: sha256Of,
  which: findBinary,
  chromeOverride: () => {
    const configured = process.env.DESKTOP_CHROME?.trim();
    return configured && configured !== chromeImagePath ? configured : null;
  },
  images: { chrome: chromeImagePath, cutout: cutoutImageDir },
  log: (message) => console.log(message),
};

let deps = defaults;
const states = new Map<ToolName, InstallState>();

export function useToolDeps(overrides: Partial<ToolDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
  states.clear();
}

const versions: Record<ToolName, string> = { chrome: chromeVersion, cutout: cutoutVersion };
const downloads: Record<ToolName, number> = { chrome: chromeDownloadMb, cutout: cutoutDownloadMb };
const labels: Record<ToolName, string> = { chrome: "o navegador", cutout: "o recorte de imagem" };

export function isToolName(value: string): value is ToolName {
  return (toolNames as readonly string[]).includes(value);
}

function toolName(value: string) {
  if (!isToolName(value)) throw new ValidationError("Ferramenta desconhecida. Use chrome ou cutout.", "tool");
  return value;
}

function stateOf(tool: ToolName) {
  let state = states.get(tool);
  if (!state) {
    state = { task: null, lastError: null };
    states.set(tool, state);
  }
  return state;
}

function toolDir(tool: ToolName) {
  return join(deps.root(), tool);
}

function entryOf(tool: ToolName, base: string) {
  return tool === "chrome" ? join(base, "chrome") : base;
}

function complete(tool: ToolName, base: string) {
  if (tool === "chrome") return existsSync(join(base, "chrome"));
  return existsSync(join(base, "bin", "python")) && existsSync(join(base, "models", cutoutModel.name));
}

function currentOf(tool: ToolName) {
  try {
    return readlinkSync(join(toolDir(tool), currentLink));
  } catch {
    return null;
  }
}

function locate(tool: ToolName): Located | null {
  if (tool === "chrome") {
    const override = deps.chromeOverride();
    if (override) return { source: "override", path: override, base: null };
  }
  const managed = join(toolDir(tool), versions[tool]);
  if (currentOf(tool) === versions[tool] && complete(tool, managed))
    return { source: "managed", path: entryOf(tool, managed), base: managed };
  const image = tool === "chrome" ? dirname(deps.images.chrome) : deps.images.cutout;
  if (complete(tool, image)) return { source: "image", path: entryOf(tool, image), base: image };
  if (tool === "chrome" && deps.arch() !== "x64") {
    const system = deps.which(systemChromium);
    if (system) return { source: "system", path: system, base: null };
  }
  return null;
}

function unsupported(tool: ToolName) {
  if (tool === "chrome" && deps.arch() !== "x64")
    return "O Chrome for Testing não existe para arm64. Use o chromium do sistema (apt install chromium).";
  return null;
}

function tail(text: string) {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

export async function sha256Of(file: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function fetchVerified(url: string, file: string, sha256: string) {
  await deps.download(url, file, downloadTimeoutMs);
  if ((await deps.hash(file)) !== sha256) {
    rmSync(file, { force: true });
    throw new Error(`O arquivo baixado de ${url} não confere com o checksum esperado.`);
  }
}

async function exec(bin: string, args: string[], failure: string) {
  const result = await deps.spawn(bin, args, installTimeoutMs);
  if (result.code !== 0)
    throw new Error(`${failure}: ${tail(result.stderr || result.stdout) || `código ${result.code}`}`);
  return result.stdout;
}

async function buildChrome(staging: string) {
  const zip = join(staging, "chrome.zip");
  const unpacked = join(staging, "unpacked");
  await fetchVerified(chromeUrl, zip, chromeSha256);
  await exec(deps.which(["unzip"]) ?? "unzip", ["-q", zip, "-d", unpacked], "Não consegui extrair o Chrome");
  const ready = join(unpacked, "chrome-linux64");
  if (!existsSync(join(ready, "chrome"))) throw new Error("O pacote do Chrome veio sem o executável.");
  return ready;
}

export function requirementsText() {
  return cutoutRequirements
    .map((item) => `${item.name}==${item.version} ${item.hashes.map((hash) => `--hash=sha256:${hash}`).join(" ")}`)
    .join("\n")
    .concat("\n");
}

async function buildCutout(staging: string) {
  const python = deps.which(["python3"]);
  if (!python) throw new Error("O recorte de imagem precisa do python3 do sistema.");
  await exec(python, ["-m", "venv", "--without-pip", staging], "Não consegui criar o ambiente Python");
  const work = join(staging, ".download");
  mkdirSync(work, { recursive: true });
  const wheel = join(work, pipWheel.name);
  await fetchVerified(pipWheel.url, wheel, pipWheel.sha256);
  const requirements = join(work, "requirements.txt");
  writeFileSync(requirements, requirementsText());
  await exec(
    join(staging, "bin", "python"),
    [
      join(wheel, "pip"),
      "install",
      "--disable-pip-version-check",
      "--no-cache-dir",
      "--no-compile",
      "--no-deps",
      "--only-binary=:all:",
      "--require-hashes",
      "-r",
      requirements,
    ],
    "O pip não instalou o recorte",
  );
  mkdirSync(join(staging, "models"), { recursive: true });
  await fetchVerified(cutoutModel.url, join(staging, "models", cutoutModel.name), cutoutModel.sha256);
  rmSync(work, { recursive: true, force: true });
  return staging;
}

async function verify(tool: ToolName, base: string) {
  if (!complete(tool, base)) throw new Error(`A instalação de ${labels[tool]} ficou incompleta.`);
  if (tool === "chrome") {
    const result = await deps.spawn(join(base, "chrome"), ["--version"], checkTimeoutMs);
    if (result.code !== 0 || !result.stdout.includes(chromeVersion))
      throw new Error(`O Chrome baixado não abriu: ${tail(result.stderr || result.stdout) || `código ${result.code}`}`);
    return;
  }
  const result = await deps.spawn(join(base, "bin", "python"), ["-I", "-c", cutoutImports], checkTimeoutMs);
  const found = result.stdout.trim().split("\n").at(-1);
  if (result.code !== 0 || found !== cutoutRequirements[0].version)
    throw new Error(
      `O Python do recorte não carregou: ${tail(result.stderr || result.stdout) || `código ${result.code}`}`,
    );
}

function publish(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) return chmodSync(path, stat.mode & 0o111 ? 0o755 : 0o644);
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path)) publish(join(path, entry));
}

function prune(tool: ToolName) {
  const root = toolDir(tool);
  const keep = new Set([currentLink, versions[tool]]);
  for (const entry of readdirSync(root))
    if (!keep.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
}

async function install(tool: ToolName) {
  const root = toolDir(tool);
  const version = versions[tool];
  const target = join(root, version);
  const staging = `${target}${tmpSuffix}`;
  mkdirSync(root, { recursive: true });
  deps.log(`Baixando ${labels[tool]} (uma vez só, ~${downloads[tool]} MB)...`);
  try {
    const reuse =
      complete(tool, target) &&
      (await verify(tool, target).then(
        () => true,
        () => false,
      ));
    if (!reuse) {
      rmSync(target, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const ready = tool === "chrome" ? await buildChrome(staging) : await buildCutout(staging);
      await verify(tool, ready);
      renameSync(ready, target);
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  if (currentOf(tool) !== version) pointLink(root, currentLink, version);
  prune(tool);
  publish(root);
  deps.log(`Pronto: ${labels[tool]} ficou em ${target}.`);
  return entryOf(tool, target);
}

export function ensureTool(tool: ToolName): Promise<string> {
  const found = locate(tool);
  if (found) return Promise.resolve(found.path);
  const blocked = unsupported(tool);
  if (blocked) return Promise.reject(new ToolError(blocked, 409));
  const state = stateOf(tool);
  if (!state.task) {
    state.lastError = null;
    state.task = install(tool).then(
      (path) => {
        state.task = null;
        return path;
      },
      (error: unknown) => {
        state.task = null;
        state.lastError = error instanceof Error ? error.message : String(error);
        deps.log(`Não consegui instalar ${labels[tool]}: ${state.lastError}`);
        throw error;
      },
    );
  }
  return state.task;
}

export function optionalTool(tool: ToolName) {
  return ensureTool(tool).catch(() => null);
}

function sizeOf(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + sizeOf(join(path, entry)), stat.size);
}

function stateFor(tool: ToolName): ToolState {
  const found = locate(tool);
  const state = states.get(tool);
  return {
    tool,
    installed: Boolean(found),
    source: found?.source ?? null,
    version: found?.source === "managed" ? versions[tool] : null,
    path: found?.path ?? null,
    sizeBytes: found?.base ? sizeOf(found.base) : null,
    downloadMb: downloads[tool],
    installing: Boolean(state?.task),
    lastError: state?.lastError ?? null,
  };
}

export function listTools() {
  return toolNames.map(stateFor);
}

export function startInstall(value: string) {
  const tool = toolName(value);
  if (locate(tool)) return { started: false, tool: stateFor(tool) };
  const blocked = unsupported(tool);
  if (blocked) throw new ToolError(blocked, 409);
  ensureTool(tool).catch(() => undefined);
  return { started: true, tool: stateFor(tool) };
}

export function installTask(tool: ToolName) {
  return states.get(tool)?.task?.catch(() => undefined) ?? Promise.resolve();
}
