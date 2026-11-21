import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { checkHealth, healthCommand, writeBeat } from "../health";
import { tempDir } from "./helpers";

let temp: ReturnType<typeof tempDir>;

beforeEach(() => {
  temp = tempDir("rb-health-");
});

afterEach(() => temp.remove());

describe("health", () => {
  test("is healthy only while the beat is recent", () => {
    const file = `${temp.dir}/health`;
    expect(checkHealth(file, 1000)).toEqual({ ok: false, reason: "o runner ainda não falou com o servidor" });
    writeBeat(file, 1000);
    expect(checkHealth(file, 11_000)).toEqual({ ok: true, reason: "conectado (último aviso há 10 s)" });
    expect(checkHealth(file, 61_000)).toEqual({ ok: false, reason: "sem falar com o servidor há 60 s" });
    writeBeat(file, Number.NaN);
    expect(checkHealth(file, 1000).ok).toBe(false);
    writeBeat(`${temp.dir}/missing/health`);
  });

  test("writes the beat private and never through a symlink", () => {
    const file = `${temp.dir}/health`;
    writeBeat(file, 1000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const target = `${temp.dir}/target`;
    writeFileSync(target, "keep");
    const link = `${temp.dir}/link`;
    symlinkSync(target, link);
    writeBeat(link, 2000);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  test("the health command reads RBOTS_HEALTH_FILE and exits 0 or 1", () => {
    const file = `${temp.dir}/health`;
    const lines: string[] = [];
    expect(healthCommand({ RBOTS_HEALTH_FILE: file }, (line) => lines.push(line))).toBe(1);
    writeBeat(file);
    expect(healthCommand({ RBOTS_HEALTH_FILE: file }, (line) => lines.push(line))).toBe(0);
    expect(healthCommand({}, (line) => lines.push(line))).toBeOneOf([0, 1]);
    expect(lines[0]).toBe("o runner ainda não falou com o servidor");
    expect(lines[1]).toStartWith("conectado");
  });
});
