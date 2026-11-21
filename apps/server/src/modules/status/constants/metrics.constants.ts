import type { BoxState, EnvironmentInfo } from "@runelay-bots/protocol";

export const metricsContentType = "text/plain; version=0.0.4; charset=utf-8";

export const turnDurationBuckets: readonly number[] = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

export const boxStates: readonly BoxState[] = ["running", "paused", "stopped"];

export const localEnvironment: EnvironmentInfo = {
  id: "local",
  name: "local",
  kind: "local",
  connected: true,
  capabilities: [],
  runtime: null,
  capacity: null,
  boxes: [],
};
