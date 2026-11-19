import { createAuthRoutes } from "./routes/auth.routes";
import { createAccessService, type IssuedSession } from "./services/accounts-access.service";
import { createAuthenticator, type Principal } from "./services/auth.middleware";
import { type AuthDatabase, createAuth, ownerRole } from "./services/auth.service";
import { resolveAuthSecret } from "./services/auth-secret.service";

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
  required?: () => boolean;
  internalToken?: () => string;
  onOwnerCreated?: (owner: IssuedSession["user"]) => void | Promise<void>;
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
  const auth = createAuth({ db: options.db, secret: resolved.secret, baseURL, trustedOrigins: extraOrigins });
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
  const routes = createAuthRoutes({ auth, access, secret: resolved.secret, required: options.required });
  return { auth, access, authenticate, handle: routes.handle, baseURL, secretSource: resolved.source };
}

export type AuthModule = ReturnType<typeof createAuthModule>;
