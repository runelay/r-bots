import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDataDir } from "../../../../test/helpers";
import {
  activeKeyFile,
  assertKeyFileReadable,
  deriveKey,
  integrationInfo,
  keyFileCandidates,
  openGcm,
  parseKey,
  runSecretsKeyFile,
  sealV2,
  vaultInfo,
  writableKeyFile,
} from "../services/vault-key.service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("vault key", () => {
  test("looks for the key in VAULT_KEY_FILE, /run/secrets and the data dir, in that order", () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-key-"));
    dirs.push(dir);
    const custom = join(dir, "custom.key");
    const env = { VAULT_KEY_FILE: custom };
    expect(keyFileCandidates(env)).toEqual([custom, runSecretsKeyFile, join(testDataDir(), "vault.key")]);
    expect(keyFileCandidates({})).toEqual([runSecretsKeyFile, join(testDataDir(), "vault.key")]);
    expect(activeKeyFile(env)).toBe(custom);
    writeFileSync(custom, randomBytes(32).toString("hex"), { mode: 0o600 });
    expect(activeKeyFile(env)).toBe(custom);
    expect(writableKeyFile(env)).toBe(custom);
    expect(writableKeyFile({ VAULT_KEY_FILE: " " })).toBe(join(testDataDir(), "vault.key"));
  });

  test("parses 32 byte raw, hex or base64 keys", () => {
    const key = randomBytes(32);
    expect(parseKey(Buffer.from(key.toString("hex")))?.equals(key)).toBe(true);
    expect(parseKey(Buffer.from(`${key.toString("base64")}\n`))?.equals(key)).toBe(true);
    expect(parseKey(Buffer.from(key.toString("base64url")))?.equals(key)).toBe(true);
    expect(parseKey(key)?.equals(key)).toBe(true);
    expect(parseKey(randomBytes(31))).toBeNull();
    expect(parseKey(Buffer.from(randomBytes(31).toString("base64")))).toBeNull();
    expect(parseKey(Buffer.from("short"))).toBeNull();
  });

  test("refuses a key file that exists but does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-key-"));
    dirs.push(dir);
    const file = join(dir, "vault.key");
    writeFileSync(file, randomBytes(32), { mode: 0o600 });
    expect(() => assertKeyFileReadable(file)).not.toThrow();
    writeFileSync(file, "not a key", { mode: 0o600 });
    expect(() => assertKeyFileReadable(file)).toThrow("refusing to replace it");
  });

  test("derives separate subkeys and rejects a wrong key id or tag length", () => {
    const master = randomBytes(32);
    const vault = deriveKey(master, vaultInfo);
    const integration = deriveKey(master, integrationInfo);
    expect(vault.equals(integration)).toBe(false);
    expect(vault.equals(master)).toBe(false);
    const aad = Buffer.from("aad");
    const sealed = sealV2(vault, "hello world", aad);
    expect(openGcm(vault, sealed, aad)).toBe("hello world");
    expect(() => openGcm(integration, sealed, aad)).toThrow("key id mismatch");
    expect(() => openGcm(vault, { ...sealed, tag: sealed.tag.subarray(0, 12) }, aad)).toThrow("bad tag length");
    expect(() => openGcm(vault, { ...sealed, iv: Buffer.alloc(8) }, aad)).toThrow("bad iv length");
    expect(() => openGcm(vault, sealed, Buffer.from("other"))).toThrow();
  });
});
