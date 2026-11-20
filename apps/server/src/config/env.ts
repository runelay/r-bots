import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const optionalText = text.optional();
const portNumber = z.coerce.number().int().min(1).max(65_535);
const positive = z.coerce.number().positive();

const schema = z.object({
  BOTS_APP_DIR: optionalText,
  GATEWAY_HOST: text.default("127.0.0.1"),
  GATEWAY_PORT: portNumber.default(2000),
  BOTS_DATA_DIR: optionalText,
  BOTS_MODEL: text.default("claude-sonnet-5-5"),
  BOTS_SCHEDULES: text.default("on"),
  BOTS_MAX_TURNS: positive.default(3),
  BOTS_CONTEXT_LIMIT: positive.optional(),
  BOTS_HANDOFF_CHARS: positive.optional(),
  BOTS_FAULTS_FILE: optionalText,
  JEV_API_KEY: optionalText,
  JEV_URL: z.url().optional(),
  JEV_MODEL: optionalText,
  JEV_TIMEOUT_MS: positive.optional(),
  RUNELAY_MCP_URL: z.url().optional(),
  RUNELAY_MCP_TOKEN: optionalText,
  RUNELAY_API_URL: z.url().optional(),
  RUNELAY_RECONNECT_URL: z.url().optional(),
  ELEVENLABS_API_KEY: optionalText,
  VOICE_MAX_WARM: positive.optional(),
  VAULT_KEY_FILE: optionalText,
  CODE_GH_BIN: optionalText,
  CODE_PR_AUTOCLOSE_HOURS: positive.default(24),
  DEV_PORT_BASE: portNumber.default(5310),
  BROWSER_IDLE_MS: positive.optional(),
  DESKTOP_USER: optionalText,
  DESKTOP_HOME: optionalText,
  DESKTOP_FPS: positive.optional(),
  DESKTOP_CHROME: optionalText,
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const source = Object.fromEntries(Object.entries(Bun.env).filter(([, value]) => value?.trim()));
  const parsed = schema.safeParse(source);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Configuração inválida: ${problems}`);
}

export const env = load();

export const rootDir = env.BOTS_APP_DIR ?? resolve(import.meta.dirname, "..", "..");
export const repoDir = resolve(rootDir, "..", "..");
export const dataDir = env.BOTS_DATA_DIR ?? join(homedir(), ".local", "share", "runelay-bots");
export const host = env.GATEWAY_HOST;
export const port = env.GATEWAY_PORT;
export const model = env.BOTS_MODEL;

export const botsDir = join(dataDir, "bots");
export const sessionsDir = join(dataDir, "sessions");
export const threadsDir = join(dataDir, "threads");
export const workspacesDir = join(dataDir, "workspaces");

export function botDir(botId: string) {
  return join(botsDir, botId);
}

export function botFile(botId: string) {
  return join(botsDir, `${botId}.json`);
}

export function workspaceDir(botId: string) {
  return join(workspacesDir, botId);
}
