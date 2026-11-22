import {
  type EnvironmentId,
  type EnvironmentInfo,
  type EnvironmentsResponse,
  environmentLabels,
} from "@runelay-bots/protocol";
import {
  environmentStates,
  onRunnerEnvironmentsChange,
  runnerEnvironments,
} from "../../accounts/services/mac-runner.service";
import { readPreferences } from "../../settings/services/preferences.service";
import { localCapabilities, localEnvironmentId } from "../constants/environments.constants";
import type { RunnerEnvironment } from "../types/environments.types";
import { readLocalCapacity } from "./local-capacity.service";

function localEnvironment(): EnvironmentInfo {
  return {
    id: localEnvironmentId,
    name: localEnvironmentId,
    kind: "local",
    connected: true,
    capabilities: localCapabilities,
    runtime: null,
    capacity: readLocalCapacity(),
    boxes: [],
  };
}

function runnerEnvironment({ key, name, capabilities, runner, capacity, boxes }: RunnerEnvironment): EnvironmentInfo {
  return {
    id: key,
    name: runner?.name ?? name ?? key,
    kind: "runner",
    connected: true,
    capabilities,
    runtime: runner?.runtime ?? null,
    capacity,
    boxes,
  };
}

export function listEnvironments(): EnvironmentInfo[] {
  return [localEnvironment(), ...runnerEnvironments().map(runnerEnvironment)];
}

export function onEnvironmentsChange(listener: () => void) {
  return onRunnerEnvironmentsChange(listener);
}

export async function readEnvironments(): Promise<EnvironmentsResponse> {
  const { environment } = await readPreferences();
  const states = environmentStates();
  const option = (id: EnvironmentId) => ({
    id,
    label: environmentLabels[id],
    online: states[id].online,
    canRun: states[id].canRun,
  });
  return { selected: environment, environments: [option("vps"), ...(states.mac.online ? [option("mac")] : [])] };
}
