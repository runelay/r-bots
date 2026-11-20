import type { Root } from "../src/db";
import { createDatabase, settingsFor } from "./postgres";

const opened: Root[] = [];

export async function freshDb(options: { migrate?: boolean } = {}) {
  const name = await createDatabase(options.migrate === false ? undefined : process.env.TEST_DATABASE_TEMPLATE);
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase({ migrate: false, settings: settingsFor(name) });
  opened.push(db);
  return db;
}

export function freshSettings(name: string) {
  return settingsFor(name);
}

export async function closeFreshDbs() {
  for (const db of opened.splice(0)) await db.$client.close();
}
