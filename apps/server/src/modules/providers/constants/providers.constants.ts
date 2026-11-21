import type { Provider } from "@runelay-bots/protocol";

export const registryUrl = "https://registry.npmjs.org/-/package";
export const registryTimeoutMs = 4_000;
export const latestTtlMs = 6 * 60 * 60 * 1000;
export const latestFailureTtlMs = 10 * 60 * 1000;
export const installTimeoutMs = 10 * 60 * 1000;
export const versionTimeoutMs = 20_000;
export const currentLink = "current";
export const previousLink = "previous";
export const tmpSuffix = ".tmp";
export const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const imageBinaries: Record<Provider, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  grok: ["grok"],
  cursor: ["cursor-agent", "agent"],
};
