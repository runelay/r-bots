import type { BoxStatus, EnvironmentCapacity, EnvironmentHello, EnvironmentId } from "@runelay-bots/protocol";
import type { Env } from "../../../config/env";

export type RunnerInfo = NonNullable<EnvironmentHello["runner"]>;

export interface RunnerEnvironment {
  key: string;
  name: string | null;
  capabilities: string[];
  runner: RunnerInfo | null;
  capacity: EnvironmentCapacity | null;
  boxes: BoxStatus[];
}

export interface EnvironmentState {
  key: string | null;
  online: boolean;
  canRun: boolean;
}

export type EnvironmentStates = Record<EnvironmentId, EnvironmentState>;

export interface PlacementContext {
  sandbox: Env["BOTS_SANDBOX"];
  codeCwd: string | null;
  environments: RunnerEnvironment[];
  environment?: EnvironmentId;
  hosts?: EnvironmentStates;
}

export type LocalRunnerOutcome = "off" | "no-auth" | "waiting" | "kept" | "written" | "failed" | "stopped";

export interface LocalRunnerWatch {
  settled: Promise<LocalRunnerOutcome>;
  stop: () => void;
}
