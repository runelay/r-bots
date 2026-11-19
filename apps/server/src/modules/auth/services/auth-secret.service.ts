import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SecretSource = "env" | "data-file";

export interface ResolvedSecret {
  secret: string;
  source: SecretSource;
  generated: boolean;
}

export interface SecretOptions {
  env: Record<string, string | undefined>;
  dataDir: string;
}

const minLength = 32;

function readSecretFile(path: string) {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value.length >= minLength ? value : null;
}

export function resolveAuthSecret(options: SecretOptions): ResolvedSecret {
  const fromEnv = options.env.BETTER_AUTH_SECRET?.trim();
  if (fromEnv && fromEnv.length >= minLength) return { secret: fromEnv, source: "env", generated: false };
  const dataFile = join(options.dataDir, "auth.secret");
  const stored = readSecretFile(dataFile);
  if (stored) return { secret: stored, source: "data-file", generated: false };
  const secret = randomBytes(32).toString("base64url");
  mkdirSync(options.dataDir, { recursive: true });
  writeFileSync(dataFile, `${secret}\n`, { mode: 0o600 });
  chmodSync(dataFile, 0o600);
  return { secret, source: "data-file", generated: true };
}
