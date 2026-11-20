import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dataDir } from "../../../config/env";
import { forgetSecretValue, redactDeep, rememberSecretValue } from "../../../shared/redact";
import { MacRunnerUnavailable, macRunnerSupports, macSecretResolve } from "../../accounts/services/mac-runner.service";
import {
  addAudit,
  loadSecretMetas,
  readAuditRows,
  readSealed,
  saveSecretMetas,
  writeSealed,
} from "../repositories/vault.repository";

const keyFile = process.env.VAULT_KEY_FILE ?? join(dataDir, "vault.key");
const legacyKeyFiles = [
  join(process.env.HOST_HOME?.trim() || homedir(), ".config", "runelay-bots", "vault.key"),
  join(homedir(), ".config", "runelay-bots", "vault.key"),
  "/run/runelay-bots/vault.key",
];

export const secretNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const secretRefPattern = /segredo:([a-z0-9][a-z0-9_-]{0,63})/g;
const envRefPattern = /\$\{?(SEGREDO_[A-Z0-9_]{1,64})\}?/g;
const domainPattern = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/;

export type TouchPolicy = "always" | "hourly" | "never";
export type SecretStorage = "mac" | "mac+server";
export type SecretKind = "password" | "token" | "text";

export interface SecretMeta {
  name: string;
  description: string;
  domains: string[];
  bots: string[];
  touchId: TouchPolicy;
  expiresAt: string | null;
  storage: SecretStorage;
  kind: SecretKind;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  lastTool: string | null;
}

export class VaultError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolveRequest {
  name: string;
  botId: string;
  botName: string;
  tool: string;
  host: string | null;
  sessionId?: string;
}

export interface SecretSource {
  id: string;
  handles: (meta: SecretMeta) => boolean;
  read: (meta: SecretMeta, request: ResolveRequest) => Promise<string>;
}

const externalSources: SecretSource[] = [];

export function registerSecretSource(source: SecretSource) {
  externalSources.push(source);
}

let index: Record<string, SecretMeta> = {};
let loaded = false;

function ensureKeyFile() {
  if (existsSync(keyFile)) return;
  mkdirSync(dirname(keyFile), { recursive: true });
  const legacy = legacyKeyFiles.find((file) => file !== keyFile && existsSync(file));
  if (legacy) {
    copyFileSync(legacy, keyFile);
    chmodSync(keyFile, 0o600);
    console.log(`vault key copied from ${legacy}`);
    return;
  }
  if (Object.keys(index).length > 0) {
    console.warn("vault key missing and secrets exist: not generating a new one");
    return;
  }
  writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  console.log("vault key created");
}

export async function loadVault() {
  index = await loadSecretMetas();
  loaded = true;
  try {
    ensureKeyFile();
  } catch (error) {
    console.warn(`vault key setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveIndex() {
  await saveSecretMetas(index);
}

export function envNameOf(name: string) {
  return `SEGREDO_${name.toUpperCase().replace(/-/g, "_")}`;
}

export function listSecretMeta() {
  return Object.values(index).sort((a, b) => a.name.localeCompare(b.name));
}

export function getSecretMeta(name: string) {
  return index[name] ?? null;
}

function loadKey() {
  let raw: Buffer;
  try {
    raw = readFileSync(keyFile);
  } catch {
    return null;
  }
  if (raw.length === 32) return raw;
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  return decoded.length === 32 ? decoded : null;
}

export function serverStorageAvailable() {
  return loadKey() !== null;
}

function aad(name: string) {
  return Buffer.from(`runelay-bots:vault:v1:${name}`, "utf8");
}

async function writeServerCopy(name: string, value: string) {
  const key = loadKey();
  if (!key)
    throw new VaultError("no_key", "O servidor não tem a chave do cofre, então não dá para guardar uma cópia aqui.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(name));
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  await saveSecretMetas(index);
  await writeSealed(name, { iv, tag, ct });
}

async function readServerCopy(name: string) {
  const key = loadKey();
  if (!key)
    throw new VaultError("no_key", "O servidor perdeu a chave do cofre e não consegue abrir a cópia guardada aqui.");
  try {
    const sealed = await readSealed(name);
    if (!sealed) throw new Error("missing");
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
    decipher.setAAD(aad(name));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ct), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError(
      "server_copy_broken",
      `A cópia do segredo:${name} no servidor não abriu. Peça à pessoa para salvar o segredo de novo no Cofre.`,
    );
  } finally {
    key.fill(0);
  }
}

export async function audit(entry: Record<string, unknown>) {
  await addAudit(redactDeep({ at: new Date().toISOString(), ...entry }) as Record<string, unknown>);
}

export async function readAudit(name: string | null, limit: number): Promise<Record<string, unknown>[]> {
  return await readAuditRows(name, limit);
}

export function normalizeHost(value: string | null | undefined) {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {}
  host = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host || null;
}

export function hostAllowed(patterns: string[], host: string | null) {
  if (patterns.length === 0) return true;
  if (!host) return false;
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === pattern || host === `www.${pattern}`;
  });
}

export function normalizeDomains(list: unknown) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new VaultError("bad_domains", "domains precisa ser uma lista de sites.");
  const out: string[] = [];
  for (const item of list) {
    let value = String(item ?? "")
      .trim()
      .toLowerCase();
    if (!value) continue;
    if (value.includes("://")) {
      try {
        value = new URL(value).hostname;
      } catch {}
    }
    value = value.replace(/\/.*$/, "").replace(/^www\./, "");
    if (!domainPattern.test(value) || value.length > 253)
      throw new VaultError(
        "bad_domains",
        `“${String(item)}” não é um site válido. Use algo como github.com ou *.github.com.`,
      );
    if (!out.includes(value)) out.push(value);
  }
  if (out.length > 30) throw new VaultError("bad_domains", "Use no máximo 30 sites por segredo.");
  return out;
}

function dateLabel(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function policyError(meta: SecretMeta, botId: string, host: string | null) {
  if (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) {
    return new VaultError(
      "expired",
      `O segredo:${meta.name} venceu em ${dateLabel(meta.expiresAt)}. Peça um novo com request_secret ou peça para a pessoa renovar no Cofre.`,
    );
  }
  if (meta.bots.length > 0 && !meta.bots.includes(botId)) {
    return new VaultError(
      "denied_bot",
      `O segredo:${meta.name} não está liberado para você. A pessoa pode liberar no Cofre do app, se quiser.`,
    );
  }
  if (!hostAllowed(meta.domains, host)) {
    const where = meta.domains.join(", ");
    return new VaultError(
      "denied_domain",
      host
        ? `O segredo:${meta.name} só pode ser usado em ${where}, não em ${host}.`
        : `O segredo:${meta.name} só pode ser usado em ${where}, e aqui não dá para saber o site.`,
    );
  }
  return null;
}

export async function markUsed(name: string, botId: string, tool: string) {
  const meta = index[name];
  if (!meta) return;
  meta.lastUsedAt = new Date().toISOString();
  meta.lastUsedBy = botId;
  meta.lastTool = tool;
  await saveIndex().catch(() => undefined);
}

export async function resolveSecret(request: ResolveRequest): Promise<string> {
  if (!loaded) await loadVault();
  const meta = index[request.name];
  const base = {
    name: request.name,
    botId: request.botId,
    botName: request.botName,
    tool: request.tool,
    domain: request.host,
    sessionId: request.sessionId ?? null,
  };
  if (!meta) {
    await audit({ ...base, outcome: "denied", reason: "not_found" });
    throw new VaultError(
      "not_found",
      `Não existe segredo:${request.name} no cofre. Veja os nomes com list_secrets ou peça à pessoa com request_secret.`,
    );
  }
  const denied = policyError(meta, request.botId, request.host);
  if (denied) {
    await audit({ ...base, outcome: "denied", reason: denied.code });
    throw denied;
  }
  let value: string | null = null;
  let source = "mac";
  let macFailure: VaultError | null = null;
  const external = externalSources.find((item) => item.handles(meta));
  if (external) {
    value = await external.read(meta, request);
    source = external.id;
  } else if (macRunnerSupports("vault")) {
    try {
      const response = await macSecretResolve({
        name: request.name,
        botId: request.botId,
        botName: request.botName,
        tool: request.tool,
        domain: request.host,
      });
      if (response.ok === true && typeof (response.result as { value?: unknown } | undefined)?.value === "string") {
        value = (response.result as { value: string }).value;
      } else {
        const code = String(response.code ?? "denied");
        const error = new VaultError(code, String(response.error ?? `O Mac não liberou o segredo:${request.name}.`));
        if (code !== "not_found" || meta.storage !== "mac+server") {
          await audit({ ...base, outcome: "denied", reason: code, source: "mac" });
          throw error;
        }
        macFailure = error;
      }
    } catch (error) {
      if (error instanceof VaultError) throw error;
      if (!(error instanceof MacRunnerUnavailable)) throw error;
      macFailure = new VaultError("mac_offline", error.message);
    }
  } else {
    macFailure = new VaultError("mac_offline", "O app runelay bots não está aberto no Mac.");
  }
  if (value === null) {
    if (meta.storage !== "mac+server") {
      await audit({ ...base, outcome: "denied", reason: "mac_offline" });
      throw new VaultError(
        "mac_offline",
        `O segredo:${request.name} fica só no Mac da pessoa, e o Mac está offline (${macFailure?.message ?? "app fechado"}). Diga isso à pessoa: ela pode abrir o app runelay bots ou ligar “usar com o Mac fechado” nesse segredo no Cofre.`,
      );
    }
    value = await readServerCopy(request.name);
    source = "server";
  }
  rememberSecretValue(request.name, value);
  await audit({ ...base, outcome: "used", source });
  await markUsed(request.name, request.botId, request.tool);
  return value;
}

export function refsIn(text: string) {
  return [...new Set([...text.matchAll(secretRefPattern)].map((match) => match[1]))];
}

export function hasRefs(text: unknown) {
  return typeof text === "string" && refsIn(text).length > 0;
}

export function onlyRefs(text: unknown) {
  return typeof text === "string" && hasRefs(text) && text.replace(secretRefPattern, "").trim() === "";
}

export async function substituteRefs(text: string, request: Omit<ResolveRequest, "name">) {
  let out = text;
  for (const name of refsIn(text)) {
    const value = await resolveSecret({ ...request, name });
    out = out.split(`segredo:${name}`).join(value);
  }
  return out;
}

export function envRefsIn(command: string) {
  const byEnv = new Map(listSecretMeta().map((meta) => [envNameOf(meta.name), meta.name]));
  const names = new Set(refsIn(command));
  const unknown: string[] = [];
  for (const match of command.matchAll(envRefPattern)) {
    const name = byEnv.get(match[1]);
    if (name) names.add(name);
    else unknown.push(match[1]);
  }
  return { names: [...names], unknown: [...new Set(unknown)] };
}

const tickets = new Map<string, { env: Record<string, string>; redact: string[]; until: number }>();

export function issueExecTicket(env: Record<string, string>, redact: string[]) {
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { env, redact, until: Date.now() + 60_000 });
  setTimeout(() => tickets.delete(ticket), 61_000).unref();
  return ticket;
}

export function takeExecTicket(ticket: string) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  return entry.until >= Date.now() ? entry : null;
}

export async function saveSecretMeta(name: string, body: Record<string, unknown>) {
  if (!loaded) await loadVault();
  if (!secretNamePattern.test(name))
    throw new VaultError("bad_name", "Use só letras minúsculas, números, - e _ no nome (até 64).");
  const now = new Date().toISOString();
  const current = index[name];
  const touchId = body.touchId === undefined ? (current?.touchId ?? "hourly") : String(body.touchId);
  if (!["always", "hourly", "never"].includes(touchId))
    throw new VaultError("bad_touch", "touchId precisa ser always, hourly ou never.");
  const kind = body.kind === undefined ? (current?.kind ?? "password") : String(body.kind);
  if (!["password", "token", "text"].includes(kind))
    throw new VaultError("bad_kind", "kind precisa ser password, token ou text.");
  let expiresAt = current?.expiresAt ?? null;
  if (body.expiresAt !== undefined) {
    expiresAt = body.expiresAt === null || body.expiresAt === "" ? null : String(body.expiresAt);
    if (expiresAt && Number.isNaN(Date.parse(expiresAt)))
      throw new VaultError("bad_expiry", "Data de validade inválida.");
  }
  let bots = current?.bots ?? [];
  if (body.bots !== undefined) {
    if (body.bots !== null && !Array.isArray(body.bots))
      throw new VaultError("bad_bots", "bots precisa ser uma lista de ids.");
    bots = ((body.bots as unknown[] | null) ?? []).map(String).filter((id) => /^[a-z0-9-]{1,60}$/.test(id));
  }
  const meta: SecretMeta = {
    name,
    description:
      body.description === undefined ? (current?.description ?? "") : String(body.description ?? "").slice(0, 200),
    domains: body.domains === undefined ? (current?.domains ?? []) : normalizeDomains(body.domains),
    bots,
    touchId: touchId as TouchPolicy,
    expiresAt,
    storage: current?.storage ?? "mac",
    kind: kind as SecretKind,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    rotatedAt: body.rotated === true ? now : (current?.rotatedAt ?? null),
    lastUsedAt: current?.lastUsedAt ?? null,
    lastUsedBy: current?.lastUsedBy ?? null,
    lastTool: current?.lastTool ?? null,
  };
  index[name] = meta;
  await saveIndex();
  if (body.rotated === true && meta.storage === "mac+server") {
    await writeSealed(name, null);
    meta.storage = "mac";
    await saveIndex();
  }
  await audit({ name, outcome: current ? (body.rotated === true ? "rotated" : "updated") : "created", by: "person" });
  return meta;
}

export async function deleteSecret(name: string) {
  if (!loaded) await loadVault();
  const existed = Boolean(index[name]);
  delete index[name];
  await saveIndex();
  await writeSealed(name, null);
  forgetSecretValue(name);
  if (existed) await audit({ name, outcome: "deleted", by: "person" });
  return existed;
}

export async function setServerCopy(name: string, value: string | null) {
  const meta = index[name];
  if (!meta) throw new VaultError("not_found", "Esse segredo não existe no cofre.");
  if (value === null) {
    await writeSealed(name, null);
    meta.storage = "mac";
  } else {
    await writeServerCopy(name, value);
    meta.storage = "mac+server";
  }
  meta.updatedAt = new Date().toISOString();
  await saveIndex();
  await audit({ name, outcome: value === null ? "server_copy_off" : "server_copy_on", by: "person" });
  return meta;
}

export async function ensureVaultLoaded() {
  if (!loaded) await loadVault();
}
