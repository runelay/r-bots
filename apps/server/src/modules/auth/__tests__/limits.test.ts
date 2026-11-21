import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "../../../shared/redact";
import { createDeviceRequests, normalizeUserCode } from "../services/device-requests.service";
import { createAccountLockout, createWindowLimiter } from "../services/rate-limit.service";
import { createSetupToken } from "../services/setup-token.service";

const dir = mkdtempSync(join(tmpdir(), "rb-limits-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function readToken(path: string) {
  const fd = openSync(path, "r");
  try {
    return { mode: fstatSync(fd).mode & 0o777, value: readFileSync(fd, "utf8").trim() };
  } finally {
    closeSync(fd);
  }
}

describe("window limiter", () => {
  test("counts per key, resets after the window and evicts expired buckets", () => {
    const clock = { at: 0 };
    const limiter = createWindowLimiter(() => clock.at);
    const rule = { windowMs: 1000, max: 2 };
    expect(limiter.hit("a", rule)).toBeNull();
    expect(limiter.hit("a", rule)).toBeNull();
    expect(limiter.hit("a", rule)).toEqual({ retryAfter: 1 });
    expect(limiter.hit("b", rule)).toBeNull();
    clock.at = 1000;
    expect(limiter.hit("a", rule)).toBeNull();
    for (let index = 0; index < 5200; index++) limiter.hit(`k${index}`, rule);
    clock.at = 5000;
    limiter.hit("fresh", rule);
    expect(limiter.size()).toBe(1);
  });

  test("never grows past its cap", () => {
    const limiter = createWindowLimiter(() => 0);
    for (let index = 0; index < 10_050; index++) limiter.hit(`k${index}`, { windowMs: 60_000, max: 1 });
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
  });
});

describe("account lockout", () => {
  test("locks after repeated failures with growing backoff and clears on success", () => {
    const clock = { at: 0 };
    const lockout = createAccountLockout({ threshold: 3, baseLockMs: 1000, maxLockMs: 3000, now: () => clock.at });
    for (let index = 0; index < 2; index++) lockout.failed("Dona@Example.com");
    expect(lockout.locked("dona@example.com")).toBeNull();
    lockout.failed("dona@example.com");
    expect(lockout.locked(" DONA@example.com ")).toEqual({ retryAfter: 1 });
    clock.at = 1000;
    expect(lockout.locked("dona@example.com")).toBeNull();
    for (let index = 0; index < 3; index++) lockout.failed("dona@example.com");
    expect(lockout.locked("dona@example.com")).toEqual({ retryAfter: 2 });
    clock.at = 3000;
    for (let index = 0; index < 3; index++) lockout.failed("dona@example.com");
    clock.at = 3001;
    expect(lockout.locked("dona@example.com")).toEqual({ retryAfter: 3 });
    lockout.succeeded("dona@example.com");
    expect(lockout.locked("dona@example.com")).toBeNull();
  });

  test("forgets old failures outside the window and prunes idle accounts", () => {
    const clock = { at: 0 };
    const lockout = createAccountLockout({ threshold: 2, windowMs: 100, now: () => clock.at });
    lockout.failed("a@x.co");
    clock.at = 200;
    lockout.failed("a@x.co");
    expect(lockout.locked("a@x.co")).toBeNull();
    for (let index = 0; index < 5100; index++) lockout.failed(`u${index}@x.co`);
    clock.at = 10_000_000;
    lockout.failed("late@x.co");
    expect(lockout.size()).toBe(1);
    const defaults = createAccountLockout();
    for (let index = 0; index < 5; index++) defaults.failed("b@x.co");
    expect(defaults.locked("b@x.co")?.retryAfter).toBe(60);
  });

  test("never grows past its cap", () => {
    const lockout = createAccountLockout({ now: () => 0 });
    for (let index = 0; index < 10_050; index++) lockout.failed(`c${index}@x.co`);
    expect(lockout.size()).toBeLessThanOrEqual(10_000);
  });
});

describe("device requests", () => {
  test("remembers who asked for a code for ten minutes", () => {
    const clock = { at: Date.parse("2026-11-20T12:00:00.000Z") };
    const requests = createDeviceRequests(() => clock.at);
    requests.record("abcd-efgh", "runelay-bots-mac", "100.64.0.7");
    requests.record("ZZZZ", "other-client", "1.1.1.1");
    expect(normalizeUserCode("ab-cd ef")).toBe("ABCDEF");
    expect(requests.lookup("ABCDEFGH")).toEqual({
      clientName: "app r/bots para Mac",
      ip: "100.64.0.7",
      requestedAt: "2026-11-20T12:00:00.000Z",
    });
    expect(requests.lookup("zzzz")?.clientName).toBe("other-client");
    expect(requests.lookup("nope")).toBeNull();
    clock.at += 10 * 60_000;
    expect(requests.lookup("ABCDEFGH")).toBeNull();
    requests.record("NEW", "runelay-bots-mac", "x");
    expect(requests.size()).toBe(1);
    const capped = createDeviceRequests(() => 0);
    for (let index = 0; index < 2100; index++) capped.record(`C${index}`, "c", "ip");
    expect(capped.size()).toBeLessThanOrEqual(2000);
  });
});

describe("setup token", () => {
  test("is written once with mode 600, checked in constant time, redacted and deleted after use", () => {
    const file = join(dir, "nested", "setup.token");
    const token = createSetupToken(file);
    expect(token.exists()).toBe(false);
    expect(token.verify("anything")).toBe(false);
    expect(token.issue()).toBe(file);
    const { mode, value } = readToken(file);
    expect(mode).toBe(0o600);
    expect(value.length).toBeGreaterThanOrEqual(43);
    expect(token.issue()).toBe(file);
    expect(readToken(file).value).toBe(value);
    expect(redactText(`code ${value}`)).not.toContain(value);
    expect(token.verify(value)).toBe(true);
    expect(token.verify(` ${value} `)).toBe(true);
    expect(token.verify(`${value}x`)).toBe(false);
    expect(token.verify("")).toBe(false);
    expect(token.verify(42)).toBe(false);
    token.consume();
    expect(() => readToken(file)).toThrow();
    expect(token.verify(value)).toBe(false);
    writeFileSync(file, "short\n", { flag: "wx" });
    expect(token.exists()).toBe(false);
    token.issue();
    expect(readToken(file).value).not.toBe("short");
  });
});
