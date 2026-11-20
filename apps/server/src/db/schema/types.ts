import { type SQL, sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

const nulEscape = /(?<!\\)((?:\\\\)*)\\u0000/g;

export function jsonText(value: unknown) {
  return JSON.stringify(value).replace(nulEscape, "$1\\ufffd");
}

export function isoOf(value: string | Date) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export const jsonb = <T>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (value): SQL => sql`${jsonText(value)}::text::jsonb`,
    fromDriver: (value) => value as T,
  })(name);

export const json = <T>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "json",
    toDriver: (value): SQL => sql`${JSON.stringify(value)}::text::json`,
    fromDriver: (value) => value as T,
  })(name);

export const timestamptz = (name: string) =>
  customType<{ data: string; driverData: string | Date }>({
    dataType: () => "timestamp (3) with time zone",
    toDriver: (value) => value,
    fromDriver: isoOf,
  })(name);
