import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./env";

type Env = Record<string, string | undefined>;

export interface DatabaseSettings {
  url: string;
  local: boolean;
  prepare: boolean;
  tls: boolean | { rejectUnauthorized: boolean };
  max: number;
}

const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "postgres"]);
const strippedParams = ["sslmode", "pgbouncer", "channel_binding", "prepare"];

function appUser(env: Env) {
  return env.POSTGRES_APP_USER?.trim() || null;
}

export function passwordFile(env: Env = process.env) {
  const secrets = join(env.BOTS_DATA_DIR ?? dataDir, "secrets");
  if (appUser(env)) return env.POSTGRES_APP_PASSWORD_FILE ?? join(secrets, "postgres-app.password");
  return env.POSTGRES_PASSWORD_FILE ?? join(secrets, "postgres.password");
}

export function localDatabaseUrl(env: Env = process.env) {
  const file = passwordFile(env);
  let password: string;
  try {
    password = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`postgres password not found in ${file}: set DATABASE_URL or POSTGRES_PASSWORD_FILE`);
  }
  const user = encodeURIComponent(appUser(env) ?? env.POSTGRES_USER ?? "runelay_bots");
  const host = env.POSTGRES_HOST ?? "127.0.0.1";
  const port = env.POSTGRES_PORT ?? "5432";
  const name = env.POSTGRES_DB ?? "runelay_bots";
  return `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

function tlsOf(mode: string | null): DatabaseSettings["tls"] {
  if (!mode || mode === "disable" || mode === "allow" || mode === "prefer") return false;
  return { rejectUnauthorized: mode === "verify-ca" || mode === "verify-full" };
}

function prepareOf(url: URL, env: Env) {
  if (env.DATABASE_PREPARE === "off") return false;
  if (env.DATABASE_PREPARE === "on") return true;
  if (url.searchParams.get("pgbouncer") === "true" || url.searchParams.get("prepare") === "false") return false;
  return !url.hostname.includes("-pooler");
}

export function databaseSettings(env: Env = process.env, purpose: "app" | "direct" = "app"): DatabaseSettings {
  const given = purpose === "direct" ? (env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL) : env.DATABASE_URL;
  const url = new URL(given ?? localDatabaseUrl(env));
  const tls = tlsOf(url.searchParams.get("sslmode"));
  const prepare = prepareOf(url, env);
  for (const param of strippedParams) url.searchParams.delete(param);
  return {
    url: url.toString(),
    local: localHosts.has(url.hostname),
    prepare,
    tls,
    max: Number(env.DATABASE_POOL_MAX ?? (purpose === "direct" ? 2 : 10)),
  };
}
