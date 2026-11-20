import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { authSchema } from "../../../db/schema/auth";

export const authBasePath = "/api/auth";
export const devicePagePath = "/device";
export const appClientId = "runelay-bots-mac";
export const apiKeyPrefix = "rbk_";
export const ownerRole = "owner";
export const memberRole = "member";

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

export type AuthDatabase = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

export interface AuthConfig {
  db: AuthDatabase;
  secret: string;
  baseURL: string;
  appName?: string;
  trustedOrigins?: string[];
  social?: SocialConfig;
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
    appName: config.appName ?? "runelay bots",
    baseURL: config.baseURL,
    basePath: authBasePath,
    secret: config.secret,
    database: drizzleAdapter(config.db, { provider: "sqlite", schema: authSchema }),
    trustedOrigins: [origin, ...socialOrigins, ...(config.trustedOrigins ?? [])],
    socialProviders,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
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
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
        "/device/code": { window: 60, max: 10 },
        "/device/approve": { window: 60, max: 10 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
      useSecureCookies: base.protocol === "https:",
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
        rpName: config.appName ?? "runelay bots",
        origin,
      }),
      apiKey({
        defaultPrefix: apiKeyPrefix,
        defaultKeyLength: 48,
        enableMetadata: true,
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: null },
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
