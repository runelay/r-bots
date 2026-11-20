import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Cron } from "croner";
import { type DatabaseSettings, databaseSettings } from "../../../config/database";
import { dataDir } from "../../../config/env";
import { backupDir, backupKeepDays } from "../../../config/storage";
import type { BlobStore } from "./blob-store";
import { getBlobStore } from "./storage.service";

const dayMs = 24 * 3600_000;
const snapshotPattern = /^\d{4}-\d{2}-\d{2}$/;

export interface BackupOptions {
  database?: DatabaseSettings;
  pgDump?: string;
  store?: BlobStore;
  dir?: string;
  keepDays?: number;
  voiceDir?: string;
  now?: Date;
  ageRecipient?: string | null;
  ageBin?: string;
}

export interface BackupReport {
  snapshot: string | null;
  blobsCopied: number;
  blobsKept: number;
  blobsRetired: number;
  snapshotsPruned: number;
  voiceFilesRemoved: number;
}

export class BackupEncryptionUnavailable extends Error {}

function spawnPrivate(command: string[], env: Record<string, string | undefined> = { ...process.env }) {
  const previous = process.umask(0o077);
  try {
    return Bun.spawn(command, { env, stdout: "ignore", stderr: "pipe" });
  } finally {
    process.umask(previous);
  }
}

async function privateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function encryptFile(source: string, target: string, recipient: string, ageBin = "age") {
  const child = spawnPrivate([ageBin, "-r", recipient, "-o", target, source]);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    await rm(target, { force: true });
    throw new Error(`age exited ${code}: ${stderr.trim().slice(0, 300)}`);
  }
  await chmod(target, 0o600);
}

export function ensureAge(recipient: string | null | undefined, ageBin = "age") {
  if (!recipient) return null;
  if (!Bun.which(ageBin))
    throw new BackupEncryptionUnavailable(
      `BOTS_BACKUP_AGE_RECIPIENT is set but the ${ageBin} binary is missing: refusing to write an unencrypted backup`,
    );
  return recipient;
}

export async function snapshotDatabase(
  database: DatabaseSettings,
  dir: string,
  now: Date,
  pgDump = "pg_dump",
  age: { recipient: string | null; bin?: string } = { recipient: null },
) {
  const day = now.toISOString().slice(0, 10);
  const folder = join(dir, "db", day);
  await privateDir(join(dir, "db"));
  await privateDir(folder);
  const target = join(folder, age.recipient ? "runelay-bots.dump.age" : "runelay-bots.dump");
  const temp = join(folder, "runelay-bots.dump.partial");
  await rm(temp, { force: true });
  const url = new URL(database.url);
  const password = decodeURIComponent(url.password);
  url.password = "";
  const child = spawnPrivate(
    [pgDump, "--format=custom", "--compress=6", "--no-owner", `--file=${temp}`, url.toString()],
    { ...process.env, PGPASSWORD: password, ...(database.tls ? { PGSSLMODE: "require" } : {}) },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    await rm(temp, { force: true });
    throw new Error(`pg_dump exited ${code}: ${stderr.trim().slice(0, 300)}`);
  }
  await chmod(temp, 0o600);
  if (age.recipient) {
    try {
      await encryptFile(temp, `${target}.tmp`, age.recipient, age.bin);
    } finally {
      await rm(temp, { force: true });
    }
    await rename(`${target}.tmp`, target);
  } else {
    await rename(temp, target);
  }
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
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await Bun.write(`${target}.tmp`, new Response(body));
    await chmod(`${target}.tmp`, 0o600);
    await rename(`${target}.tmp`, target);
    copied++;
  }
  let retired = 0;
  const day = now.toISOString().slice(0, 10);
  for (const key of await filesUnder(mirror)) {
    if (present.has(key) || key.endsWith(".tmp")) continue;
    const target = join(dir, "blobs-deleted", day, ...key.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
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
  await privateDir(dir);
  const ageBin = options.ageBin ?? "age";
  const recipient = ensureAge(
    options.ageRecipient === undefined ? process.env.BOTS_BACKUP_AGE_RECIPIENT?.trim() : options.ageRecipient,
    ageBin,
  );
  const database = options.database ?? databaseSettings(process.env, "direct");
  const snapshot = database.local
    ? await snapshotDatabase(database, dir, now, options.pgDump ?? process.env.PG_DUMP_BIN ?? "pg_dump", {
        recipient,
        bin: ageBin,
      })
    : null;
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
  if (!databaseSettings(process.env, "direct").local)
    console.log("database is external: pg_dump backup is off, the provider keeps the database backups");
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
