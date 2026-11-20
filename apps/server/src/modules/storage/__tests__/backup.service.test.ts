import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSettings } from "../../../config/database";

const dir = mkdtempSync(join(tmpdir(), "rb-backup-"));
const { FsBlobStore } = await import("../services/fs-blob-store");
const backup = await import("../services/backup.service");

const local: DatabaseSettings = {
  url: "postgres://runelay_bots:p%40ss@127.0.0.1:55432/runelay_bots",
  local: true,
  prepare: true,
  tls: false,
  max: 1,
};
const external: DatabaseSettings = {
  ...local,
  url: "postgres://u:p@db.example.com/x",
  local: false,
  tls: { rejectUnauthorized: false },
};

function fakeDump(name: string, code = 0) {
  const path = join(dir, name);
  const log = `${path}.log`;
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" "PGPASSWORD=$PGPASSWORD" "PGSSLMODE=$PGSSLMODE" > ${JSON.stringify(log)}\nfor arg in "$@"; do case "$arg" in --file=*) printf 'dump' > "\${arg#--file=}";; esac; done\n[ ${code} -eq 0 ] || echo 'connection refused' >&2\nexit ${code}\n`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
});

describe("backup", () => {
  test("dumps the database, mirrors blobs, prunes and cleans voice work", async () => {
    const dump = fakeDump("pg_dump");
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
    const options = { database: local, pgDump: dump.path, store, dir: target, voiceDir, now };

    const first = await backup.runBackup({ ...options, keepDays: 7 });
    expect(first).toMatchObject({
      snapshot: join(target, "db", "2026-11-19", "runelay-bots.dump"),
      blobsCopied: 2,
      blobsKept: 0,
      blobsRetired: 0,
      snapshotsPruned: 1,
      voiceFilesRemoved: 1,
    });
    expect(readFileSync(first.snapshot as string, "utf8")).toBe("dump");
    const args = readFileSync(dump.log, "utf8").trim().split("\n");
    expect(args).toContain("--format=custom");
    expect(args).toContain("--compress=6");
    expect(args).toContain("postgres://runelay_bots@127.0.0.1:55432/runelay_bots");
    expect(args).toContain("PGPASSWORD=p@ss");
    expect(args).toContain("PGSSLMODE=");
    expect(existsSync(join(target, "db", "not-a-day"))).toBe(true);

    await store.delete("two.txt");
    await store.put("a/one.txt", "changed");
    const second = await backup.runBackup(options);
    expect(second).toMatchObject({ blobsCopied: 1, blobsKept: 0, blobsRetired: 1, voiceFilesRemoved: 0 });
    expect(existsSync(join(target, "blobs-deleted", "2026-11-19", "two.txt"))).toBe(true);
    const third = await backup.runBackup(options);
    expect(third).toMatchObject({ blobsCopied: 0, blobsKept: 1 });
  });

  test("fails without leaving a partial dump and skips the dump for an external database", async () => {
    const broken = fakeDump("pg_dump_broken", 2);
    const now = new Date("2026-11-19T12:00:00Z");
    const target = join(dir, "broken-backup");
    await expect(
      backup.snapshotDatabase({ ...local, tls: { rejectUnauthorized: false } }, target, now, broken.path),
    ).rejects.toThrow("pg_dump exited 2: connection refused");
    expect(existsSync(join(target, "db", "2026-11-19", "runelay-bots.dump.partial"))).toBe(false);
    expect(readFileSync(broken.log, "utf8")).toContain("PGSSLMODE=require");
    const store = new FsBlobStore(join(dir, "external-blobs"));
    const report = await backup.runBackup({
      database: external,
      pgDump: broken.path,
      store,
      dir: join(dir, "external-backup"),
      voiceDir: join(dir, "none"),
      now,
    });
    expect(report.snapshot).toBeNull();
  });

  test("keeps the backup private and encrypts the dump with age when configured", async () => {
    const dump = fakeDump("pg_dump_private");
    const age = join(dir, "age");
    writeFileSync(
      age,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(`${age}.log`)}\nprintf 'age:' > "$4"\ncat "$5" >> "$4"\n`,
    );
    chmodSync(age, 0o755);
    const store = new FsBlobStore(join(dir, "private-blobs"));
    await store.put("doc.txt", "doc");
    const target = join(dir, "private-backup");
    const now = new Date("2026-11-19T12:00:00Z");
    const options = { database: local, pgDump: dump.path, store, dir: target, voiceDir: join(dir, "none"), now };
    const report = await backup.runBackup({ ...options, ageRecipient: "age1recipient", ageBin: age });
    expect(report.snapshot).toBe(join(target, "db", "2026-11-19", "runelay-bots.dump.age"));
    expect(readFileSync(report.snapshot as string, "utf8")).toBe("age:dump");
    expect(readFileSync(`${age}.log`, "utf8").split("\n").slice(0, 2)).toEqual(["-r", "age1recipient"]);
    expect(existsSync(join(target, "db", "2026-11-19", "runelay-bots.dump.partial"))).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, "db", "2026-11-19")).mode & 0o777).toBe(0o700);
    expect(statSync(report.snapshot as string).mode & 0o777).toBe(0o600);
    expect(statSync(join(target, "blobs", "doc.txt")).mode & 0o777).toBe(0o600);
    const plain = await backup.runBackup({ ...options, dir: join(dir, "plain-backup"), ageRecipient: null });
    expect(statSync(plain.snapshot as string).mode & 0o777).toBe(0o600);
  });

  test("refuses to back up without encryption when age is configured but missing or failing", async () => {
    const dump = fakeDump("pg_dump_noage");
    const options = {
      database: local,
      pgDump: dump.path,
      store: new FsBlobStore(join(dir, "noage-blobs")),
      dir: join(dir, "noage-backup"),
      voiceDir: join(dir, "none"),
      now: new Date("2026-11-19T12:00:00Z"),
    };
    process.env.BOTS_BACKUP_AGE_RECIPIENT = "age1recipient";
    try {
      await expect(backup.runBackup({ ...options, ageBin: join(dir, "no-age-here") })).rejects.toBeInstanceOf(
        backup.BackupEncryptionUnavailable,
      );
    } finally {
      delete process.env.BOTS_BACKUP_AGE_RECIPIENT;
    }
    const failing = join(dir, "age-failing");
    writeFileSync(failing, "#!/bin/sh\necho 'bad recipient' >&2\nexit 1\n");
    chmodSync(failing, 0o755);
    await expect(backup.runBackup({ ...options, ageRecipient: "age1bad", ageBin: failing })).rejects.toThrow(
      "age exited 1: bad recipient",
    );
    const day = join(options.dir, "db", "2026-11-19");
    expect(existsSync(join(day, "runelay-bots.dump.partial"))).toBe(false);
    expect(existsSync(join(day, "runelay-bots.dump.age.tmp"))).toBe(false);
    expect(existsSync(join(day, "runelay-bots.dump.age"))).toBe(false);
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
    const store = new FsBlobStore(join(dir, "scheduled"));
    const options = {
      database: local,
      pgDump: fakeDump("pg_dump_scheduled").path,
      store,
      dir: join(dir, "scheduled-backup"),
      voiceDir: join(dir, "none"),
    };
    const logs: unknown[] = [];
    const errors: unknown[] = [];
    const original = { log: console.log, error: console.error };
    console.log = (...args: unknown[]) => logs.push(args[0]);
    console.error = (...args: unknown[]) => errors.push(args[0]);
    const job = backup.startBackupSchedule("0 0 1 1 *", options);
    expect(job?.nextRun()).toBeInstanceOf(Date);
    job?.trigger();
    for (let attempt = 0; attempt < 400 && !logs.length; attempt++) await Bun.sleep(5);
    expect(String(logs[0])).toStartWith("backup ok");
    writeFileSync(join(dir, "blocked"), "file");
    expect(await backup.scheduledBackup({ ...options, dir: join(dir, "blocked") })).toBeNull();
    expect(errors).toContain("backup failed");
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://u:p@db.example.com/x?sslmode=require";
    backup.startBackupSchedule("0 0 1 1 *", options);
    process.env.DATABASE_URL = previous;
    expect(logs).toContain("database is external: pg_dump backup is off, the provider keeps the database backups");
    console.log = original.log;
    console.error = original.error;
    process.env.BOTS_BACKUP = "off";
    expect(backup.startBackupSchedule()).toBeNull();
    delete process.env.BOTS_BACKUP;
    backup.stopBackupSchedule();
    backup.stopBackupSchedule();
  });
});
