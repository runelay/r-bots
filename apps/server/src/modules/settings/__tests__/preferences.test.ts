import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { requiresOwner } from "../../auth/services/policy.service";
import {
  type AppPreferences,
  defaultPreferences,
  onPreferences,
  readPreferences,
  updatePreferences,
} from "../services/preferences.service";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
  await updatePreferences({ notifications: defaultPreferences().notifications, microphone: null, microphones: [] });
});

describe("preferences", () => {
  test("reads defaults, patches and notifies listeners", async () => {
    const seen: AppPreferences[] = [];
    const stop = onPreferences((value) => seen.push(value));
    const first = await request<AppPreferences>("/preferences");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toMatchObject({ notifications: defaultPreferences().notifications, microphone: null });
    const patched = await request<AppPreferences>("/preferences", {
      method: "PATCH",
      body: { notifications: { failures: false }, microphones: ["USB", " USB ", "", "Mac"], microphone: " USB " },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      notifications: { replies: true, failures: false },
      microphone: "USB",
      microphones: ["USB", "Mac"],
    });
    expect(patched.body.updatedAt).toEqual(expect.any(String));
    expect(seen.at(-1)?.microphone).toBe("USB");
    stop();
    await updatePreferences({ microphone: "" });
    expect((await readPreferences()).microphone).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test("rejects invalid bodies and other methods", async () => {
    const bad = async (body: unknown) =>
      (await request<{ field?: string }>("/preferences", { method: "PATCH", body })).body.field;
    expect(await bad([1])).toBe("body");
    expect(await bad({ theme: "dark" })).toBe("theme");
    expect(await bad({ notifications: [] })).toBe("notifications");
    expect(await bad({ notifications: { sms: true } })).toBe("notifications.sms");
    expect(await bad({ notifications: { replies: "sim" } })).toBe("notifications.replies");
    expect(await bad({ microphones: "USB" })).toBe("microphones");
    expect(await bad({ microphone: 3 })).toBe("microphone");
    expect((await request("/preferences", { method: "DELETE" })).status).toBe(404);
    expect((await request("/preferences/x")).status).toBe(404);
    expect(requiresOwner("PATCH", ["preferences"])).toBe(true);
    expect(requiresOwner("GET", ["preferences"])).toBe(false);
  });
});
