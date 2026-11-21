import { dataDir, host, port, repoDir, rootDir } from "../../config/env";
import { runnerToken } from "../../config/runtime-secrets";
import { hasProxyHeaders, isLoopback, requestContext } from "../../shared/http";
import type { AuthModule, Principal } from ".";
import { isPublicRoute } from "./services/auth.middleware";
import { misdirected } from "./services/origins.service";
import { authorize, forbiddenResponse } from "./services/policy.service";

export type AuthMode = "on" | "off";

let current: AuthModule | null = null;
const principals = new WeakMap<Request, Principal>();
const originsKey = "auth:origins";
const revokedListeners = new Set<(userId: string, deviceIds: string[]) => void>();

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

export function onUserRevoked(listener: (userId: string, deviceIds: string[]) => void) {
  revokedListeners.add(listener);
  return () => {
    revokedListeners.delete(listener);
  };
}

export function notifyUserRevoked(userId: string, deviceIds: string[]) {
  for (const listener of revokedListeners) listener(userId, deviceIds);
}

export async function initAuth(env: Record<string, string | undefined> = Bun.env) {
  if (authMode(env) === "off") return null;
  const { getDb } = await import("../../db");
  const { readSetting, writeSetting } = await import("../../db/settings");
  const { createAuthModule } = await import(".");
  const knownOrigins = await readSetting<string[]>(originsKey, []);
  const module = createAuthModule({
    db: getDb(),
    env,
    dataDir,
    repoDir,
    serverDir: rootDir,
    host,
    port,
    internalToken: runnerToken,
    knownOrigins: Array.isArray(knownOrigins) ? knownOrigins.filter((item) => typeof item === "string") : [],
    saveOrigins: (origins) => writeSetting(originsKey, origins),
    onOwnerCreated: async (owner) => {
      await recordOwner(owner.id).catch((error) => console.error("auth: could not record the owner", error));
    },
    onUserRevoked: notifyUserRevoked,
  });
  current = module;
  const waiting = await module.access.needsOwner();
  if (waiting) console.log(`auth: waiting for the owner, first-run code in ${module.setupToken.issue()}`);
  console.log(`auth on (origin from each request, secret from ${module.secretSource})`);
  return module;
}

export function useAuthModule(module: AuthModule | null) {
  current = module;
}

export const vaultExecPrefix = ["vault", "exec"];

export function isLocalExec(request: Request) {
  const context = requestContext(request);
  const [first, second, ticket] = context.parts;
  if (first !== vaultExecPrefix[0] || second !== vaultExecPrefix[1] || !ticket || context.parts.length !== 3)
    return false;
  return request.method === "POST" && isLoopback(context.peer) && !hasProxyHeaders(request.headers);
}

function isBlockedLocalExec(request: Request) {
  const { parts } = requestContext(request);
  return parts[0] === "vault" && parts[1] === "exec" && !isLocalExec(request);
}

function notFoundResponse() {
  return Response.json({ ok: false, error: "Rota não encontrada." }, { status: 404 });
}

export interface GateOptions {
  bypass?: () => boolean;
}

export async function gate(request: Request, options: GateOptions | (() => boolean) = {}): Promise<Response | null> {
  if (!current) return null;
  const bypass = typeof options === "function" ? options : options.bypass;
  const hostAllowed = (current as Partial<AuthModule>).hostAllowed;
  if (hostAllowed && !hostAllowed(request)) return misdirected();
  if (bypass?.()) return null;
  if (isLocalExec(request)) return null;
  if (isBlockedLocalExec(request)) return notFoundResponse();
  const outcome = await current.authenticate(request);
  if (outcome instanceof Response) return outcome;
  const principal = outcome.kind === "principal" ? outcome.principal : null;
  if (principal) {
    const context = requestContext(request);
    const decision = authorize(request.method, context.parts, principal, new URL(request.url).searchParams);
    if (decision !== "allow") return forbiddenResponse(decision);
    principals.set(request, principal);
  }
  return current.handle(request, principal);
}

export function principalOf(request: Request) {
  return principals.get(request) ?? null;
}

export function requestAllowed(request: Request) {
  if (!current) return true;
  if (principals.has(request) || isLocalExec(request)) return true;
  return isPublicRoute(request.method, requestContext(request).pathname);
}

export function currentAuthModule() {
  return current;
}

export function authActive() {
  return current !== null;
}
