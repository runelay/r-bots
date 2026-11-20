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

export type AuthDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface AuthConfig {
  db: AuthDatabase;
  secret: string;
  baseURL: string;
  appName?: string;
  trustedOrigins?: string[];
}

export function createAuth(config: AuthConfig) {
  const base = new URL(config.baseURL);
  const origin = base.origin;
  return betterAuth({
    appName: config.appName ?? "runelay bots",
    baseURL: config.baseURL,
    basePath: authBasePath,
    secret: config.secret,
    database: drizzleAdapter(config.db, { provider: "pg", schema: authSchema }),
    trustedOrigins: [origin, ...(config.trustedOrigins ?? [])],
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
