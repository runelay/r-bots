import { dataDir, host, port, repoDir, rootDir } from "../../config/env";
import { runnerToken } from "../../config/runtime-secrets";
import type { AuthModule, Principal } from ".";
import { authBasePath, devicePagePath } from "./services/auth.service";

export type AuthMode = "on" | "off" | "auto";

let current: AuthModule | null = null;
let enforced = false;
const principals = new WeakMap<Request, Principal>();

export function authMode(env: Record<string, string | undefined> = Bun.env): AuthMode {
  const value = (env.BOTS_AUTH ?? "").trim().toLowerCase();
  if (value === "on" || value === "true" || value === "1") return "on";
  if (value === "off" || value === "false" || value === "0") return "off";
  return "auto";
}

export function authEnabled(env: Record<string, string | undefined> = Bun.env) {
  return authMode(env) !== "off";
}

function isAuthPath(pathname: string) {
  return (
    pathname === authBasePath ||
    pathname.startsWith(`${authBasePath}/`) ||
    pathname === devicePagePath ||
    pathname.startsWith("/auth/")
  );
}

async function recordOwner(ownerId: string) {
  const { writeSetting } = await import("../../db/settings");
  await writeSetting("auth:owner", { userId: ownerId, claimedAt: new Date().toISOString() });
}

export async function initAuth(env: Record<string, string | undefined> = Bun.env) {
  const mode = authMode(env);
  if (mode === "off") return null;
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
    required: () => enforced,
    internalToken: runnerToken,
    onOwnerCreated: async (owner) => {
      enforced = true;
      await recordOwner(owner.id).catch((error) => console.error("auth: could not record the owner", error));
    },
  });
  current = module;
  enforced = mode === "on" || !(await module.access.needsOwner());
  console.log(
    `auth ${enforced ? "on" : "waiting for the owner"} (${module.baseURL}, secret from ${module.secretSource})`,
  );
  return module;
}

export function useAuthModule(module: AuthModule | null, required = true) {
  current = module;
  enforced = module !== null && required;
}

export async function gate(request: Request, bypass?: () => boolean): Promise<Response | null> {
  if (!current) return null;
  if (bypass?.()) return null;
  if (!enforced && !isAuthPath(new URL(request.url).pathname)) return null;
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
  return current !== null && enforced;
}
