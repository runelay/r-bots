import { existsSync } from "node:fs";
import { join } from "node:path";

export const managedClis = {
  claude: { pkg: "@anthropic-ai/claude-code", bin: "claude" },
  codex: { pkg: "@openai/codex", bin: "codex" },
} as const;

export type ManagedProvider = keyof typeof managedClis;

export function isManaged(provider: string): provider is ManagedProvider {
  return Object.hasOwn(managedClis, provider);
}

export function clisDir() {
  const configured = process.env.RBOTS_CLIS_DIR?.trim();
  if (configured) return configured;
  const data = process.env.BOTS_DATA_DIR?.trim();
  return data ? join(data, "clis") : "/data/clis";
}

export function managedBinary(provider: string, dir = clisDir()) {
  if (!isManaged(provider)) return null;
  const path = join(dir, provider, "current", "bin", managedClis[provider].bin);
  return existsSync(path) ? path : null;
}
