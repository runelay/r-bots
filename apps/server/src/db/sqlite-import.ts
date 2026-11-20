import type { Database } from "bun:sqlite";
import { getTableColumns, type SQL, sql } from "drizzle-orm";
import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import { queryRows, type Root } from "./client";
import * as auth from "./schema/auth";
import * as tables from "./tables";

type Row = Record<string, unknown>;
type Writer = Parameters<Parameters<Root["transaction"]>[0]>[0];

export interface TableReport {
  table: string;
  source: number;
  target: number;
}

export interface ImportReport {
  tables: TableReport[];
  skipped: string[];
  countsMatch: boolean;
}

export interface ImportOptions {
  replace?: boolean;
  batch?: number;
}

export class ImportError extends Error {}

const nul = /\u0000/g;

export function allTables() {
  const seen = new Map<string, PgTable>();
  for (const value of [...Object.values(tables), ...Object.values(auth)])
    if (value instanceof PgTable) seen.set(getTableConfig(value).name, value);
  return [...seen.values()];
}

export function importOrder(list: PgTable[]) {
  const byName = new Map(list.map((table) => [getTableConfig(table).name, table]));
  const ordered: PgTable[] = [];
  const visiting = new Set<string>();
  const visit = (table: PgTable) => {
    const name = getTableConfig(table).name;
    if (ordered.includes(table) || visiting.has(name)) return;
    visiting.add(name);
    for (const key of getTableConfig(table).foreignKeys) {
      const parent = byName.get(getTableConfig(key.reference().foreignTable).name);
      if (parent && parent !== table) visit(parent);
    }
    ordered.push(table);
  };
  for (const table of list) visit(table);
  return ordered;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(nul, "�") : value;
}

export function convertValue(column: PgColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = column.getSQLType();
  if (type === "jsonb" || type === "json") {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed === null) return column.notNull ? sql`'null'::${sql.raw(type)}` : null;
    return parsed;
  }
  if (type.startsWith("timestamp")) {
    if (column.columnType === "PgTimestamp") return new Date(Number(value));
    return value === "" ? null : String(value);
  }
  if (type === "boolean") return Boolean(Number(value));
  if (type === "bytea") return Buffer.from(value as Uint8Array);
  if (type === "bigint" || type === "integer" || type === "double precision") return Number(value);
  return cleanText(String(value));
}

export function convertRow(table: PgTable, row: Row) {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (!(column.name in row)) continue;
    out[key] = convertValue(column, row[column.name]);
  }
  return out;
}

function sourceTables(sqlite: Database) {
  return new Set(
    sqlite
      .query<{ name: string }, []>("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => row.name),
  );
}

async function countOf(writer: Writer, name: string) {
  const [row] = await queryRows<{ count: number }>(
    sql`select count(*)::int as count from ${sql.identifier(name)}`,
    writer,
  );
  return Number(row?.count ?? 0);
}

async function resetIdentity(writer: Writer, table: PgTable) {
  const name = getTableConfig(table).name;
  for (const column of Object.values(getTableColumns(table))) {
    if (!(column as PgColumn & { generatedIdentity?: unknown }).generatedIdentity) continue;
    const query: SQL = sql`select setval(pg_get_serial_sequence(${name}, ${column.name}), coalesce((select max(${sql.identifier(column.name)}) from ${sql.identifier(name)}), 0) + 1, false)`;
    await writer.execute(query);
  }
}

export async function importSqlite(sqlite: Database, db: Root, options: ImportOptions = {}): Promise<ImportReport> {
  const batch = options.batch ?? 500;
  const present = sourceTables(sqlite);
  const ordered = importOrder(allTables());
  const wanted = ordered.filter((table) => present.has(getTableConfig(table).name));
  const skipped = ordered.filter((table) => !wanted.includes(table)).map((table) => getTableConfig(table).name);
  return db.transaction(async (writer) => {
    if (!options.replace) {
      for (const table of wanted) {
        const name = getTableConfig(table).name;
        if ((await countOf(writer, name)) > 0)
          throw new ImportError(`postgres already has rows in ${name}: run again with --replace to overwrite them`);
      }
    }
    if (wanted.length)
      await writer.execute(
        sql`truncate ${sql.join(
          wanted.map((table) => sql.identifier(getTableConfig(table).name)),
          sql`, `,
        )} restart identity cascade`,
      );
    const report: TableReport[] = [];
    for (const table of wanted) {
      const name = getTableConfig(table).name;
      const rows = sqlite.query<Row, []>(`select * from "${name}"`).all();
      for (let start = 0; start < rows.length; start += batch) {
        const values = rows.slice(start, start + batch).map((row) => convertRow(table, row));
        await writer.insert(table).values(values as never);
      }
      await resetIdentity(writer, table);
      report.push({ table: name, source: rows.length, target: await countOf(writer, name) });
    }
    return { tables: report, skipped, countsMatch: report.every((item) => item.source === item.target) };
  });
}
