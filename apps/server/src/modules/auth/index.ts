import { join } from "node:path";
import { createAuthRoutes } from "./routes/auth.routes";
import { createAccessService } from "./services/accounts-access.service";
import { resolveAuthSecret } from "./services/auth-secret.service";
import { createAuthenticator } from "./services/auth.middleware";
import { type AuthDatabase, createAuth } from "./services/auth.service";

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
}

export function authBaseURL(env: Record<string, string | undefined>, host: string, port: number) {
  return env.BETTER_AUTH_URL?.trim() || `http://${host}:${port}`;
}

export function createAuthModule(options: AuthModuleOptions) {
  const resolved = resolveAuthSecret({
    env: options.env,
    envFiles: [join(options.serverDir, ".env.local"), join(options.repoDir, ".env.local")],
    dataDir: options.dataDir,
  });
  const baseURL = authBaseURL(options.env, options.host, options.port);
  const extraOrigins = (options.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const auth = createAuth({ db: options.db, secret: resolved.secret, baseURL, trustedOrigins: extraOrigins });
  const access = createAccessService(auth, options.db);
  const authenticate = createAuthenticator(auth, { trustedOrigins: [baseURL, ...extraOrigins] });
  const routes = createAuthRoutes({ auth, access, secret: resolved.secret });
  return { auth, access, authenticate, handle: routes.handle, baseURL, secretSource: resolved.source };
}

export type AuthModule = ReturnType<typeof createAuthModule>;
