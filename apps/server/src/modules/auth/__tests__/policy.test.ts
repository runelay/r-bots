import { describe, expect, test } from "bun:test";
import type { Principal } from "../services/auth.middleware";
import {
  authorize,
  forbiddenResponse,
  internalAllowed,
  ownerRoutes,
  pathMatches,
  requiresOwner,
} from "../services/policy.service";

const owner: Principal = { userId: "o", email: "o@x.co", name: "O", role: "owner", method: "session" };
const member: Principal = { ...owner, userId: "m", role: "member" };
const internal: Principal = { ...owner, method: "internal" };

const split = (path: string) => path.split("/").filter(Boolean);

describe("route policy", () => {
  test("matches literal, single and trailing wildcard segments", () => {
    expect(pathMatches(["bots", "*"], split("/bots/b1"))).toBe(true);
    expect(pathMatches(["bots", "*"], split("/bots"))).toBe(false);
    expect(pathMatches(["bots", "*"], split("/bots/b1/x"))).toBe(false);
    expect(pathMatches(["vault", "**"], split("/vault"))).toBe(true);
    expect(pathMatches(["vault", "**"], split("/vault/secrets/a"))).toBe(true);
    expect(pathMatches(["code", "grants"], split("/code/repos"))).toBe(false);
  });

  test("owner-only routes", () => {
    const ownerOnly: Array<[string, string]> = [
      ["PUT", "/integrations/elevenlabs"],
      ["DELETE", "/integrations/jev"],
      ["GET", "/vault/secrets"],
      ["PUT", "/vault/secrets/github"],
      ["GET", "/code/grants"],
      ["DELETE", "/code/grants"],
      ["GET", "/jobs"],
      ["POST", "/jobs/j1/retry"],
      ["POST", "/connectors/refresh"],
      ["POST", "/connectors/github/install"],
      ["DELETE", "/connectors/github"],
      ["POST", "/bots"],
      ["PATCH", "/bots/b1"],
      ["POST", "/bots/b1/delete"],
      ["POST", "/bots/b1/restore"],
      ["POST", "/accounts/refresh"],
      ["POST", "/accounts/dirs"],
      ["PATCH", "/accounts/claude-2:claude"],
      ["DELETE", "/accounts/claude-2:claude"],
      ["POST", "/servers"],
      ["POST", "/servers/dev_1/stop"],
      ["DELETE", "/servers/profiles/p1"],
    ];
    for (const [method, path] of ownerOnly) {
      expect(requiresOwner(method, split(path))).toBe(true);
      expect(authorize(method, split(path), member)).toBe("owner");
      expect(authorize(method, split(path), owner)).toBe("allow");
    }
    expect(requiresOwner("GET", ["accounts"], new URLSearchParams("refresh=1"))).toBe(true);
    expect(authorize("GET", ["accounts"], member, new URLSearchParams("refresh=1"))).toBe("owner");
    expect(ownerRoutes.length).toBeGreaterThan(5);
  });

  test("members keep the normal use of bots and conversations", () => {
    const memberRoutes: Array<[string, string]> = [
      ["GET", "/bots"],
      ["GET", "/bots/b1"],
      ["POST", "/bots/b1/conversations/c1/messages"],
      ["PATCH", "/bots/b1/sidebar"],
      ["POST", "/bots/b1/archive"],
      ["GET", "/integrations"],
      ["GET", "/connectors"],
      ["GET", "/connectors/catalog"],
      ["GET", "/accounts"],
      ["GET", "/status"],
      ["GET", "/status/stream"],
      ["GET", "/devices"],
      ["GET", "/code/repos"],
      ["GET", "/accounts/login-guide"],
      ["GET", "/servers"],
      ["GET", "/servers/projects"],
    ];
    for (const [method, path] of memberRoutes) expect(authorize(method, split(path), member)).toBe("allow");
  });

  test("the internal token reaches only status and health", () => {
    expect(internalAllowed("GET", ["status"])).toBe(true);
    expect(authorize("GET", ["status"], internal)).toBe("allow");
    expect(authorize("GET", ["health"], internal)).toBe("allow");
    expect(authorize("GET", ["status", "stream"], internal)).toBe("deny-internal");
    expect(authorize("POST", ["status"], internal)).toBe("deny-internal");
    expect(authorize("GET", ["bots"], internal)).toBe("deny-internal");
    expect(authorize("PUT", ["vault", "secrets", "x"], internal)).toBe("deny-internal");
  });

  test("forbidden answers say why in pt-BR", async () => {
    const forOwner = forbiddenResponse("owner");
    expect(forOwner.status).toBe(403);
    expect(forOwner.headers.get("cache-control")).toBe("no-store");
    expect(await forOwner.json()).toEqual({
      ok: false,
      error: "Só o dono da conta pode fazer isso.",
      code: "forbidden",
    });
    expect(await forbiddenResponse("deny-internal").json()).toEqual({
      ok: false,
      error: "O token interno não tem acesso a esta rota.",
      code: "forbidden",
    });
  });
});
