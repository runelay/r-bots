import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { forgetSecretValue, minSecretLength, redactDeep, rememberSecretValue } from "../../../shared/redact";
import { MacRunnerUnavailable, macRunnerSupports, macSecretResolve } from "../../accounts/services/mac-runner.service";
import { vaultText } from "../constants/vault-messages.constants";
import {
  addAudit,
  loadSecretMetas,
  readAuditRows,
  readSealed,
  type Sealed,
  saveSecretMetas,
  writeSealed,
  writeSealedMany,
} from "../repositories/vault.repository";
import { isPublicSuffix } from "./public-suffix";
import {
  assertKeyFileReadable,
  assertKeyFileSafe,
  deriveKey,
  KeyFileUnsafe,
  keyFileCandidates,
  loadMasterKey,
  openGcm,
  policyDigest,
  sealV2,
  sealVersionOf,
  vaultInfo,
  writableKeyFile,
} from "./vault-key.service";

const legacyKeyFiles = () => [
  join(process.env.HOST_HOME?.trim() || homedir(), ".config", "runelay-bots", "vault.key"),
  join(homedir(), ".config", "runelay-bots", "vault.key"),
  "/run/runelay-bots/vault.key",
];
const hostTools = new Set(["http_request", "Bash", "browser_fill"]);

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
  const present = keyFileCandidates().find((file) => existsSync(file));
  if (present) {
    assertKeyFileSafe(present);
    assertKeyFileReadable(present);
    return;
  }
  const keyFile = writableKeyFile();
  mkdirSync(dirname(keyFile), { recursive: true });
  const legacy = legacyKeyFiles().find((file) => file !== keyFile && existsSync(file));
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
    if (error instanceof KeyFileUnsafe) throw error;
    console.warn(`vault key setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await migrateServerCopies();
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

export function serverStorageAvailable() {
  return loadMasterKey() !== null;
}

type Policy = Pick<SecretMeta, "bots" | "domains" | "expiresAt">;

function aadV1(name: string) {
  return Buffer.from(`runelay-bots:vault:v1:${name}`, "utf8");
}

function aadV2(name: string, policy: Policy) {
  return Buffer.from(`runelay-bots:vault:v2:${name}:${policyDigest(policy)}`, "utf8");
}

function sealCopy(master: Buffer, name: string, value: string, policy: Policy) {
  const key = deriveKey(master, vaultInfo);
  try {
    return sealV2(key, value, aadV2(name, policy));
  } finally {
    key.fill(0);
  }
}

function openCopy(master: Buffer, name: string, sealed: Sealed, policy: Policy) {
  if (sealVersionOf(sealed) === 1) return openGcm(master, sealed, aadV1(name));
  const key = deriveKey(master, vaultInfo);
  try {
    return openGcm(key, sealed, aadV2(name, policy));
  } finally {
    key.fill(0);
  }
}

async function writeServerCopy(name: string, value: string, policy: Policy) {
  const master = loadMasterKey();
  if (!master) throw new VaultError("no_key", vaultText("noKey"));
  const sealed = sealCopy(master, name, value, policy);
  master.fill(0);
  await saveSecretMetas(index);
  await writeSealed(name, sealed);
}

async function readServerCopy(name: string, policy: Policy) {
  const master = loadMasterKey();
  if (!master) throw new VaultError("no_key", vaultText("lostKey"));
  try {
    const sealed = await readSealed(name);
    if (!sealed) throw new Error("missing");
    return openCopy(master, name, sealed, policy);
  } catch {
    throw new VaultError(
      "server_copy_broken",
      `A cópia do segredo:${name} no servidor não abriu. Peça à pessoa para salvar o segredo de novo no Cofre.`,
    );
  } finally {
    master.fill(0);
  }
}

export async function migrateServerCopies() {
  const master = loadMasterKey();
  if (!master) return 0;
  const updates: { name: string; sealed: Sealed }[] = [];
  try {
    for (const meta of Object.values(index)) {
      if (meta.storage !== "mac+server") continue;
      const sealed = await readSealed(meta.name);
      if (!sealed || sealVersionOf(sealed) !== 1) continue;
      try {
        const value = openGcm(master, sealed, aadV1(meta.name));
        updates.push({ name: meta.name, sealed: sealCopy(master, meta.name, value, meta) });
      } catch {
        console.warn(`vault: server copy of ${meta.name} did not open with the current key, left as is`);
      }
    }
  } finally {
    master.fill(0);
  }
  if (updates.length) {
    await writeSealedMany(updates);
    console.log(`vault: re-encrypted ${updates.length} server copies to v2`);
  }
  return updates.length;
}

async function resealForPolicy(name: string, before: Policy, after: Policy) {
  if (policyDigest(before) === policyDigest(after)) return;
  const master = loadMasterKey();
  if (!master) return;
  try {
    const sealed = await readSealed(name);
    if (!sealed) return;
    const value = openCopy(master, name, sealed, before);
    await writeSealed(name, sealCopy(master, name, value, after));
  } catch {
    console.warn(`vault: server copy of ${name} could not be re-encrypted for the new policy`);
  } finally {
    master.fill(0);
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
      throw new VaultError("bad_domains", vaultText("badSite", { site: String(item) }));
    const base = value.replace(/^\*\./, "");
    if (base.split(".").length < 2 || isPublicSuffix(base))
      throw new VaultError("bad_domains", vaultText("broadSite", { site: String(item) }));
    if (!out.includes(value)) out.push(value);
  }
  if (out.length > 30) throw new VaultError("bad_domains", vaultText("maxSites"));
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
  const denied =
    policyError(meta, request.botId, request.host) ??
    (meta.domains.length === 0 && hostTools.has(request.tool)
      ? new VaultError(
          "no_domains",
          `O segredo:${meta.name} não tem sites liberados, então não pode sair por ${request.tool}. Peça para a pessoa colocar os sites dele no Cofre (por exemplo api.github.com).`,
        )
      : null);
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
    macFailure = new VaultError("mac_offline", "O app r/bots não está aberto no Mac.");
  }
  if (value === null) {
    if (meta.storage !== "mac+server") {
      await audit({ ...base, outcome: "denied", reason: "mac_offline" });
      throw new VaultError(
        "mac_offline",
        `O segredo:${request.name} fica só no Mac da pessoa, e o Mac está offline (${macFailure?.message ?? "app fechado"}). Diga isso à pessoa: ela pode abrir o app r/bots ou ligar “usar com o Mac fechado” nesse segredo no Cofre.`,
      );
    }
    value = await readServerCopy(request.name, meta);
    source = "server";
  }
  if (value.length < minSecretLength) {
    await audit({ ...base, outcome: "denied", reason: "too_short", source });
    throw new VaultError(
      "too_short",
      `O segredo:${request.name} tem menos de ${minSecretLength} caracteres e não dá para escondê-lo das saídas. Peça para a pessoa salvar um valor maior.`,
    );
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

export interface ExecGrant {
  argv: string[];
  env: Record<string, string>;
  stdin: string | null;
  tempHome: boolean;
  redact: string[];
  path: string;
}

interface TicketEntry {
  grant: ExecGrant;
  until: number;
  signal: AbortSignal | null;
}

export const execTicketTtlMs = 30_000;
const tickets = new Map<string, TicketEntry>();
const spentTickets = new Map<string, number>();

export function issueExecTicket(grant: ExecGrant, signal: AbortSignal | null = null) {
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { grant, until: Date.now() + execTicketTtlMs, signal });
  const drop = () => tickets.delete(ticket);
  setTimeout(drop, execTicketTtlMs + 1000).unref();
  signal?.addEventListener("abort", drop, { once: true });
  return ticket;
}

export function takeExecTicket(ticket: string) {
  const entry = tickets.get(ticket);
  if (!entry) {
    if (spentTickets.has(ticket)) console.warn("vault: an exec ticket was presented twice");
    return null;
  }
  tickets.delete(ticket);
  const now = Date.now();
  for (const [key, until] of spentTickets) if (until < now) spentTickets.delete(key);
  spentTickets.set(ticket, now + execTicketTtlMs);
  if (entry.until < now || entry.signal?.aborted) return null;
  return entry.grant;
}

export async function saveSecretMeta(name: string, body: Record<string, unknown>) {
  if (!loaded) await loadVault();
  if (!secretNamePattern.test(name)) throw new VaultError("bad_name", vaultText("nameRule"));
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
      throw new VaultError("bad_expiry", vaultText("expiryInvalid"));
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
  if (current && meta.storage === "mac+server" && body.rotated !== true) await resealForPolicy(name, current, meta);
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
  if (!meta) throw new VaultError("not_found", vaultText("secretMissing"));
  if (value === null) {
    await writeSealed(name, null);
    meta.storage = "mac";
  } else {
    if (value.length < minSecretLength)
      throw new VaultError("too_short", vaultText("tooShort", { min: minSecretLength }));
    await writeServerCopy(name, value, meta);
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
