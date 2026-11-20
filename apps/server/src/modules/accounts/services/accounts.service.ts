import { readdir } from "node:fs/promises";
import {
  type AccountProbe,
  type ModelOption,
  type NativeToolHooks,
  type Provider,
  type ProviderEvent,
  providers,
  type TurnRequest,
} from "@runelay-bots/protocol";
import { probe, runTurn } from "@runelay-bots/providers";
import { dataDir, env } from "../../../config/env";
import { ValidationError } from "../../../shared/errors";
import {
  type AccountDir,
  type AccountSettings,
  autoName,
  detectProvider,
  type DirProvider,
  discoverAccountDirs,
  displayPath,
  dirProviders,
  expandPath,
  homeDir,
  readAccountSettings,
  readIdentity,
  writeAccountSettings,
} from "./account-dirs.service";
import { emitFault, injectedFault } from "./limits.service";

export type RunnerId = "vps";
export type AccountStatus = "ready" | "logged_out" | "offline" | "missing";

export interface Account {
  id: string;
  runner: RunnerId;
  provider: Provider;
  label: string;
  name: string;
  autoName: string;
  email: string | null;
  plan: string | null;
  configDir: string | null;
  isDefault: boolean;
  added: boolean;
  status: AccountStatus;
  models: ModelOption[];
  detail: string;
  checkedAt: string;
}

export interface LoginGuide {
  provider: DirProvider;
  dir: string;
  command: string;
  steps: string[];
}

const accountIdPattern = /^([a-z0-9][a-z0-9-]{0,47}):(claude|codex|grok|cursor)$/;
const legacyMacPattern = /^mac(?:-[a-z0-9]{1,16})?$/;
const toolLabels: Record<Provider, string> = { claude: "Claude", codex: "Codex", grok: "Grok", cursor: "Cursor" };
const maxAgeMs = 10 * 60_000;
const maxName = 60;

let cache: Account[] = [];
let dirs = new Map<string, AccountDir>();
let checkedAt = 0;
let pending: Promise<Account[]> | null = null;

function fromProbe(base: Omit<Account, "status" | "models" | "detail" | "checkedAt">, result: AccountProbe): Account {
  return {
    ...base,
    status: result.status,
    models: result.models,
    detail: result.detail,
    checkedAt: new Date().toISOString(),
  };
}

function withDefaults(accounts: Account[], settings: AccountSettings) {
  for (const provider of providers) {
    const own = accounts.filter((account) => account.provider === provider);
    const chosen = own.find((account) => account.id === settings.defaults[provider as DirProvider]) ?? own[0];
    for (const account of own) account.isDefault = account === chosen;
  }
  return accounts;
}

function uniqueNames(accounts: Account[]) {
  const counts = new Map<string, number>();
  for (const account of accounts) counts.set(account.autoName, (counts.get(account.autoName) ?? 0) + 1);
  for (const account of accounts)
    if ((counts.get(account.autoName) ?? 0) > 1 && account.configDir)
      account.autoName = `${account.autoName} (${account.configDir.replace(/^~\/\.?/, "")})`;
}

async function probeDirs(settings: AccountSettings) {
  const found = await discoverAccountDirs(settings);
  for (const provider of dirProviders)
    if (!found.some((item) => item.provider === provider))
      found.push({
        id: `vps:${provider}`,
        provider,
        dir: `${homeDir()}/.${provider}`,
        cliDefault: true,
        added: false,
      });
  found.sort((a, b) => dirProviders.indexOf(a.provider) - dirProviders.indexOf(b.provider));
  const accounts = await Promise.all(
    found.map(async (item) => {
      const [identity, result] = await Promise.all([
        readIdentity(item),
        probe(item.provider, item.cliDefault ? null : item.dir),
      ]);
      const siblings = found.filter((other) => other.provider === item.provider).length;
      const name = autoName(item, identity, siblings);
      return fromProbe(
        {
          id: item.id,
          runner: "vps",
          provider: item.provider,
          label: name,
          name,
          autoName: name,
          email: identity.email,
          plan: identity.plan,
          configDir: displayPath(item.dir),
          isDefault: false,
          added: item.added,
        },
        result,
      );
    }),
  );
  uniqueNames(accounts);
  return { found, accounts };
}

async function probeTools() {
  const extra = providers.filter((provider) => !(dirProviders as readonly string[]).includes(provider));
  const results = await Promise.all(extra.map((provider) => probe(provider)));
  return results.map((result) =>
    fromProbe(
      {
        id: `vps:${result.provider}`,
        runner: "vps",
        provider: result.provider,
        label: toolLabels[result.provider],
        name: toolLabels[result.provider],
        autoName: toolLabels[result.provider],
        email: null,
        plan: null,
        configDir: null,
        isDefault: false,
        added: false,
      },
      result,
    ),
  );
}

function applyNames(accounts: Account[], settings: AccountSettings) {
  for (const account of accounts) {
    const custom = settings.names[account.id]?.trim();
    account.name = custom || account.autoName;
    account.label = account.name;
  }
  return withDefaults(accounts, settings);
}

export function refreshAccounts() {
  if (pending) return pending;
  pending = (async () => {
    const settings = await readAccountSettings();
    const [{ found, accounts }, tools] = await Promise.all([probeDirs(settings), probeTools()]);
    dirs = new Map(found.map((item) => [item.id, item]));
    cache = applyNames([...accounts, ...tools], settings);
    checkedAt = Date.now();
    return cache;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export async function listAccounts() {
  if (cache.length === 0 || Date.now() - checkedAt > maxAgeMs) await refreshAccounts();
  return cache;
}

export async function findAccount(id: string) {
  const accounts = await listAccounts();
  const account = accounts.find((item) => item.id === id);
  if (account && account.status !== "ready" && Date.now() - checkedAt > 30_000) {
    return (await refreshAccounts()).find((item) => item.id === id);
  }
  return account;
}

export function isAccountId(value: string) {
  const match = value.match(accountIdPattern);
  return Boolean(match && !legacyMacPattern.test(match[1] ?? ""));
}

export function isLegacyMacAccount(value: string) {
  const prefix = value.split(":")[0] ?? "";
  return legacyMacPattern.test(prefix);
}

export function accountDir(id: string) {
  const found = dirs.get(id);
  return found && !found.cliDefault ? found.dir : null;
}

export function accountPath(id: string) {
  return dirs.get(id)?.dir ?? null;
}

export function preferredAccountId(provider: Provider) {
  return cache.find((account) => account.provider === provider && account.isDefault)?.id ?? `vps:${provider}`;
}

export function defaultAccount(accounts: Account[], provider: Provider) {
  return accounts.find((account) => account.provider === provider && account.isDefault) ?? null;
}

export function siblingAccounts(accounts: Account[], account: Pick<Account, "id" | "provider">) {
  const others = accounts.filter((item) => item.provider === account.provider && item.id !== account.id);
  return others.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

export function mcpBaseFor() {
  return `http://127.0.0.1:${env.GATEWAY_PORT}`;
}

export function runOnAccount(
  account: Pick<Account, "id" | "provider">,
  request: TurnRequest,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  hooks?: NativeToolHooks,
) {
  const fault = injectedFault(account.id);
  if (fault) return Promise.resolve(emitFault(fault, emit));
  return runTurn({ ...request, configDir: accountDir(account.id) }, dataDir, signal, emit, hooks);
}

async function changeSettings(change: (settings: AccountSettings) => void) {
  const settings = await readAccountSettings();
  change(settings);
  await writeAccountSettings(settings);
  return refreshAccounts();
}

export async function updateAccount(id: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Corpo inválido.", "body");
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (key !== "name" && key !== "isDefault") throw new ValidationError(`Campo desconhecido: ${key}.`, key);
  const account = (await listAccounts()).find((item) => item.id === id);
  if (!account) return null;
  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string")
    throw new ValidationError("O nome precisa ser texto.", "name");
  const name = typeof raw.name === "string" ? raw.name.trim() : raw.name;
  if (typeof name === "string" && name.length > maxName)
    throw new ValidationError(`O nome pode ter até ${maxName} caracteres.`, "name");
  if (raw.isDefault !== undefined && raw.isDefault !== true)
    throw new ValidationError("Para trocar a padrão, marque outra conta como padrão.", "isDefault");
  if (raw.isDefault === true && !(dirProviders as readonly string[]).includes(account.provider))
    throw new ValidationError("Só contas do Claude e do Codex têm padrão.", "isDefault");
  return changeSettings((settings) => {
    if (name !== undefined) {
      if (name) settings.names[id] = name;
      else delete settings.names[id];
    }
    if (raw.isDefault === true) settings.defaults[account.provider as DirProvider] = id;
  });
}

export async function addAccountDir(body: unknown) {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof raw.path !== "string" || !raw.path.trim())
    throw new ValidationError("Informe o diretório da conta, por exemplo ~/.claude-3.", "path");
  const dir = expandPath(raw.path);
  if (!dir) throw new ValidationError("Use um caminho absoluto ou que comece com ~/.", "path");
  const provider = await detectProvider(dir);
  if (!provider) throw new ValidationError("Não achei login do Claude Code nem do Codex nesse diretório.", "path");
  const settings = await readAccountSettings();
  const stored = displayPath(dir);
  const accounts = settings.dirs.includes(stored)
    ? await listAccounts()
    : await changeSettings((next) => {
        next.dirs.push(stored);
      });
  return accounts;
}

export async function removeAccountDir(id: string) {
  const account = (await listAccounts()).find((item) => item.id === id);
  if (!account) return null;
  if (!account.added)
    throw new ValidationError(
      "Essa conta foi achada sozinha na pasta pessoal. Para tirar, faça logout dela no terminal.",
      "id",
    );
  return changeSettings((settings) => {
    settings.dirs = settings.dirs.filter((item) => {
      const dir = expandPath(item);
      return item !== account.configDir && (!dir || displayPath(dir) !== account.configDir);
    });
    delete settings.names[id];
    for (const provider of dirProviders) if (settings.defaults[provider] === id) delete settings.defaults[provider];
  });
}

export async function loginGuide(provider: string): Promise<LoginGuide> {
  if (provider !== "claude" && provider !== "codex")
    throw new ValidationError("Use provider=claude ou provider=codex.", "provider");
  const base = provider === "claude" ? ".claude" : ".codex";
  const names = new Set(await readdir(homeDir()).catch(() => [] as string[]));
  let index = 2;
  while (names.has(`${base}-${index}`)) index++;
  const dir = `~/${base}-${index}`;
  const variable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const command =
    provider === "claude"
      ? `${variable}=${dir} claude auth login`
      : `mkdir -p ${dir} && ${variable}=${dir} codex login`;
  const title = provider === "claude" ? "Claude Code" : "Codex";
  return {
    provider,
    dir,
    command,
    steps: [
      `Abra um terminal no servidor onde o runelay bots roda, com o mesmo usuário dele.`,
      `Rode o comando abaixo e entre com a outra conta do ${title} no navegador.`,
      `O diretório fica dentro da sua pasta pessoal, então o servidor já enxerga. Volte aqui e toque em Procurar de novo.`,
    ],
  };
}
