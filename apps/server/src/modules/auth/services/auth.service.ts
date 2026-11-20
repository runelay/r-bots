import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { authSchema } from "../../../db/schema/auth";

export const authBasePath = "/api/auth";
export const devicePagePath = "/device";
export const appClientId = "runelay-bots-mac";
export const apiKeyPrefix = "rbk_";
export const ownerRole = "owner";
export const memberRole = "member";
export const clientIpHeader = "x-rb-client-ip";
export const apiKeyLifetimeSeconds = 180 * 24 * 60 * 60;
export const sessionMaxAgeMs = 90 * 24 * 60 * 60_000;

export const socialProviderIds = ["apple", "google", "github"] as const;
export type SocialProviderId = (typeof socialProviderIds)[number];
export interface SocialCredentials {
  clientId: string;
  clientSecret: string;
}
export type SocialConfig = Partial<Record<SocialProviderId, SocialCredentials>>;
const appleOrigin = "https://appleid.apple.com";

export function socialFromEnv(env: Record<string, string | undefined>): SocialConfig {
  const config: SocialConfig = {};
  for (const id of socialProviderIds) {
    const prefix = id.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
    const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
    if (clientId && clientSecret) config[id] = { clientId, clientSecret };
  }
  return config;
}

export type AuthDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface AuthConfig {
  db: AuthDatabase;
  secret: string;
  baseURL: string;
  appName?: string;
  trustedOrigins?: () => string[];
  social?: SocialConfig;
  onUserRevoked?: (userId: string) => void | Promise<void>;
}

async function revokeQuietly(config: AuthConfig, userId: string) {
  await Promise.resolve(config.onUserRevoked?.(userId)).catch((error) =>
    console.error("auth: could not revoke the user's credentials", error),
  );
}

export function createAuth(config: AuthConfig) {
  const base = new URL(config.baseURL);
  const origin = base.origin;
  const social = config.social ?? {};
  const socialProviders = Object.fromEntries(
    Object.entries(social).map(([id, credentials]) => [id, { ...credentials, disableImplicitSignUp: true }]),
  );
  const socialOrigins = social.apple ? [appleOrigin] : [];
  return betterAuth({
    appName: config.appName ?? "r/bots",
    baseURL: config.baseURL,
    basePath: authBasePath,
    secret: config.secret,
    database: drizzleAdapter(config.db, { provider: "pg", schema: authSchema }),
    trustedOrigins: () => [origin, ...socialOrigins, ...(config.trustedOrigins?.() ?? [])],
    socialProviders,
    account: { encryptOAuthTokens: true },
    databaseHooks: {
      user: {
        update: {
          after: async (updated, context) => {
            const body = (context?.body ?? {}) as Record<string, unknown>;
            const changedRole =
              typeof body.role === "string" && (updated as { role?: string | null }).role !== ownerRole;
            if ((updated as { banned?: boolean | null }).banned || changedRole) await revokeQuietly(config, updated.id);
          },
        },
        delete: {
          after: async (deleted) => {
            await revokeQuietly(config, deleted.id);
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 10,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 120,
      storage: "memory",
      customRules: {
        "/sign-in/*": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
        "/passkey/generate-authenticate-options": { window: 60, max: 20 },
        "/device/code": { window: 60, max: 10 },
        "/device/token": { window: 60, max: 30 },
        "/device/approve": { window: 60, max: 10 },
        "/device/deny": { window: 60, max: 10 },
        "/device": { window: 60, max: 30 },
        "/request-password-reset": { window: 300, max: 3 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [clientIpHeader] },
      useSecureCookies: base.protocol === "https:",
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    telemetry: { enabled: false },
    plugins: [
      bearer(),
      admin({
        defaultRole: memberRole,
        adminRoles: [ownerRole],
        roles: { [ownerRole]: adminAc, [memberRole]: userAc },
      }),
      passkey({
        rpID: base.hostname,
        rpName: config.appName ?? "r/bots",
        origin,
      }),
      apiKey({
        defaultPrefix: apiKeyPrefix,
        defaultKeyLength: 48,
        enableMetadata: true,
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: apiKeyLifetimeSeconds, maxExpiresIn: 180 },
        apiKeyHeaders: ["x-api-key"],
        deferUpdates: true,
      }),
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        verificationUri: devicePagePath,
        validateClient: (clientId) => clientId === appClientId,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
