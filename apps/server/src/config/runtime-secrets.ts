import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      return stored;
    }
  }
  const secret = randomBytes(bytes).toString("base64url");
  persist(directory, file, secret);
  cache.set(file, secret);
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

export function runnerToken() {
  return readOrCreateSecret("runner.token");
}
