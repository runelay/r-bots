import { runBackup } from "./modules/storage/services/backup.service";

interface BackupCommandDeps {
  run: typeof runBackup;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const defaults: BackupCommandDeps = {
  run: runBackup,
  log: (line) => console.log(line),
  warn: (line) => console.error(line),
};

export async function runBackupCommand(overrides: Partial<BackupCommandDeps> = {}) {
  const deps = { ...defaults, ...overrides };
  try {
    const report = await deps.run();
    if (report.snapshot) deps.log(report.snapshot);
    else deps.warn("sem snapshot do banco: o banco é externo e o provedor guarda os backups dele");
    return 0;
  } catch (error) {
    deps.warn(`backup falhou: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
