import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rememberSecretValue } from "../shared/redact";
import { dataDir } from "./env";

const cache = new Map<string, string>();

export function readOrCreateSecret(name: string, bytes = 32, directory = dataDir) {
  const file = join(directory, name);
  const cached = cache.get(file);
  if (cached) {
    if (!existsSync(file)) persist(directory, file, cached);
    return cached;
  }
  if (existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored.length >= 24) {
      cache.set(file, stored);
      rememberSecretValue(`runtime:${file}`, stored, { pinned: true });
      return stored;
    }
    throw new Error(`${file} exists but holds no usable secret: refusing to replace it`);
  }
  const secret = randomBytes(bytes).toString("base64url");
  persist(directory, file, secret);
  cache.set(file, secret);
  rememberSecretValue(`runtime:${file}`, secret, { pinned: true });
  return secret;
}

function persist(directory: string, file: string, secret: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function runnerTokenFile() {
  return join(dataDir, "runner.token");
}

let runner: string | null = null;

export function rotateRunnerToken() {
  runner = randomBytes(32).toString("base64url");
  persist(dataDir, runnerTokenFile(), runner);
  rememberSecretValue("runner", runner, { pinned: true });
  return runner;
}

export function runnerToken() {
  if (!runner) return rotateRunnerToken();
  if (!existsSync(runnerTokenFile())) persist(dataDir, runnerTokenFile(), runner);
  return runner;
}
