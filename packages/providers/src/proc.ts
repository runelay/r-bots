import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function searchPath() {
  const extra = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...extra, ...current])].join(delimiter);
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

export function childEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  delete env.CURSOR_API_KEY;
  delete env.XAI_API_KEY;
  delete env.RUNNER_TOKEN;
  delete env.JEV_API_KEY;
  delete env.RUNELAY_MCP_TOKEN;
  delete env.ELEVENLABS_API_KEY;
  env.PATH = searchPath();
  return { ...env, ...extra };
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
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
      env: options.env,
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
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code: child.signalCode ? 1 : exit, stdout, stderr };
}

export async function run(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await runBytes(bin, args, options);
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout), stderr: result.stderr };
}

export function capture(bin: string, args: string[], timeoutMs = 20_000) {
  return run(bin, args, { timeoutMs, env: childEnv() });
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
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
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
