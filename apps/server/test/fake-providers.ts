import type { AccountProbe, NativeToolHooks, Provider, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { emptyUsage } from "@runelay-bots/protocol";

export interface FakeTurn {
  request: TurnRequest;
  baseDir: string;
  signal: AbortSignal;
  emit: (event: ProviderEvent) => void;
  hooks?: NativeToolHooks;
}

export type TurnScript = (turn: FakeTurn) => unknown;

export const fakeModels: Record<Provider, string> = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-5.6-sol",
  grok: "grok-4.6",
  cursor: "auto",
};

export function replyWith(text: string, extra: ProviderEvent[] = []): TurnScript {
  return ({ request, emit }) => {
    emit({ type: "session", id: `session-${request.turnId}` });
    emit({ type: "text", part: `${request.turnId}:0`, text });
    for (const event of extra) emit(event);
    emit({ type: "usage", usage: emptyUsage(), contextTokens: null });
    emit({ type: "done", ok: true });
  };
}

export function readyProbe(provider: Provider): AccountProbe {
  return {
    provider,
    status: "ready",
    detail: "fake",
    models: [{ id: fakeModels[provider], label: fakeModels[provider] }],
  };
}

const defaultScript = replyWith("ok");

export const fakeProviders = {
  turns: [] as FakeTurn[],
  probes: {} as Partial<Record<Provider, AccountProbe>>,
  probed: [] as Array<{ provider: Provider; configDir: string | null }>,
  script: defaultScript,
  next(script: TurnScript) {
    fakeProviders.script = script;
  },
  probe: async (provider: Provider, configDir: string | null = null) => {
    fakeProviders.probed.push({ provider, configDir });
    return fakeProviders.probes[provider] ?? readyProbe(provider);
  },
  runTurn: async (
    request: TurnRequest,
    baseDir: string,
    signal: AbortSignal,
    emit: (event: ProviderEvent) => void,
    hooks?: NativeToolHooks,
  ) => {
    const turn: FakeTurn = { request, baseDir, signal, emit, hooks };
    fakeProviders.turns.push(turn);
    await fakeProviders.script(turn);
  },
  reset() {
    fakeProviders.turns.length = 0;
    fakeProviders.probes = {};
    fakeProviders.probed.length = 0;
    fakeProviders.script = defaultScript;
  },
};

export function accountFields(id: string, label: string) {
  return {
    name: label,
    autoName: label,
    email: null,
    plan: null,
    configDir: null,
    isDefault: id.startsWith("vps:"),
    added: false,
  };
}
