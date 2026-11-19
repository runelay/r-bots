import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Cron } from "croner";
import { dataDir } from "../../../config/env";
import { backupDir, backupKeepDays } from "../../../config/storage";
import { type Db, getDb } from "../../../db";
import type { BlobStore } from "./blob-store";
import { getBlobStore } from "./storage.service";

const dayMs = 24 * 3600_000;
const snapshotPattern = /^\d{4}-\d{2}-\d{2}$/;

export interface BackupOptions {
  db?: Db;
  store?: BlobStore;
  dir?: string;
  keepDays?: number;
  voiceDir?: string;
  now?: Date;
}

export interface BackupReport {
  snapshot: string;
  blobsCopied: number;
  blobsKept: number;
  blobsRetired: number;
  snapshotsPruned: number;
  voiceFilesRemoved: number;
}

export async function snapshotDatabase(db: Db, dir: string, now: Date) {
  const day = now.toISOString().slice(0, 10);
  const folder = join(dir, "db", day);
  await mkdir(folder, { recursive: true });
  const target = join(folder, "runelay-bots.db");
  const temp = `${target}.tmp`;
  await rm(temp, { force: true });
  db.$client.run("VACUUM INTO ?", [temp]);
  await rename(temp, target);
  return target;
}

async function filesUnder(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

export async function syncBlobs(store: BlobStore, dir: string, now: Date) {
  const mirror = join(dir, "blobs");
  const present = new Set<string>();
  let copied = 0;
  let kept = 0;
  for await (const head of store.list()) {
    present.add(head.key);
    const target = join(mirror, ...head.key.split("/"));
    const local = await stat(target).catch(() => null);
    if (local?.isFile() && local.size === head.size) {
      kept++;
      continue;
    }
    const body = await store.get(head.key);
    if (!body) continue;
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(`${target}.tmp`, new Response(body));
    await rename(`${target}.tmp`, target);
    copied++;
  }
  let retired = 0;
  const day = now.toISOString().slice(0, 10);
  for (const key of await filesUnder(mirror)) {
    if (present.has(key) || key.endsWith(".tmp")) continue;
    const target = join(dir, "blobs-deleted", day, ...key.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await rename(join(mirror, ...key.split("/")), target);
    retired++;
  }
  return { copied, kept, retired };
}

async function pruneDated(root: string, keepDays: number, now: Date) {
  const floor = now.getTime() - keepDays * dayMs;
  let pruned = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!snapshotPattern.test(name) || Date.parse(`${name}T00:00:00Z`) >= floor) continue;
    await rm(join(root, name), { recursive: true, force: true });
    pruned++;
  }
  return pruned;
}

export async function cleanVoiceWork(voiceDir: string, now: Date) {
  const floor = now.getTime() - dayMs;
  let removed = 0;
  for (const name of await readdir(voiceDir).catch(() => [] as string[])) {
    const path = join(voiceDir, name);
    if ((await stat(path)).mtimeMs >= floor) continue;
    await rm(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export async function runBackup(options: BackupOptions = {}): Promise<BackupReport> {
  const now = options.now ?? new Date();
  const dir = options.dir ?? backupDir;
  const keepDays = options.keepDays ?? backupKeepDays;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const snapshot = await snapshotDatabase(options.db ?? getDb(), dir, now);
  const blobs = await syncBlobs(options.store ?? getBlobStore(), dir, now);
  const snapshotsPruned =
    (await pruneDated(join(dir, "db"), keepDays, now)) + (await pruneDated(join(dir, "blobs-deleted"), keepDays, now));
  const voiceFilesRemoved = await cleanVoiceWork(options.voiceDir ?? join(dataDir, "work", "voice"), now);
  return {
    snapshot,
    blobsCopied: blobs.copied,
    blobsKept: blobs.kept,
    blobsRetired: blobs.retired,
    snapshotsPruned,
    voiceFilesRemoved,
  };
}

export async function scheduledBackup(options: BackupOptions = {}) {
  try {
    const report = await runBackup(options);
    console.log(`backup ok: ${JSON.stringify(report)}`);
    return report;
  } catch (error) {
    console.error("backup failed", error);
    return null;
  }
}

let job: Cron | null = null;

export function startBackupSchedule(
  pattern = process.env.BOTS_BACKUP_CRON ?? "30 4 * * *",
  options: BackupOptions = {},
) {
  if (process.env.BOTS_BACKUP === "off") return null;
  job?.stop();
  job = new Cron(
    pattern,
    { protect: true, name: "backup", timezone: process.env.TZ ?? "America/Sao_Paulo" },
    async () => {
      await scheduledBackup(options);
    },
  );
  return job;
}

export function stopBackupSchedule() {
  job?.stop();
  job = null;
}
