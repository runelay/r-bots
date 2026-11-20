import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rememberSecretValue } from "../shared/redact";
import { dataDir } from "./env";

type Source = Record<string, string | undefined>;

export function readSecretFile(file: string) {
  if (!existsSync(file)) return undefined;
  const value = readFileSync(file, "utf8").trim();
  return value || undefined;
}

function remembered(key: string, value: string | undefined) {
  if (value) rememberSecretValue(key, value);
  return value;
}

export interface RedisSettings {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls: boolean;
}

export function redisSettings(env: Source = process.env): RedisSettings {
  const url = new URL(env.REDIS_URL?.trim() || "redis://127.0.0.1:6379");
  const file =
    env.REDIS_PASSWORD_FILE?.trim() || join(env.BOTS_DATA_DIR?.trim() || dataDir, "secrets", "redis.password");
  const password = remembered(
    "REDIS_PASSWORD",
    env.REDIS_PASSWORD?.trim() || decodeURIComponent(url.password) || readSecretFile(file),
  );
  const username = decodeURIComponent(url.username);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    tls: url.protocol === "rediss:",
  };
}
