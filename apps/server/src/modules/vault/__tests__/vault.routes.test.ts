import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { resetData } from "../../../../test/helpers";
import { getDb } from "../../../db";
import { vaultAudit, vaultSecrets } from "../../../db/tables";
import { Req, Res } from "../../../shared/http";
import type { AuthModule } from "../../auth";
import { gate, useAuthModule } from "../../auth/gate";
import * as repository from "../repositories/vault.repository";
import { handleVaultRoute } from "../routes/vault.routes";
import { getSecretMeta, issueExecTicket, loadVault, readAudit, saveSecretMeta } from "../services/vault.service";

const keyFile = process.env.VAULT_KEY_FILE as string;

let device: { id: string; name: string; registeredAt: string } | null = {
  id: "mac-1",
  name: "Mac",
  registeredAt: "2026-11-01T00:00:00.000Z",
};

const fakeAuth = {
  authenticate: async () => ({
    kind: "principal",
    principal: {
      userId: "u1",
      email: "person@example.com",
      name: "Person",
      role: "owner",
      method: "session",
      ...(device ? { device } : {}),
    },
  }),
  handle: async () => null,
} as unknown as AuthModule;

interface CallOptions {
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
  authorized?: boolean;
}

async function call(method: string, path: string, options: CallOptions = {}) {
  const body = typeof options.body === "string" ? options.body : options.body ? JSON.stringify(options.body) : null;
  const request = new Request(`http://gateway.local${path}`, {
    method,
    headers: options.headers,
    ...(body === null ? {} : { body }),
  });
  if (options.authorized !== false) await gate(request);
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const res = new Res(request.signal);
  await handleVaultRoute(new Req(request), res, url, method, parts);
  const response = await res.response;
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: JSON.parse(text) };
}

beforeAll(async () => {
  useAuthModule(fakeAuth);
  await writeFile(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
});

afterAll(async () => {
  useAuthModule(null);
  await rm(keyFile, { force: true });
});

beforeEach(async () => {
  await resetData();
  await getDb().delete(vaultAudit);
  await getDb().delete(vaultSecrets);
  await loadVault();
});

describe("exec tickets", () => {
  test("a local caller gets the env once", async () => {
    const grant = {
      argv: ["gh", "api", "user"],
      env: { GH_TOKEN: "value-1234" },
      stdin: null,
      tempHome: true,
      redact: ["value-1234"],
      path: "/usr/bin",
    };
    const ticket = issueExecTicket(grant);
    const first = await call("POST", `/vault/exec/${ticket}`, { authorized: false });
    expect(first.status).toBe(200);
    expect(first.body).toEqual(grant);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const again = await call("POST", `/vault/exec/${ticket}`, { authorized: false });
    expect(again.status).toBe(410);
  });

  test("proxied callers never see the ticket route", async () => {
    const ticket = issueExecTicket({ argv: [], env: {}, stdin: null, tempHome: false, redact: [], path: "" });
    const forwarded = await call("POST", `/vault/exec/${ticket}`, { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(forwarded.status).toBe(404);
    const tailscale = await call("POST", `/vault/exec/${ticket}`, { headers: { "tailscale-user-login": "a@b" } });
    expect(tailscale.status).toBe(404);
  });
});

test("everything else needs the Mac app", async () => {
  const response = await call("GET", "/vault/secrets", { authorized: false });
  expect(response.status).toBe(401);
});

describe("secrets", () => {
  test("lists secrets with their reference and env name", async () => {
    await saveSecretMeta("github-token", { description: "GH" });
    const response = await call("GET", "/vault/secrets");
    expect(response.status).toBe(200);
    expect(response.body.serverStorage).toBe(true);
    expect(response.body.secrets).toEqual([
      expect.objectContaining({ name: "github-token", ref: "segredo:github-token", env: "SEGREDO_GITHUB_TOKEN" }),
    ]);
  });

  test("PUT creates and validates", async () => {
    const created = await call("PUT", "/vault/secrets/api-key", { body: { description: "Key", domains: ["x.com"] } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "api-key", domains: ["x.com"], ref: "segredo:api-key" });
    const empty = await call("PUT", "/vault/secrets/empty-body", { body: "" });
    expect(empty.status).toBe(200);
    const invalid = await call("PUT", "/vault/secrets/api-key", { body: { touchId: "sometimes" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ ok: false, code: "bad_touch" });
  });

  test("bad and oversized bodies are rejected", async () => {
    const bad = await call("PUT", "/vault/secrets/a", { body: "{nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("bad_json");
    const big = await call("PUT", "/vault/secrets/a", { body: "x".repeat(70 * 1024) });
    expect(big.status).toBe(400);
    expect(big.body.code).toBe("too_big");
  });

  test("DELETE removes known secrets and 404s unknown ones", async () => {
    await saveSecretMeta("a", {});
    const removed = await call("DELETE", "/vault/secrets/a");
    expect(removed).toMatchObject({ status: 200, body: { ok: true, name: "a" } });
    const missing = await call("DELETE", "/vault/secrets/a");
    expect(missing.status).toBe(404);
  });

  test("server copy can be turned on and off", async () => {
    await saveSecretMeta("a", {});
    const on = await call("PUT", "/vault/secrets/a/server-copy", { body: { value: "copy-value-1" } });
    expect(on.status).toBe(200);
    expect(on.body.storage).toBe("mac+server");
    const off = await call("DELETE", "/vault/secrets/a/server-copy");
    expect(off.body.storage).toBe("mac");
    const empty = await call("PUT", "/vault/secrets/a/server-copy", { body: { value: "" } });
    expect(empty.body.code).toBe("bad_value");
    const big = await call("PUT", "/vault/secrets/a/server-copy", { body: { value: "x".repeat(16_385) } });
    expect(big.body.code).toBe("bad_value");
    const notText = await call("PUT", "/vault/secrets/a/server-copy", { body: { value: 12 } });
    expect(notText.body.code).toBe("bad_value");
    const unknown = await call("PUT", "/vault/secrets/zzz/server-copy", { body: { value: "copy-value-1" } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("not_found");
  });

  test("unknown paths are 404", async () => {
    const response = await call("PATCH", "/vault/secrets/a");
    expect(response.status).toBe(404);
  });
});

describe("audit", () => {
  test("GET returns rows filtered and clamps the limit", async () => {
    await saveSecretMeta("a", {});
    await saveSecretMeta("b", {});
    const all = await call("GET", "/vault/audit?limit=nope");
    expect(all.body).toHaveLength(2);
    const one = await call("GET", "/vault/audit?name=a&limit=0");
    expect(one.body).toEqual([expect.objectContaining({ name: "a", outcome: "created" })]);
    const capped = await call("GET", "/vault/audit?limit=9999");
    expect(capped.body).toHaveLength(2);
  });

  test("POST records a bot use and marks the secret as used", async () => {
    await saveSecretMeta("a", {});
    const response = await call("POST", "/vault/audit", {
      body: {
        name: "a",
        outcome: "used",
        botId: "bot-a",
        botName: "Bot A",
        tool: "computer_type",
        domain: "github.com",
        reason: "typed",
      },
    });
    expect(response.body).toEqual({ ok: true });
    expect((await readAudit("a", 1))[0]).toMatchObject({
      outcome: "used",
      by: "bot",
      botId: "bot-a",
      botName: "Bot A",
      tool: "computer_type",
      domain: "github.com",
      reason: "typed",
      source: "mac",
    });
    expect(getSecretMeta("a")).toMatchObject({ lastUsedBy: "bot-a", lastTool: "computer_type" });
  });

  test("POST by the person does not mark use", async () => {
    await saveSecretMeta("a", {});
    await call("POST", "/vault/audit", { body: { name: "a", outcome: "revealed" } });
    expect((await readAudit("a", 1))[0]).toMatchObject({ outcome: "revealed", by: "person" });
    await call("POST", "/vault/audit", { body: { name: "a", outcome: "used", tool: "x" } });
    expect(getSecretMeta("a")?.lastUsedAt).toBeNull();
  });

  test("POST is only for a registered Mac device", async () => {
    await saveSecretMeta("a", {});
    const saved = device;
    device = null;
    try {
      const response = await call("POST", "/vault/audit", { body: { name: "a", outcome: "revealed" } });
      expect(response.status).toBe(403);
      expect(await readAudit("a", 5)).toHaveLength(1);
    } finally {
      device = saved;
    }
  });

  test("POST validates name and outcome", async () => {
    const name = await call("POST", "/vault/audit", { body: { outcome: "used" } });
    expect(name.body.code).toBe("bad_name");
    const outcome = await call("POST", "/vault/audit", { body: { name: "a", outcome: "stolen" } });
    expect(outcome.body.code).toBe("bad_outcome");
  });
});

test("non vault errors bubble up", async () => {
  const rows = spyOn(repository, "readAuditRows").mockImplementation(() => {
    throw new Error("db exploded");
  });
  try {
    await expect(call("GET", "/vault/audit")).rejects.toThrow("db exploded");
  } finally {
    rows.mockRestore();
  }
});
