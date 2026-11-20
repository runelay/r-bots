import { join } from "node:path";
import { rememberSecretValue } from "../../shared/redact";
import { createDeviceRepository } from "../devices/repositories/devices.repository";
import type { BlobStore } from "../storage/services/blob-store";
import { getBlobStore } from "../storage/services/storage.service";
import { createAuthRoutes } from "./routes/auth.routes";
import { createAccessService, type IssuedSession } from "./services/accounts-access.service";
import { createAuthenticator, type Principal } from "./services/auth.middleware";
import { type AuthDatabase, createAuth, ownerRole, socialFromEnv } from "./services/auth.service";
import { resolveAuthSecret } from "./services/auth-secret.service";
import { createAvatarService } from "./services/avatar.service";
import { createAuthPool, createOriginRegistry } from "./services/origins.service";
import { createSetupToken } from "./services/setup-token.service";

export type { AuthOutcome, Principal } from "./services/auth.middleware";
export { isPublicRoute, unauthorized } from "./services/auth.middleware";
export { requestOrigin } from "./services/origins.service";
export { authorize, forbiddenResponse } from "./services/policy.service";

export interface AuthModuleOptions {
  db: AuthDatabase;
  env: Record<string, string | undefined>;
  dataDir: string;
  repoDir: string;
  serverDir: string;
  host: string;
  port: number;
  internalToken?: () => string;
  onOwnerCreated?: (owner: IssuedSession["user"]) => void | Promise<void>;
  blobs?: () => BlobStore;
  knownOrigins?: string[];
  saveOrigins?: (origins: string[]) => void | Promise<void>;
  onUserRevoked?: (userId: string, deviceIds: string[]) => void | Promise<void>;
  setupTokenFile?: string;
}

export function authBaseURL(host: string, port: number) {
  return `http://${host}:${port}`;
}

export function previewHostOf(value: string | undefined) {
  try {
    return value?.trim() ? new URL(value.trim()).host.toLowerCase() : "";
  } catch {
    return "";
  }
}

export function createAuthModule(options: AuthModuleOptions) {
  const resolved = resolveAuthSecret({
    env: options.env,
    dataDir: options.dataDir,
  });
  rememberSecretValue("auth", resolved.secret, { pinned: true });
  const baseURL = authBaseURL(options.host, options.port);
  const origins = createOriginRegistry({
    known: options.knownOrigins,
    save: options.saveOrigins,
    allowedHosts: [options.env.BOTS_ALLOWED_HOSTS ?? "", previewHostOf(options.env.BOTS_PREVIEW_ORIGIN)].join(","),
    port: options.port,
  });
  const social = socialFromEnv(options.env);
  const providers = Object.keys(social);
  const devices = createDeviceRepository(options.db);
  const onUserRevoked = async (userId: string) => {
    const deviceIds = await devices.revokeUser(userId);
    await options.onUserRevoked?.(userId, deviceIds);
  };
  const pool = createAuthPool(
    (origin) =>
      createAuth({
        db: options.db,
        secret: resolved.secret,
        baseURL: origin,
        trustedOrigins: origins.list,
        social,
        onUserRevoked,
      }),
    baseURL,
    origins.originOf,
  );
  const auth = pool.fallback;
  const setupToken = createSetupToken(options.setupTokenFile ?? join(options.dataDir, "setup.token"));
  const access = createAccessService(auth, options.db, {
    onOwnerCreated: options.onOwnerCreated,
    setupGuard: setupToken,
  });
  const internalToken = options.internalToken;
  const internal = internalToken
    ? {
        token: internalToken,
        principal: async (): Promise<Principal> => {
          const owner = await access.findOwner();
          return {
            userId: owner?.id ?? "internal",
            email: owner?.email ?? "",
            name: owner?.name ?? "r/bots",
            role: ownerRole,
            method: "internal",
          };
        },
      }
    : undefined;
  const deviceFor = async (apiKeyId: string) => {
    const row = await devices.byApiKey(apiKeyId);
    return row ? { id: row.id, name: row.name, registeredAt: row.registeredAt.toISOString() } : null;
  };
  const authenticate = createAuthenticator(auth, {
    trusts: origins.trusts,
    authFor: pool.forRequest,
    internal,
    deviceFor,
  });
  const avatars = createAvatarService(auth, options.blobs ?? getBlobStore);
  const routes = createAuthRoutes({
    auth,
    authFor: pool.forRequest,
    access,
    avatars,
    secret: resolved.secret,
    providers,
    setupTokenRequired: setupToken.exists,
  });
  return {
    devices,
    setupToken,
    hostAllowed: origins.hostAllowed,
    auth,
    access,
    avatars,
    authenticate,
    authFor: pool.forRequest,
    origins,
    handle: routes.handle,
    baseURL,
    providers,
    secretSource: resolved.source,
  };
}

export type AuthModule = ReturnType<typeof createAuthModule>;
