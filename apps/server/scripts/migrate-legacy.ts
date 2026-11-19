import { join } from "node:path";
import { dataDir, repoDir } from "../src/config/env";
import { dbFile } from "../src/config/storage";
import { closeDb, openDatabase } from "../src/db";
import { importLegacy, type LegacyCounts } from "../src/db/legacy-import";
import { createBlobStore } from "../src/modules/storage/services/storage.service";

const legacyDir = process.argv[2] ?? process.env.BOTS_LEGACY_DIR ?? join(repoDir, "data");
const target = process.argv[3] ?? dbFile;

function table(before: LegacyCounts, after: LegacyCounts) {
  const keys = (Object.keys(before) as (keyof LegacyCounts)[]).filter((key) => key !== "eventsBySession");
  const rows = keys.map((key) => [key, String(before[key]), String(after[key]), before[key] === after[key] ? "ok" : "DIFF"]);
  const sessions = Object.keys(before.eventsBySession);
  const sessionsOk = sessions.filter((id) => before.eventsBySession[id] === (after.eventsBySession[id] ?? 0)).length;
  rows.push(["sessions with all events", String(sessions.length), String(sessionsOk), sessionsOk === sessions.length ? "ok" : "DIFF"]);
  const widths = [0, 1, 2, 3].map((column) => Math.max(...[["", "before", "after", ""], ...rows].map((row) => row[column]!.length)));
  const line = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
  return [line(["", "before", "after", ""]), ...rows.map(line)].join("\n");
}

console.log(`legacy: ${legacyDir}`);
console.log(`database: ${target}`);
const db = openDatabase(target);
const store = createBlobStore();
console.log(`data dir: ${dataDir}`);
console.log(`blob driver: ${store.driver}`);
const started = performance.now();
const report = await importLegacy(db, store, legacyDir, { targetDataDir: dataDir });
closeDb();
db.$client.close();
console.log(table(report.before, report.after));
console.log(`files copied to disk: ${report.copiedFiles}`);
console.log(`took ${Math.round(performance.now() - started)}ms`);
if (report.mismatches.length) {
  console.error(`mismatches:\n${report.mismatches.map((item) => `  ${item}`).join("\n")}`);
  process.exit(1);
}
console.log("counts match");
