import type { Placement, PlacementInput } from "@runelay-bots/protocol";
import { env } from "../../../config/env";
import { environmentStates, runnerEnvironments } from "../../accounts/services/mac-runner.service";
import { readPreferences } from "../../settings/services/preferences.service";
import { vpsFallbackNotice } from "../constants/environments.constants";
import { decidePlacement } from "./placement.service";

export async function place({ codeCwd, botId }: PlacementInput): Promise<Placement> {
  const { BOTS_SANDBOX: sandbox } = env;
  const { environment } = await readPreferences();
  const placement = decidePlacement({
    sandbox,
    codeCwd,
    environments: runnerEnvironments(),
    environment,
    hosts: environmentStates(),
  });
  if (sandbox === "docker" && placement.kind === "local")
    console.warn(`${new Date().toISOString()} sandbox: no box runner for bot ${botId}, running local`);
  if (placement.kind === "local" && env.BOTS_HOST_RUNNER === "on") return { ...placement, notice: vpsFallbackNotice };
  return placement;
}
