import {
  type BoxRuntime,
  type BoxState,
  type BoxStatus,
  type EnvironmentCapacity,
  type HookRequestFrame,
  type Provider,
  providers,
} from "@runelay-bots/protocol";
import type { RunnerInfo } from "../types/environments.types";

const runtimes: readonly BoxRuntime[] = ["runsc", "runc", "host"];
const boxStates: readonly BoxState[] = ["running", "paused", "stopped"];

export function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProvider(value: unknown): value is Provider {
  return providers.some((provider) => provider === value);
}

function isRuntime(value: unknown): value is BoxRuntime {
  return runtimes.some((runtime) => runtime === value);
}

function isBoxState(value: unknown): value is BoxState {
  return boxStates.some((state) => state === value);
}

export function capabilitiesOf(value: unknown) {
  return Array.isArray(value) ? value.filter(isText) : [];
}

export function capacityOf(value: unknown): EnvironmentCapacity | null {
  const raw = recordOf(value);
  if (!raw) return null;
  const { cpus, memTotalMb, memFreeMb, boxesRunning, boxesPaused, maxBoxes } = raw;
  if (!isCount(cpus) || !isCount(memTotalMb) || !isCount(memFreeMb)) return null;
  if (!isCount(boxesRunning) || !isCount(boxesPaused) || !isCount(maxBoxes)) return null;
  return { cpus, memTotalMb, memFreeMb, boxesRunning, boxesPaused, maxBoxes };
}

function boxOf(value: unknown): BoxStatus | null {
  const raw = recordOf(value);
  if (!raw) return null;
  const { botId, state, memMb, startedAt, lastUsedAt } = raw;
  if (!isText(botId) || !isBoxState(state) || !isCount(memMb) || !isText(startedAt) || !isText(lastUsedAt)) return null;
  return { botId, state, memMb, startedAt, lastUsedAt };
}

export function boxesOf(value: unknown): BoxStatus[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(boxOf).filter((box): box is BoxStatus => box !== null);
}

export function runnerOf(value: unknown): RunnerInfo | null {
  const raw = recordOf(value);
  if (!raw) return null;
  const { version, name, kvm, runtime, providers: installed, workspaceRoots } = raw;
  const capacity = capacityOf(raw.capacity);
  if (!isText(version) || !isText(name) || typeof kvm !== "boolean" || !isRuntime(runtime) || !capacity) return null;
  if (!Array.isArray(installed) || !Array.isArray(workspaceRoots)) return null;
  return {
    version,
    name,
    kvm,
    runtime,
    providers: installed.filter(isProvider),
    workspaceRoots: workspaceRoots.filter(isText),
    capacity,
  };
}

export function hookRequestOf(value: Record<string, unknown>): HookRequestFrame | null {
  const { id, turnId, phase, tool, toolUseId, response, failed } = value;
  const input = recordOf(value.input);
  if (!isText(id) || !isText(turnId) || !isText(tool) || !isText(toolUseId) || !input) return null;
  if (phase !== "before" && phase !== "after") return null;
  return { type: "hook.request", id, turnId, phase, tool, input, toolUseId, response, failed: failed === true };
}
