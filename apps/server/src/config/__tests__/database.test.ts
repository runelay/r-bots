import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseSettings, localDatabaseUrl, passwordFile } from "../database";

const dir = mkdtempSync(join(tmpdir(), "rb-dbconfig-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("database settings", () => {
  test("builds the local url from the compose defaults and the password file", () => {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "postgres.password"), "s3cr@t/x\n");
    const env = { BOTS_DATA_DIR: dir };
    expect(passwordFile(env)).toBe(join(dir, "secrets", "postgres.password"));
    expect(localDatabaseUrl(env)).toBe("postgres://runelay_bots:s3cr%40t%2Fx@127.0.0.1:5432/runelay_bots");
    expect(databaseSettings(env)).toEqual({
      url: "postgres://runelay_bots:s3cr%40t%2Fx@127.0.0.1:5432/runelay_bots",
      local: true,
      prepare: true,
      tls: false,
      max: 10,
    });
    expect(
      localDatabaseUrl({
        POSTGRES_PASSWORD_FILE: join(dir, "secrets", "postgres.password"),
        POSTGRES_USER: "u",
        POSTGRES_HOST: "postgres",
        POSTGRES_PORT: "6543",
        POSTGRES_DB: "d",
      }),
    ).toBe("postgres://u:s3cr%40t%2Fx@postgres:6543/d");
    expect(() => localDatabaseUrl({ BOTS_DATA_DIR: join(dir, "none") })).toThrow("postgres password not found");
  });

  test("an external url turns on TLS, the pooler mode and the direct url", () => {
    const neon = {
      DATABASE_URL: "postgres://u:p@ep-x-pooler.sa-east-1.aws.neon.tech/db?sslmode=require&channel_binding=require",
      DATABASE_URL_UNPOOLED: "postgres://u:p@ep-x.sa-east-1.aws.neon.tech/db?sslmode=verify-full",
    };
    expect(databaseSettings(neon)).toEqual({
      url: "postgres://u:p@ep-x-pooler.sa-east-1.aws.neon.tech/db",
      local: false,
      prepare: false,
      tls: { rejectUnauthorized: false },
      max: 10,
    });
    expect(databaseSettings(neon, "direct")).toEqual({
      url: "postgres://u:p@ep-x.sa-east-1.aws.neon.tech/db",
      local: false,
      prepare: true,
      tls: { rejectUnauthorized: true },
      max: 2,
    });
    const single = { DATABASE_URL: "postgres://u:p@db.example.com/db?pgbouncer=true&sslmode=prefer" };
    expect(databaseSettings(single, "direct")).toMatchObject({ prepare: false, tls: false });
    expect(databaseSettings({ DATABASE_URL: "postgres://u:p@db.example.com/db?prepare=false" }).prepare).toBe(false);
    expect(databaseSettings({ ...single, DATABASE_PREPARE: "on", DATABASE_POOL_MAX: "4" })).toMatchObject({
      prepare: true,
      max: 4,
    });
    expect(databaseSettings({ DATABASE_URL: "postgres://u:p@localhost/db", DATABASE_PREPARE: "off" })).toMatchObject({
      local: true,
      prepare: false,
    });
  });
});
