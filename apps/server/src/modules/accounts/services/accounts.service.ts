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
import { emitFault, injectedFault } from "./limits.service";
import { macAccounts, macRunnerConnected, onMacRunnerChange, runMacTurn } from "./mac-runner.service";

export type RunnerId = "vps" | "mac";
export type AccountStatus = "ready" | "logged_out" | "offline" | "missing";

export interface Account {
  id: string;
  runner: RunnerId;
  provider: Provider;
  label: string;
  status: AccountStatus;
  models: ModelOption[];
  detail: string;
  checkedAt: string;
}

export const runnerIds: RunnerId[] = ["vps", "mac"];
const runnerToken = env.RUNNER_TOKEN;
const macUrl = env.MAC_RUNNER_URL;
const macUrlMissing = "Mac não conectado e MAC_RUNNER_URL não definida.";
const runnerLabels: Record<RunnerId, string> = { vps: "VPS", mac: "Mac" };
const maxAgeMs = 10 * 60_000;

let cache: Account[] = [];
let checkedAt = 0;
let pending: Promise<Account[]> | null = null;

function toAccount(
  runner: RunnerId,
  result: AccountProbe | { provider: Provider; status: AccountStatus; detail: string; models: ModelOption[] },
): Account {
  return {
    id: `${runner}:${result.provider}`,
    runner,
    provider: result.provider,
    label: `${providerLabels[result.provider]} (${runnerLabels[runner]})`,
    status: result.status,
    models: result.models,
    detail: result.detail,
    checkedAt: new Date().toISOString(),
  };
}

async function probeMacHttp() {
  if (!macUrl) throw new Error(macUrlMissing);
  const response = await fetch(`${macUrl}/accounts`, {
    headers: { authorization: `Bearer ${runnerToken}` },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`runner respondeu ${response.status}`);
  return (await response.json()) as AccountProbe[];
}

async function probeMac(): Promise<Account[]> {
  try {
    const list = macRunnerConnected() ? await macAccounts() : await probeMacHttp();
    return providers.map((provider) => {
      const found = list.find((item) => item.provider === provider);
      return toAccount(
        "mac",
        found ?? { provider, status: "missing", detail: "CLI não instalada no Mac.", models: [] },
      );
    });
  } catch (error) {
    const detail = `Mac fora do ar: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    return providers.map((provider) => toAccount("mac", { provider, status: "offline", detail, models: [] }));
  }
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
  const [runner, provider] = value.split(":");
  return runnerIds.includes(runner as RunnerId) && (providers as readonly string[]).includes(provider ?? "");
}

export function mcpBaseFor(runner: RunnerId) {
  if (runner === "mac" && env.PUBLIC_MCP_BASE) return env.PUBLIC_MCP_BASE;
  return `http://127.0.0.1:${env.GATEWAY_PORT}`;
}

async function runRemote(request: TurnRequest, signal: AbortSignal, emit: (event: ProviderEvent) => void) {
  if (!macUrl) {
    emit({ type: "done", ok: false, message: macUrlMissing });
    return;
  }
  const controller = new AbortController();
  const onAbort = () => {
    void fetch(`${macUrl}/turns/${encodeURIComponent(request.turnId)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${runnerToken}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    setTimeout(() => controller.abort(), 5000).unref();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let done = false;
  try {
    const response = await fetch(`${macUrl}/turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      emit({ type: "done", ok: false, message: `Runner do Mac respondeu ${response.status}: ${body.slice(0, 200)}` });
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const event = JSON.parse(line) as ProviderEvent;
          if (event.type === "done") done = true;
          emit(event);
        } catch {}
      }
    }
  } catch (error) {
    if (!done)
      emit({
        type: "done",
        ok: false,
        message: signal.aborted
          ? "cancelled"
          : `Runner do Mac caiu: ${error instanceof Error ? error.message : String(error)}`,
      });
    done = true;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (!done)
    emit({ type: "done", ok: false, message: signal.aborted ? "cancelled" : "Runner do Mac fechou a conexão." });
}

export function runOnRunner(
  runner: RunnerId,
  request: TurnRequest,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  hooks?: NativeToolHooks,
) {
  const fault = injectedFault(`${runner}:${request.provider}`);
  if (fault) return Promise.resolve(emitFault(fault, emit));
  if (runner === "mac")
    return macRunnerConnected()
      ? runMacTurn({ ...request, code: null }, signal, emit)
      : runRemote({ ...request, code: null }, signal, emit);
  return runTurn(request, dataDir, signal, emit, hooks);
}
