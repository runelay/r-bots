import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rb-backup-"));
const { openDatabase, tables } = await import("../../../db");
const { FsBlobStore } = await import("../services/fs-blob-store");
const backup = await import("../services/backup.service");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("backup", () => {
  test("snapshots the db, mirrors blobs, prunes and cleans voice work", async () => {
    const db = openDatabase(join(dir, "source.db"));
    db.insert(tables.settings).values({ key: "k", value: 1, updatedAt: "t" }).run();
    const store = new FsBlobStore(join(dir, "blobs"));
    await store.put("a/one.txt", "one");
    await store.put("two.txt", "two");
    const target = join(dir, "backup");
    mkdirSync(join(target, "db", "2026-01-01"), { recursive: true });
    mkdirSync(join(target, "db", "not-a-day"), { recursive: true });
    const voiceDir = join(dir, "voice");
    mkdirSync(voiceDir, { recursive: true });
    writeFileSync(join(voiceDir, "old.wav"), "x");
    writeFileSync(join(voiceDir, "new.wav"), "x");
    const old = new Date("2026-11-17T00:00:00Z");
    utimesSync(join(voiceDir, "old.wav"), old, old);
    const now = new Date("2026-11-19T12:00:00Z");

    const first = await backup.runBackup({ db, store, dir: target, voiceDir, now, keepDays: 7 });
    expect(first).toMatchObject({
      blobsCopied: 2,
      blobsKept: 0,
      blobsRetired: 0,
      snapshotsPruned: 1,
      voiceFilesRemoved: 1,
    });
    const copy = openDatabase(first.snapshot, { readonly: true });
    expect(copy.select().from(tables.settings).all()).toHaveLength(1);
    copy.$client.close();
    expect(existsSync(join(target, "db", "not-a-day"))).toBe(true);

    await store.delete("two.txt");
    await store.put("a/one.txt", "changed");
    const second = await backup.runBackup({ db, store, dir: target, voiceDir, now });
    expect(second).toMatchObject({ blobsCopied: 1, blobsKept: 0, blobsRetired: 1, voiceFilesRemoved: 0 });
    expect(existsSync(join(target, "blobs-deleted", "2026-11-19", "two.txt"))).toBe(true);
    const third = await backup.runBackup({ db, store, dir: target, voiceDir, now });
    expect(third).toMatchObject({ blobsCopied: 0, blobsKept: 1 });
    db.$client.close();
  });

  test("skips blobs that vanish while syncing", async () => {
    const store = new FsBlobStore(join(dir, "vanish"));
    await store.put("gone.txt", "x");
    const flaky = Object.assign(Object.create(store), { get: async () => null });
    expect(await backup.syncBlobs(flaky, join(dir, "vanish-backup"), new Date())).toEqual({
      copied: 0,
      kept: 0,
      retired: 0,
    });
  });

  test("schedules and reports", async () => {
    const db = openDatabase(":memory:");
    const store = new FsBlobStore(join(dir, "scheduled"));
    const options = { db, store, dir: join(dir, "scheduled-backup"), voiceDir: join(dir, "none") };
    const logs: unknown[] = [];
    const errors: unknown[] = [];
    const original = { log: console.log, error: console.error };
    console.log = (...args: unknown[]) => logs.push(args[0]);
    console.error = (...args: unknown[]) => errors.push(args[0]);
    const job = backup.startBackupSchedule("0 0 1 1 *", options);
    expect(job?.nextRun()).toBeInstanceOf(Date);
    job?.trigger();
    await Bun.sleep(50);
    expect(String(logs[0])).toStartWith("backup ok");
    writeFileSync(join(dir, "blocked"), "file");
    expect(await backup.scheduledBackup({ ...options, dir: join(dir, "blocked") })).toBeNull();
    expect(errors).toContain("backup failed");
    console.log = original.log;
    console.error = original.error;
    process.env.BOTS_BACKUP = "off";
    expect(backup.startBackupSchedule()).toBeNull();
    delete process.env.BOTS_BACKUP;
    backup.stopBackupSchedule();
    backup.stopBackupSchedule();
  });
});
