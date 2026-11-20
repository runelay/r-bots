import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSecretValue } from "../../shared/redact";
import { readSecretFile, redisSettings } from "../redis";

const dir = mkdtempSync(join(tmpdir(), "rb-redis-config-"));

afterAll(() => {
  forgetSecretValue("REDIS_PASSWORD");
});

describe("redisSettings", () => {
  test("defaults to the local redis and the password file in the data dir", () => {
    const data = join(dir, "data");
    writeFileSync(join(dir, "empty"), "  \n");
    expect(redisSettings({ BOTS_DATA_DIR: data })).toEqual({ host: "127.0.0.1", port: 6379, db: 0, tls: false });
    expect(readSecretFile(join(dir, "empty"))).toBeUndefined();
    expect(readSecretFile(join(dir, "nada"))).toBeUndefined();
  });

  test("reads the password from the file, the url or the variable", () => {
    const file = join(dir, "redis.password");
    writeFileSync(file, "segredo-do-arquivo\n");
    expect(redisSettings({ REDIS_URL: "redis://10.0.0.2:7000/2", REDIS_PASSWORD_FILE: file })).toEqual({
      host: "10.0.0.2",
      port: 7000,
      db: 2,
      password: "segredo-do-arquivo",
      tls: false,
    });
    expect(redisSettings({ REDIS_URL: "rediss://fila:s%40nha@redis.example:6380" })).toEqual({
      host: "redis.example",
      port: 6380,
      db: 0,
      username: "fila",
      password: "s@nha",
      tls: true,
    });
    expect(redisSettings({ REDIS_PASSWORD: "da-variavel", REDIS_PASSWORD_FILE: file }).password).toBe("da-variavel");
  });
});
