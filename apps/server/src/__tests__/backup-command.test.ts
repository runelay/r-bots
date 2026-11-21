import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBackupCommand } from "../backup-command";
import type { BackupReport } from "../modules/storage/services/backup.service";

const report: BackupReport = {
  snapshot: "/backups/db/2026-11-21/runelay-bots.dump",
  blobsCopied: 1,
  blobsKept: 0,
  blobsRetired: 0,
  snapshotsPruned: 0,
  voiceFilesRemoved: 0,
};

const root = mkdtempSync(join(tmpdir(), "rb-backup-command-"));
const entry = resolve(import.meta.dirname, "..", "index.ts");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function collector() {
  const lines: string[] = [];
  return { lines, push: (line: string) => lines.push(line) };
}

describe("backup command", () => {
  test("prints the snapshot path and exits 0", async () => {
    const out = collector();
    const err = collector();
    expect(await runBackupCommand({ run: async () => report, log: out.push, warn: err.push })).toBe(0);
    expect(out.lines).toEqual([report.snapshot ?? ""]);
    expect(err.lines).toEqual([]);
  });

  test("an external database has no snapshot and still exits 0", async () => {
    const out = collector();
    const err = collector();
    const code = await runBackupCommand({
      run: async () => ({ ...report, snapshot: null }),
      log: out.push,
      warn: err.push,
    });
    expect(code).toBe(0);
    expect(out.lines).toEqual([]);
    expect(err.lines[0]).toContain("banco é externo");
  });

  test("a failed backup exits 1 with the reason", async () => {
    const err = collector();
    const failing = async (): Promise<BackupReport> => {
      throw new Error("pg_dump exited 1: boom");
    };
    expect(await runBackupCommand({ run: failing, warn: err.push })).toBe(1);
    expect(err.lines).toEqual(["backup falhou: pg_dump exited 1: boom"]);
    const raw = async (): Promise<BackupReport> => Promise.reject("sem disco");
    expect(await runBackupCommand({ run: raw, warn: err.push })).toBe(1);
    expect(err.lines.at(-1)).toBe("backup falhou: sem disco");
  });

  test("writes to the console by default", async () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runBackupCommand({ run: async () => report });
      await runBackupCommand({ run: async () => ({ ...report, snapshot: null }) });
      expect(log).toHaveBeenCalledWith(report.snapshot);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe("backup subcommand of the server entry", () => {
  const cases: string[] = [];

  afterEach(() => {
    for (const dir of cases.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakePgDump(dir: string, exitCode: number) {
    const bin = join(dir, "pg_dump");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `if [ ${exitCode} -ne 0 ]; then echo "conexão recusada" >&2; exit ${exitCode}; fi`,
        `for arg in "$@"; do case "$arg" in --file=*) printf dump > "\${arg#--file=}";; esac; done`,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  async function runEntry(exitCode: number) {
    const dir = mkdtempSync(join(root, "case-"));
    cases.push(dir);
    const dataDir = join(dir, "data");
    const blobsDir = join(dir, "blobs");
    mkdirSync(join(blobsDir, "bots", "b1"), { recursive: true });
    writeFileSync(join(blobsDir, "bots", "b1", "file.txt"), "blob");
    const env: Record<string, string | undefined> = {
      ...process.env,
      BOTS_DATA_DIR: dataDir,
      BOTS_BACKUP_DIR: join(dir, "backups"),
      BLOB_DRIVER: "fs",
      BLOB_FS_DIR: blobsDir,
      DATABASE_URL: "postgres://rb:segredo@127.0.0.1:9/rb",
      PG_DUMP_BIN: fakePgDump(dir, exitCode),
      GATEWAY_PORT: "9",
    };
    delete env.DATABASE_URL_UNPOOLED;
    delete env.BOTS_BACKUP_AGE_RECIPIENT;
    const child = Bun.spawn([process.execPath, entry, "backup"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, dir, dataDir };
  }

  test("runs the backup, prints the snapshot and exits without booting the server", async () => {
    const result = await runEntry(0);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const snapshot = result.stdout.trim();
    expect(snapshot).toMatch(/backups\/db\/\d{4}-\d{2}-\d{2}\/runelay-bots\.dump$/);
    expect(readFileSync(snapshot, "utf8")).toBe("dump");
    expect(readFileSync(join(result.dir, "backups", "blobs", "bots", "b1", "file.txt"), "utf8")).toBe("blob");
    expect(existsSync(join(result.dataDir, "runner.token"))).toBe(false);
    expect(result.stdout).not.toContain("r/bots");
  }, 30_000);

  test("exits 1 when the backup fails", async () => {
    const result = await runEntry(3);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("backup falhou: pg_dump exited 3: conexão recusada");
    expect(result.stderr).not.toContain("segredo");
  }, 30_000);
});
