import type { Placement, PlacementInput } from "@runelay-bots/protocol";
import { env } from "../../../config/env";
import { hostRunnerKey, runnerEnvironments } from "../../accounts/services/mac-runner.service";
import { hostFallbackNotice } from "../constants/environments.constants";
import { decidePlacement } from "./placement.service";

export function place({ codeCwd, botId }: PlacementInput): Placement {
  const { BOTS_SANDBOX: sandbox } = env;
  const placement = decidePlacement({
    sandbox,
    codeCwd,
    environments: runnerEnvironments(),
    hostKey: hostRunnerKey(),
  });
  if (sandbox === "docker" && placement.kind === "local")
    console.warn(`${new Date().toISOString()} sandbox: no box runner for bot ${botId}, running local`);
  if (placement.kind === "local" && env.BOTS_HOST_RUNNER === "on") return { ...placement, notice: hostFallbackNotice };
  return placement;
}
