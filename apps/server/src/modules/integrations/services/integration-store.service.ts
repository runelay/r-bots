import { eq, like } from "drizzle-orm";
import { readOrCreateSecret } from "../../../config/runtime-secrets";
import { getDb, writeTransaction } from "../../../db/client";
import { writeSetting } from "../../../db/settings";
import { settings } from "../../../db/tables";
import { forgetSecretValue, rememberSecretValue } from "../../../shared/redact";
import {
  deriveKey,
  integrationInfo,
  loadMasterKey,
  openGcm,
  parseKey,
  sealV2,
  sealVersionOf,
} from "../../vault/services/vault-key.service";

export const integrationIds = ["elevenlabs", "jev", "runelay"] as const;
export type IntegrationId = (typeof integrationIds)[number];
export type IntegrationSource = "app" | "env";
type KeyRef = "vault" | "data";

const envKeys: Record<IntegrationId, string> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  jev: "JEV_API_KEY",
  runelay: "RUNELAY_MCP_TOKEN",
};

export interface StoredIntegration {
  iv: string;
  tag: string;
  ct: string;
  keyRef: KeyRef;
  last4: string;
  url: string | null;
  validatedAt: string;
  savedAt: string;
}

const listeners = new Set<(id: IntegrationId) => void>();
const plain = new Map<IntegrationId, string | null>();
const stored = new Map<IntegrationId, StoredIntegration | null>();

export function isIntegrationId(value: string): value is IntegrationId {
  return (integrationIds as readonly string[]).includes(value);
}

function settingKey(id: IntegrationId) {
  return `integration:${id}`;
}

function dataKey() {
  return parseKey(Buffer.from(readOrCreateSecret("integrations.key"), "utf8"));
}

function keyFor(ref: KeyRef) {
  return ref === "vault" ? loadMasterKey() : dataKey();
}

function aadV1(id: IntegrationId) {
  return Buffer.from(`runelay-bots:integration:v1:${id}`, "utf8");
}

function aadV2(id: IntegrationId, url: string | null) {
  return Buffer.from(`runelay-bots:integration:v2:${id}:${url ?? ""}`, "utf8");
}

function seal(id: IntegrationId, secret: string, url: string | null) {
  const vault = loadMasterKey();
  const keyRef: KeyRef = vault ? "vault" : "data";
  const base = vault ?? dataKey();
  if (!base) throw new Error("no integration key");
  const key = deriveKey(base, integrationInfo);
  base.fill(0);
  try {
    const sealed = sealV2(key, secret, aadV2(id, url));
    return {
      iv: sealed.iv.toString("base64"),
      tag: sealed.tag.toString("base64"),
      ct: sealed.ct.toString("base64"),
      keyRef,
    };
  } finally {
    key.fill(0);
  }
}

export async function loadIntegrations() {
  const rows = await getDb().select().from(settings).where(like(settings.key, "integration:%"));
  stored.clear();
  plain.clear();
  for (const row of rows) {
    const id = row.key.slice("integration:".length);
    if (isIntegrationId(id)) stored.set(id, row.value as StoredIntegration);
  }
  await migrateIntegrations();
  return stored.size;
}

function partsOf(current: StoredIntegration) {
  return {
    iv: Buffer.from(current.iv, "base64"),
    tag: Buffer.from(current.tag, "base64"),
    ct: Buffer.from(current.ct, "base64"),
  };
}

export async function migrateIntegrations() {
  const updates: [IntegrationId, StoredIntegration][] = [];
  for (const [id, current] of stored) {
    if (!current || sealVersionOf(partsOf(current)) !== 1) continue;
    const value = open(id, current);
    if (value === null) continue;
    updates.push([id, { ...current, ...seal(id, value, current.url) }]);
  }
  if (updates.length === 0) return 0;
  await writeTransaction(async (tx) => {
    for (const [id, next] of updates) await writeSetting(settingKey(id), next, tx);
  });
  for (const [id, next] of updates) stored.set(id, next);
  console.log(`integrations: re-encrypted ${updates.length} keys to v2`);
  return updates.length;
}

export function readStored(id: IntegrationId) {
  return stored.get(id) ?? null;
}

function open(id: IntegrationId, current: StoredIntegration) {
  const base = keyFor(current.keyRef);
  if (!base) return null;
  const parts = partsOf(current);
  const v1 = sealVersionOf(parts) === 1;
  const key = v1 ? base : deriveKey(base, integrationInfo);
  try {
    return openGcm(key, parts, v1 ? aadV1(id) : aadV2(id, current.url));
  } catch {
    return null;
  } finally {
    key.fill(0);
    base.fill(0);
  }
}

function savedSecret(id: IntegrationId) {
  if (plain.has(id)) return plain.get(id) ?? null;
  const current = readStored(id);
  const value = current ? open(id, current) : null;
  if (value) rememberSecretValue(`integration:${id}`, value);
  plain.set(id, value);
  return value;
}

function envSecret(id: IntegrationId) {
  return process.env[envKeys[id]]?.trim() || null;
}

export function integrationSecret(id: IntegrationId) {
  return savedSecret(id) ?? envSecret(id);
}

export function integrationSource(id: IntegrationId): IntegrationSource | null {
  if (savedSecret(id)) return "app";
  return envSecret(id) ? "env" : null;
}

export function integrationUrl(id: IntegrationId) {
  if (savedSecret(id)) {
    const url = readStored(id)?.url;
    if (url) return url;
  }
  return id === "runelay" ? process.env.RUNELAY_MCP_URL?.trim() || null : null;
}

export function storedIntegrationBroken(id: IntegrationId) {
  return readStored(id) !== null && savedSecret(id) === null;
}

export function last4(value: string) {
  return value.length >= 8 ? value.slice(-4) : "";
}

export async function writeStored(id: IntegrationId, secret: string, url: string | null) {
  const now = new Date().toISOString();
  const next: StoredIntegration = {
    ...seal(id, secret, url),
    last4: last4(secret),
    url,
    validatedAt: now,
    savedAt: now,
  };
  await writeSetting(settingKey(id), next);
  stored.set(id, next);
  rememberSecretValue(`integration:${id}`, secret);
  plain.set(id, secret);
  notify(id);
  return next;
}

export async function clearStored(id: IntegrationId) {
  const existed = readStored(id) !== null;
  await getDb()
    .delete(settings)
    .where(eq(settings.key, settingKey(id)));
  stored.delete(id);
  forgetSecretValue(`integration:${id}`);
  plain.delete(id);
  notify(id);
  return existed;
}

export function envLast4(id: IntegrationId) {
  const value = envSecret(id);
  return value ? last4(value) : "";
}

export function onIntegrationChange(listener: (id: IntegrationId) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(id: IntegrationId) {
  for (const listener of listeners) {
    try {
      listener(id);
    } catch {}
  }
}

export async function resetIntegrationCache() {
  await loadIntegrations();
}
