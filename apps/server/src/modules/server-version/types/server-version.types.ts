import type { updateStates } from "../constants/server-version.constants";

export type ReleaseChannel = "stable" | "beta";

export type ServerUpdateState = (typeof updateStates)[number];

export interface ServerUpdate {
  available: boolean;
  state: ServerUpdateState;
  step?: string;
  message?: string;
  from?: string;
  to?: string;
  finishedAt?: string;
}

export interface UpdateRequest {
  id: string;
  requestedAt: string;
  force: boolean;
}

export interface ServerUpdateDeps {
  dir: () => string;
  runningTurns: () => Promise<number>;
  now: () => number;
  newId: () => string;
}

export type UpdateRequestResult =
  | { ok: true; update: ServerUpdate }
  | { ok: false; status: 409 | 422; code: "agent_missing" | "update_in_progress" | "turns_running"; running?: number };

export interface ServerVersion {
  current: string;
  channel: ReleaseChannel;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  notes: string | null;
  updateCommand: "rbots update";
  update: ServerUpdate;
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
  ghToken: () => Promise<string | null>;
  timeoutMs: number;
}
