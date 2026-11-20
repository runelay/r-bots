import { describe, expect, mock, test } from "bun:test";
import { ValidationError } from "../../../shared/errors";
import { buildRequestContext, setRequestContext } from "../../../shared/http";
import { createAuthRoutes } from "../routes/auth.routes";
import { type AccessService, InviteInvalidError, SetupClosedError } from "../services/accounts-access.service";
import type { Principal } from "../services/auth.middleware";
import type { Auth } from "../services/auth.service";

const base = "http://127.0.0.1:2998";

const owner: Principal = { userId: "u1", email: "o@example.com", name: "Dono", role: "owner", method: "session" };

function setup(access: Partial<AccessService> = {}, clock = { at: 1_000 }) {
  const auth = { handler: mock(async () => new Response("auth")), $context: Promise.resolve({}) } as unknown as Auth;
  const routes = createAuthRoutes({
    auth,
    access: { needsOwner: async () => true, ...access } as AccessService,
    secret: "s",
    now: () => clock.at,
  });
  return routes;
}

function post(path: string, body?: string, headers: Record<string, string> = {}) {
  return new Request(`${base}${path}`, { method: "POST", body, headers });
}

async function bodyOf(response: Response | null) {
  expect(response).not.toBeNull();
  return { status: (response as Response).status, body: await (response as Response).json() };
}

describe("auth routes", () => {
  test("a malformed JSON body is a 400 on the body field and an empty one reaches the service as undefined", async () => {
    const setupOwner = mock(async (input: unknown) => ({ received: input ?? null }));
    const routes = setup({ setupOwner } as unknown as Partial<AccessService>);
    expect(await bodyOf(await routes.handle(post("/auth/setup", "{bad"), null))).toEqual({
      status: 400,
      body: { ok: false, error: "JSON inválido.", field: "body" },
    });
    expect(await bodyOf(await routes.handle(post("/auth/setup", "   ", { "x-real-ip": "9.9.9.9" }), null))).toEqual({
      status: 201,
      body: { ok: true, received: null },
    });
    expect(setupOwner).toHaveBeenCalledTimes(1);
  });

  test("setup and invite errors map to their codes, client errors keep their status and others are rethrown", async () => {
    const acceptInvite = mock(async (): Promise<Record<string, unknown>> => {
      throw new InviteInvalidError("Convite inválido.");
    });
    const routes = setup({
      setupOwner: async () => {
        throw new SetupClosedError("Já tem dono.");
      },
      acceptInvite,
    } as unknown as Partial<AccessService>);
    expect(await bodyOf(await routes.handle(post("/auth/setup", "{}"), null))).toEqual({
      status: 409,
      body: { ok: false, error: "Já tem dono.", code: "setup_closed" },
    });
    expect(await bodyOf(await routes.handle(post("/auth/invites/accept", "{}"), null))).toEqual({
      status: 400,
      body: { ok: false, error: "Convite inválido.", code: "invite_invalid" },
    });
    acceptInvite.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Código expirado."), { statusCode: 410 });
    });
    expect(await bodyOf(await routes.handle(post("/auth/invites/accept", "{}"), null))).toEqual({
      status: 410,
      body: { ok: false, error: "Código expirado." },
    });
    acceptInvite.mockImplementationOnce(async () => {
      throw Object.assign(new Error(""), { statusCode: 422 });
    });
    expect(await bodyOf(await routes.handle(post("/auth/invites/accept", "{}"), null))).toEqual({
      status: 422,
      body: { ok: false, error: "Pedido inválido." },
    });
    acceptInvite.mockImplementationOnce(async () => {
      throw Object.assign(new Error("caiu"), { statusCode: 500 });
    });
    await expect(routes.handle(post("/auth/invites/accept", "{}"), null)).rejects.toThrow("caiu");
    acceptInvite.mockImplementationOnce(async () => {
      throw new ValidationError("Código obrigatório.", "code");
    });
    expect(await bodyOf(await routes.handle(post("/auth/invites/accept", "{}"), null))).toEqual({
      status: 400,
      body: { ok: false, error: "Código obrigatório.", field: "code" },
    });
  });

  test("setup is rate limited per client after five tries until the window resets", async () => {
    const clock = { at: 1_000 };
    const routes = setup({ setupOwner: async () => ({ token: "t" }) } as unknown as Partial<AccessService>, clock);
    const from = (ip: string) => {
      const request = post("/auth/setup", "{}", {
        "x-forwarded-for": `${ip}, 10.0.0.1`,
        "tailscale-user-login": "a@b.c",
      });
      const context = buildRequestContext(request, "127.0.0.1");
      if (context) setRequestContext(request, context);
      return request;
    };
    for (let i = 0; i < 5; i++) expect((await routes.handle(from("1.1.1.1"), null))?.status).toBe(201);
    clock.at += 20_500;
    const blocked = await routes.handle(from("1.1.1.1"), null);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("retry-after")).toBe("40");
    expect(await blocked?.json()).toEqual({
      ok: false,
      error: "Muitas tentativas. Espere um minuto.",
      code: "rate_limited",
    });
    expect((await routes.handle(from("2.2.2.2"), null))?.status).toBe(201);
    clock.at += 40_000;
    expect((await routes.handle(from("1.1.1.1"), null))?.status).toBe(201);
  });

  test("unknown auth paths and invite methods fall through to null", async () => {
    const routes = setup();
    expect(await routes.handle(new Request(`${base}/auth/other`), owner)).toBeNull();
    expect(await routes.handle(new Request(`${base}/auth/invites/abc`, { method: "PUT" }), owner)).toBeNull();
    expect(await routes.handle(new Request(`${base}/auth/invites/`, { method: "DELETE" }), owner)).toBeNull();
    expect(await routes.handle(new Request(`${base}/bots`), owner)).toBeNull();
  });
});
