import type { Placement } from "@runelay-bots/protocol";
import { boxesCapability } from "../constants/environments.constants";
import type { PlacementContext, RunnerEnvironment } from "../types/environments.types";

const local: Placement = { kind: "local" };

export function containsPath(root: string, path: string) {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === base || path.startsWith(`${base}/`);
}

function reaches({ runner }: RunnerEnvironment, codeCwd: string | null) {
  return codeCwd === null || (runner?.workspaceRoots.some((root) => containsPath(root, codeCwd)) ?? false);
}

function memFreeOf({ capacity }: RunnerEnvironment) {
  return capacity?.memFreeMb ?? Number.NEGATIVE_INFINITY;
}

export function decidePlacement({ sandbox, codeCwd, environments }: PlacementContext): Placement {
  if (sandbox === "off") return local;
  const eligible = environments.filter(
    (environment) => environment.capabilities.includes(boxesCapability) && reaches(environment, codeCwd),
  );
  const [best] = eligible.sort((a, b) => memFreeOf(b) - memFreeOf(a));
  return best ? { kind: "remote", environmentId: best.key } : local;
}
