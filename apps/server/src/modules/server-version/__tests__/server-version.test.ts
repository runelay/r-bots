import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { env } from "../../../config/env";
import { redactText } from "../../../shared/redact";
import type { Principal } from "../../auth/services/auth.middleware";
import { authorize } from "../../auth/services/policy.service";
import { latestFailureTtlMs, latestTtlMs } from "../../providers/constants/providers.constants";
import { notesLimit } from "../constants/server-version.constants";
import { ghAuthToken, normalizeVersion, serverVersion, useServerVersionDeps } from "../services/server-version.service";
import type { ReleaseSettings, ServerVersion, ServerVersionDeps } from "../types/server-version.types";

interface Call {
  url: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];
let clock = 1_000_000;
let reply: () => Response | Promise<Response> = () => Response.json({});

const stableSettings: ReleaseSettings = { version: "0.2.0", channel: "stable", token: null, repo: "runelay/r-bots" };

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/runelay/r-bots/releases/tag/${tag}`,
    published_at: "2026-11-20T12:00:00Z",
    body: `notas de ${tag}`,
    draft: false,
    prerelease: tag.includes("-"),
    ...extra,
  };
}

function useFakes(settings: Partial<ReleaseSettings> = {}, overrides: Partial<ServerVersionDeps> = {}) {
  useServerVersionDeps({
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return reply();
    },
    now: () => clock,
    settings: () => ({ ...stableSettings, ...settings }),
    ghToken: async () => null,
    ...overrides,
  });
}

afterEach(() => {
  calls = [];
  clock = 1_000_000;
  reply = () => Response.json({});
  useServerVersionDeps(null);
});

describe("server version", () => {
  test("reads the stable latest release and offers the update", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes();
    expect(await serverVersion()).toEqual({
      current: "0.2.0",
      channel: "stable",
      latest: "0.3.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/runelay/r-bots/releases/tag/v0.3.0",
      publishedAt: "2026-11-20T12:00:00Z",
      notes: "notas de v0.3.0",
      updateCommand: "rbots update",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/runelay/r-bots/releases/latest");
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  test("the same or an older release is not an update", async () => {
    reply = () => Response.json(release("v0.2.0"));
    useFakes();
    expect(await serverVersion()).toMatchObject({ latest: "0.2.0", updateAvailable: false });
    useFakes({ version: "v0.4.0", repo: "acme/fork" });
    expect(await serverVersion()).toMatchObject({ current: "0.4.0", latest: "0.2.0", updateAvailable: false });
    expect(calls.at(-1)?.url).toBe("https://api.github.com/repos/acme/fork/releases/latest");
  });

  test("sends the token as a bearer and keeps it out of the logs", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({ token: "ghp_releasetoken123456" });
    await serverVersion();
    expect(calls[0].headers.authorization).toBe("Bearer ghp_releasetoken123456");
    expect(redactText("token ghp_releasetoken123456")).not.toContain("ghp_releasetoken123456");
  });

  test("falls back to the gh login when no token is configured", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({}, { ghToken: async () => "gho_fromghlogin123456" });
    await serverVersion();
    expect(calls[0].headers.authorization).toBe("Bearer gho_fromghlogin123456");
  });

  test("reads the gh token and ignores a missing or failing gh", async () => {
    const reply = (code: number, stdout: string) => async () => ({ code, stdout, stderr: "" });
    expect(await ghAuthToken(reply(0, "gho_token\n"))).toBe("gho_token");
    expect(await ghAuthToken(reply(0, "  "))).toBeNull();
    expect(await ghAuthToken(reply(1, "gho_token"))).toBeNull();
    expect(
      await ghAuthToken(async () => {
        throw new Error("gh not found");
      }),
    ).toBeNull();
  });

  test("dev never has an update", async () => {
    reply = () => Response.json(release("v9.0.0"));
    useFakes({ version: null });
    expect(await serverVersion()).toMatchObject({ current: "dev", latest: "9.0.0", updateAvailable: false });
    useFakes({ version: "dev" });
    expect(await serverVersion()).toMatchObject({ current: "dev", updateAvailable: false });
    useFakes({ version: "nightly" });
    expect(await serverVersion()).toMatchObject({ current: "nightly", updateAvailable: false });
  });

  test("the beta channel picks the newest release including pre-releases", async () => {
    reply = () =>
      Response.json([
        release("v0.3.0"),
        release("v0.4.0-beta.2"),
        release("v0.4.0-beta.10"),
        release("v0.9.0", { draft: true }),
        release("latest"),
        "garbage",
        null,
      ]);
    useFakes({ channel: "beta", version: "0.4.0-beta.2" });
    const version = await serverVersion();
    expect(version).toMatchObject({ channel: "beta", latest: "0.4.0-beta.10", updateAvailable: true });
    expect(calls[0].url).toBe("https://api.github.com/repos/runelay/r-bots/releases?per_page=30");
    useFakes({ channel: "beta", version: "0.4.0" });
    expect(await serverVersion()).toMatchObject({ latest: "0.4.0-beta.10", updateAvailable: false });
  });

  test("a beta answer that is not a list has no latest", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({ channel: "beta" });
    expect((await serverVersion()).latest).toBeNull();
  });

  test("cuts the notes and drops empty fields", async () => {
    reply = () => Response.json(release("v0.3.0", { body: "é".repeat(notesLimit + 500) }));
    useFakes();
    const notes = (await serverVersion()).notes ?? "";
    expect(Array.from(notes)).toHaveLength(notesLimit);
    reply = () => Response.json(release("v0.3.1", { body: "  ", html_url: 1, published_at: null }));
    useFakes();
    expect(await serverVersion()).toMatchObject({ latest: "0.3.1", notes: null, releaseUrl: null, publishedAt: null });
  });

  test("caches the release for 6 hours", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes();
    await serverVersion();
    clock += latestTtlMs - 1;
    await serverVersion();
    expect(calls).toHaveLength(1);
    reply = () => Response.json(release("v0.3.1"));
    clock += 1;
    expect((await serverVersion()).latest).toBe("0.3.1");
    expect(calls).toHaveLength(2);
  });

  test("caches a failure for 10 minutes and then asks again", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("Not Found", { status: 404 }),
      () => Promise.reject(new TypeError("fetch failed")),
      () => Response.json(["x"]),
      () => new Response("{", { status: 200 }),
    ];
    for (const failure of failures) {
      reply = failure;
      useFakes();
      expect(await serverVersion()).toMatchObject({
        latest: null,
        updateAvailable: false,
        releaseUrl: null,
        notes: null,
      });
      clock += latestFailureTtlMs - 1;
      await serverVersion();
      expect(calls).toHaveLength(1);
      reply = () => Response.json(release("v0.3.0"));
      clock += 1;
      expect((await serverVersion()).latest).toBe("0.3.0");
      expect(calls).toHaveLength(2);
      calls = [];
    }
  });

  test("gives up on GitHub after the deadline", async () => {
    let signal: AbortSignal | null = null;
    useFakes(
      {},
      {
        timeoutMs: 5,
        fetch: (_url, init) => {
          signal = init.signal;
          return new Promise<Response>((_resolve, reject) =>
            init.signal.addEventListener("abort", () => reject(init.signal.reason)),
          );
        },
      },
    );
    expect((await serverVersion()).latest).toBeNull();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  test("BOTS_UPDATE_CHECKS=off skips GitHub", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes({}, { checks: () => false });
    expect(await serverVersion()).toMatchObject({ current: "0.2.0", latest: null, updateAvailable: false });
    expect(calls).toEqual([]);
  });

  test("normalizes tags and the defaults read the environment without leaving the machine", async () => {
    expect(normalizeVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(normalizeVersion(" 1.2.3 ")).toBe("1.2.3");
    expect(normalizeVersion("1.2")).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
    const version = await serverVersion();
    expect(version).toMatchObject({
      current: normalizeVersion(env.RBOTS_VERSION) ?? env.RBOTS_VERSION?.trim() ?? "dev",
      channel: env.RBOTS_CHANNEL,
      latest: null,
      updateCommand: "rbots update",
    });
  });
});

describe("server version route", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  test("answers GET /server/version for the owner only", async () => {
    reply = () => Response.json(release("v0.3.0"));
    useFakes();
    const response = await request<ServerVersion>("/server/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toMatchObject({ current: "0.2.0", latest: "0.3.0", updateAvailable: true });
    expect((await request("/server/version", { method: "POST" })).status).toBe(404);
    expect((await request("/server/other")).status).toBe(404);
    const owner: Principal = { userId: "o", email: "o@x.co", name: "O", role: "owner", method: "session" };
    expect(authorize("GET", ["server", "version"], owner)).toBe("allow");
    expect(authorize("GET", ["server", "version"], { ...owner, role: "member" })).toBe("owner");
    expect(authorize("GET", ["server", "version"], { ...owner, method: "internal" })).toBe("deny-internal");
  });
});
