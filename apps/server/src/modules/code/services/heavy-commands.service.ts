import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../../../config/env";
import { shellQuote } from "./sandbox.service";

const testPattern =
  /\b(vitest|jest|mocha|ava|playwright\s+test|pytest|go\s+test|cargo\s+test|swift\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|npx\s+(?:vitest|jest|playwright))\b/;
const heavyPattern =
  /\b(tsc|vue-tsc|next\s+build|vite\s+build|turbo|nx\s+run|webpack|esbuild|rollup|eslint|biome|cargo\s+build|swift\s+build|gradle|mvn|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|type-check|lint|check)(?::\S+)?)\b/;

export const heavyLimits = {
  memoryMb: Number(process.env.CODE_HEAVY_MEMORY_MB ?? 2048),
  timeoutMin: Number(process.env.CODE_HEAVY_TIMEOUT_MIN ?? 20),
  testWaitSec: Number(process.env.CODE_TEST_WAIT_SEC ?? 100),
  workers: Number(process.env.CODE_TEST_WORKERS ?? 2),
  lockFile: process.env.CODE_TEST_LOCK ?? join(dataDir, "locks", "tests.lock"),
};

export function heavyKind(command: string): "test" | "heavy" | null {
  if (process.platform !== "linux") return null;
  if (testPattern.test(command)) return "test";
  if (heavyPattern.test(command)) return "heavy";
  return null;
}

export function heavyTimeoutSec(command: string) {
  return heavyKind(command) ? heavyLimits.timeoutMin * 60 + 30 : 0;
}

export function wrapHeavyCommand(
  original: string,
  finalCommand: string,
  outer?: (inner: string) => string,
  lockFile = heavyLimits.lockFile,
) {
  const kind = heavyKind(original);
  if (!kind) return null;
  const env = [
    `NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${heavyLimits.memoryMb}"`,
    kind === "test"
      ? `VITEST_MAX_WORKERS=${heavyLimits.workers} VITEST_MAX_THREADS=${heavyLimits.workers} VITEST_MAX_FORKS=${heavyLimits.workers} JEST_WORKERS=${heavyLimits.workers}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const inner = `ulimit -c 0; env ${env} nice -n 10 timeout -k 15s ${heavyLimits.timeoutMin}m bash -c ${shellQuote(finalCommand)}`;
  const run = outer ? outer(inner) : inner;
  if (kind === "heavy") return run;
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  const busy = shellQuote(
    "Outra suíte de testes ainda está rodando na VPS (só roda uma por vez). Tente de novo em alguns minutos.",
  );
  const locked = outer ? run : `bash -c ${shellQuote(run)}`;
  return `flock -E 75 -w ${heavyLimits.testWaitSec} ${shellQuote(lockFile)} ${locked}; rc=$?; [ "$rc" = 75 ] && echo ${busy} >&2; (exit $rc)`;
}
