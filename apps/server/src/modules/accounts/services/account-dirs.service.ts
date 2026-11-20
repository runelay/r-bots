import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { readSetting, writeSetting } from "../../../db/settings";

export type DirProvider = "claude" | "codex";

export interface AccountDir {
  id: string;
  provider: DirProvider;
  dir: string;
  cliDefault: boolean;
  added: boolean;
}

export interface AccountSettings {
  dirs: string[];
  names: Record<string, string>;
  defaults: Partial<Record<DirProvider, string>>;
}

export interface AccountIdentity {
  email: string | null;
  name: string | null;
  organization: string | null;
  plan: string | null;
}

export const dirProviders: DirProvider[] = ["claude", "codex"];
const settingsKey = "accounts.settings";
const baseNames: Record<DirProvider, string> = { claude: ".claude", codex: ".codex" };
const loginMarkers: Record<DirProvider, string> = { claude: ".credentials.json", codex: "auth.json" };
const providerTitles: Record<DirProvider, string> = { claude: "Claude", codex: "Codex" };

export function homeDir() {
  return resolve(process.env.HOST_HOME?.trim() || homedir());
}

export function displayPath(dir: string) {
  const home = homeDir();
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
}

export function expandPath(input: string) {
  const text = input.trim();
  if (text === "~") return homeDir();
  if (text.startsWith("~/")) return resolve(homeDir(), text.slice(2));
  return isAbsolute(text) ? resolve(text) : null;
}

export async function readAccountSettings(): Promise<AccountSettings> {
  const stored = await readSetting<Partial<AccountSettings> | null>(settingsKey, null);
  const dirs = Array.isArray(stored?.dirs) ? stored.dirs.filter((item) => typeof item === "string") : [];
  const names = stored?.names && typeof stored.names === "object" ? stored.names : {};
  const defaults = stored?.defaults && typeof stored.defaults === "object" ? stored.defaults : {};
  return { dirs, names, defaults };
}

export async function writeAccountSettings(settings: AccountSettings) {
  await writeSetting(settingsKey, settings);
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function dirKey(path: string) {
  try {
    const info = await stat(path);
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null;
  } catch {
    return null;
  }
}

export async function detectProvider(dir: string): Promise<DirProvider | null> {
  if ((await exists(join(dir, ".credentials.json"))) || (await exists(join(dir, ".claude.json")))) return "claude";
  if ((await exists(join(dir, "auth.json"))) || (await exists(join(dir, "config.toml")))) return "codex";
  const name = basename(dir).toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("claude")) return "claude";
  return null;
}

function slugOf(dir: string) {
  const slug =
    basename(dir)
      .toLowerCase()
      .replace(/^\.+/, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "conta";
  return slug === "vps" || slug.startsWith("mac") ? `d-${slug}` : slug;
}

export async function discoverAccountDirs(settings: AccountSettings): Promise<AccountDir[]> {
  const home = homeDir();
  const names = (await readdir(home).catch(() => [] as string[])).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const found: Array<Omit<AccountDir, "id">> = [];
  for (const provider of dirProviders) {
    const base = baseNames[provider];
    for (const name of names) {
      if (name !== base && !name.startsWith(`${base}-`)) continue;
      const dir = join(home, name);
      if (name !== base && !(await exists(join(dir, loginMarkers[provider])))) continue;
      found.push({ provider, dir, cliDefault: name === base, added: false });
    }
  }
  for (const raw of settings.dirs) {
    const dir = expandPath(raw);
    const provider = dir ? await detectProvider(dir) : null;
    if (dir && provider) found.push({ provider, dir, cliDefault: false, added: true });
  }
  const seen = new Set<string>();
  const used = new Set<string>();
  const result: AccountDir[] = [];
  for (const item of found) {
    const key = await dirKey(item.dir);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let prefix = item.cliDefault ? "vps" : slugOf(item.dir);
    if (used.has(`${prefix}:${item.provider}`))
      prefix = `${prefix}-${createHash("sha1").update(item.dir).digest("hex").slice(0, 6)}`;
    used.add(`${prefix}:${item.provider}`);
    result.push({ ...item, id: `${prefix}:${item.provider}` });
  }
  return result;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function claudeIdentity(account: AccountDir): Promise<AccountIdentity> {
  const files = account.cliDefault
    ? [join(homeDir(), ".claude.json"), join(account.dir, ".claude.json")]
    : [join(account.dir, ".claude.json")];
  let oauth: Record<string, unknown> = {};
  for (const file of files) {
    const parsed = await readJson(file);
    const candidate = parsed?.oauthAccount;
    if (candidate && typeof candidate === "object") {
      oauth = candidate as Record<string, unknown>;
      break;
    }
  }
  const credentials = await readJson(join(account.dir, ".credentials.json"));
  const claudeAi = (credentials?.claudeAiOauth ?? {}) as Record<string, unknown>;
  return {
    email: text(oauth.emailAddress),
    name: text(oauth.displayName),
    organization: text(oauth.organizationName),
    plan: text(claudeAi.subscriptionType),
  };
}

async function codexIdentity(account: AccountDir): Promise<AccountIdentity> {
  const auth = await readJson(join(account.dir, "auth.json"));
  const tokens = (auth?.tokens ?? {}) as Record<string, unknown>;
  const claims = jwtClaims(tokens.id_token) ?? {};
  const openai = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  return {
    email: text(claims.email),
    name: text(claims.name),
    organization: null,
    plan: text(openai.chatgpt_plan_type),
  };
}

export function readIdentity(account: AccountDir) {
  return account.provider === "claude" ? claudeIdentity(account) : codexIdentity(account);
}

export function autoName(account: AccountDir, identity: AccountIdentity, siblings: number) {
  const title = providerTitles[account.provider];
  if (account.provider === "codex" && siblings <= 1) return title;
  const who =
    (account.provider === "claude" ? identity.name : null) ??
    identity.organization ??
    identity.email?.split("@")[0] ??
    (account.cliDefault ? null : basename(account.dir).replace(/^\.+/, ""));
  return who ? `${title} ${who}` : title;
}
