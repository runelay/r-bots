import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SecretSource = "env" | "env-file" | "data-file";

export interface ResolvedSecret {
  secret: string;
  source: SecretSource;
  generated: boolean;
}

export interface SecretOptions {
  env: Record<string, string | undefined>;
  envFiles: string[];
  dataDir: string;
}

const minLength = 32;

function readSecretFile(path: string) {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value.length >= minLength ? value : null;
}

function appendToEnvFile(path: string, secret: string) {
  const exists = existsSync(path);
  const current = exists ? readFileSync(path, "utf8") : "";
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  if (exists) appendFileSync(path, `${prefix}BETTER_AUTH_SECRET=${secret}\n`);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `BETTER_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
}

export function resolveAuthSecret(options: SecretOptions): ResolvedSecret {
  const fromEnv = options.env.BETTER_AUTH_SECRET?.trim();
  if (fromEnv && fromEnv.length >= minLength) return { secret: fromEnv, source: "env", generated: false };
  const dataFile = join(options.dataDir, "auth.secret");
  const stored = readSecretFile(dataFile);
  if (stored) return { secret: stored, source: "data-file", generated: false };
  const secret = randomBytes(32).toString("base64url");
  const target = options.envFiles.find((path) => existsSync(path)) ?? options.envFiles[0];
  if (target) {
    try {
      appendToEnvFile(target, secret);
      return { secret, source: "env-file", generated: true };
    } catch {}
  }
  mkdirSync(options.dataDir, { recursive: true });
  writeFileSync(dataFile, `${secret}\n`, { mode: 0o600 });
  chmodSync(dataFile, 0o600);
  return { secret, source: "data-file", generated: true };
}
