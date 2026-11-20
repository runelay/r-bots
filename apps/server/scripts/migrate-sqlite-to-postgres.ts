import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { databaseSettings } from "../src/config/database";
import { openDatabase } from "../src/db";
import { importSqlite } from "../src/db/sqlite-import";

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const source =
  args.find((arg) => !arg.startsWith("--")) ??
  join(process.env.BOTS_DATA_DIR ?? join(homedir(), ".local", "share", "runelay-bots"), "runelay-bots.db");

if (!existsSync(source)) {
  console.error(`sqlite file not found: ${source}`);
  process.exit(1);
}

const sqlite = new Database(source, { readonly: true });
const db = await openDatabase({ settings: databaseSettings(process.env, "direct") });
try {
  const report = await importSqlite(sqlite, db, { replace });
  for (const item of report.tables) console.log(`${item.table.padEnd(24)} ${String(item.source).padStart(7)} → ${item.target}`);
  if (report.skipped.length) console.log(`not in sqlite: ${report.skipped.join(", ")}`);
  console.log(report.countsMatch ? "counts match" : "counts do not match");
  process.exitCode = report.countsMatch ? 0 : 1;
} finally {
  sqlite.close();
  await db.$client.close();
}
