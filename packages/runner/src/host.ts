import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { BoxSpec, Provider, TurnRequest } from "@runelay-bots/protocol";
import { hostAgentFile, hostAgentSource, hostProbeMemory, hostProviderBinaries } from "./constants";
import type { BoxExecHandle, ExecOptions } from "./types";

export interface HostProbe {
  scope: boolean;
  bwrap: boolean;
}

export interface HostLayout {
  home: string;
  dataDir: string;
  agent: string[];
  probe: HostProbe;
  exists: (path: string) => boolean;
}

export interface Exposed {
  path: string;
  readOnly: boolean;
}

export type RunCode = (argv: string[]) => Promise<number>;

export const runQuiet: RunCode = async (argv) =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;

export const scopeProbeArgv = ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${hostProbeMemory}`, "true"];
export const bwrapProbeArgv = ["bwrap", "--dev-bind", "/", "/", "true"];

export async function probeHost(run: RunCode): Promise<HostProbe> {
  const [scope, bwrap] = await Promise.all([run(scopeProbeArgv).catch(() => 1), run(bwrapProbeArgv).catch(() => 1)]);
  return { scope: scope === 0, bwrap: bwrap === 0 };
}

export function probeWarnings({ scope, bwrap }: HostProbe) {
  return [
    ...(scope
      ? []
      : ["aviso: sem systemd-run --user --scope; os turnos rodam sem limite de memória e CPU (veja docs/hosting.md)"]),
    ...(bwrap
      ? []
      : [
          "aviso: o bwrap não roda aqui (no Ubuntu 24.04 falta o perfil do AppArmor); os comandos dos bots enxergam a pasta de dados do r/bots (veja docs/hosting.md)",
        ]),
  ];
}

export function hiddenPaths(home: string, dataDir: string) {
  return [
    resolve(dataDir),
    join(home, ".local", "share", "runelay-bots-backups"),
    join(home, ".config", "runelay-bots"),
  ];
}

function inside(root: string, path: string) {
  return path === root || path.startsWith(`${root}/`);
}

export function exposedPaths(dataDir: string, botId: string, request: TurnRequest): Exposed[] {
  const [workRoot = ""] = request.workKey.replace(/[^\w/-]/g, "_").split("/");
  return [
    { path: join(dataDir, "work", workRoot), readOnly: false },
    { path: join(dataDir, "bots", botId, "uploads"), readOnly: true },
    { path: join(dataDir, "locks"), readOnly: false },
    { path: join(dataDir, "clis"), readOnly: true },
    ...(request.code ? [{ path: resolve(request.code.cwd), readOnly: request.code.readOnly === true }] : []),
    ...(request.configDir ? [{ path: resolve(request.configDir), readOnly: false }] : []),
  ];
}

export function bwrapArgv(hidden: string[], exposed: Exposed[]) {
  const binds = exposed.filter(({ path }) => hidden.some((root) => inside(root, path)));
  return [
    "bwrap",
    "--dev-bind",
    "/",
    "/",
    "--die-with-parent",
    ...hidden.flatMap((path) => ["--tmpfs", path]),
    ...binds.flatMap(({ path, readOnly }) => [readOnly ? "--ro-bind-try" : "--bind-try", path, path]),
    "--",
  ];
}

export function scopeArgv({ memMb, cpus }: Pick<BoxSpec, "memMb" | "cpus">) {
  return [
    "systemd-run",
    "--user",
    "--scope",
    "-q",
    "--collect",
    "-p",
    `MemoryMax=${Math.max(1, Math.round(memMb))}M`,
    "-p",
    `CPUQuota=${Math.max(1, Math.round(cpus * 100))}%`,
    "--",
  ];
}

export function hostAgentArgv(layout: HostLayout, botId: string, request: TurnRequest, box: BoxSpec) {
  const { home, dataDir, agent, probe, exists } = layout;
  const hidden = hiddenPaths(home, dataDir).filter(exists);
  return [
    ...(probe.scope ? scopeArgv(box) : []),
    ...(probe.bwrap && hidden.length > 0 ? bwrapArgv(hidden, exposedPaths(dataDir, botId, request)) : []),
    ...agent,
  ];
}

export function agentScript(dir: string, exists: (path: string) => boolean, configured?: string) {
  if (configured) return configured;
  const bundled = join(dir, hostAgentFile);
  return exists(bundled) ? bundled : join(dir, hostAgentSource);
}

export function findOnPath(names: string[], path: string, exists: (path: string) => boolean) {
  for (const dir of path.split(delimiter).filter(Boolean))
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  return null;
}

export function installedProviders(path: string, dataDir: string, exists: (path: string) => boolean): Provider[] {
  return (Object.entries(hostProviderBinaries) as Array<[Provider, string[]]>)
    .filter(
      ([provider, names]) =>
        findOnPath(names, path, exists) !== null || exists(join(dataDir, "clis", provider, "current")),
    )
    .map(([provider]) => provider);
}

export function hostAgentEnv(
  base: Record<string, string | undefined>,
  dataDir: string,
  exists: (path: string) => boolean,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const claude = env.CLAUDE_CODE_EXECUTABLE || findOnPath(["claude"], env.PATH ?? "", exists);
  return { ...env, BOTS_DATA_DIR: dataDir, ...(claude ? { CLAUDE_CODE_EXECUTABLE: claude } : {}) };
}

export function spawnAgent(argv: string[], { cwd, env, signal }: ExecOptions): BoxExecHandle {
  const proc = Bun.spawn(argv, {
    cwd: existsSync(cwd) ? cwd : "/",
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  };
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill,
    write(line: string) {
      const sink = proc.stdin;
      void Promise.resolve()
        .then(() => {
          sink.write(line);
          return sink.flush();
        })
        .catch(() => undefined);
    },
  };
}
