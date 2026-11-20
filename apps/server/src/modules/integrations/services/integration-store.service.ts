import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, like } from "drizzle-orm";
import { dataDir } from "../../../config/env";
import { readOrCreateSecret } from "../../../config/runtime-secrets";
import { getDb } from "../../../db/client";
import { writeSetting } from "../../../db/settings";
import { settings } from "../../../db/tables";
import { forgetSecretValue, rememberSecretValue } from "../../../shared/redact";

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

function vaultKey() {
  try {
    const raw = readFileSync(process.env.VAULT_KEY_FILE ?? join(dataDir, "vault.key"));
    if (raw.length === 32) return raw;
    const text = raw.toString("utf8").trim();
    return /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : null;
  } catch {
    return null;
  }
}

function dataKey() {
  return Buffer.from(readOrCreateSecret("integrations.key"), "base64url").subarray(0, 32);
}

function keyFor(ref: KeyRef) {
  return ref === "vault" ? vaultKey() : dataKey();
}

function aad(id: IntegrationId) {
  return Buffer.from(`runelay-bots:integration:v1:${id}`, "utf8");
}

export async function loadIntegrations() {
  const rows = await getDb().select().from(settings).where(like(settings.key, "integration:%"));
  stored.clear();
  plain.clear();
  for (const row of rows) {
    const id = row.key.slice("integration:".length);
    if (isIntegrationId(id)) stored.set(id, row.value as StoredIntegration);
  }
  return stored.size;
}

export function readStored(id: IntegrationId) {
  return stored.get(id) ?? null;
}

function open(id: IntegrationId, stored: StoredIntegration) {
  const key = keyFor(stored.keyRef);
  if (!key) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
    decipher.setAAD(aad(id));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const ct = Buffer.from(stored.ct, "base64");
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
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
  const vault = vaultKey();
  const keyRef: KeyRef = vault ? "vault" : "data";
  const key = vault ?? dataKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(id));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const now = new Date().toISOString();
  const next: StoredIntegration = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    keyRef,
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
