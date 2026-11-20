import { constants } from "node:fs";
import { type FileHandle, open, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { botDir, botsDir, dataDir } from "../../../config/env";
import { botWorktreePaths } from "../repositories/uploads.repository";

export class SendFileError extends Error {}

export function outboxDir(botId: string) {
  return join(botDir(botId), "outbox");
}

export function exportsTmpDir(botId: string) {
  return join(tmpdir(), "runelay-exports", botId);
}

const protectedPart = /(^|\/)(\.env[^/]*|\.git|\.ssh|\.claude|\.codex|\.aws|\.gnupg|\.npmrc|\.netrc)(\/|$)/;
const dataSecrets = [
  "secrets",
  "postgres",
  "redis",
  "storage",
  "blobs",
  "runner.token",
  "auth.secret",
  "setup.token",
  "integrations.key",
];

function inside(path: string, root: string) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function real(path: string) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function deniedRoots(botId: string) {
  const data = await real(dataDir);
  const bots = await real(botsDir);
  const own = await real(botDir(botId));
  const backups = process.env.BOTS_BACKUP_DIR ? [await real(process.env.BOTS_BACKUP_DIR)] : [];
  return {
    data,
    bots,
    own,
    fixed: ["/backups", "/run", "/proc", "/sys", "/dev", ...backups, ...dataSecrets.map((name) => join(data, name))],
  };
}

export async function isDenied(botId: string, path: string) {
  if (protectedPart.test(path)) return true;
  const roots = await deniedRoots(botId);
  if (roots.fixed.some((root) => inside(path, root))) return true;
  if (path.startsWith(`${roots.data}${sep}vault.`)) return true;
  return inside(path, roots.bots) && !inside(path, roots.own);
}

export async function allowedRoots(botId: string) {
  const own = botDir(botId);
  const roots = [
    outboxDir(botId),
    join(own, "uploads"),
    join(own, "browser"),
    join(own, "desktop"),
    exportsTmpDir(botId),
  ];
  roots.push(...(await botWorktreePaths(botId)));
  return Promise.all(roots.map(real));
}

export function lexicallyInOutbox(botId: string, rawPath: string) {
  return inside(resolve(rawPath), resolve(outboxDir(botId)));
}

const macRoots = /^(?:~|\/Users\/[^/]+)\/(?:Downloads|Desktop|Documents)\/[^/]|^\/(?:private\/)?tmp\/[^/]/;

export function macPathAllowed(rawPath: string) {
  if (!macRoots.test(rawPath)) return false;
  return !rawPath.split("/").some((part) => part === ".." || part === ".") && !protectedPart.test(rawPath);
}

export interface ConfinedFile {
  handle: FileHandle;
  path: string;
  size: number;
}

async function fdPath(handle: FileHandle) {
  try {
    return await readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    throw new SendFileError("Não consegui conferir onde o arquivo está.");
  }
}

export async function openConfined(botId: string, rawPath: string): Promise<ConfinedFile | null> {
  let handle: FileHandle;
  try {
    handle = await open(resolve(rawPath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new SendFileError("Esse caminho é um atalho (symlink). Mande o arquivo de verdade.");
    throw new SendFileError(`Não consegui abrir ${rawPath}.`);
  }
  try {
    const path = await fdPath(handle);
    const info = await handle.stat();
    if (!info.isFile()) throw new SendFileError("Isso não é um arquivo.");
    if (await isDenied(botId, path)) throw new SendFileError("Esse arquivo é protegido.");
    if (lexicallyInOutbox(botId, rawPath)) {
      if (!inside(path, await real(outboxDir(botId))))
        throw new SendFileError("O arquivo saiu da pasta de saída do bot por um atalho.");
    } else if (!(await allowedRoots(botId)).some((root) => inside(path, root))) {
      throw new SendFileError(
        `${path} está fora das pastas que posso enviar: a pasta de saída do bot (${outboxDir(botId)}), os anexos e prints dele, os worktrees abertos por ele ou ${exportsTmpDir(botId)}.`,
      );
    }
    return { handle, path, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
