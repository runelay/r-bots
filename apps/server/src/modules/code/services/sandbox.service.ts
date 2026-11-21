import { run } from "@runelay-bots/providers/proc";

export type SandboxMode = "uid" | "off";

export const sandboxUser = "runelaytool";
export const sandboxGroup = "rbwork";
export const sandboxEnvNames = new Set([
  "NODE_OPTIONS",
  "NODE_ENV",
  "PORT",
  "HOST",
  "HOSTNAME",
  "BROWSER",
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
  "TZ",
  "TERM",
  "LANG",
  "VITEST_MAX_WORKERS",
  "VITEST_MAX_THREADS",
  "VITEST_MAX_FORKS",
  "JEST_WORKERS",
  "GIT_TERMINAL_PROMPT",
]);

export const sandboxMissingMessage =
  "O sandbox de ferramentas está ligado (BOTS_TOOL_SANDBOX=uid), mas o servidor não conseguiu usar sudo com o rb-sandbox-exec. Por segurança, nenhum comando roda até isso ser corrigido na VPS. Diga isso à pessoa em uma linha.";

export interface SandboxSpec {
  cwd: string;
  command: string;
  marker?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
}

export type SandboxStatus = { ok: true; bwrap: boolean } | { ok: false; message: string };

let probe: { key: string; status: Promise<SandboxStatus> } | null = null;

export function sandboxMode(): SandboxMode {
  const value = (process.env.BOTS_TOOL_SANDBOX ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  return "uid";
}

export function sandboxSudo() {
  return process.env.BOTS_SANDBOX_SUDO?.trim() || "/usr/bin/sudo";
}

export function sandboxExec() {
  return process.env.BOTS_SANDBOX_EXEC?.trim() || "/usr/local/bin/rb-sandbox-exec";
}

export function sandboxScope() {
  return `rb${process.env.GATEWAY_PORT ?? "0"}`;
}

export function sandboxMarker(kind: string, id: string) {
  return `${sandboxScope()}:${kind}:${id}`.replace(/[^A-Za-z0-9:._-]/g, "_").slice(0, 200);
}

function base() {
  return [sandboxSudo(), "-n", "-u", sandboxUser, sandboxExec()];
}

export function sandboxArgv(spec: SandboxSpec) {
  const args = [...base(), "--cwd", spec.cwd];
  if (spec.marker) args.push("--marker", spec.marker);
  if (spec.timeoutSec !== undefined) args.push("--timeout", String(Math.max(1, Math.ceil(spec.timeoutSec))));
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    if (!sandboxEnvNames.has(name)) throw new Error(`Variável ${name} não passa para o sandbox.`);
    if (/[\n\r\0]/.test(value)) throw new Error(`Valor inválido para ${name}.`);
    args.push("--env", `${name}=${value}`);
  }
  args.push("--", spec.command);
  return args;
}

export function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function sandboxShell(spec: Omit<SandboxSpec, "cwd"> & { cwd?: string }) {
  const argv = sandboxArgv({ ...spec, cwd: spec.cwd ?? "." });
  const cwdAt = argv.indexOf("--cwd") + 1;
  return argv.map((arg, index) => (index === cwdAt && spec.cwd === undefined ? '"$PWD"' : shellQuote(arg))).join(" ");
}

async function runProbe(): Promise<SandboxStatus> {
  const result = await run(sandboxSudo(), [...base().slice(1), "--probe"], { timeoutMs: 15_000 });
  const match = result.stdout.match(/^ok \d+ bwrap=([01])/m);
  if (result.code !== 0 || !match) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300);
    console.warn(`sandbox de ferramentas indisponível: ${detail || `código ${result.code}`}`);
    return { ok: false, message: sandboxMissingMessage };
  }
  await sweepSandboxed([]);
  return { ok: true, bwrap: match[1] === "1" };
}

export function sandboxStatus(): Promise<SandboxStatus> {
  const key = `${sandboxSudo()}|${sandboxExec()}`;
  if (!probe || probe.key !== key) probe = { key, status: runProbe() };
  return probe.status;
}

export function resetSandboxProbe() {
  probe = null;
}

export async function sandboxProblem(): Promise<string | null> {
  if (sandboxMode() === "off") return null;
  const status = await sandboxStatus();
  return status.ok ? null : status.message;
}

export async function sandboxBootReport(): Promise<{ ok: boolean; line: string }> {
  if (sandboxMode() === "off")
    return { ok: true, line: "sandbox de ferramentas: off (comandos dos bots rodam como o usuário do servidor)" };
  const status = await sandboxStatus();
  if (status.ok)
    return {
      ok: true,
      line: `sandbox de ferramentas: uid (${sandboxUser}, bwrap ${status.bwrap ? "ligado" : "ausente"})`,
    };
  return {
    ok: false,
    line: `ERRO: BOTS_TOOL_SANDBOX=uid, mas o sandbox de ferramentas não respondeu (sudo -n -u ${sandboxUser} ${sandboxExec()} --probe). Nenhum comando de bot roda até corrigir o sudoers, o wrapper e o usuário ${sandboxUser}.`,
  };
}

export async function killSandboxed(marker: string) {
  if (sandboxMode() === "off") return 0;
  const result = await run(sandboxSudo(), [...base().slice(1), "--kill", marker], { timeoutMs: 15_000 });
  return Number(result.stdout.trim()) || 0;
}

export async function sweepSandboxed(keep: string[]) {
  if (sandboxMode() === "off") return 0;
  const result = await run(sandboxSudo(), [...base().slice(1), "--sweep", sandboxScope(), ...keep], {
    timeoutMs: 15_000,
  });
  return Number(result.stdout.trim()) || 0;
}
