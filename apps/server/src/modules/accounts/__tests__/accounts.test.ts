import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { fakeProviders, request, startTestServer, type TestServer, testDataDir } from "../../../../test/helpers";
import { writeSetting } from "../../../db/settings";
import { onSettingsChange } from "../../settings/services/settings-events.service";
import {
  type Account,
  accountDir,
  accountPath,
  addAccountDir,
  defaultAccount,
  findAccount,
  isAccountId,
  isLegacyMacAccount,
  listAccounts,
  loginGuide,
  mcpBaseFor,
  preferredAccountId,
  refreshAccounts,
  removeAccountDir,
  runOnAccount,
  siblingAccounts,
  updateAccount,
} from "../services/accounts.service";
import {
  clearLimit,
  emitFault,
  formatReset,
  injectedFault,
  isLimitError,
  isLimitReply,
  isOutageError,
  limitOf,
  markLimited,
  markUnavailable,
  parseResetAt,
  providerName,
} from "../services/limits.service";

let server: TestServer;
let home = "";
let previousHome: string | undefined;
let counter = 0;

function jwt(claims: Record<string, unknown>) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function put(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function seedHome() {
  put(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "t", subscriptionType: "team" } });
  put(join(home, ".claude.json"), {
    oauthAccount: { displayName: "Trabalho", emailAddress: "ferramentas@x.com", organizationName: "Acme" },
  });
  put(join(home, ".claude-2", ".credentials.json"), { claudeAiOauth: { accessToken: "t", subscriptionType: "max" } });
  put(join(home, ".claude-2", ".claude.json"), {
    oauthAccount: { displayName: "Alex", emailAddress: "alex@x.com" },
  });
  mkdirSync(join(home, ".claude-old"), { recursive: true });
  put(join(home, ".codex", "auth.json"), {
    tokens: { id_token: jwt({ email: "dev@x.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }) },
  });
}

function turnRequest(provider: TurnRequest["provider"] = "claude"): TurnRequest {
  return {
    turnId: `turn-${Math.random().toString(36).slice(2)}`,
    provider,
    workKey: "bot/session",
  } as unknown as TurnRequest;
}

beforeAll(async () => {
  server = await startTestServer();
});

beforeEach(async () => {
  previousHome = process.env.HOST_HOME;
  home = join(testDataDir(), `home-${process.pid}-${counter++}`);
  mkdirSync(home, { recursive: true });
  process.env.HOST_HOME = home;
  await writeSetting("accounts.settings", {});
});

afterEach(async () => {
  jest.useRealTimers();
  setSystemTime();
  delete process.env.BOTS_FAULTS_FILE;
  process.env.HOST_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  await writeSetting("accounts.settings", {});
  await refreshAccounts();
});

afterAll(async () => {
  await server.close();
});

describe("limits", () => {
  test("recognizes limit replies and errors", () => {
    expect(isLimitReply("You've hit your limit · resets 3pm")).toBe(true);
    expect(isLimitReply("tudo certo")).toBe(false);
    expect(isLimitReply(`usage limit reached ${"x".repeat(400)}`)).toBe(false);
    expect(isLimitError("429 Too Many Requests")).toBe(true);
    expect(isLimitError("boom")).toBe(false);
    expect(isLimitError(null)).toBe(false);
    expect(isLimitError(undefined)).toBe(false);
  });

  test("parses every reset format", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(parseResetAt("limit|1763560800", now)?.toISOString()).toBe("2025-11-19T14:00:00.000Z");
    expect(parseResetAt("resets 2026-11-20T08:30:00Z", now)?.toISOString()).toBe("2026-11-20T08:30:00.000Z");
    expect(parseResetAt("try again in 1 day, 2 hours and 5 minutes", now)?.toISOString()).toBe(
      "2026-11-20T14:05:00.000Z",
    );
    expect(parseResetAt("resets in 0 minutes", now)).toBeNull();
    expect(parseResetAt("resets at 3pm", now, "UTC")?.toISOString()).toBe("2026-11-19T15:00:00.000Z");
    expect(parseResetAt("resets at 12am", now, "UTC")?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(parseResetAt("resets 9:30 (America/Sao_Paulo)", now, "UTC")?.toISOString()).toBe("2026-11-19T12:30:00.000Z");
    expect(parseResetAt("resets 13:00 (Not/AZone)", now, "UTC")?.toISOString()).toBe("2026-11-19T13:00:00.000Z");
    expect(parseResetAt("resets at 25:00", now, "UTC")).toBeNull();
    expect(parseResetAt("resets at 10:75", now, "UTC")).toBeNull();
    expect(parseResetAt("nada aqui", now)).toBeNull();
    expect(parseResetAt("resets at 3pm", now)).toBeInstanceOf(Date);
  });

  test("marks, reads, expires and clears a limit", () => {
    const known = markLimited("vps:claude", "resets in 2 hours");
    expect(known.known).toBe(true);
    expect(limitOf("vps:claude")).toBe(known);
    clearLimit("vps:claude");
    expect(limitOf("vps:claude")).toBeNull();
    const unknown = markLimited("vps:codex", "quota", "UTC");
    expect(unknown.known).toBe(false);
    expect(unknown.until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect(limitOf("vps:codex")).toBeNull();
  });

  test("formats the reset time relative to now", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(formatReset(new Date("2026-11-19T18:00:00Z"), now)).toBe("às 15:00");
    expect(formatReset(new Date("2026-11-20T18:00:00Z"), now)).toBe("amanhã às 15:00");
    expect(formatReset(new Date("2026-11-25T18:00:00Z"), now)).toBe("dia 25/11 às 15:00");
    expect(formatReset(new Date())).toStartWith("às ");
  });

  test("tells an outage from a limit and keeps it for a few minutes", () => {
    expect(isOutageError("API Error: 401 authentication_error")).toBe(true);
    expect(isOutageError("overloaded_error")).toBe(true);
    expect(isOutageError("429 Too Many Requests")).toBe(false);
    expect(isOutageError("boom")).toBe(false);
    expect(isOutageError(null)).toBe(false);
    const state = markUnavailable("vps:claude", "caiu");
    expect(state).toMatchObject({ known: false, kind: "down", message: "caiu" });
    expect(limitOf("vps:claude")?.kind).toBe("down");
    clearLimit("vps:claude");
  });

  test("names providers and injects faults from a file", () => {
    expect(providerName("codex")).toBe("Codex");
    expect(providerName("claude")).toBe("Claude");
    expect(injectedFault("vps:claude")).toBeNull();
    const file = join(testDataDir(), "faults.json");
    writeFileSync(file, JSON.stringify({ "vps:claude": "fora do ar" }));
    process.env.BOTS_FAULTS_FILE = file;
    expect(injectedFault("vps:claude")).toBe("fora do ar");
    expect(injectedFault("vps:codex")).toBeNull();
    process.env.BOTS_FAULTS_FILE = join(testDataDir(), "missing.json");
    expect(injectedFault("vps:claude")).toBeNull();
    rmSync(file);
    const events: ProviderEvent[] = [];
    emitFault("falhou", (event) => events.push(event));
    expect(events).toEqual([
      { type: "text", part: "fault", text: "falhou" },
      { type: "done", ok: false, message: "falhou" },
    ]);
  });
});

describe("accounts", () => {
  test("finds every Claude and Codex directory in the home and names each account", async () => {
    seedHome();
    fakeProviders.probes.grok = { provider: "grok", status: "missing", detail: "sem", models: [] };
    const first = refreshAccounts();
    expect(refreshAccounts()).toBe(first);
    const accounts = await first;
    expect(accounts.map((account) => account.id)).toEqual([
      "vps:claude",
      "claude-2:claude",
      "vps:codex",
      "vps:grok",
      "vps:cursor",
    ]);
    expect(accounts[0]).toMatchObject({
      runner: "vps",
      label: "Claude",
      name: "Claude",
      email: "ferramentas@x.com",
      plan: "team",
      configDir: "~/.claude",
      isDefault: true,
      added: false,
      status: "ready",
    });
    expect(accounts[1]).toMatchObject({
      label: "Claude 2",
      email: "alex@x.com",
      plan: "max",
      configDir: "~/.claude-2",
      isDefault: false,
    });
    expect(accounts[2]).toMatchObject({ label: "Codex", email: "dev@x.com", plan: "plus", isDefault: true });
    expect(accounts[3]).toMatchObject({ label: "Grok", status: "missing", configDir: null });
    expect(fakeProviders.probed).toContainEqual({ provider: "claude", configDir: null });
    expect(fakeProviders.probed).toContainEqual({ provider: "claude", configDir: join(home, ".claude-2") });
    expect(accountDir("vps:claude")).toBeNull();
    expect(accountDir("claude-2:claude")).toBe(join(home, ".claude-2"));
    expect(accountPath("vps:claude")).toBe(join(home, ".claude"));
    expect(accountPath("nada:claude")).toBeNull();
    expect(preferredAccountId("claude")).toBe("vps:claude");
  });

  test("keeps a default Claude and Codex slot when nothing is logged in", async () => {
    const accounts = await refreshAccounts();
    expect(accounts.map((account) => [account.id, account.label])).toEqual([
      ["vps:claude", "Claude"],
      ["vps:codex", "Codex"],
      ["vps:grok", "Grok"],
      ["vps:cursor", "Cursor"],
    ]);
    expect(accounts[0].email).toBeNull();
    process.env.HOST_HOME = join(home, "nao-existe");
    expect((await refreshAccounts()).map((account) => account.id)).toEqual(accounts.map((account) => account.id));
  });

  test("names accounts by provider and position, never by organization or e-mail", async () => {
    put(join(home, ".claude", ".credentials.json"), {});
    put(join(home, ".claude.json"), { oauthAccount: { organizationName: "Acme" } });
    put(join(home, ".claude-b", ".credentials.json"), {});
    put(join(home, ".claude-b", ".claude.json"), { oauthAccount: { organizationName: "Acme" } });
    put(join(home, ".claude-c", ".credentials.json"), {});
    put(join(home, ".claude-c", ".claude.json"), { oauthAccount: { emailAddress: "maria@x.com" } });
    put(join(home, ".claude-d", ".credentials.json"), "{broken");
    put(join(home, ".claude-d", ".claude.json"), "[]");
    put(join(home, ".codex", "auth.json"), { tokens: { id_token: "sem-claims" } });
    put(join(home, ".codex-work", "auth.json"), { tokens: { id_token: jwt({ email: "ana@x.com" }) } });
    put(join(home, ".codex-x", "auth.json"), { tokens: { id_token: "a.bm90LWpzb24.c" } });
    const accounts = await refreshAccounts();
    const label = (id: string) => accounts.find((account) => account.id === id)?.label;
    expect(label("vps:claude")).toBe("Claude");
    expect(label("claude-b:claude")).toBe("Claude 2");
    expect(label("claude-c:claude")).toBe("Claude 3");
    expect(label("claude-d:claude")).toBe("Claude 4");
    expect(label("vps:codex")).toBe("Codex");
    expect(label("codex-work:codex")).toBe("Codex 2");
    expect(label("codex-x:codex")).toBe("Codex 3");
    expect(accounts.some((account) => /Acme|maria|ana/.test(account.label))).toBe(false);
  });

  test("adds a directory outside the home, renames, picks the default and removes it", async () => {
    seedHome();
    const extra = join(home, "contas", "Claude Team");
    put(join(extra, ".credentials.json"), { claudeAiOauth: { subscriptionType: "team" } });
    let accounts = await addAccountDir({ path: extra });
    expect(accounts.find((account) => account.id === "claude-team:claude")).toMatchObject({
      added: true,
      configDir: "~/contas/Claude Team",
      label: "Claude 3",
    });
    expect((await addAccountDir({ path: "~/contas/Claude Team" })).length).toBe(accounts.length);
    accounts = (await updateAccount("claude-team:claude", { name: "  Time  ", isDefault: true })) as Account[];
    expect(accounts.find((account) => account.id === "claude-team:claude")).toMatchObject({
      name: "Time",
      label: "Time",
      autoName: "Claude 3",
      isDefault: true,
    });
    expect(accounts.find((account) => account.id === "vps:claude")?.isDefault).toBe(false);
    expect(defaultAccount(accounts, "claude")?.id).toBe("claude-team:claude");
    expect(defaultAccount([], "claude")).toBeNull();
    expect(siblingAccounts(accounts, { id: "vps:claude", provider: "claude" }).map((item) => item.id)).toEqual([
      "claude-team:claude",
      "claude-2:claude",
    ]);
    accounts = (await updateAccount("claude-team:claude", { name: null })) as Account[];
    expect(accounts.find((account) => account.id === "claude-team:claude")?.label).toBe("Claude 3");
    accounts = (await updateAccount("claude-team:claude", { name: "" })) as Account[];
    expect(accounts.find((account) => account.id === "claude-team:claude")?.label).toBe("Claude 3");
    accounts = (await removeAccountDir("claude-team:claude")) as Account[];
    expect(accounts.some((account) => account.id === "claude-team:claude")).toBe(false);
    expect(defaultAccount(accounts, "claude")?.id).toBe("vps:claude");
    expect(await removeAccountDir("nada:claude")).toBeNull();
    expect(await updateAccount("nada:claude", {})).toBeNull();
  });

  test("dedupes a directory found twice and gives colliding folders distinct ids", async () => {
    seedHome();
    const twin = join(home, "outro", ".claude-2");
    put(join(twin, ".credentials.json"), {});
    await writeSetting("accounts.settings", {
      dirs: ["~/.claude-2", twin, "~/sem-login", "relativo", 7],
      names: "x",
      defaults: "y",
    });
    mkdirSync(join(home, "sem-login"), { recursive: true });
    const ids = (await refreshAccounts()).map((account) => account.id);
    expect(ids.filter((id) => id.startsWith("claude-2"))).toHaveLength(2);
    expect(ids.find((id) => id.startsWith("claude-2-"))).toMatch(/^claude-2-[0-9a-f]{6}:claude$/);
  });

  test("detects the provider of an added folder by its files or name", async () => {
    const codex = join(home, "x", "conta-codex");
    mkdirSync(codex, { recursive: true });
    const named = join(home, "x", "minha-claude");
    mkdirSync(named, { recursive: true });
    const toml = join(home, "x", "cfg");
    put(join(toml, "config.toml"), "");
    const mac = join(home, "x", "macbook");
    put(join(mac, ".claude.json"), {});
    for (const path of [codex, named, toml, mac]) await addAccountDir({ path });
    const ids = (await listAccounts()).map((account) => account.id);
    expect(ids).toEqual(
      expect.arrayContaining(["conta-codex:codex", "minha-claude:claude", "cfg:codex", "d-macbook:claude"]),
    );
  });

  test("validates edits and new directories", async () => {
    seedHome();
    await refreshAccounts();
    const fails = async (work: Promise<unknown>, field: string) => {
      await expect(work).rejects.toMatchObject({ field });
    };
    await fails(updateAccount("vps:claude", null), "body");
    await fails(updateAccount("vps:claude", []), "body");
    await fails(updateAccount("vps:claude", { cor: "azul" }), "cor");
    await fails(updateAccount("vps:claude", { name: 3 }), "name");
    await fails(updateAccount("vps:claude", { name: "x".repeat(61) }), "name");
    await fails(updateAccount("vps:claude", { isDefault: false }), "isDefault");
    await fails(updateAccount("vps:grok", { isDefault: true }), "isDefault");
    await fails(addAccountDir(null), "path");
    await fails(addAccountDir({ path: "  " }), "path");
    await fails(addAccountDir({ path: "relativo/.claude" }), "path");
    await fails(addAccountDir({ path: join(home, "vazio") }), "path");
    await fails(removeAccountDir("claude-2:claude"), "id");
    expect(await addAccountDir({ path: "~" })).toBeDefined();
  });

  test("guides a login into the next free directory", async () => {
    seedHome();
    mkdirSync(join(home, ".claude-3"), { recursive: true });
    expect(await loginGuide("claude")).toMatchObject({
      provider: "claude",
      dir: "~/.claude-4",
      command: "CLAUDE_CONFIG_DIR=~/.claude-4 claude auth login",
    });
    const codex = await loginGuide("codex");
    expect(codex.command).toBe("mkdir -p ~/.codex-2 && CODEX_HOME=~/.codex-2 codex login");
    expect(codex.steps).toHaveLength(3);
    await expect(loginGuide("grok")).rejects.toMatchObject({ field: "provider" });
    process.env.HOST_HOME = join(home, "nao-existe");
    expect((await loginGuide("claude")).dir).toBe("~/.claude-2");
  });

  test("serves the cache, refreshes it when stale and finds accounts", async () => {
    await refreshAccounts();
    const cached = await listAccounts();
    expect(await listAccounts()).toBe(cached);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect(await listAccounts()).not.toBe(cached);
    expect((await findAccount("vps:claude"))?.status).toBe("ready");
    expect(await findAccount("vps:none")).toBeUndefined();
    fakeProviders.probes.codex = { provider: "codex", status: "logged_out", detail: "saiu", models: [] };
    await refreshAccounts();
    fakeProviders.probes.codex = undefined;
    setSystemTime(new Date(Date.now() + 60_000));
    expect((await findAccount("vps:codex"))?.status).toBe("ready");
  });

  test("validates ids and the MCP base", () => {
    expect(isAccountId("vps:claude")).toBe(true);
    expect(isAccountId("claude-2:claude")).toBe(true);
    expect(isAccountId("mac:grok")).toBe(false);
    expect(isAccountId("mac-ab12cd34:grok")).toBe(false);
    expect(isAccountId("Claude:claude")).toBe(false);
    expect(isAccountId("vps")).toBe(false);
    expect(isAccountId("vps:gemini")).toBe(false);
    expect(isLegacyMacAccount("mac-ab12:claude")).toBe(true);
    expect(isLegacyMacAccount("vps:claude")).toBe(false);
    expect(mcpBaseFor()).toStartWith("http://127.0.0.1:");
  });
});

describe("runOnAccount", () => {
  test("emits an injected fault instead of running", async () => {
    const file = join(testDataDir(), "faults-run.json");
    writeFileSync(file, JSON.stringify({ "vps:claude": "falha injetada" }));
    process.env.BOTS_FAULTS_FILE = file;
    const events: ProviderEvent[] = [];
    await runOnAccount({ id: "vps:claude", provider: "claude" }, turnRequest(), new AbortController().signal, (event) =>
      events.push(event),
    );
    expect(events.at(-1)).toEqual({ type: "done", ok: false, message: "falha injetada" });
    expect(fakeProviders.turns).toHaveLength(0);
  });

  test("runs each account in its own directory", async () => {
    seedHome();
    await refreshAccounts();
    const events: ProviderEvent[] = [];
    await runOnAccount(
      { id: "claude-2:claude", provider: "claude" },
      turnRequest(),
      new AbortController().signal,
      (event) => events.push(event),
    );
    await runOnAccount({ id: "vps:claude", provider: "claude" }, turnRequest(), new AbortController().signal, () => {});
    expect(fakeProviders.turns.map((turn) => turn.request.configDir)).toEqual([join(home, ".claude-2"), null]);
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
  });
});

describe("routes", () => {
  test("GET /accounts lists and refreshes, POST /accounts/refresh refreshes", async () => {
    const listed = await request<Array<{ id: string }>>("/accounts");
    expect(listed.status).toBe(200);
    expect(listed.body.some((account) => account.id === "vps:claude")).toBe(true);
    fakeProviders.probes.claude = { provider: "claude", status: "logged_out", detail: "saiu", models: [] };
    const refreshed = await request<Array<{ id: string; status: string }>>("/accounts?refresh=1");
    expect(refreshed.body.find((account) => account.id === "vps:claude")?.status).toBe("logged_out");
    fakeProviders.probes.claude = { provider: "claude", status: "ready", detail: "voltou", models: [] };
    const posted = await request<Array<{ id: string; detail: string }>>("/accounts/refresh", {
      method: "POST",
      body: "{not json",
    });
    expect(posted.status).toBe(200);
    expect(posted.body.find((account) => account.id === "vps:claude")?.detail).toBe("voltou");
  });

  test("renames, adds, removes and guides through the account routes", async () => {
    seedHome();
    await refreshAccounts();
    const renamed = await request<Account[]>("/accounts/claude-2:claude", {
      method: "PATCH",
      body: { name: "Pessoal" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.find((account) => account.id === "claude-2:claude")?.label).toBe("Pessoal");
    expect((await request("/accounts/nada:claude", { method: "PATCH", body: {} })).status).toBe(404);
    const bad = await request<{ field: string }>("/accounts/vps:claude", { method: "PATCH", body: { cor: 1 } });
    expect(bad).toMatchObject({ status: 400, body: { field: "cor" } });
    expect((await request("/accounts/vps:claude", { method: "PATCH", body: "{oops" })).status).toBe(400);
    put(join(home, "extra", ".credentials.json"), {});
    const added = await request<Account[]>("/accounts/dirs", { method: "POST", body: { path: "~/extra" } });
    expect(added.body.some((account) => account.id === "extra:claude")).toBe(true);
    const removed = await request<Account[]>("/accounts/extra:claude", { method: "DELETE" });
    expect(removed.body.some((account) => account.id === "extra:claude")).toBe(false);
    expect((await request("/accounts/nada:claude", { method: "DELETE" })).status).toBe(404);
    const guide = await request<{ command: string }>("/accounts/login-guide?provider=codex");
    expect(guide.body.command).toContain("CODEX_HOME=");
    expect((await request<{ dir: string }>("/accounts/login-guide")).body.dir).toBe("~/.claude-3");
    expect((await request("/accounts/x/y")).status).toBe(404);
  });

  test("tells connected apps when an account changes through the routes", async () => {
    seedHome();
    await refreshAccounts();
    const seen: string[][] = [];
    const stop = onSettingsChange((areas) => seen.push(areas));
    await request("/accounts/claude-2:claude", { method: "PATCH", body: { name: "Pessoal" } });
    await request("/accounts/nada:claude", { method: "PATCH", body: {} });
    await request("/accounts/refresh", { method: "POST" });
    stop();
    expect(seen).toEqual([
      ["accounts", "usage"],
      ["accounts", "usage"],
    ]);
  });
});
