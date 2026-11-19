const testPattern =
  /\b(vitest|jest|mocha|ava|playwright\s+test|pytest|go\s+test|cargo\s+test|swift\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|npx\s+(?:vitest|jest|playwright))\b/;
const heavyPattern =
  /\b(tsc|vue-tsc|next\s+build|vite\s+build|turbo|nx\s+run|webpack|esbuild|rollup|eslint|biome|cargo\s+build|swift\s+build|gradle|mvn|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|type-check|lint|check)(?::\S+)?)\b/;

export const heavyLimits = {
  memoryMb: Number(process.env.CODE_HEAVY_MEMORY_MB ?? 2048),
  timeoutMin: Number(process.env.CODE_HEAVY_TIMEOUT_MIN ?? 20),
  testWaitSec: Number(process.env.CODE_TEST_WAIT_SEC ?? 100),
  workers: Number(process.env.CODE_TEST_WORKERS ?? 2),
  lockFile: process.env.CODE_TEST_LOCK ?? "/tmp/runelay-bots-tests.lock",
};

function quote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function heavyKind(command: string): "test" | "heavy" | null {
  if (process.platform !== "linux") return null;
  if (testPattern.test(command)) return "test";
  if (heavyPattern.test(command)) return "heavy";
  return null;
}

export function wrapHeavyCommand(original: string, finalCommand: string) {
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
  const run = `env ${env} nice -n 10 timeout -k 15s ${heavyLimits.timeoutMin}m bash -c ${quote(finalCommand)}`;
  if (kind === "heavy") return `ulimit -c 0; ${run}`;
  const busy = quote(
    "Outra suíte de testes ainda está rodando na VPS (só roda uma por vez). Tente de novo em alguns minutos.",
  );
  return `ulimit -c 0; flock -E 75 -w ${heavyLimits.testWaitSec} ${quote(heavyLimits.lockFile)} ${run}; rc=$?; [ "$rc" = 75 ] && echo ${busy} >&2; (exit $rc)`;
}
