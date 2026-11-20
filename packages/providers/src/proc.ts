import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function searchPath() {
  const system = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...system, ...current, join(homedir(), ".local", "bin")])].join(delimiter);
}

export function findBinary(names: string[]) {
  for (const dir of searchPath().split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const allowedEnv = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TERM",
  "TMPDIR",
  "COLORTERM",
  "NO_COLOR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_EXECUTABLE",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "DISPLAY",
  "DESKTOP_CHROME",
  "GIT_TERMINAL_PROMPT",
]);

export function allowedEnvKey(key: string) {
  return allowedEnv.has(key) || key.startsWith("LC_") || key.startsWith("AGENT_BROWSER_");
}

export function childEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedEnvKey(key)) env[key] = value;
  }
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  env.PATH = searchPath();
  return { ...env, ...extra };
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  maxBytes?: number;
}

export const defaultMaxBytes = 64 * 1024 * 1024;
export const maxLineBytes = 8 * 1024 * 1024;

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size >= limit) continue;
    const piece = chunk.byteLength > limit - size ? chunk.subarray(0, limit - size) : chunk;
    chunks.push(piece);
    size += piece.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runBytes(bin: string, args: string[], options: RunOptions = {}) {
  let child: Bun.Subprocess<"ignore" | Buffer, "pipe", "pipe">;
  try {
    child = Bun.spawn([bin, ...args], {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
      stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs,
      killSignal: "SIGTERM",
      signal: options.signal,
    });
  } catch (error) {
    return { code: 1, stdout: new Uint8Array(), stderr: error instanceof Error ? error.message : String(error) };
  }
  const [stdout, stderr, exit] = await Promise.all([
    readCapped(child.stdout, options.maxBytes ?? defaultMaxBytes),
    new Response(child.stderr).text().then((text) => text.slice(-1_000_000)),
    child.exited,
  ]);
  return { code: child.signalCode ? 1 : exit, stdout, stderr };
}

export async function run(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await runBytes(bin, args, options);
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout), stderr: result.stderr };
}

export function accountEnv(provider: string, configDir: string | null | undefined): Record<string, string> {
  if (!configDir) return {};
  if (provider === "claude") return { CLAUDE_CONFIG_DIR: configDir };
  if (provider === "codex") return { CODEX_HOME: configDir };
  return {};
}

export function capture(bin: string, args: string[], timeoutMs = 20_000, extra: Record<string, string> = {}) {
  return run(bin, args, { timeoutMs, env: childEnv(extra) });
}

export async function runLines(
  bin: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal; stdin?: string },
  onLine: (line: string) => void,
) {
  let child: Bun.Subprocess<Buffer, "pipe", "pipe">;
  try {
    child = Bun.spawn([bin, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdin: Buffer.from(options.stdin ?? ""),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { code: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
  const kill = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  };
  if (options.signal.aborted) kill();
  options.signal.addEventListener("abort", kill, { once: true });
  let stderr = "";
  const readErrors = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-20_000);
  })();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > maxLineBytes && !buffer.includes("\n")) buffer = "";
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, Math.min(index, maxLineBytes)).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf("\n");
    }
  }
  await readErrors;
  const code = await child.exited;
  options.signal.removeEventListener("abort", kill);
  if (buffer.trim()) onLine(buffer.trim());
  return { code: child.signalCode ? 1 : code, stderr };
}

export function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
