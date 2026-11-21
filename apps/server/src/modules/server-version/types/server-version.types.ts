export type ReleaseChannel = "stable" | "beta";

export interface ServerVersion {
  current: string;
  channel: ReleaseChannel;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  notes: string | null;
  updateCommand: "rbots update";
}

export interface LatestRelease {
  version: string;
  url: string | null;
  publishedAt: string | null;
  notes: string | null;
}

export interface ReleaseSettings {
  version: string | null;
  channel: ReleaseChannel;
  token: string | null;
  repo: string;
}

export type ReleaseFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export interface ServerVersionDeps {
  fetch: ReleaseFetch;
  now: () => number;
  checks: () => boolean;
  settings: () => ReleaseSettings;
  timeoutMs: number;
}
