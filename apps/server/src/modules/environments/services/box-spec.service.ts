import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BoxSpec, TurnRequest } from "@runelay-bots/protocol";
import { clisDir, dataDir, env, hostDataDir, hostHome } from "../../../config/env";
import { boxHome } from "../constants/environments.constants";
import { containsPath } from "./placement.service";

type Mount = BoxSpec["mounts"][number];

export function hostPathOf(path: string) {
  if (containsPath(dataDir, path)) return `${hostDataDir}${path.slice(dataDir.replace(/\/$/, "").length)}`;
  if (containsPath(boxHome, path)) return `${hostHome}${path.slice(boxHome.length)}`;
  return path;
}

export function workDirOf({ workKey }: Pick<TurnRequest, "workKey">) {
  return join(dataDir, "work", workKey.replace(/[^\w/-]/g, "_"));
}

function mountOf(path: string, readOnly: boolean): Mount {
  return { host: hostPathOf(path), box: path, readOnly };
}

export function boxSpecFor({ request, accountPath }: { request: TurnRequest; accountPath: string | null }): BoxSpec {
  const { code } = request;
  const mounts = [
    mountOf(workDirOf(request), false),
    ...(accountPath ? [mountOf(accountPath, false)] : []),
    ...(code ? [mountOf(code.cwd, code.readOnly === true)] : []),
    ...(existsSync(clisDir) ? [mountOf(clisDir, true)] : []),
  ];
  const unique = mounts.filter((mount, index) => mounts.findIndex(({ box }) => box === mount.box) === index);
  return { memMb: env.BOX_MEM_MB, cpus: env.BOX_CPUS, mounts: unique };
}
