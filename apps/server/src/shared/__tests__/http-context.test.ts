import { describe, expect, spyOn, test } from "bun:test";
import {
  buildRequestContext,
  clientIpOf,
  hasProxyHeaders,
  internalError,
  isLoopback,
  normalizePath,
  Res,
  requestContext,
  setRequestContext,
  viaTrustedProxy,
  withSecurityHeaders,
} from "../http";

describe("path normalization", () => {
  test("decodes once and keeps ordinary segments", () => {
    expect(normalizePath("/bots/b%C3%A1/conversations/")).toEqual({
      pathname: "/bots/bá/conversations",
      parts: ["bots", "bá", "conversations"],
    });
    expect(normalizePath("/%62ots/x")).toEqual({ pathname: "/bots/x", parts: ["bots", "x"] });
    expect(normalizePath("/")).toEqual({ pathname: "/", parts: [] });
    expect(normalizePath("//health")).toEqual({ pathname: "/health", parts: ["health"] });
  });

  test("refuses encoded separators, dot segments, double encoding and control characters", () => {
    for (const bad of [
      "/bots/a%2Fb",
      "/bots/a%5Cb",
      "/bots/%2e%2e/vault",
      "/bots/%2E",
      "/bots/a\\b",
      "/bots/%252e",
      "/bots/%2562ots",
      "/bots/%E0%A4%A",
      "/bots/a%00b",
      "/bots/a%0Ab",
    ])
      expect(normalizePath(bad)).toBeNull();
  });
});

describe("request context", () => {
  test("trusts forwarded headers only from tailscale serve on loopback", () => {
    const tailnet = new Headers({ "tailscale-user-login": "a@b.c", "x-forwarded-for": "100.64.0.9, 10.0.0.1" });
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(viaTrustedProxy(tailnet, "127.0.0.1")).toBe(true);
    expect(viaTrustedProxy(new Headers({ "tailscale-headers-info": "x" }), "::1")).toBe(true);
    expect(viaTrustedProxy(tailnet, "10.0.0.1")).toBe(false);
    expect(viaTrustedProxy(new Headers({ "x-forwarded-for": "1.2.3.4" }), "127.0.0.1")).toBe(false);
    expect(clientIpOf(tailnet, "127.0.0.1")).toBe("100.64.0.9");
    expect(clientIpOf(new Headers({ "tailscale-user-login": "a" }), "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIpOf(new Headers({ "x-forwarded-for": "6.6.6.6" }), "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIpOf(new Headers(), "")).toBe("unknown");
    expect(hasProxyHeaders(new Headers({ "X-Forwarded-For": "1" }))).toBe(true);
    expect(hasProxyHeaders(new Headers({ "Tailscale-User-Login": "a" }))).toBe(true);
    expect(hasProxyHeaders(new Headers({ forwarded: "for=1" }))).toBe(true);
    expect(hasProxyHeaders(new Headers({ "x-real-ip": "1" }))).toBe(true);
    expect(hasProxyHeaders(new Headers({ accept: "*/*" }))).toBe(false);
  });

  test("builds once, is reused and falls back for paths that do not normalize", () => {
    const request = new Request("http://127.0.0.1:2000/%62ots/x", { headers: { "tailscale-user-login": "a" } });
    const built = buildRequestContext(request, "127.0.0.1", 2000);
    expect(built).toEqual({
      pathname: "/bots/x",
      parts: ["bots", "x"],
      peer: "127.0.0.1",
      viaProxy: true,
      clientIp: "127.0.0.1",
      listenPort: 2000,
    });
    if (built) setRequestContext(request, built);
    expect(requestContext(request)).toBe(built as NonNullable<typeof built>);
    expect(buildRequestContext(new Request("http://x/a%2Fb"), "")).toBeNull();
    const odd = new Request("http://x/a%2Fb");
    expect(requestContext(odd)).toEqual({
      pathname: "/",
      parts: [],
      peer: "",
      viaProxy: false,
      clientIp: "unknown",
      listenPort: null,
    });
    expect(requestContext(odd)).toBe(requestContext(odd));
    expect(requestContext(new Request("http://x/health")).parts).toEqual(["health"]);
  });
});

describe("security headers and errors", () => {
  test("adds the baseline headers without overriding what a route set", async () => {
    const json = withSecurityHeaders(Response.json({ ok: true }, { status: 201 }), "/bots");
    expect(json.status).toBe(201);
    expect(json.headers.get("x-content-type-options")).toBe("nosniff");
    expect(json.headers.get("referrer-policy")).toBe("no-referrer");
    expect(json.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(json.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(json.headers.get("permissions-policy")).toContain("camera=()");
    expect(json.headers.get("cache-control")).toBe("no-store");
    expect(await json.json()).toEqual({ ok: true });
    const artifact = withSecurityHeaders(
      new Response("<p>", {
        headers: {
          "content-type": "text/html",
          "cache-control": "private, max-age=60",
          "cross-origin-resource-policy": "cross-origin",
        },
      }),
      "/bots/b/artifacts/a/v/1.html",
    );
    expect(artifact.headers.get("cache-control")).toBe("private, max-age=60");
    expect(artifact.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const page = withSecurityHeaders(new Response("html", { headers: { "content-type": "text/html" } }), "/device");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(withSecurityHeaders(new Response("x"), "/auth/me").headers.get("cache-control")).toBe("no-store");
    expect(withSecurityHeaders(new Response("x"), "/api/auth/ok").headers.get("cache-control")).toBe("no-store");
    expect(withSecurityHeaders(new Response("x"), "/files").headers.get("cache-control")).toBeNull();
    const asset = withSecurityHeaders(new Response("img"), "/bots/b1/artifacts/a/v/1/img.png");
    expect(asset.headers.get("cross-origin-resource-policy")).toBeNull();
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      withSecurityHeaders(new Response("f"), "/bots/b1/uploads/u1").headers.get("cross-origin-resource-policy"),
    ).toBeNull();
  });

  test("a failing request answers a generic message with an id and logs the details", async () => {
    const logged: unknown[][] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const res = new Res(new AbortController().signal);
      const id = internalError(res, new Error("segredo do banco"));
      const response = await res.response;
      expect(response.status).toBe(500);
      const body = (await response.json()) as { ok: boolean; errorId: string; error: string };
      expect(body).toEqual({ ok: false, error: "Algo deu errado no servidor. Tente de novo.", errorId: id });
      expect(JSON.stringify(body)).not.toContain("segredo");
      expect(logged[0]?.[0]).toBe(`request failed (${id})`);
      const streaming = new Res(new AbortController().signal);
      streaming.write("partial");
      internalError(streaming, new Error("late"));
      expect(await (await streaming.response).text()).toBe("partial");
    } finally {
      error.mockRestore();
    }
  });
});
