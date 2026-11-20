import { SQL } from "bun";
import type { DatabaseSettings } from "../src/config/database";

export const testServerUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://runelay_bots:runelay_bots@127.0.0.1:55432/runelay_bots";

const suffix = `${process.pid}_${Date.now().toString(36)}`;
export const templateName = `rb_tpl_${suffix}`;
const created: string[] = [];
let counter = 0;

export function urlFor(name: string) {
  const url = new URL(testServerUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export function settingsFor(name: string): DatabaseSettings {
  return { url: urlFor(name), local: true, prepare: true, tls: false, max: 4 };
}

async function admin<T>(run: (sql: SQL) => Promise<T>) {
  const sql = new SQL({ url: testServerUrl, max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.close();
  }
}

export async function createDatabase(template?: string) {
  const name = `rb_test_${suffix}_${counter++}`;
  await admin((sql) =>
    sql.unsafe(template ? `create database "${name}" template "${template}"` : `create database "${name}"`),
  );
  created.push(name);
  return name;
}

export async function createTemplate() {
  await admin((sql) => sql.unsafe(`create database "${templateName}"`));
  created.push(templateName);
  return templateName;
}

export async function dropDatabases() {
  await admin(async (sql) => {
    for (const name of created.splice(0).reverse()) await sql.unsafe(`drop database if exists "${name}" with (force)`);
  });
}
