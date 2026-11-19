import { describe, expect, test } from "bun:test";
import { heavyKind, heavyLimits, wrapHeavyCommand } from "../services/heavy-commands.service";

async function runShell(script: string) {
  const child = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("heavyKind", () => {
  test("classifies test runners, heavy builds and everything else", () => {
    expect(heavyKind("bunx vitest run src")).toBe("test");
    expect(heavyKind("pnpm run test:unit")).toBe("test");
    expect(heavyKind("go test ./...")).toBe("test");
    expect(heavyKind("npx tsc --noEmit")).toBe("heavy");
    expect(heavyKind("pnpm run typecheck")).toBe("heavy");
    expect(heavyKind("cargo build")).toBe("heavy");
    expect(heavyKind("ls -la")).toBeNull();
  });

  test("never wraps anything outside linux", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(heavyKind("vitest")).toBeNull();
      expect(wrapHeavyCommand("vitest", "vitest")).toBeNull();
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("wrapHeavyCommand", () => {
  test("leaves light commands alone", () => {
    expect(wrapHeavyCommand("git status", "git status")).toBeNull();
  });

  test("heavy commands get a memory cap, nice and a timeout without the test lock", () => {
    const wrapped = wrapHeavyCommand("tsc -p .", "tsc -p 'it''s'") as string;
    expect(wrapped.startsWith("ulimit -c 0; env NODE_OPTIONS=")).toBe(true);
    expect(wrapped).toContain(`--max-old-space-size=${heavyLimits.memoryMb}`);
    expect(wrapped).toContain(`timeout -k 15s ${heavyLimits.timeoutMin}m bash -c `);
    expect(wrapped).not.toContain("flock");
    expect(wrapped).not.toContain("VITEST_MAX_WORKERS");
  });

  test("test suites run under the shared lock with limited workers", () => {
    const wrapped = wrapHeavyCommand("vitest run", "vitest run") as string;
    expect(wrapped).toContain(`flock -E 75 -w ${heavyLimits.testWaitSec} '${heavyLimits.lockFile}'`);
    expect(wrapped).toContain(`VITEST_MAX_WORKERS=${heavyLimits.workers}`);
    expect(wrapped).toContain(`JEST_WORKERS=${heavyLimits.workers}`);
  });

  test("the wrapped script keeps quoting and the exit code of the original command", async () => {
    const original = "bun test --bail";
    const final = 'echo "it\'s $VITEST_MAX_WORKERS"; exit 3';
    const wrapped = wrapHeavyCommand(original, final) as string;
    const result = await runShell(wrapped.replace(/nice -n 10 timeout -k 15s \d+m /, ""));
    expect(result.stdout.trim()).toBe(`it's ${heavyLimits.workers}`);
    expect(result.code).toBe(3);
  });
});
