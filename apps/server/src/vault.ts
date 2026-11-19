import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import { join } from "node:path";
import { dataDir } from "./config";
import { MacRunnerUnavailable, macRunnerAuthorized, macRunnerSupports, macSecretResolve } from "./mac-runner";
import { forgetSecretValue, redactDeep, rememberSecretValue } from "./redact";

export const vaultDir = join(dataDir, "vault");
const indexFile = join(vaultDir, "index.json");
const auditFile = join(vaultDir, "audit.ndjson");
const keyFile = process.env.VAULT_KEY_FILE ?? "/run/runelay-bots/vault.key";

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

async function ensureDir() {
  await mkdir(vaultDir, { recursive: true, mode: 0o700 });
  await chmod(vaultDir, 0o700).catch(() => undefined);
}

export async function loadVault() {
  await ensureDir();
  try {
    index = JSON.parse(await readFile(indexFile, "utf8")) as Record<string, SecretMeta>;
  } catch {
    index = {};
  }
  loaded = true;
}

async function saveIndex() {
  await ensureDir();
  const tmp = `${indexFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
  await rename(tmp, indexFile);
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

function encFile(name: string) {
  return join(vaultDir, `${name}.enc`);
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
  await ensureDir();
  const file = encFile(name);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
    }),
    { mode: 0o600 },
  );
  await rename(tmp, file);
}

async function readServerCopy(name: string) {
  const key = loadKey();
  if (!key)
    throw new VaultError("no_key", "O servidor perdeu a chave do cofre e não consegue abrir a cópia guardada aqui.");
  try {
    const payload = JSON.parse(await readFile(encFile(name), "utf8")) as { iv: string; tag: string; ct: string };
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAAD(aad(name));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload.ct, "base64")), decipher.final()]).toString("utf8");
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
  await ensureDir();
  const line = JSON.stringify(redactDeep({ at: new Date().toISOString(), ...entry }));
  await appendFile(auditFile, `${line}\n`, { mode: 0o600 });
}

export async function readAudit(name: string | null, limit: number) {
  let text = "";
  try {
    text = await readFile(auditFile, "utf8");
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  const lines = text.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]) as Record<string, unknown>;
      if (!name || row.name === name) rows.push(row);
    } catch {}
  }
  return rows;
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

async function markUsed(name: string, botId: string, tool: string) {
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

function takeExecTicket(ticket: string) {
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
    await rm(encFile(name), { force: true });
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
  await rm(encFile(name), { force: true });
  forgetSecretValue(name);
  if (existed) await audit({ name, outcome: "deleted", by: "person" });
  return existed;
}

async function setServerCopy(name: string, value: string | null) {
  const meta = index[name];
  if (!meta) throw new VaultError("not_found", "Esse segredo não existe no cofre.");
  if (value === null) {
    await rm(encFile(name), { force: true });
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

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new VaultError("too_big", "Corpo grande demais.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new VaultError("bad_json", "JSON inválido.");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function publicMeta(meta: SecretMeta) {
  return { ...meta, ref: `segredo:${meta.name}`, env: envNameOf(meta.name) };
}

export async function handleVaultRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  method: string,
  parts: string[],
) {
  if (!loaded) await loadVault();
  if (parts[1] === "exec" && parts.length === 3 && method === "POST") {
    if (req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"])
      return json(res, 404, { ok: false, error: "Rota não encontrada." });
    const entry = takeExecTicket(parts[2]);
    if (!entry) return json(res, 410, { ok: false, error: "Esse tíquete já foi usado ou venceu." });
    return json(res, 200, { env: entry.env, redact: entry.redact });
  }
  if (!macRunnerAuthorized(req))
    return json(res, 401, { ok: false, error: "O cofre só responde ao app runelay bots." });
  try {
    if (parts.length === 2 && parts[1] === "secrets" && method === "GET") {
      return json(res, 200, { secrets: listSecretMeta().map(publicMeta), serverStorage: serverStorageAvailable() });
    }
    if (parts.length === 2 && parts[1] === "audit" && method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      return json(res, 200, await readAudit(url.searchParams.get("name"), limit));
    }
    if (parts.length === 2 && parts[1] === "audit" && method === "POST") {
      const body = await readJsonBody(req);
      const name = String(body.name ?? "");
      if (!secretNamePattern.test(name)) throw new VaultError("bad_name", "Nome inválido.");
      const outcome = String(body.outcome ?? "");
      if (!["used", "denied", "revealed"].includes(outcome)) throw new VaultError("bad_outcome", "outcome inválido.");
      await audit({
        name,
        outcome,
        by: body.botId ? "bot" : "person",
        ...(body.botId ? { botId: String(body.botId).slice(0, 60) } : {}),
        ...(body.botName ? { botName: String(body.botName).slice(0, 60) } : {}),
        ...(body.tool ? { tool: String(body.tool).slice(0, 60) } : {}),
        ...(body.domain ? { domain: String(body.domain).slice(0, 253) } : {}),
        ...(body.reason ? { reason: String(body.reason).slice(0, 60) } : {}),
        source: "mac",
      });
      if (outcome === "used" && body.botId) await markUsed(name, String(body.botId), String(body.tool ?? ""));
      return json(res, 200, { ok: true });
    }
    const name = parts[2] ?? "";
    if (parts[1] === "secrets" && parts.length === 3 && method === "PUT")
      return json(res, 200, publicMeta(await saveSecretMeta(name, await readJsonBody(req))));
    if (parts[1] === "secrets" && parts.length === 3 && method === "DELETE") {
      const existed = await deleteSecret(name);
      return json(
        res,
        existed ? 200 : 404,
        existed ? { ok: true, name } : { ok: false, error: "Esse segredo não existe no cofre." },
      );
    }
    if (parts[1] === "secrets" && parts.length === 4 && parts[3] === "server-copy" && method === "PUT") {
      const body = await readJsonBody(req);
      const value = typeof body.value === "string" ? body.value : "";
      body.value = null;
      if (!value || value.length > 16_384)
        throw new VaultError("bad_value", "Valor vazio ou grande demais (máximo 16 KB).");
      return json(res, 200, publicMeta(await setServerCopy(name, value)));
    }
    if (parts[1] === "secrets" && parts.length === 4 && parts[3] === "server-copy" && method === "DELETE")
      return json(res, 200, publicMeta(await setServerCopy(name, null)));
    return json(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    if (error instanceof VaultError)
      return json(res, error.code === "not_found" ? 404 : 400, { ok: false, code: error.code, error: error.message });
    throw error;
  }
}
