import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir, env } from "../../../config/env";
import { rememberSecretValue } from "../../../shared/redact";
import type { AuthModule } from "../../auth";
import { currentAuthModule } from "../../auth/gate";
import { ownerRole } from "../../auth/services/auth.service";
import { registerDevice } from "../../devices/services/devices.service";
import {
  localRunnerDir,
  localRunnerMachineId,
  localRunnerName,
  localRunnerRetryMs,
  localRunnerSecretKey,
  localRunnerTokenFile,
} from "../constants/environments.constants";
import type { LocalRunnerOutcome, LocalRunnerWatch } from "../types/environments.types";

const retryable: ReadonlySet<LocalRunnerOutcome> = new Set(["waiting", "failed"]);

export function localRunnerTokenPath() {
  return join(dataDir, localRunnerDir, localRunnerTokenFile);
}

async function readToken(path: string) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

async function tokenAlive({ auth, devices }: AuthModule, token: string, ownerId: string) {
  if (!token) return false;
  const result = await auth.api.verifyApiKey({ body: { key: token } });
  if (!result.valid || !result.key || result.key.referenceId !== ownerId) return false;
  return (await devices.byApiKey(result.key.id)) !== null;
}

async function writeToken(path: string, token: string) {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function ensureLocalRunnerToken(): Promise<LocalRunnerOutcome> {
  if (env.BOTS_SANDBOX !== "docker" && env.BOTS_HOST_RUNNER !== "on") return "off";
  const module = currentAuthModule();
  if (!module) return "no-auth";
  const owner = await module.access.findOwner();
  if (!owner) return "waiting";
  const { id: userId, email, name } = owner;
  const path = localRunnerTokenPath();
  const stored = await readToken(path);
  if (await tokenAlive(module, stored, userId)) {
    rememberSecretValue(localRunnerSecretKey, stored, { pinned: true });
    return "kept";
  }
  const { token } = await registerDevice(
    { userId, email, name, role: ownerRole, method: "session" },
    { name: localRunnerName, machineId: localRunnerMachineId },
  );
  rememberSecretValue(localRunnerSecretKey, token, { pinned: true });
  await writeToken(path, token);
  return "written";
}

function failed(error: unknown): LocalRunnerOutcome {
  console.error(`sandbox: local runner token failed: ${error instanceof Error ? error.message : String(error)}`);
  return "failed";
}

export function startLocalRunnerToken(retryMs = localRunnerRetryMs): LocalRunnerWatch {
  const { promise, resolve } = Promise.withResolvers<LocalRunnerOutcome>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const attempt = async () => {
    timer = null;
    const outcome = await ensureLocalRunnerToken().catch(failed);
    if (stopped) return;
    if (outcome === "written") console.log(`sandbox: local runner token in ${localRunnerTokenPath()}`);
    if (!retryable.has(outcome)) return resolve(outcome);
    timer = setTimeout(attempt, retryMs);
    timer.unref();
  };
  void attempt();
  return {
    settled: promise,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      resolve("stopped");
    },
  };
}
