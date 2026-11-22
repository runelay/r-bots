import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type Provider, providers } from "@runelay-bots/protocol";
import { isManaged, type ManagedProvider, managedBinary, managedClis } from "@runelay-bots/providers/managed";
import { childEnv, findBinary, run } from "@runelay-bots/providers/proc";
import { clisDir, env } from "../../../config/env";
import { ValidationError } from "../../../shared/errors";
import {
  currentLink,
  imageBinaries,
  installTimeoutMs,
  latestFailureTtlMs,
  latestTtlMs,
  previousLink,
  registryTimeoutMs,
  registryUrl,
  tmpSuffix,
  versionPattern,
  versionTimeoutMs,
} from "../constants/providers.constants";
import { providersText } from "../constants/providers-messages.constants";
import type { CliDeps, CliVersion } from "../types/providers.types";

export class CliUpdateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface UpdateState {
  updating: boolean;
  task: Promise<void> | null;
  lastError: string | null;
}

export function spawnCli(bin: string, args: string[], timeoutMs: number) {
  return run(bin, args, { timeoutMs, env: childEnv() });
}

const defaults: CliDeps = {
  spawn: spawnCli,
  fetch: (url, init) => fetch(url, init),
  which: findBinary,
  now: () => Date.now(),
  checks: () => env.BOTS_UPDATE_CHECKS === "on",
  registryTimeoutMs,
};

let deps = defaults;
const imageVersions = new Map<Provider, Promise<string | null>>();
const latestCache = new Map<string, { value: string | null; expiresAt: number }>();
const states = new Map<string, UpdateState>();

export function useCliDeps(overrides: Partial<CliDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
  imageVersions.clear();
  latestCache.clear();
  states.clear();
}

export function parseVersion(text: string) {
  return text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

export function compareVersions(left: string, right: string) {
  const [leftCore, leftPre = ""] = left.split(/-(.*)/s);
  const [rightCore, rightPre = ""] = right.split(/-(.*)/s);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (leftPre === rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  return Math.sign(leftPre.localeCompare(rightPre, "en", { numeric: true }));
}

function stateOf(provider: string) {
  let state = states.get(provider);
  if (!state) {
    state = { updating: false, task: null, lastError: null };
    states.set(provider, state);
  }
  return state;
}

function managedProvider(provider: string): ManagedProvider {
  if (!isManaged(provider)) throw new ValidationError(providersText("providerInvalid"), "provider");
  return provider;
}

function providerDir(provider: ManagedProvider) {
  return join(clisDir, provider);
}

function linkOf(provider: ManagedProvider, name: string) {
  try {
    return readlinkSync(join(providerDir(provider), name));
  } catch {
    return null;
  }
}

function tail(text: string) {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

function imageVersion(provider: Provider) {
  let found = imageVersions.get(provider);
  if (!found) {
    const bin = deps.which(imageBinaries[provider]);
    found = bin
      ? deps.spawn(bin, ["--version"], versionTimeoutMs).then(
          (result) => (result.code === 0 ? parseVersion(result.stdout) : null),
          () => null,
        )
      : Promise.resolve(null);
    imageVersions.set(provider, found);
  }
  return found;
}

async function fetchLatest(pkg: string) {
  try {
    const response = await deps.fetch(`${registryUrl}/${pkg}/dist-tags`, {
      signal: AbortSignal.timeout(deps.registryTimeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    const latest = body && typeof body === "object" ? (body as Record<string, unknown>).latest : null;
    return typeof latest === "string" && versionPattern.test(latest) ? latest : null;
  } catch {
    return null;
  }
}

async function latestVersion(pkg: string) {
  if (!deps.checks()) return null;
  const cached = latestCache.get(pkg);
  if (cached && deps.now() < cached.expiresAt) return cached.value;
  const value = await fetchLatest(pkg);
  latestCache.set(pkg, { value, expiresAt: deps.now() + (value ? latestTtlMs : latestFailureTtlMs) });
  return value;
}

async function versionOf(provider: Provider): Promise<CliVersion> {
  const state = states.get(provider);
  const base = { provider, updating: state?.updating ?? false, lastError: state?.lastError ?? null };
  if (!isManaged(provider)) {
    const installed = await imageVersion(provider);
    return { ...base, installed, source: "image", latest: null, updateAvailable: false, previous: null };
  }
  const current = managedBinary(provider, clisDir) ? linkOf(provider, currentLink) : null;
  const installed = current ?? (await imageVersion(provider));
  const latest = await latestVersion(managedClis[provider].pkg);
  return {
    ...base,
    installed,
    source: current ? "managed" : "image",
    latest,
    updateAvailable: Boolean(installed && latest && compareVersions(latest, installed) > 0),
    previous: linkOf(provider, previousLink),
  };
}

export function listVersions() {
  return Promise.all(providers.map(versionOf));
}

export function pointLink(root: string, name: string, target: string) {
  const staging = join(root, `${name}${tmpSuffix}`);
  rmSync(staging, { force: true });
  symlinkSync(target, staging);
  renameSync(staging, join(root, name));
}

function prune(provider: ManagedProvider) {
  const root = providerDir(provider);
  const keep = new Set([currentLink, previousLink, linkOf(provider, currentLink), linkOf(provider, previousLink)]);
  for (const entry of readdirSync(root)) {
    if (!keep.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
  }
}

async function verify(bin: string, version: string) {
  const result = await deps.spawn(bin, ["--version"], versionTimeoutMs);
  const found = result.code === 0 ? parseVersion(result.stdout) : null;
  if (found !== version)
    throw new Error(providersText("versionMismatch", { version, found: found ?? providersText("withError") }));
}

async function install(provider: ManagedProvider, version: string) {
  const root = providerDir(provider);
  const target = join(root, version);
  const staging = `${target}${tmpSuffix}`;
  const { pkg, bin } = managedClis[provider];
  mkdirSync(root, { recursive: true });
  try {
    if (existsSync(target)) await verify(join(target, "bin", bin), version);
    else {
      rmSync(staging, { recursive: true, force: true });
      const npm = deps.which(["npm"]) ?? "npm";
      const args = ["install", "-g", "--prefix", staging, "--no-audit", "--no-fund", `${pkg}@${version}`];
      const result = await deps.spawn(npm, args, installTimeoutMs);
      if (result.code !== 0)
        throw new Error(providersText("npmFailed", { pkg, version, reason: tail(result.stderr || result.stdout) }));
      await verify(join(staging, "bin", bin), version);
      renameSync(staging, target);
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const current = linkOf(provider, currentLink);
  if (current !== version) {
    pointLink(root, currentLink, version);
    if (current) pointLink(root, previousLink, current);
  }
  prune(provider);
}

export async function startUpdate(provider: string, requested: unknown) {
  const managed = managedProvider(provider);
  if (requested !== undefined && (typeof requested !== "string" || !versionPattern.test(requested)))
    throw new ValidationError(providersText("versionInvalid"), "version");
  const state = stateOf(managed);
  if (state.updating) throw new CliUpdateError(providersText("updating"), 409);
  state.updating = true;
  const version = requested ?? (await latestVersion(managedClis[managed].pkg));
  if (!version) {
    state.updating = false;
    throw new ValidationError(providersText("latestUnknown"), "version");
  }
  state.lastError = null;
  state.task = install(managed, version).then(
    () => {
      state.updating = false;
    },
    (error: unknown) => {
      state.updating = false;
      state.lastError = error instanceof Error ? error.message : String(error);
    },
  );
  return { provider: managed, version };
}

export function updateTask(provider: string) {
  return states.get(provider)?.task ?? Promise.resolve();
}

export function rollback(provider: string) {
  const managed = managedProvider(provider);
  const state = stateOf(managed);
  if (state.updating) throw new CliUpdateError(providersText("waitUpdate"), 409);
  const root = providerDir(managed);
  const previous = linkOf(managed, previousLink);
  if (!previous || !existsSync(join(root, previous))) throw new CliUpdateError(providersText("noPrevious"), 409);
  const current = linkOf(managed, currentLink);
  pointLink(root, currentLink, previous);
  if (current) pointLink(root, previousLink, current);
  state.lastError = null;
  return versionOf(managed);
}
