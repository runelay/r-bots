import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { chmod, mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { resetData } from "../../../../test/helpers";
import { connectFakeRunner } from "../../../../test/media-helpers";
import { getDb } from "../../../db";
import { vaultAudit, vaultSecrets } from "../../../db/tables";
import { forgetSecretValue, redactText } from "../../../shared/redact";
import * as macRunner from "../../accounts/services/mac-runner.service";
import * as repository from "../repositories/vault.repository";
import {
  audit,
  deleteSecret,
  type ExecGrant,
  ensureVaultLoaded,
  envNameOf,
  envRefsIn,
  getSecretMeta,
  hasRefs,
  hostAllowed,
  issueExecTicket,
  listSecretMeta,
  loadVault,
  markUsed,
  migrateServerCopies,
  normalizeDomains,
  normalizeHost,
  onlyRefs,
  policyError,
  readAudit,
  refsIn,
  registerSecretSource,
  resolveSecret,
  type SecretMeta,
  saveSecretMeta,
  serverStorageAvailable,
  setServerCopy,
  substituteRefs,
  takeExecTicket,
  VaultError,
} from "../services/vault.service";

const keyFile = process.env.VAULT_KEY_FILE as string;
const testKey = randomBytes(32);
const request = { botId: "bot-a", botName: "Bot A", tool: "computer_type", host: "github.com", sessionId: "s1" };
const remembered = new Set<string>();

async function useKey(content: Buffer | string | null, mode = 0o600) {
  if (content === null) return await rm(keyFile, { force: true });
  await writeFile(keyFile, content, { mode });
  await chmod(keyFile, mode);
}

function grant(extra: Partial<ExecGrant> = {}): ExecGrant {
  return { argv: ["curl"], env: {}, stdin: null, tempHome: false, redact: [], path: "/usr/bin", ...extra };
}

function sealV1(name: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", testKey, iv);
  cipher.setAAD(Buffer.from(`runelay-bots:vault:v1:${name}`, "utf8"));
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

async function resolveOk(name: string, extra: Partial<typeof request> = {}) {
  remembered.add(name);
  return resolveSecret({ ...request, ...extra, name });
}

async function vaultCode(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof VaultError) return error.code;
    throw error;
  }
  return "ok";
}

async function auditRows() {
  return readAudit(null, 500);
}

beforeEach(async () => {
  await resetData();
  await useKey(testKey.toString("hex"));
  await getDb().delete(vaultAudit);
  await getDb().delete(vaultSecrets);
  await loadVault();
});

afterEach(async () => {
  for (const name of remembered) forgetSecretValue(name);
  remembered.clear();
  setSystemTime();
});

afterAll(async () => {
  await useKey(null);
});

describe("names and references", () => {
  test("envNameOf turns a secret name into its env variable", async () => {
    expect(envNameOf("github-token")).toBe("SEGREDO_GITHUB_TOKEN");
  });

  test("refsIn, hasRefs and onlyRefs find segredo references", async () => {
    expect(refsIn("a segredo:one b segredo:two segredo:one")).toEqual(["one", "two"]);
    expect(hasRefs("segredo:x")).toBe(true);
    expect(hasRefs("nothing")).toBe(false);
    expect(hasRefs(42)).toBe(false);
    expect(onlyRefs(" segredo:x segredo:y ")).toBe(true);
    expect(onlyRefs("user segredo:x")).toBe(false);
    expect(onlyRefs(null)).toBe(false);
  });

  test("envRefsIn maps known env names and reports unknown ones", async () => {
    await saveSecretMeta("api-key", {});
    expect(envRefsIn(`curl -H $SEGREDO_API_KEY \${SEGREDO_MISSING} segredo:other`)).toEqual({
      names: ["other", "api-key"],
      unknown: ["SEGREDO_MISSING"],
    });
  });
});

describe("hosts and domains", () => {
  test("normalizeHost cleans urls, brackets and trailing dots", async () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost(" HTTPS://GitHub.com/path ")).toBe("github.com");
    expect(normalizeHost("http://[bad")).toBe("http://[bad");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost(".")).toBeNull();
  });

  test("hostAllowed applies exact, www and wildcard patterns", async () => {
    expect(hostAllowed([], null)).toBe(true);
    expect(hostAllowed(["github.com"], null)).toBe(false);
    expect(hostAllowed(["github.com"], "github.com")).toBe(true);
    expect(hostAllowed(["github.com"], "www.github.com")).toBe(true);
    expect(hostAllowed(["github.com"], "api.github.com")).toBe(false);
    expect(hostAllowed(["*.github.com"], "github.com")).toBe(true);
    expect(hostAllowed(["*.github.com"], "api.github.com")).toBe(true);
    expect(hostAllowed(["*.github.com"], "evilgithub.com")).toBe(false);
  });

  test("normalizeDomains cleans the list and rejects invalid entries", async () => {
    expect(normalizeDomains(undefined)).toEqual([]);
    expect(normalizeDomains(null)).toEqual([]);
    expect(
      normalizeDomains([
        "https://www.GitHub.com/login",
        "github.com",
        "",
        null,
        "*.example.org",
        "docs.example.org/path",
      ]),
    ).toEqual(["github.com", "*.example.org", "docs.example.org"]);
    expect(() => normalizeDomains("github.com")).toThrow("domains precisa ser uma lista");
    expect(() => normalizeDomains(["http://[bad"])).toThrow("não é um site válido");
    expect(() => normalizeDomains(["bad domain"])).toThrow("não é um site válido");
    expect(() => normalizeDomains([`${"a".repeat(250)}.com`])).toThrow("não é um site válido");
    for (const broad of ["com", "*.com", "com.br", "*.com.br", "co.uk", "*.github.io", "localhost"])
      expect(() => normalizeDomains([broad])).toThrow("amplo demais");
    expect(normalizeDomains(["*.exemplo.com.br", "api.exemplo.co.uk"])).toEqual([
      "*.exemplo.com.br",
      "api.exemplo.co.uk",
    ]);
    const many = Array.from({ length: 31 }, (_, index) => `site${index}.com`);
    expect(() => normalizeDomains(many)).toThrow("no máximo 30 sites");
  });
});

describe("metadata", () => {
  test("saveSecretMeta creates with defaults and persists the index", async () => {
    const meta = await saveSecretMeta("github-token", { description: "Token", domains: ["github.com"] });
    expect(meta).toMatchObject({
      name: "github-token",
      description: "Token",
      domains: ["github.com"],
      bots: [],
      touchId: "hourly",
      kind: "password",
      storage: "mac",
      expiresAt: null,
      rotatedAt: null,
    });
    expect(getSecretMeta("github-token")).toEqual(meta);
    expect(getSecretMeta("nope")).toBeNull();
    expect((await repository.loadSecretMetas())["github-token"].description).toBe("Token");
    expect((await auditRows())[0]).toMatchObject({ name: "github-token", outcome: "created", by: "person" });
  });

  test("saveSecretMeta updates only the given fields", async () => {
    await saveSecretMeta("a", { description: "first", touchId: "always", kind: "token", bots: ["bot-a"] });
    const updated = await saveSecretMeta("a", {
      description: null,
      expiresAt: "2030-01-01T00:00:00.000Z",
      bots: ["bot-b", "Bad Id!"],
    });
    expect(updated).toMatchObject({
      description: "",
      touchId: "always",
      kind: "token",
      bots: ["bot-b"],
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect((await saveSecretMeta("a", { expiresAt: "" })).expiresAt).toBeNull();
    expect((await saveSecretMeta("a", { expiresAt: null, bots: null })).bots).toEqual([]);
    expect((await auditRows())[0]).toMatchObject({ name: "a", outcome: "updated" });
  });

  test("saveSecretMeta validates every field", async () => {
    expect(await vaultCode(saveSecretMeta("Bad Name", {}))).toBe("bad_name");
    expect(await vaultCode(saveSecretMeta("a", { touchId: "sometimes" }))).toBe("bad_touch");
    expect(await vaultCode(saveSecretMeta("a", { kind: "pin" }))).toBe("bad_kind");
    expect(await vaultCode(saveSecretMeta("a", { expiresAt: "not a date" }))).toBe("bad_expiry");
    expect(await vaultCode(saveSecretMeta("a", { bots: "bot-a" }))).toBe("bad_bots");
    expect(await vaultCode(saveSecretMeta("a", { domains: ["bad domain"] }))).toBe("bad_domains");
    expect(listSecretMeta()).toEqual([]);
  });

  test("rotating a secret drops its server copy", async () => {
    await saveSecretMeta("a", {});
    await setServerCopy("a", "server-value-1");
    expect(await repository.readSealed("a")).not.toBeNull();
    const rotated = await saveSecretMeta("a", { rotated: true });
    expect(rotated.storage).toBe("mac");
    expect(rotated.rotatedAt).not.toBeNull();
    expect(await repository.readSealed("a")).toBeNull();
    expect((await auditRows())[0]).toMatchObject({ name: "a", outcome: "rotated" });
  });

  test("listSecretMeta is sorted by name", async () => {
    await saveSecretMeta("zeta", {});
    await saveSecretMeta("alpha", {});
    expect(listSecretMeta().map((meta) => meta.name)).toEqual(["alpha", "zeta"]);
  });

  test("deleteSecret removes the meta, the server copy and audits only real deletes", async () => {
    await saveSecretMeta("a", {});
    await setServerCopy("a", "server-value-1");
    expect(await deleteSecret("a")).toBe(true);
    expect(getSecretMeta("a")).toBeNull();
    expect(await repository.readSealed("a")).toBeNull();
    expect(await deleteSecret("a")).toBe(false);
    const outcomes = (await auditRows()).map((row) => row.outcome);
    expect(outcomes.filter((outcome) => outcome === "deleted")).toHaveLength(1);
  });

  test("loadVault reads the stored secrets back", async () => {
    await saveSecretMeta("a", { description: "kept" });
    await getDb().delete(vaultSecrets);
    await ensureVaultLoaded();
    expect(getSecretMeta("a")?.description).toBe("kept");
    await loadVault();
    expect(listSecretMeta()).toEqual([]);
  });

  test("markUsed records the last use and ignores unknown names and write failures", async () => {
    await saveSecretMeta("a", {});
    await markUsed("missing", "bot-a", "tool");
    await markUsed("a", "bot-a", "http_request");
    expect(getSecretMeta("a")).toMatchObject({ lastUsedBy: "bot-a", lastTool: "http_request" });
    const write = spyOn(repository, "saveSecretMetas").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      await markUsed("a", "bot-b", "Bash");
    } finally {
      write.mockRestore();
    }
    expect(getSecretMeta("a")?.lastUsedBy).toBe("bot-b");
  });
});

describe("server copy and key", () => {
  test("serverStorageAvailable accepts raw, hex and base64 keys", async () => {
    expect(serverStorageAvailable()).toBe(true);
    await useKey(`${testKey.toString("base64")}\n`);
    expect(serverStorageAvailable()).toBe(true);
    await useKey(testKey.toString("base64url"));
    expect(serverStorageAvailable()).toBe(true);
    await useKey(testKey);
    expect(serverStorageAvailable()).toBe(true);
    await useKey("short");
    expect(serverStorageAvailable()).toBe(false);
    await useKey(null);
    expect(serverStorageAvailable()).toBe(false);
  });

  test("setServerCopy encrypts the value and turning it off removes it", async () => {
    await saveSecretMeta("a", {});
    const on = await setServerCopy("a", "plain-secret-value");
    expect(on.storage).toBe("mac+server");
    const sealed = await repository.readSealed("a");
    expect(sealed?.iv).toHaveLength(17);
    expect(sealed?.iv[0]).toBe(2);
    expect(sealed?.tag).toHaveLength(16);
    expect(sealed?.ct.toString("utf8")).not.toContain("plain-secret-value");
    const off = await setServerCopy("a", null);
    expect(off.storage).toBe("mac");
    expect(await repository.readSealed("a")).toBeNull();
    const outcomes = (await auditRows()).map((row) => row.outcome);
    expect(outcomes).toContain("server_copy_on");
    expect(outcomes).toContain("server_copy_off");
  });

  test("setServerCopy fails for unknown secrets and without a key", async () => {
    expect(await vaultCode(setServerCopy("missing", "x"))).toBe("not_found");
    await saveSecretMeta("a", {});
    expect(await vaultCode(setServerCopy("a", "abc"))).toBe("too_short");
    await useKey(null);
    expect(await vaultCode(setServerCopy("a", "value-1234"))).toBe("no_key");
  });
});

describe("key file setup", () => {
  const realExists = fs.existsSync;

  async function keyOnDisk() {
    const handle = await open(keyFile);
    try {
      return { text: await handle.readFile("utf8"), mode: (await handle.stat()).mode & 0o777 };
    } finally {
      await handle.close();
    }
  }
  const legacyKey = join(process.env.HOST_HOME as string, ".config", "runelay-bots", "vault.key");

  function hideMachineKeys() {
    const machine = [join(homedir(), ".config", "runelay-bots"), "/run/runelay-bots", "/run/secrets"];
    return spyOn(fs, "existsSync").mockImplementation((path) =>
      machine.some((dir) => String(path).startsWith(dir)) ? false : realExists(path),
    );
  }

  test("a missing key is copied from the legacy file, created for an empty vault and kept missing over stored secrets", async () => {
    const exists = hideMachineKeys();
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await useKey(null);
      await mkdir(dirname(legacyKey), { recursive: true });
      await writeFile(legacyKey, testKey.toString("hex"));
      await loadVault();
      expect(await keyOnDisk()).toEqual({ text: testKey.toString("hex"), mode: 0o600 });
      expect(log).toHaveBeenCalledWith(`vault key copied from ${legacyKey}`);
      await rm(legacyKey, { force: true });
      await useKey(null);
      await loadVault();
      expect(await keyOnDisk()).toEqual({ text: expect.stringMatching(/^[0-9a-f]{64}\n$/), mode: 0o600 });
      expect(log).toHaveBeenCalledWith("vault key created");
      expect(serverStorageAvailable()).toBe(true);
      await saveSecretMeta("kept", {});
      await useKey(null);
      await loadVault();
      expect(realExists(keyFile)).toBe(false);
      expect(warn).toHaveBeenCalledWith("vault key missing and secrets exist: not generating a new one");
      expect(getSecretMeta("kept")).not.toBeNull();
    } finally {
      exists.mockRestore();
      log.mockRestore();
      warn.mockRestore();
      await rm(legacyKey, { force: true });
    }
  });

  test("a key file readable by group or others stops the vault from loading", async () => {
    await useKey(testKey.toString("hex"), 0o644);
    await expect(loadVault()).rejects.toThrow("chmod 600");
    await useKey(testKey.toString("hex"));
    await loadVault();
  });

  test("a key setup failure is only a warning and the vault still loads", async () => {
    await saveSecretMeta("a", {});
    await useKey(null);
    const exists = hideMachineKeys();
    const mkdirFails = spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("sem permissão");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await loadVault();
      expect(warn).toHaveBeenCalledWith("vault key setup failed: sem permissão");
      expect(getSecretMeta("a")).not.toBeNull();
      mkdirFails.mockImplementation(() => {
        throw "disco cheio";
      });
      await loadVault();
      expect(warn).toHaveBeenCalledWith("vault key setup failed: disco cheio");
    } finally {
      exists.mockRestore();
      mkdirFails.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("audit", () => {
  test("readAudit returns newest first, filters by name and honors the limit", async () => {
    expect(await readAudit(null, 10)).toEqual([]);
    await audit({ name: "a", outcome: "used", botId: "bot-a" });
    await audit({ name: "b", outcome: "used" });
    await audit({ name: "a", outcome: "denied" });
    expect((await readAudit("a", 10)).map((row) => row.outcome)).toEqual(["denied", "used"]);
    expect(await readAudit(null, 2)).toHaveLength(2);
    expect((await readAudit(null, 2))[0].name).toBe("a");
    expect((await readAudit("a", 10))[1]).toMatchObject({ botId: "bot-a" });
  });
});

describe("policy", () => {
  function meta(overrides: Partial<SecretMeta>): SecretMeta {
    return {
      name: "a",
      description: "",
      domains: [],
      bots: [],
      touchId: "hourly",
      expiresAt: null,
      storage: "mac",
      kind: "password",
      createdAt: "",
      updatedAt: "",
      rotatedAt: null,
      lastUsedAt: null,
      lastUsedBy: null,
      lastTool: null,
      ...overrides,
    };
  }

  test("policyError checks expiry, bot and domain", async () => {
    expect(policyError(meta({}), "bot-a", null)).toBeNull();
    expect(policyError(meta({ expiresAt: "2000-01-01T00:00:00.000Z" }), "bot-a", null)?.code).toBe("expired");
    expect(policyError(meta({ expiresAt: "2999-01-01T00:00:00.000Z" }), "bot-a", null)).toBeNull();
    expect(policyError(meta({ bots: ["bot-b"] }), "bot-a", null)?.code).toBe("denied_bot");
    const elsewhere = policyError(meta({ domains: ["github.com"] }), "bot-a", "evil.com");
    expect(elsewhere?.code).toBe("denied_domain");
    expect(elsewhere?.message).toContain("não em evil.com");
    expect(policyError(meta({ domains: ["github.com"] }), "bot-a", null)?.message).toContain(
      "não dá para saber o site",
    );
  });
});

describe("resolveSecret", () => {
  test("unknown secrets are denied and audited", async () => {
    expect(await vaultCode(resolveOk("missing"))).toBe("not_found");
    expect((await auditRows())[0]).toMatchObject({ name: "missing", outcome: "denied", reason: "not_found" });
  });

  test("policy denials are audited", async () => {
    await saveSecretMeta("a", { domains: ["gitlab.com"] });
    expect(await vaultCode(resolveOk("a"))).toBe("denied_domain");
    expect((await auditRows())[0]).toMatchObject({ outcome: "denied", reason: "denied_domain" });
  });

  test("mac-only secrets fail when the Mac is offline", async () => {
    await saveSecretMeta("a", {});
    const error = await resolveOk("a").catch((caught: VaultError) => caught);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe("mac_offline");
    expect((error as VaultError).message).toContain("O app r/bots não está aberto no Mac");
  });

  test("server copies are decrypted when the Mac is offline", async () => {
    await saveSecretMeta("a", {});
    await setServerCopy("a", "server-secret-value");
    expect(await resolveOk("a", { sessionId: undefined })).toBe("server-secret-value");
    expect(redactText("leak server-secret-value")).toBe("leak ••••");
    expect((await auditRows())[0]).toMatchObject({ outcome: "used", source: "server", sessionId: null });
    expect(getSecretMeta("a")).toMatchObject({ lastUsedBy: "bot-a", lastTool: "computer_type" });
  });

  test("a lost key or a broken copy is reported", async () => {
    await saveSecretMeta("a", {});
    await setServerCopy("a", "server-secret-value");
    await useKey(null);
    expect(await vaultCode(resolveOk("a"))).toBe("no_key");
    await useKey(testKey.toString("hex"));
    const sealed = await repository.readSealed("a");
    await repository.writeSealed("a", { iv: sealed?.iv as Buffer, tag: Buffer.alloc(16), ct: sealed?.ct as Buffer });
    expect(await vaultCode(resolveOk("a"))).toBe("server_copy_broken");
    await repository.writeSealed("a", null);
    expect(await vaultCode(resolveOk("a"))).toBe("server_copy_broken");
  });

  test("the Mac resolves the value when it supports the vault", async () => {
    await saveSecretMeta("a", {});
    const runner = connectFakeRunner(["vault"], () => ({ ok: true, result: { value: "mac-secret-value" } }));
    try {
      expect(await resolveOk("a")).toBe("mac-secret-value");
    } finally {
      runner.close();
    }
    expect(runner.requests.filter((request) => request.op === "secret.resolve")).toEqual([
      {
        op: "secret.resolve",
        body: { name: "a", botId: "bot-a", botName: "Bot A", tool: "computer_type", domain: "github.com" },
      },
    ]);
    expect((await auditRows())[0]).toMatchObject({ outcome: "used", source: "mac" });
  });

  test("a Mac denial is audited with its code", async () => {
    await saveSecretMeta("a", {});
    const runner = connectFakeRunner(["vault"], () => ({ ok: false, code: "touch_cancelled", error: "Cancelado" }));
    try {
      const error = await resolveOk("a").catch((caught: VaultError) => caught);
      expect((error as VaultError).code).toBe("touch_cancelled");
      expect((error as VaultError).message).toBe("Cancelado");
    } finally {
      runner.close();
    }
    expect((await auditRows())[0]).toMatchObject({ outcome: "denied", reason: "touch_cancelled", source: "mac" });
  });

  test("a Mac answer without code or value counts as denied", async () => {
    await saveSecretMeta("a", {});
    const runner = connectFakeRunner(["vault"], () => ({ ok: true, result: {} }));
    try {
      const error = await resolveOk("a").catch((caught: VaultError) => caught);
      expect((error as VaultError).code).toBe("denied");
      expect((error as VaultError).message).toContain("O Mac não liberou o segredo:a");
    } finally {
      runner.close();
    }
  });

  test("a secret missing on the Mac falls back to the server copy", async () => {
    await saveSecretMeta("a", {});
    await setServerCopy("a", "server-fallback-value");
    const runner = connectFakeRunner(["vault"], () => ({ ok: false, code: "not_found" }));
    try {
      expect(await resolveOk("a")).toBe("server-fallback-value");
    } finally {
      runner.close();
    }
  });

  test("a secret missing on the Mac without server copy is denied", async () => {
    await saveSecretMeta("a", {});
    const runner = connectFakeRunner(["vault"], () => ({ ok: false, code: "not_found" }));
    try {
      expect(await vaultCode(resolveOk("a"))).toBe("not_found");
    } finally {
      runner.close();
    }
  });

  test("a Mac that disconnects mid request is treated as offline", async () => {
    await saveSecretMeta("a", {});
    let runner: ReturnType<typeof connectFakeRunner> | null = null;
    runner = connectFakeRunner(["vault"], () => {
      runner?.close();
      return { ok: true };
    });
    const error = await resolveOk("a").catch((caught: VaultError) => caught);
    expect((error as VaultError).code).toBe("mac_offline");
    expect((error as VaultError).message).toContain("O app r/bots desconectou");
  });

  test("unexpected Mac errors propagate", async () => {
    await saveSecretMeta("a", {});
    const runner = connectFakeRunner(["vault"]);
    const resolve = spyOn(macRunner, "macSecretResolve").mockRejectedValue(new Error("socket exploded"));
    try {
      await expect(resolveOk("a")).rejects.toThrow("socket exploded");
    } finally {
      resolve.mockRestore();
      runner.close();
    }
  });

  test("a registered external source takes precedence", async () => {
    registerSecretSource({
      id: "test-source",
      handles: (meta) => meta.description === "vault-test-external-source",
      read: async (meta, wanted) => `external-${meta.name}-${wanted.botId}`,
    });
    await saveSecretMeta("ext", { description: "vault-test-external-source" });
    expect(await resolveOk("ext")).toBe("external-ext-bot-a");
    expect((await auditRows())[0]).toMatchObject({ outcome: "used", source: "test-source" });
  });

  test("substituteRefs replaces every reference with its value", async () => {
    await saveSecretMeta("user", {});
    await saveSecretMeta("pass", {});
    await setServerCopy("user", "alice-user");
    await setServerCopy("pass", "alice-pass");
    remembered.add("user");
    remembered.add("pass");
    const { sessionId: _sessionId, ...base } = request;
    expect(await substituteRefs("segredo:user:segredo:pass segredo:user", base)).toBe(
      "alice-user:alice-pass alice-user",
    );
  });
});

describe("hardening", () => {
  test("secrets without sites are refused for tools that leave the server", async () => {
    await saveSecretMeta("a", {});
    await setServerCopy("a", "server-secret-value");
    for (const tool of ["http_request", "Bash", "browser_fill"])
      expect(await vaultCode(resolveOk("a", { tool }))).toBe("no_domains");
    expect((await auditRows())[0]).toMatchObject({ outcome: "denied", reason: "no_domains" });
    expect(await resolveOk("a")).toBe("server-secret-value");
  });

  test("values shorter than the mask minimum are never used", async () => {
    registerSecretSource({
      id: "short-source",
      handles: (meta) => meta.description === "vault-test-short",
      read: async () => "abc",
    });
    await saveSecretMeta("tiny", { description: "vault-test-short" });
    expect(await vaultCode(resolveOk("tiny"))).toBe("too_short");
    expect((await auditRows())[0]).toMatchObject({ outcome: "denied", reason: "too_short" });
  });

  test("v1 copies are re-encrypted to v2 at boot once and keep opening", async () => {
    await saveSecretMeta("old", {});
    await saveSecretMeta("plain", {});
    await setServerCopy("old", "placeholder-value");
    await repository.writeSealed("old", sealV1("old", "legacy-secret-value"));
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await loadVault();
      expect(log).toHaveBeenCalledWith("vault: re-encrypted 1 server copies to v2");
    } finally {
      log.mockRestore();
    }
    const sealed = await repository.readSealed("old");
    expect(sealed?.iv[0]).toBe(2);
    expect(await migrateServerCopies()).toBe(0);
    expect(await resolveOk("old")).toBe("legacy-secret-value");
  });

  test("a v1 copy that does not open is left alone", async () => {
    await saveSecretMeta("old", {});
    await setServerCopy("old", "placeholder-value");
    const broken = sealV1("old", "legacy-secret-value");
    await repository.writeSealed("old", { ...broken, tag: Buffer.alloc(16) });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await migrateServerCopies()).toBe(0);
      expect(warn).toHaveBeenCalledWith("vault: server copy of old did not open with the current key, left as is");
    } finally {
      warn.mockRestore();
    }
    await useKey(null);
    expect(await migrateServerCopies()).toBe(0);
  });

  test("changing the policy columns in the database breaks the copy", async () => {
    await saveSecretMeta("a", { domains: ["api.github.com"] });
    await setServerCopy("a", "server-secret-value");
    await getDb()
      .update(vaultSecrets)
      .set({ domains: ["evil.example.com"] })
      .where(eq(vaultSecrets.name, "a"));
    await loadVault();
    expect(await vaultCode(resolveOk("a", { host: "evil.example.com" }))).toBe("server_copy_broken");
  });

  test("a policy change through the vault re-encrypts the copy", async () => {
    await saveSecretMeta("a", { domains: ["api.github.com"] });
    await setServerCopy("a", "server-secret-value");
    const before = await repository.readSealed("a");
    await saveSecretMeta("a", { description: "same policy" });
    expect((await repository.readSealed("a"))?.ct.equals(before?.ct as Buffer)).toBe(true);
    await saveSecretMeta("a", { domains: ["uploads.github.com"], bots: ["bot-a"] });
    expect(await resolveOk("a", { host: "uploads.github.com" })).toBe("server-secret-value");
    await repository.writeSealed("a", null);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await saveSecretMeta("a", { domains: ["github.com"] });
      expect(warn).not.toHaveBeenCalled();
      await setServerCopy("a", "server-secret-value");
      await repository.writeSealed("a", {
        ...((await repository.readSealed("a")) as repository.Sealed),
        tag: Buffer.alloc(16),
      });
      await saveSecretMeta("a", { domains: ["gist.github.com"] });
      expect(warn).toHaveBeenCalledWith("vault: server copy of a could not be re-encrypted for the new policy");
      await useKey(null);
      await saveSecretMeta("a", { domains: ["api.github.com"] });
    } finally {
      warn.mockRestore();
    }
  });

  test("audit entries are hash chained and tampering is detected", async () => {
    await audit({ name: "a", outcome: "used" });
    await audit({ name: "b", outcome: "denied", reason: "x" });
    await audit({ name: "a", outcome: "revealed" });
    const rows = await auditRows();
    expect(rows[0].prevHash).toBe(rows[1].hash);
    expect(rows[2].prevHash).toBe(repository.auditGenesis);
    expect(await repository.verifyAuditChain()).toEqual({ ok: true, brokenAt: null });
    const [middle] = await getDb().select().from(vaultAudit).where(eq(vaultAudit.name, "b"));
    await getDb().update(vaultAudit).set({ outcome: "used" }).where(eq(vaultAudit.id, middle.id));
    expect(await repository.verifyAuditChain()).toEqual({ ok: false, brokenAt: middle.id });
  });
});

describe("exec tickets", () => {
  test("a ticket is taken once and expires", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const ticket = issueExecTicket(grant({ env: { GH_TOKEN: "v" }, redact: ["v"] }));
      expect(takeExecTicket(ticket)).toMatchObject({ env: { GH_TOKEN: "v" }, redact: ["v"] });
      expect(takeExecTicket(ticket)).toBeNull();
      expect(warn).toHaveBeenCalledWith("vault: an exec ticket was presented twice");
      expect(takeExecTicket("unknown")).toBeNull();
      const late = issueExecTicket(grant());
      setSystemTime(new Date(Date.now() + 120_000));
      expect(takeExecTicket(late)).toBeNull();
      expect(takeExecTicket(issueExecTicket(grant()))).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("a ticket dies with its turn", async () => {
    const turn = new AbortController();
    const ticket = issueExecTicket(grant(), turn.signal);
    turn.abort();
    expect(takeExecTicket(ticket)).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    expect(takeExecTicket(issueExecTicket(grant(), aborted.signal))).toBeNull();
  });

  test("an unused ticket is dropped by its timer", async () => {
    const real = globalThis.setTimeout;
    const held: Array<() => void> = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
      if (ms === 31_000) {
        held.push(callback);
        return real(() => undefined, 0);
      }
      return real(callback, ms);
    }) as unknown as typeof setTimeout);
    let ticket = "";
    try {
      ticket = issueExecTicket(grant());
    } finally {
      timer.mockRestore();
    }
    for (const callback of held) callback();
    expect(takeExecTicket(ticket)).toBeNull();
  });
});
