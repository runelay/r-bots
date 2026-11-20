import {
  type AccountProbe,
  type ModelOption,
  type NativeToolHooks,
  type Provider,
  type ProviderEvent,
  providerLabels,
  providers,
  type TurnRequest,
} from "@runelay-bots/protocol";
import { probe, runTurn } from "@runelay-bots/providers";
import { dataDir, env } from "../../../config/env";
import { listRegisteredDevices } from "../../devices/services/devices.service";
import { emitFault, injectedFault, providerName } from "./limits.service";
import {
  macAccounts,
  macRunnerConnected,
  macRunnerConnections,
  onMacRunnerChange,
  runMacTurn,
} from "./mac-runner.service";

export type RunnerId = "vps" | "mac";
export type AccountStatus = "ready" | "logged_out" | "offline" | "missing";

export interface AccountDevice {
  id: string;
  name: string;
  connected: boolean;
}

export interface Account {
  id: string;
  runner: RunnerId;
  provider: Provider;
  label: string;
  status: AccountStatus;
  models: ModelOption[];
  detail: string;
  checkedAt: string;
  device?: AccountDevice | null;
}

interface MacSlot {
  prefix: string;
  key: string;
  name: string | null;
  connected: boolean;
}

export const runnerIds: RunnerId[] = ["vps", "mac"];
const macPrefixPattern = /^mac(?:-[a-z0-9]{1,16})?$/;
const runnerLabels: Record<RunnerId, string> = { vps: "VPS", mac: "Mac" };
const offlineDetail = "Mac desconectado: abra o app runelay bots nele.";
const noDeviceDetail = "Nenhum Mac na conta: entre no app runelay bots no Mac.";
const maxAgeMs = 10 * 60_000;

let cache: Account[] = [];
let checkedAt = 0;
let pending: Promise<Account[]> | null = null;

function shortKey(key: string) {
  return (
    key
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 8) || "mac"
  );
}

async function macSlots(): Promise<MacSlot[]> {
  const devices = (await listRegisteredDevices()).sort((a, b) => Number(b.owner) - Number(a.owner));
  const next: Omit<MacSlot, "prefix">[] = devices.map((device) => ({
    key: device.id,
    name: device.name,
    connected: macRunnerConnected(device.id),
  }));
  if (devices.length > 0 && !devices[0]?.owner) next.unshift({ key: "", name: null, connected: false });
  for (const live of macRunnerConnections())
    if (!next.some((slot) => slot.key === live.key)) next.push({ key: live.key, name: live.name, connected: true });
  if (next.length === 0) next.push({ key: "", name: null, connected: false });
  const used = new Set<string>();
  return next.map((slot, index) => {
    let prefix = index === 0 ? "mac" : `mac-${shortKey(slot.key)}`;
    while (used.has(prefix)) prefix = `${prefix}x`.slice(0, 20);
    used.add(prefix);
    return { ...slot, prefix };
  });
}

function toAccount(
  runner: RunnerId,
  result: AccountProbe | { provider: Provider; status: AccountStatus; detail: string; models: ModelOption[] },
  slot?: MacSlot,
): Account {
  const named = slot?.name ?? null;
  return {
    id: `${slot?.prefix ?? runner}:${result.provider}`,
    runner,
    provider: result.provider,
    label: named
      ? `${providerName(result.provider)} · ${named}`
      : `${providerLabels[result.provider]} (${runnerLabels[runner]})`,
    status: result.status,
    models: result.models,
    detail: result.detail,
    checkedAt: new Date().toISOString(),
    ...(runner === "mac"
      ? { device: slot && named ? { id: slot.key, name: named, connected: slot.connected } : null }
      : {}),
  };
}

async function probeSlot(slot: MacSlot): Promise<Account[]> {
  if (!slot.connected)
    return providers.map((provider) =>
      toAccount(
        "mac",
        { provider, status: "offline", detail: slot.key ? offlineDetail : noDeviceDetail, models: [] },
        slot,
      ),
    );
  try {
    const list = await macAccounts(slot.key);
    return providers.map((provider) => {
      const found = list.find((item) => item.provider === provider);
      return toAccount(
        "mac",
        found ?? { provider, status: "missing", detail: "CLI não instalada no Mac.", models: [] },
        slot,
      );
    });
  } catch (error) {
    const detail = `Mac fora do ar: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    return providers.map((provider) => toAccount("mac", { provider, status: "offline", detail, models: [] }, slot));
  }
}

async function probeMac(): Promise<Account[]> {
  const found = await macSlots();
  return (await Promise.all(found.map(probeSlot))).flat();
}

async function probeVps(): Promise<Account[]> {
  const results = await Promise.all(providers.map((provider) => probe(provider)));
  return results.map((result) => toAccount("vps", result));
}

export function refreshAccounts() {
  if (pending) return pending;
  pending = (async () => {
    const [vps, mac] = await Promise.all([probeVps(), probeMac()]);
    cache = [...vps, ...mac];
    checkedAt = Date.now();
    return cache;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

let macPending: Promise<void> | null = null;

function refreshMacAccounts() {
  if (macPending) return macPending;
  macPending = (async () => {
    const mac = await probeMac();
    cache = [...cache.filter((account) => account.runner !== "mac"), ...mac];
    if (checkedAt === 0) checkedAt = Date.now();
    console.log(`accounts: ${mac.map((item) => `${item.id}=${item.status}`).join(", ")}`);
  })().finally(() => {
    macPending = null;
  });
  return macPending;
}

onMacRunnerChange(() => {
  void refreshMacAccounts().catch(() => undefined);
});

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
  const [runner = "", provider] = value.split(":");
  return (
    (runner === "vps" || macPrefixPattern.test(runner)) && (providers as readonly string[]).includes(provider ?? "")
  );
}

export function runnerTarget(account: Pick<Account, "id" | "runner">) {
  const prefix = account.id.split(":")[0] ?? "";
  return account.runner === "mac" && macPrefixPattern.test(prefix) ? prefix : account.runner;
}

export function mcpBaseFor() {
  return `http://127.0.0.1:${env.GATEWAY_PORT}`;
}

async function deviceFor(target: string) {
  return (await macSlots()).find((slot) => slot.prefix === target)?.key || undefined;
}

async function runOnMac(
  target: string,
  request: TurnRequest,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
) {
  const key = await deviceFor(target);
  if (!key) {
    emit({ type: "done", ok: false, message: "Mac desconectado." });
    return;
  }
  return runMacTurn({ ...request, code: null }, signal, emit, key);
}

export function runOnRunner(
  runner: string,
  request: TurnRequest,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  hooks?: NativeToolHooks,
) {
  const fault = injectedFault(`${runner}:${request.provider}`);
  if (fault) return Promise.resolve(emitFault(fault, emit));
  if (runner === "mac" || macPrefixPattern.test(runner)) return runOnMac(runner, request, signal, emit);
  return runTurn(request, dataDir, signal, emit, hooks);
}
