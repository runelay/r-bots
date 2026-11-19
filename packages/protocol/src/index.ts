export const providers = ["claude", "codex", "grok", "cursor"] as const;
export type Provider = (typeof providers)[number];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface McpTarget {
  url: string;
  token: string;
}

export interface TurnRequest {
  turnId: string;
  provider: Provider;
  model: string;
  effort: string | null;
  systemPrompt: string;
  prompt: string;
  images?: Array<{ path: string; mime: string; label: string }>;
  resume: string | null;
  mcp: McpTarget | null;
  workKey: string;
  code?: { cwd: string; readOnly?: boolean } | null;
}

export interface NativeToolGate {
  allow: boolean;
  message?: string;
  input?: Record<string, unknown>;
}

export interface NativeToolHooks {
  before: (tool: string, input: Record<string, unknown>, toolUseId: string) => Promise<NativeToolGate>;
  after: (
    tool: string,
    input: Record<string, unknown>,
    response: unknown,
    toolUseId: string,
    failed: boolean,
  ) => Promise<void>;
}

export type ProviderEvent =
  | { type: "session"; id: string }
  | { type: "text.delta"; part: string; text: string }
  | { type: "text"; part: string; text: string }
  | { type: "usage"; usage: Usage; contextTokens: number | null }
  | { type: "warning"; message: string }
  | {
      type: "tool";
      id: string;
      name: string;
      phase: "start" | "end";
      input?: Record<string, unknown>;
      output?: unknown;
      ok?: boolean;
    }
  | { type: "done"; ok: boolean; message?: string };

export interface ModelOption {
  id: string;
  label: string;
}

export interface AccountProbe {
  provider: Provider;
  status: "ready" | "logged_out" | "missing";
  detail: string;
  models: ModelOption[];
}

export const providerLabels: Record<Provider, string> = {
  claude: "Claude · assinatura",
  codex: "ChatGPT · Codex",
  grok: "Grok",
  cursor: "Cursor",
};

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export * from "./blocks";
