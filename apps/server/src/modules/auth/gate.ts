import { dataDir, host, port, repoDir, rootDir } from "../../config/env";
import { runnerToken } from "../../config/runtime-secrets";
import type { AuthModule, Principal } from ".";

export type AuthMode = "on" | "off";

let current: AuthModule | null = null;
const principals = new WeakMap<Request, Principal>();

function isTestEnv(env: Record<string, string | undefined>) {
  const bunTest = (env.BOTS_TEST ?? "").trim().toLowerCase();
  return env.NODE_ENV === "test" || bunTest === "1" || bunTest === "true";
}

export function authMode(env: Record<string, string | undefined> = Bun.env): AuthMode {
  const value = (env.BOTS_AUTH ?? "").trim().toLowerCase();
  const off = value === "off" || value === "false" || value === "0";
  return off && isTestEnv(env) ? "off" : "on";
}

export function authEnabled(env: Record<string, string | undefined> = Bun.env) {
  return authMode(env) === "on";
}

async function recordOwner(ownerId: string) {
  const { writeSetting } = await import("../../db/settings");
  await writeSetting("auth:owner", { userId: ownerId, claimedAt: new Date().toISOString() });
}

export async function initAuth(env: Record<string, string | undefined> = Bun.env) {
  if (authMode(env) === "off") return null;
  const { getDb } = await import("../../db");
  const { createAuthModule } = await import(".");
  const module = createAuthModule({
    db: getDb(),
    env,
    dataDir,
    repoDir,
    serverDir: rootDir,
    host,
    port,
    internalToken: runnerToken,
    onOwnerCreated: async (owner) => {
      await recordOwner(owner.id).catch((error) => console.error("auth: could not record the owner", error));
    },
  });
  current = module;
  const waiting = await module.access.needsOwner();
  console.log(
    `auth on${waiting ? ", waiting for the owner" : ""} (${module.baseURL}, secret from ${module.secretSource})`,
  );
  return module;
}

export function useAuthModule(module: AuthModule | null) {
  current = module;
}

export async function gate(request: Request, bypass?: () => boolean): Promise<Response | null> {
  if (!current) return null;
  if (bypass?.()) return null;
  const outcome = await current.authenticate(request);
  if (outcome instanceof Response) return outcome;
  const principal = outcome.kind === "principal" ? outcome.principal : null;
  if (principal) principals.set(request, principal);
  return current.handle(request, principal);
}

export function principalOf(request: Request) {
  return principals.get(request) ?? null;
}

export function currentAuthModule() {
  return current;
}

export function authActive() {
  return current !== null;
}
