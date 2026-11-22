import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BoxSpec, TurnRequest } from "@runelay-bots/protocol";
import { clisDir, dataDir, env, hostDataDir, hostHome, hostToolsDir, toolsDir } from "../../../config/env";
import { boxHome } from "../constants/environments.constants";
import { containsPath } from "./placement.service";

type Mount = BoxSpec["mounts"][number];

export function hostPathOf(path: string) {
  if (containsPath(dataDir, path)) return `${hostDataDir}${path.slice(dataDir.replace(/\/$/, "").length)}`;
  if (containsPath(toolsDir, path)) return `${hostToolsDir}${path.slice(toolsDir.replace(/\/$/, "").length)}`;
  if (containsPath(boxHome, path)) return `${hostHome}${path.slice(boxHome.length)}`;
  return path;
}

export function workDirOf({ workKey }: Pick<TurnRequest, "workKey">) {
  return join(dataDir, "work", workKey.replace(/[^\w/-]/g, "_"));
}

function botWorkDirOf({ workKey }: Pick<TurnRequest, "workKey">) {
  const [botId = ""] = workKey.split("/");
  return join(dataDir, "work", botId.replace(/[^\w-]/g, "_"));
}

function mountOf(path: string, readOnly: boolean): Mount {
  return { host: hostPathOf(path), box: path, readOnly };
}

function linkedDirsOf(accountPath: string): Mount[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(accountPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isSymbolicLink())
    .flatMap((entry) => {
      try {
        const target = realpathSync(join(accountPath, entry.name));
        if (containsPath(accountPath, target) || !statSync(target).isDirectory()) return [];
        return [mountOf(target, false)];
      } catch {
        return [];
      }
    });
}

export function boxSpecFor({ request, accountPath }: { request: TurnRequest; accountPath: string | null }): BoxSpec {
  const { code } = request;
  const mounts = [
    mountOf(botWorkDirOf(request), false),
    ...(accountPath ? [mountOf(accountPath, false), ...linkedDirsOf(accountPath)] : []),
    ...(code ? [mountOf(code.cwd, code.readOnly === true)] : []),
    ...(existsSync(clisDir) ? [mountOf(clisDir, true)] : []),
    ...(existsSync(toolsDir) ? [mountOf(toolsDir, true)] : []),
  ];
  const unique = mounts.filter((mount, index) => mounts.findIndex(({ box }) => box === mount.box) === index);
  return { memMb: env.BOX_MEM_MB, cpus: env.BOX_CPUS, mounts: unique };
}
