import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { invite, user } from "../../../db/schema/auth";
import { ValidationError } from "../../../shared/errors";
import { type Auth, type AuthDatabase, apiKeyPrefix, memberRole, ownerRole } from "./auth.service";

export const runnerKeyName = "mac-runner";
const inviteTtlMs = 7 * 24 * 60 * 60_000;

export interface Credentials {
  name: string;
  email: string;
  password: string;
}

export interface IssuedSession {
  token: string;
  user: { id: string; name: string; email: string; role: string };
}

export class SetupClosedError extends Error {}
export class InviteInvalidError extends Error {}

function hashCode(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

export function safeEqual(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function readCredentials(body: unknown): Credentials {
  if (!body || typeof body !== "object") throw new ValidationError("Envie nome, e-mail e senha.", "body");
  const input = body as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!name) throw new ValidationError("Informe o nome.", "name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("E-mail inválido.", "email");
  if (password.length < 10) throw new ValidationError("A senha precisa de pelo menos 10 caracteres.", "password");
  return { name, email, password };
}

export function createAccessService(auth: Auth, db: AuthDatabase) {
  let setupRunning: Promise<unknown> | null = null;

  async function userCount() {
    const [row] = await db.select({ value: count() }).from(user);
    return row?.value ?? 0;
  }

  async function needsOwner() {
    return (await userCount()) === 0;
  }

  async function signIn(email: string, password: string): Promise<IssuedSession> {
    const result = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const token = result.headers.get("set-auth-token") ?? result.response.token;
    const found = result.response.user as { id: string; name: string; email: string; role?: string | null };
    return {
      token,
      user: { id: found.id, name: found.name, email: found.email, role: found.role ?? memberRole },
    };
  }

  async function createAccount(credentials: Credentials, role: string) {
    const created = await auth.api.createUser({
      body: {
        email: credentials.email,
        password: credentials.password,
        name: credentials.name,
        role: role as "member" | "owner",
      },
    });
    return created.user.id;
  }

  async function setupOwner(body: unknown): Promise<IssuedSession> {
    const credentials = readCredentials(body);
    if (setupRunning) throw new SetupClosedError("O primeiro acesso já está em andamento.");
    const run = (async () => {
      if (!(await needsOwner())) throw new SetupClosedError("O dono já foi criado. Peça um convite.");
      await createAccount(credentials, ownerRole);
      return signIn(credentials.email, credentials.password);
    })();
    setupRunning = run;
    try {
      return await run;
    } finally {
      setupRunning = null;
    }
  }

  async function createInvite(createdBy: string, body: unknown) {
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const email = typeof input.email === "string" && input.email.trim() ? input.email.trim().toLowerCase() : null;
    const code = `rbi_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const row = {
      id: ulid(),
      codeHash: hashCode(code),
      email,
      role: memberRole,
      createdBy,
      expiresAt: new Date(now + inviteTtlMs),
      createdAt: new Date(now),
    };
    await db.insert(invite).values(row);
    return { id: row.id, code, email, role: row.role, expiresAt: row.expiresAt.toISOString() };
  }

  async function listInvites() {
    const rows = await db
      .select()
      .from(invite)
      .where(and(isNull(invite.usedAt), gt(invite.expiresAt, new Date())));
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function revokeInvite(id: string) {
    await db.delete(invite).where(and(eq(invite.id, id), isNull(invite.usedAt)));
  }

  async function acceptInvite(body: unknown): Promise<IssuedSession> {
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const credentials = readCredentials(body);
    if (!code) throw new InviteInvalidError("Convite inválido ou vencido.");
    const [row] = await db
      .select()
      .from(invite)
      .where(and(eq(invite.codeHash, hashCode(code)), isNull(invite.usedAt), gt(invite.expiresAt, new Date())));
    if (!row) throw new InviteInvalidError("Convite inválido ou vencido.");
    if (row.email && row.email !== credentials.email) throw new InviteInvalidError("Este convite é para outro e-mail.");
    const claimed = await db
      .update(invite)
      .set({ usedAt: new Date() })
      .where(and(eq(invite.id, row.id), isNull(invite.usedAt)))
      .returning({ id: invite.id });
    if (claimed.length === 0) throw new InviteInvalidError("Convite inválido ou vencido.");
    const userId = await createAccount(credentials, row.role);
    await db.update(invite).set({ usedBy: userId }).where(eq(invite.id, row.id));
    return signIn(credentials.email, credentials.password);
  }

  async function issueRunnerKey(headers: Headers, userId: string) {
    const existing = await auth.api.listApiKeys({ headers });
    const list = Array.isArray(existing) ? existing : ((existing as { apiKeys?: unknown[] }).apiKeys ?? []);
    for (const item of list as { id: string; name: string | null }[]) {
      if (item.name === runnerKeyName) await auth.api.deleteApiKey({ headers, body: { keyId: item.id } });
    }
    const created = await auth.api.createApiKey({
      body: { name: runnerKeyName, userId, prefix: apiKeyPrefix, metadata: { kind: "runner" } },
    });
    return { id: created.id, key: created.key, name: runnerKeyName };
  }

  return { needsOwner, setupOwner, createInvite, listInvites, revokeInvite, acceptInvite, issueRunnerKey };
}

export type AccessService = ReturnType<typeof createAccessService>;

export function signSessionCookie(token: string, secret: string) {
  if (token.includes(".")) return token;
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}
