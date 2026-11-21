import type { Provider } from "@runelay-bots/protocol";

export interface CliVersion {
  provider: Provider;
  installed: string | null;
  source: "managed" | "image";
  latest: string | null;
  updateAvailable: boolean;
  updating: boolean;
  lastError: string | null;
  previous: string | null;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliSpawn = (bin: string, args: string[], timeoutMs: number) => Promise<SpawnResult>;

export type RegistryFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface CliDeps {
  spawn: CliSpawn;
  fetch: RegistryFetch;
  which: (names: string[]) => string | null;
  now: () => number;
  checks: () => boolean;
  registryTimeoutMs: number;
}
