import { env } from "../../../config/env";
import { rememberSecretValue } from "../../../shared/redact";
import {
  latestFailureTtlMs,
  latestTtlMs,
  registryTimeoutMs,
  versionPattern,
} from "../../providers/constants/providers.constants";
import { compareVersions } from "../../providers/services/cli-versions.service";
import {
  devVersion,
  githubApiUrl,
  notesLimit,
  releasesPageSize,
  tokenSecretKey,
  updateCommand,
} from "../constants/server-version.constants";
import type { LatestRelease, ReleaseSettings, ServerVersion, ServerVersionDeps } from "../types/server-version.types";

const defaults: ServerVersionDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  checks: () => env.BOTS_UPDATE_CHECKS === "on",
  settings: () => ({
    version: env.RBOTS_VERSION ?? null,
    channel: env.RBOTS_CHANNEL,
    token: env.RBOTS_GITHUB_TOKEN ?? null,
    repo: env.RBOTS_RELEASE_REPO,
  }),
  timeoutMs: registryTimeoutMs,
};

let deps = defaults;
const cache = new Map<string, { value: LatestRelease | null; expiresAt: number }>();

export function useServerVersionDeps(overrides: Partial<ServerVersionDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
  cache.clear();
}

export function normalizeVersion(value: string | null | undefined) {
  const trimmed = value?.trim().replace(/^v/, "") ?? "";
  return versionPattern.test(trimmed) ? trimmed : null;
}

function headersFor(token: string | null) {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "r-bots-server",
  };
  if (token) {
    rememberSecretValue(tokenSecretKey, token, { pinned: true });
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function textOf(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function releaseOf(value: unknown): LatestRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.draft === true) return null;
  const version = normalizeVersion(textOf(item.tag_name));
  if (!version) return null;
  const body = textOf(item.body);
  return {
    version,
    url: textOf(item.html_url),
    publishedAt: textOf(item.published_at),
    notes: body ? Array.from(body).slice(0, notesLimit).join("") : null,
  };
}

function newest(list: unknown) {
  if (!Array.isArray(list)) return null;
  let best: LatestRelease | null = null;
  for (const entry of list) {
    const release = releaseOf(entry);
    if (release && (!best || compareVersions(release.version, best.version) > 0)) best = release;
  }
  return best;
}

async function fetchLatest(settings: ReleaseSettings) {
  const path = settings.channel === "beta" ? `releases?per_page=${releasesPageSize}` : "releases/latest";
  try {
    const response = await deps.fetch(`${githubApiUrl}/repos/${settings.repo}/${path}`, {
      signal: AbortSignal.timeout(deps.timeoutMs),
      headers: headersFor(settings.token),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return settings.channel === "beta" ? newest(body) : releaseOf(body);
  } catch {
    return null;
  }
}

async function latestRelease(settings: ReleaseSettings) {
  if (!deps.checks()) return null;
  const key = `${settings.repo}#${settings.channel}`;
  const cached = cache.get(key);
  if (cached && deps.now() < cached.expiresAt) return cached.value;
  const value = await fetchLatest(settings);
  cache.set(key, { value, expiresAt: deps.now() + (value ? latestTtlMs : latestFailureTtlMs) });
  return value;
}

export async function serverVersion(): Promise<ServerVersion> {
  const settings = deps.settings();
  const given = settings.version?.trim() || devVersion;
  const installed = normalizeVersion(given);
  const latest = await latestRelease(settings);
  return {
    current: installed ?? given,
    channel: settings.channel,
    latest: latest?.version ?? null,
    updateAvailable: Boolean(installed && latest && compareVersions(latest.version, installed) > 0),
    releaseUrl: latest?.url ?? null,
    publishedAt: latest?.publishedAt ?? null,
    notes: latest?.notes ?? null,
    updateCommand,
  };
}
