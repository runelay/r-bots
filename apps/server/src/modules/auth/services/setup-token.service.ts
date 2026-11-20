import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { rememberSecretValue } from "../../../shared/redact";
import { safeEqual } from "./accounts-access.service";

export const setupTokenHeader = "x-setup-token";

export function createSetupToken(file: string) {
  function read() {
    if (!existsSync(file)) return null;
    const value = readFileSync(file, "utf8").trim();
    return value.length >= 32 ? value : null;
  }

  function issue() {
    const existing = read();
    if (existing) {
      rememberSecretValue("setup-token", existing);
      return file;
    }
    const token = randomBytes(32).toString("base64url");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    rememberSecretValue("setup-token", token);
    return file;
  }

  function verify(given: unknown) {
    const expected = read();
    if (!expected || typeof given !== "string" || !given.trim()) return false;
    return safeEqual(given.trim(), expected);
  }

  function consume() {
    rmSync(file, { force: true });
  }

  return { file, issue, verify, consume, exists: () => read() !== null };
}

export type SetupToken = ReturnType<typeof createSetupToken>;
