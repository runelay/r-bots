import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../../config/env";

export const vaultInfo = "runelay-bots/vault/v2";
export const integrationInfo = "runelay-bots/integration/v2";
export const runSecretsKeyFile = "/run/secrets/vault.key";
const salt = Buffer.from("runelay-bots:hkdf:v2", "utf8");
const tagLength = 16;
const ivLength = 12;
const kidLength = 4;
export const sealVersion = 2;

export class KeyFileUnsafe extends Error {}

export function keyFileCandidates(env: NodeJS.ProcessEnv = process.env) {
  const list = [env.VAULT_KEY_FILE?.trim() || null, runSecretsKeyFile, join(dataDir, "vault.key")];
  return [...new Set(list.filter((item): item is string => Boolean(item)))];
}

export function activeKeyFile(env: NodeJS.ProcessEnv = process.env) {
  const candidates = keyFileCandidates(env);
  return candidates.find((file) => existsSync(file)) ?? candidates[0];
}

export function writableKeyFile(env: NodeJS.ProcessEnv = process.env) {
  return env.VAULT_KEY_FILE?.trim() || join(dataDir, "vault.key");
}

export function parseKey(raw: Buffer) {
  if (raw.length === 32) return Buffer.from(raw);
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const decoded = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (decoded.length === 32) return decoded;
  }
  return null;
}

export function assertKeyFileSafe(file: string) {
  const info = statSync(file);
  if ((info.mode & 0o077) !== 0)
    throw new KeyFileUnsafe(
      `${file} can be read by group or others (mode ${(info.mode & 0o777).toString(8)}): run chmod 600 on it`,
    );
}

export function readKeyFile(file: string) {
  try {
    return parseKey(readFileSync(file));
  } catch {
    return null;
  }
}

export function loadMasterKey(env: NodeJS.ProcessEnv = process.env) {
  return readKeyFile(activeKeyFile(env));
}

export function assertKeyFileReadable(file: string) {
  if (readKeyFile(file)) return;
  throw new KeyFileUnsafe(`${file} exists but is not a readable 32 byte key: refusing to replace it`);
}

export function deriveKey(master: Buffer, info: string) {
  return Buffer.from(hkdfSync("sha256", master, salt, Buffer.from(info, "utf8"), 32));
}

export function keyIdOf(key: Buffer) {
  return createHash("sha256").update(key).digest().subarray(0, kidLength);
}

export interface SealedParts {
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

export function sealV2(key: Buffer, plaintext: string, aad: Buffer): SealedParts {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: tagLength });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const header = Buffer.concat([Buffer.from([sealVersion]), keyIdOf(key), iv]);
  return { iv: header, tag: cipher.getAuthTag(), ct };
}

export function sealVersionOf(sealed: SealedParts) {
  return sealed.iv.length === 1 + kidLength + ivLength && sealed.iv[0] === sealVersion ? 2 : 1;
}

export function openGcm(key: Buffer, sealed: SealedParts, aad: Buffer) {
  if (sealed.tag.length !== tagLength) throw new Error("bad tag length");
  let iv = sealed.iv;
  if (sealVersionOf(sealed) === 2) {
    if (!sealed.iv.subarray(1, 1 + kidLength).equals(keyIdOf(key))) throw new Error("key id mismatch");
    iv = sealed.iv.subarray(1 + kidLength);
  }
  if (iv.length !== ivLength) throw new Error("bad iv length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: tagLength });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ct), decipher.final()]).toString("utf8");
}

export function policyDigest(policy: { bots: string[]; domains: string[]; expiresAt: string | null }) {
  const canonical = JSON.stringify({
    bots: [...policy.bots].sort(),
    domains: [...policy.domains].sort(),
    expiresAt: policy.expiresAt ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
