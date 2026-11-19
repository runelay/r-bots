import { execFile, spawn } from "node:child_process";
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

export function capture(bin: string, args: string[], timeoutMs = 20_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, env: childEnv(), maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function runLines(
  bin: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal; stdin?: string },
  onLine: (line: string) => void,
) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    };
    if (options.signal.aborted) kill();
    options.signal.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.stdin.end(options.stdin ?? "");
    child.on("error", (error) => {
      stderr += String(error.message);
    });
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", kill);
      if (buffer.trim()) onLine(buffer.trim());
      resolve({ code: code ?? 1, stderr });
    });
  });
}

export function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
