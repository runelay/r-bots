import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { macDeviceCall } from "../../accounts/services/mac-runner.service";
import { getServer } from "../../code/services/dev-server.service";

export interface SimulatorDevice {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  platform: "ios" | "android";
}

export interface DeviceList {
  devices: SimulatorDevice[];
  android: { sdk: boolean; adb: boolean };
  maestro: { installed: boolean; version: string | null };
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function parseDevices(result: Record<string, unknown>): DeviceList {
  const devices = (Array.isArray(result.devices) ? result.devices : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      udid: text(item.udid),
      name: text(item.name),
      runtime: text(item.runtime),
      state: text(item.state),
      platform: item.platform === "android" ? ("android" as const) : ("ios" as const),
    }))
    .filter((item) => item.udid);
  const android = (result.android ?? {}) as Record<string, unknown>;
  const maestro = (result.maestro ?? {}) as Record<string, unknown>;
  return {
    devices,
    android: { sdk: android.sdk === true, adb: android.adb === true },
    maestro: { installed: maestro.installed === true, version: text(maestro.version) || null },
  };
}

export async function listDevices(signal?: AbortSignal) {
  return parseDevices(await macDeviceCall("sim.list", {}, 60_000, signal));
}

export function deviceCall(op: string, body: Record<string, unknown>, timeoutMs = 90_000, signal?: AbortSignal) {
  return macDeviceCall(op, body, timeoutMs, signal);
}

export async function expoScheme(path: string, cwd: string) {
  const dir = join(path, cwd);
  for (const file of ["app.json", "app.config.json"]) {
    try {
      const json = JSON.parse(await readFile(join(dir, file), "utf8")) as { expo?: { scheme?: unknown } };
      const scheme = json.expo?.scheme;
      if (typeof scheme === "string" && scheme) return scheme;
      if (Array.isArray(scheme) && typeof scheme[0] === "string") return scheme[0];
    } catch {}
  }
  for (const file of ["app.config.ts", "app.config.js"]) {
    const source = await readFile(join(dir, file), "utf8").catch(() => "");
    const match = source.match(/\bscheme\s*:\s*["'`]([\w.+-]+)["'`]/);
    if (match) return match[1];
  }
  return null;
}

export async function hasDevClient(path: string, cwd: string) {
  try {
    const pkg = JSON.parse(await readFile(join(path, cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    return typeof pkg.dependencies?.["expo-dev-client"] === "string";
  } catch {
    return false;
  }
}

export function expoUrl(localPort: number, client: "go" | "dev", scheme: string | null) {
  const metro = `http://127.0.0.1:${localPort}`;
  if (client === "dev" && scheme)
    return `${scheme}://expo-development-client/?url=${encodeURIComponent(metro)}&disableOnboarding=1`;
  return `exp://127.0.0.1:${localPort}`;
}

export async function openExpo(
  input: { serverId: string; udid?: string; client?: "go" | "dev" },
  signal?: AbortSignal,
) {
  const server = getServer(input.serverId);
  if (server?.status !== "running") throw new Error("Esse servidor não está no ar.");
  if (server.tool !== "expo") throw new Error("Esse servidor não é um Metro do Expo.");
  const tunnel = await macDeviceCall("sim.tunnel", { port: server.port }, 30_000, signal);
  const localPort = Number(tunnel.localPort);
  if (!Number.isInteger(localPort) || localPort <= 0) throw new Error("O Mac não abriu a ponte para o Metro.");
  const cwd = relative(server.target.path, server.cwd);
  const devClient = input.client ? input.client === "dev" : await hasDevClient(server.target.path, cwd);
  const scheme = devClient ? await expoScheme(server.target.path, cwd) : null;
  const url = expoUrl(localPort, devClient && scheme ? "dev" : "go", scheme);
  await macDeviceCall("sim.open_url", { url, ...(input.udid ? { udid: input.udid } : {}) }, 60_000, signal);
  return { url, localPort, client: devClient && scheme ? ("dev" as const) : ("go" as const) };
}
