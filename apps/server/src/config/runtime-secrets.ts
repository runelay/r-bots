import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./env";

const cache = new Map<string, string>();

export function readOrCreateSecret(name: string, bytes = 32, directory = dataDir) {
  const file = join(directory, name);
  const cached = cache.get(file);
  if (cached) return cached;
  if (existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored.length >= 24) {
      cache.set(file, stored);
      return stored;
    }
  }
  const secret = randomBytes(bytes).toString("base64url");
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  cache.set(file, secret);
  return secret;
}

export function runnerTokenFile() {
  return join(dataDir, "runner.token");
}

export function runnerToken() {
  const fromEnv = process.env.RUNNER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readOrCreateSecret("runner.token");
}

export function runnerTokenSource() {
  return process.env.RUNNER_TOKEN?.trim() ? "env" : "data-file";
}
