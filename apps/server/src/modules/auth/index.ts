import type { BlobStore } from "../storage/services/blob-store";
import { getBlobStore } from "../storage/services/storage.service";
import { createAuthRoutes } from "./routes/auth.routes";
import { createAccessService, type IssuedSession } from "./services/accounts-access.service";
import { createAuthenticator, type Principal } from "./services/auth.middleware";
import { type AuthDatabase, createAuth, ownerRole, socialFromEnv } from "./services/auth.service";
import { resolveAuthSecret } from "./services/auth-secret.service";
import { createAvatarService } from "./services/avatar.service";

export type { AuthOutcome, Principal } from "./services/auth.middleware";
export { isPublicRoute, unauthorized } from "./services/auth.middleware";

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
}

export function authBaseURL(env: Record<string, string | undefined>, host: string, port: number) {
  return env.BETTER_AUTH_URL?.trim() || `http://${host}:${port}`;
}

export function createAuthModule(options: AuthModuleOptions) {
  const resolved = resolveAuthSecret({
    env: options.env,
    dataDir: options.dataDir,
  });
  const baseURL = authBaseURL(options.env, options.host, options.port);
  const extraOrigins = (options.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const social = socialFromEnv(options.env);
  const providers = Object.keys(social);
  const auth = createAuth({ db: options.db, secret: resolved.secret, baseURL, trustedOrigins: extraOrigins, social });
  const access = createAccessService(auth, options.db, { onOwnerCreated: options.onOwnerCreated });
  const internalToken = options.internalToken;
  const internal = internalToken
    ? {
        token: internalToken,
        principal: async (): Promise<Principal> => {
          const owner = await access.findOwner();
          return {
            userId: owner?.id ?? "internal",
            email: owner?.email ?? "",
            name: owner?.name ?? "runelay bots",
            role: ownerRole,
            method: "internal",
          };
        },
      }
    : undefined;
  const authenticate = createAuthenticator(auth, { trustedOrigins: [baseURL, ...extraOrigins], internal });
  const avatars = createAvatarService(auth, options.blobs ?? getBlobStore);
  const routes = createAuthRoutes({ auth, access, avatars, secret: resolved.secret, providers });
  return {
    auth,
    access,
    avatars,
    authenticate,
    handle: routes.handle,
    baseURL,
    providers,
    secretSource: resolved.source,
  };
}

export type AuthModule = ReturnType<typeof createAuthModule>;
