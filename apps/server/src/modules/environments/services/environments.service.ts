import type { EnvironmentInfo } from "@runelay-bots/protocol";
import { onRunnerEnvironmentsChange, runnerEnvironments } from "../../accounts/services/mac-runner.service";
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
