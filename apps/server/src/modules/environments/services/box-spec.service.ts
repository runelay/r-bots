import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { BoxSpec, TurnRequest } from "@runelay-bots/protocol";
import { botDir, clisDir, dataDir, env, hostDataDir, hostHome, hostToolsDir, toolsDir } from "../../../config/env";
import { boxHome, boxToolCredentials, boxToolHome } from "../constants/environments.constants";
import { containsPath } from "./placement.service";

type Mount = BoxSpec["mounts"][number];

export function hostPathOf(path: string) {
  if (containsPath(dataDir, path)) return `${hostDataDir}${path.slice(dataDir.replace(/\/$/, "").length)}`;
  if (containsPath(toolsDir, path)) return `${hostToolsDir}${path.slice(toolsDir.replace(/\/$/, "").length)}`;
  if (containsPath(boxHome, path)) return `${hostHome}${path.slice(boxHome.length)}`;
  return path;
}

function hostTextOf(text: string) {
  const base = dataDir.replace(/\/$/, "");
  const pattern = new RegExp(`(^|[\\s"'\`(=:])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`, "gm");
  return text.replace(pattern, `$1${hostDataDir}`);
}

export function hostTurnOf(request: TurnRequest): TurnRequest {
  const { code, configDir, images } = request;
  return {
    ...request,
    systemPrompt: hostTextOf(request.systemPrompt),
    prompt: hostTextOf(request.prompt),
    ...(images ? { images: images.map((image) => ({ ...image, path: hostPathOf(image.path) })) } : {}),
    ...(code ? { code: { ...code, cwd: hostPathOf(code.cwd) } } : {}),
    ...(configDir ? { configDir: hostPathOf(configDir) } : {}),
  };
}

export function hostBoxSpec(): BoxSpec {
  return { memMb: env.BOX_MEM_MB, cpus: env.BOX_CPUS, mounts: [] };
}

export function workDirOf({ workKey }: Pick<TurnRequest, "workKey">) {
  return join(dataDir, "work", workKey.replace(/[^\w/-]/g, "_"));
}

function botIdOf({ workKey }: Pick<TurnRequest, "workKey">) {
  const [botId = ""] = workKey.split("/");
  return botId.replace(/[^\w-]/g, "_");
}

function botWorkDirOf(request: Pick<TurnRequest, "workKey">) {
  return join(dataDir, "work", botIdOf(request));
}

function mountOf(path: string, readOnly: boolean): Mount {
  return { host: hostPathOf(path), box: path, readOnly };
}

function gitCommonDirOf(worktree: string) {
  try {
    const pointer = readFileSync(join(worktree, ".git"), "utf8")
      .match(/^gitdir:\s*(.+)$/m)?.[1]
      ?.trim();
    if (!pointer) return null;
    const gitDir = isAbsolute(pointer) ? pointer : resolve(worktree, pointer);
    if (basename(dirname(gitDir)) !== "worktrees") return null;
    const common = dirname(dirname(gitDir));
    return statSync(common).isDirectory() ? common : null;
  } catch {
    return null;
  }
}

export function toolCredentialMounts(home = boxHome): Mount[] {
  return boxToolCredentials
    .filter(({ path }) => existsSync(join(home, path)))
    .map(({ path, box, readOnly }) => ({
      host: hostPathOf(join(home, path)),
      box: join(boxToolHome, box),
      readOnly,
      optional: true,
    }));
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
  const uploads = join(botDir(botIdOf(request)), "uploads");
  const locks = join(dataDir, "locks");
  const gitCommon = code ? gitCommonDirOf(code.cwd) : null;
  if (code) mkdirSync(locks, { recursive: true, mode: 0o700 });
  const mounts: Mount[] = [
    mountOf(botWorkDirOf(request), false),
    ...(existsSync(uploads) ? [mountOf(uploads, true)] : []),
    ...(accountPath ? [mountOf(accountPath, false), ...linkedDirsOf(accountPath)] : []),
    ...(code ? [mountOf(code.cwd, code.readOnly === true)] : []),
    ...(gitCommon ? [{ ...mountOf(gitCommon, code?.readOnly === true), optional: true }] : []),
    ...(code ? [mountOf(locks, false)] : []),
    ...(existsSync(clisDir) ? [mountOf(clisDir, true)] : []),
    ...(existsSync(toolsDir) ? [mountOf(toolsDir, true)] : []),
    ...toolCredentialMounts(),
  ];
  const unique = mounts.filter((mount, index) => mounts.findIndex(({ box }) => box === mount.box) === index);
  return { memMb: env.BOX_MEM_MB, cpus: env.BOX_CPUS, mounts: unique };
}
