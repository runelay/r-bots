import { constants, readFileSync, writeFileSync } from "node:fs";
import { defaultHealthFile, healthMaxAgeMs } from "./constants";

export function writeBeat(file: string, now = Date.now()) {
  try {
    writeFileSync(file, String(now), {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    });
  } catch {}
}

export function checkHealth(file: string, now = Date.now(), maxAgeMs = healthMaxAgeMs) {
  let beat = Number.NaN;
  try {
    beat = Number(readFileSync(file, "utf8").trim());
  } catch {}
  if (!Number.isFinite(beat)) return { ok: false, reason: "o runner ainda não falou com o servidor" };
  const age = now - beat;
  if (age > maxAgeMs) return { ok: false, reason: `sem falar com o servidor há ${Math.round(age / 1000)} s` };
  return { ok: true, reason: `conectado (último aviso há ${Math.round(age / 1000)} s)` };
}

export function healthCommand(env: Record<string, string | undefined>, write: (line: string) => void) {
  const { ok, reason } = checkHealth(env.RBOTS_HEALTH_FILE || defaultHealthFile);
  write(reason);
  return ok ? 0 : 1;
}
