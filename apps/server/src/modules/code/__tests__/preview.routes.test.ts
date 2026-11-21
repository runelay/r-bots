import { afterAll, afterEach, beforeAll, describe, expect, type Mock, spyOn, test } from "bun:test";
import { waitFor } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { apiRoots } from "../../../app";
import { buildRequestContext, Req, Res, setRequestContext } from "../../../shared/http";
import type { Socket } from "../../../shared/ws";
import {
  handlePreview,
  isPreviewTraffic,
  issuePreviewTicket,
  onPreviewHost,
  previewHost,
  previewOrigin,
  previewSessionMs,
  previewSocket,
  previewUpgradeTarget,
  resetPreviewSessions,
  usePreviewClock,
} from "../routes/preview.routes";
import * as devServer from "../services/dev-server.service";

let server: TestServer;
const spies: Mock<(...args: never[]) => unknown>[] = [];
const upstreams: ReturnType<typeof Bun.serve>[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(async () => {
  for (const created of spies.splice(0)) created.mockRestore();
  await Promise.all(upstreams.splice(0).map((item) => item.stop(true)));
  resetPreviewSessions();
  usePreviewClock(null);
  delete process.env.BOTS_PREVIEW_ORIGIN;
});

function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const created = spyOn(target, key as never) as unknown as Mock<(...args: never[]) => unknown>;
  spies.push(created);
  return created;
}

function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  upstreams.push(target);
  return Number(target.port);
}

function serveToken(port: number, token = "tok-preview-1", workspace = "ws1") {
  spy(devServer, "previewTarget").mockImplementation(((workspaceId: string, asked: number) =>
    workspaceId === workspace && asked === port ? { port, token } : null) as never);
  spy(devServer, "findPreviewByToken").mockImplementation(((value: string) =>
    value === token ? { port, workspaceId: workspace, token } : null) as never);
  return token;
}

function cookieOf(response: { headers: Headers }) {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("preview exchange", () => {
  test("trades the link token once for a short HttpOnly cookie and redirects to the clean path", async () => {
    const port = upstream(() => new Response("ok"));
    const token = serveToken(port);
    const redirect = await request(`/preview/ws1/${port}/app/index%20x.html?t=${token}&q=1`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/app/index%20x.html");
    const setCookie = redirect.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^rb_preview=[\w-]{20,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7200$/);
    expect(setCookie).not.toContain(token);
    expect(previewSessionMs).toBe(2 * 60 * 60_000);
    const cookie = cookieOf(redirect);
    const reused = await request<{ error: string }>(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" });
    expect(reused.status).toBe(403);
    const reopened = await request(`/preview/ws1/${port}/again?t=${token}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(reopened.status).toBe(302);
    expect(reopened.headers.get("location")).toBe("/again");
    expect(reopened.headers.get("set-cookie")).toBeNull();
    expect((await request(`/preview/ws1/${port}?t=wrong`)).status).toBe(403);
    expect((await request(`/preview/ws1/abc?t=${token}`)).status).toBe(403);
    expect((await request("/preview")).status).toBe(403);
  });

  test("marks the cookie Secure behind https through tailscale serve", async () => {
    const port = upstream(() => new Response("ok"));
    const token = serveToken(port);
    const redirect = await request(`/preview/ws1/${port}/?t=${token}`, {
      redirect: "manual",
      headers: { "tailscale-user-login": "a@b.c", "x-forwarded-proto": "https" },
    });
    expect(redirect.headers.get("set-cookie")).toContain("; Secure;");
  });

  test("a session expires after two hours", async () => {
    const clock = { at: 1_000_000 };
    usePreviewClock(() => clock.at);
    const port = upstream(() => new Response("page"));
    const token = serveToken(port);
    const cookie = cookieOf(await request(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" }));
    expect((await request("/page", { headers: { cookie } })).status).toBe(200);
    clock.at += previewSessionMs;
    expect((await request("/page", { headers: { cookie } })).status).toBe(404);
  });
});

describe("preview tickets", () => {
  test("a ticket opens a session once, leaves the link token unused and expires after two minutes", async () => {
    const clock = { at: 5_000_000 };
    usePreviewClock(() => clock.at);
    const port = upstream(() => new Response("page"));
    const token = serveToken(port);
    const ticket = issuePreviewTicket(token);
    expect(ticket).toMatch(/^[\w-]{24}$/);
    expect(ticket).not.toContain(token);
    const redirect = await request(`/preview/ws1/${port}/app?t=${ticket}`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/app");
    expect((await request("/page", { headers: { cookie: cookieOf(redirect) } })).status).toBe(200);
    expect((await request(`/preview/ws1/${port}/?t=${ticket}`, { redirect: "manual" })).status).toBe(403);
    expect((await request(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" })).status).toBe(302);
    const late = issuePreviewTicket(token);
    clock.at += 2 * 60_000;
    expect((await request(`/preview/ws1/${port}/?t=${late}`, { redirect: "manual" })).status).toBe(403);
    const fresh = issuePreviewTicket(token);
    expect((await request(`/preview/ws1/${port}/?t=${fresh}`, { redirect: "manual" })).status).toBe(302);
  });

  test("a ticket for another server does not open this one", async () => {
    const port = upstream(() => new Response("page"));
    serveToken(port);
    const other = issuePreviewTicket("tok-other");
    expect((await request(`/preview/ws1/${port}/?t=${other}`, { redirect: "manual" })).status).toBe(403);
  });
});

describe("preview sessions", () => {
  test("keep a bounded number of sessions and forget tokens of stopped servers", async () => {
    let issued = 0;
    const live = new Set<string>();
    spy(devServer, "previewTarget").mockImplementation((() => {
      issued++;
      live.add(`tok-${issued}`);
      return { port: 5310, token: `tok-${issued}` };
    }) as never);
    spy(devServer, "findPreviewByToken").mockImplementation(((value: string) =>
      live.has(value) ? { port: 5310, workspaceId: "ws", token: value } : null) as never);
    const cookies: string[] = [];
    for (let index = 0; index < 502; index++) {
      const raw = new Request(`http://127.0.0.1/preview/ws/5310/?t=tok-${index + 1}`);
      const res = new Res(raw.signal);
      live.delete(`tok-${index}`);
      expect(handlePreview(new Req(raw), res, new URL(raw.url), ["preview", "ws", "5310"], apiRoots)).toBe(true);
      cookies.push(((await res.response).headers.get("set-cookie") ?? "").split(";")[0] ?? "");
    }
    const at = (cookie: string) => {
      const made = new Request("http://127.0.0.1/app", { headers: { cookie } });
      const context = buildRequestContext(made, "127.0.0.1");
      if (context) setRequestContext(made, context);
      return made;
    };
    live.add("tok-1");
    expect(isPreviewTraffic(at(cookies[0] ?? ""), apiRoots)).toBe(false);
    expect(isPreviewTraffic(at(cookies[501] ?? ""), apiRoots)).toBe(true);
  });
});

describe("preview proxy", () => {
  test("forwards without credentials, proxy or tailscale headers and strips dangerous answers", async () => {
    const seen: Array<{ method: string; path: string; body: string; headers: Record<string, string> }> = [];
    const port = upstream(async (incoming) => {
      const url = new URL(incoming.url);
      seen.push({
        method: incoming.method,
        path: `${url.pathname}${url.search}`,
        body: await incoming.text(),
        headers: Object.fromEntries(incoming.headers),
      });
      return new Response(`page ${url.pathname}`, {
        headers: {
          "x-upstream": "yes",
          "set-cookie": "steal=1; Path=/",
          "clear-site-data": '"cookies"',
          "service-worker-allowed": "/",
        },
      });
    });
    const token = serveToken(port);
    const cookie = cookieOf(await request(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" }));
    const page = await request("/assets/app.js?v=1", {
      headers: {
        cookie: `other=1; ${cookie}; better-auth.session_token=abc`,
        authorization: "Bearer rbk_secret",
        "x-api-key": "rbk_other",
        "proxy-authorization": "Basic x",
        "tailscale-user-login": "a@b.c",
        "x-forwarded-for": "1.2.3.4",
        "x-custom": "kept",
      },
    });
    expect(page.status).toBe(200);
    expect(page.text).toBe("page /assets/app.js");
    expect(page.headers.get("x-upstream")).toBe("yes");
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("clear-site-data")).toBeNull();
    expect(page.headers.get("service-worker-allowed")).toBeNull();
    const posted = await request("/form", { method: "POST", headers: { cookie }, body: "a=1" });
    expect(posted.status).toBe(200);
    expect(seen.map((item) => [item.method, item.path, item.body])).toEqual([
      ["GET", "/assets/app.js?v=1", ""],
      ["POST", "/form", "a=1"],
    ]);
    const forwarded = seen[0]?.headers ?? {};
    expect(forwarded.host).toBe(`localhost:${port}`);
    expect(forwarded["x-custom"]).toBe("kept");
    for (const name of [
      "cookie",
      "authorization",
      "x-api-key",
      "proxy-authorization",
      "tailscale-user-login",
      "x-forwarded-for",
    ])
      expect(forwarded[name]).toBeUndefined();
  });

  test("passes an answer without body through uncompressed", async () => {
    const methods: string[] = [];
    const port = upstream((incoming) => {
      methods.push(incoming.method);
      return new Response("<p>page</p>", { headers: { "content-type": "text/html" } });
    });
    const token = serveToken(port);
    const cookie = cookieOf(await request(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" }));
    const head = await request("/page", { method: "HEAD", headers: { cookie, "accept-encoding": "gzip" } });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(head.headers.get("content-encoding")).toBeNull();
    expect(methods).toEqual(["HEAD"]);
  });

  test("never shadows API routes, refuses service worker scripts and unknown cookies", async () => {
    const port = upstream(() => new Response("page"));
    const token = serveToken(port);
    const cookie = cookieOf(await request(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" }));
    for (const root of ["vault", "integrations", "devices", "usage", "jobs", "status"]) {
      const response = await request(`/${root}`, { headers: { cookie } });
      expect(response.text).not.toBe("page");
    }
    const worker = await request("/sw.js", { headers: { cookie, "service-worker": "script" } });
    expect(worker.status).toBe(403);
    expect((await request("/assets/app.js", { headers: { cookie: "rb_preview=unknown" } })).status).toBe(404);
    expect((await request("/assets/app.js")).status).toBe(404);
  });

  test("reports an upstream that is down without leaking the error", async () => {
    const port = upstream(() => new Response("x"));
    const token = serveToken(port);
    const cookie = cookieOf(await request(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" }));
    upstreams.pop()?.stop(true);
    const errors = spy(console, "error").mockImplementation(() => undefined);
    const response = await request<{ ok: boolean; error: string }>("/page", { headers: { cookie } });
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ ok: false, error: "O servidor de desenvolvimento não respondeu." });
    expect(errors).toHaveBeenCalled();
  });

  test("classifies preview traffic and upgrade targets with the normalized path", async () => {
    const port = upstream(() => new Response("x"));
    const token = serveToken(port, "good");
    const cookie = cookieOf(await request(`/preview/ws1/${port}/?t=${token}`, { redirect: "manual" }));
    const at = (path: string, headers: Record<string, string> = {}) => {
      const made = new Request(`http://127.0.0.1${path}`, { headers });
      const context = buildRequestContext(made, "127.0.0.1");
      if (context) setRequestContext(made, context);
      return made;
    };
    expect(isPreviewTraffic(at("/preview/x/1"), apiRoots)).toBe(true);
    expect(isPreviewTraffic(at("/bots", { cookie }), apiRoots)).toBe(false);
    expect(isPreviewTraffic(at("/%62ots/x", { cookie }), apiRoots)).toBe(false);
    expect(isPreviewTraffic(at("/app", { cookie }), apiRoots)).toBe(true);
    expect(isPreviewTraffic(at("/app", { cookie: "rb_preview=bad" }), apiRoots)).toBe(false);
    expect(isPreviewTraffic(at("/"), apiRoots)).toBe(false);
    expect(previewUpgradeTarget(new Req(at("/bots/x", { cookie })), apiRoots)).toBeNull();
    expect(previewUpgradeTarget(new Req(at("/preview/x", { cookie })), apiRoots)).toBeNull();
    expect(previewUpgradeTarget(new Req(at("/hmr")), apiRoots)).toBeNull();
    expect(
      previewUpgradeTarget(
        new Req(at("/hmr?x=1", { cookie, "sec-websocket-protocol": "vite-hmr, , other" })),
        apiRoots,
      ),
    ).toEqual({ port, path: "/hmr?x=1", protocols: ["vite-hmr", "other"] });
    expect(previewUpgradeTarget(new Req(at("/", { cookie })), apiRoots)).toEqual({ port, path: "/", protocols: [] });
  });
});

describe("preview origin", () => {
  test("reads BOTS_PREVIEW_ORIGIN and ignores bad values", () => {
    expect(previewOrigin({})).toBeNull();
    expect(previewOrigin({ BOTS_PREVIEW_ORIGIN: "nada" })).toBeNull();
    expect(previewOrigin({ BOTS_PREVIEW_ORIGIN: "ftp://x" })).toBeNull();
    expect(previewOrigin({ BOTS_PREVIEW_ORIGIN: " https://Preview.Example:8443/x " })?.host).toBe(
      "preview.example:8443",
    );
    expect(previewHost({ BOTS_PREVIEW_ORIGIN: "https://Preview.Example" })).toBe("preview.example");
    expect(previewHost({})).toBeNull();
    expect(onPreviewHost(new Request("http://preview.example/"))).toBe(false);
  });

  test("sends the link to the preview host and serves previews only there", async () => {
    process.env.BOTS_PREVIEW_ORIGIN = "https://preview.example.ts.net";
    const port = upstream(() => new Response("page"));
    const token = serveToken(port);
    const moved = await request(`/preview/ws1/${port}/a?t=${token}`, { redirect: "manual" });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe(`https://preview.example.ts.net/preview/ws1/${port}/a?t=${token}`);
    expect(moved.headers.get("set-cookie")).toBeNull();
    expect((await request(`/preview/ws1/${port}/a?t=wrong`)).status).toBe(403);
    const host = { host: "preview.example.ts.net" };
    const traded = await request(`/preview/ws1/${port}/a?t=${token}`, { redirect: "manual", headers: host });
    expect(traded.status).toBe(302);
    const cookie = cookieOf(traded);
    const there = await request("/bots", { headers: { ...host, cookie } });
    expect(there.text).toBe("page");
    const apiHost = await request("/assets/x.js", { headers: { cookie } });
    expect(apiHost.status).toBe(404);
  });
});

describe("preview socket relay", () => {
  function wsUpstream() {
    const received: string[] = [];
    const protocols: Array<string | null> = [];
    const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(incoming, srv) {
        protocols.push(incoming.headers.get("sec-websocket-protocol"));
        const protocol = incoming.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        return srv.upgrade(incoming, protocol ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {})
          ? undefined
          : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
        },
        message(ws, message) {
          received.push(String(message));
          ws.send(typeof message === "string" ? `echo:${message}` : message);
        },
        close(ws) {
          sockets.delete(ws);
        },
      },
    });
    upstreams.push(target);
    return { port: Number(target.port), received, protocols, sockets };
  }

  function fakeClient(data: Record<string, unknown>) {
    const sent: Array<string | Uint8Array> = [];
    let closed = 0;
    let onSend: () => void = () => undefined;
    let onClose: () => void = () => undefined;
    const client = {
      data: { kind: "preview", ...data },
      readyState: 1,
      send(message: string | Uint8Array) {
        sent.push(message);
        onSend();
      },
      close() {
        closed++;
        onClose();
      },
    } as unknown as Socket & { readyState: number };
    return {
      client,
      sent,
      closedCount: () => closed,
      nextSend: () =>
        new Promise<void>((resolve) => {
          onSend = resolve;
        }),
      nextClose: () =>
        new Promise<void>((resolve) => {
          onClose = resolve;
        }),
    };
  }

  test("queues until open, relays both ways and closes upstream", async () => {
    const { port, received, protocols, sockets } = wsUpstream();
    const fake = fakeClient({ port, path: "/hmr", protocols: ["vite-hmr"] });
    previewSocket.open(fake.client);
    const echoed = fake.nextSend();
    previewSocket.message(fake.client, "early");
    await echoed;
    expect(received).toEqual(["early"]);
    expect(fake.sent).toEqual(["echo:early"]);
    expect(protocols).toEqual(["vite-hmr"]);

    const binary = fake.nextSend();
    previewSocket.message(fake.client, Buffer.from([1, 2, 3]));
    await binary;
    expect(fake.sent[1]).toBeInstanceOf(Uint8Array);
    expect([...(fake.sent[1] as Uint8Array)]).toEqual([1, 2, 3]);

    fake.client.readyState = 3;
    previewSocket.message(fake.client, "after-close");
    await waitFor(() => received.includes("after-close"));
    const upstreamClosed = fake.nextClose();
    for (const socket of sockets) {
      socket.send("server push");
      socket.close();
    }
    await upstreamClosed;
    expect(fake.sent).toHaveLength(2);
    previewSocket.close(fake.client, 1000, "");
    previewSocket.message(fake.client, "ignored");
    expect(received).not.toContain("ignored");

    const second = fakeClient({ port, path: "/hmr", protocols: [] });
    previewSocket.open(second.client);
    await waitFor(() => sockets.size === 1);
    previewSocket.close(second.client, 1000, "");
    await waitFor(() => sockets.size === 0);
  });

  test("closes the client when the upstream closes or fails", async () => {
    const { port, sockets } = wsUpstream();
    const fake = fakeClient({ port, path: "/", protocols: undefined });
    const closed = fake.nextClose();
    previewSocket.open(fake.client);
    await waitFor(() => sockets.size === 1);
    for (const socket of sockets) socket.close();
    await closed;
    expect(fake.closedCount()).toBeGreaterThanOrEqual(1);

    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const deadPort = Number(dead.port);
    await dead.stop(true);
    const failing = fakeClient({ port: deadPort, path: "/", protocols: [] });
    const failed = failing.nextClose();
    previewSocket.open(failing.client);
    await failed;
    expect(failing.closedCount()).toBeGreaterThanOrEqual(1);
    previewSocket.close(failing.client, 1006, "");
  });
});
