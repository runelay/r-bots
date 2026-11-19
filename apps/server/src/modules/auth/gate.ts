import { dataDir, host, port, repoDir, rootDir } from "../../config/env";
import type { AuthModule, Principal } from ".";

let current: AuthModule | null = null;
const principals = new WeakMap<Request, Principal>();

export function authEnabled(env: Record<string, string | undefined> = Bun.env) {
  return (env.BOTS_AUTH ?? "off").toLowerCase() === "on";
}

export async function initAuth(env: Record<string, string | undefined> = Bun.env) {
  if (!authEnabled(env)) return null;
  const { getDb } = await import("../../db");
  const { createAuthModule } = await import(".");
  current = createAuthModule({ db: getDb(), env, dataDir, repoDir, serverDir: rootDir, host, port });
  console.log(`auth on (${current.baseURL}, secret from ${current.secretSource})`);
  return current;
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

export function authActive() {
  return current !== null;
}
