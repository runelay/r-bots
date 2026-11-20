import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../../test/db-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { macRunnerConnected, revokedCloseCode } from "../../accounts/services/mac-runner.service";
import { type AuthModule, createAuthModule, type Principal } from "../../auth";
import { useAuthModule } from "../../auth/gate";
import type { AuthDatabase } from "../../auth/services/auth.service";
import {
  DevicesError,
  deviceKeyName,
  listDevices,
  listRegisteredDevices,
  registerDevice,
  revokeDevice,
} from "../services/devices.service";

type Device = { id: string; name: string; connected: boolean; userId: string; appVersion: string | null };
type Registered = { ok: boolean; device: Device; token: string };

let dir: string;
let mod: AuthModule;
let server: TestServer;
let ownerToken = "";
let ownerId = "";
let memberToken = "";
let memberId = "";

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function mac(name: string, machineId: string, extra: Record<string, unknown> = {}) {
  return { name, model: "Mac15,12", osVersion: "26.1", appVersion: "0.9.0", machineId, ...extra };
}

async function register(token: string, body: unknown) {
  return request<Registered>("/devices", { method: "POST", headers: bearer(token), body: JSON.stringify(body) });
}

function openSocket(token: string) {
  const url = `${server.url.replace("http", "ws")}/runner/connect`;
  const ws = new WebSocket(url, { headers: bearer(token) } as unknown as string[]);
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })),
  );
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("error", () => resolve(false));
  });
  return { ws, opened, closed };
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition never became true");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-devices-"));
  mod = createAuthModule({
    db: (await freshDb()) as unknown as AuthDatabase,
    env: {},
    dataDir: join(dir, "data"),
    repoDir: join(dir, "repo"),
    serverDir: join(dir, "server"),
    host: "127.0.0.1",
    port: 2999,
  });
  const owner = await mod.access.setupOwner(
    { name: "Dona", email: "dona@example.com", password: "correct horse battery" },
    readFileSync(mod.setupToken.issue(), "utf8").trim(),
  );
  ownerToken = owner.token;
  ownerId = owner.user.id;
  const invite = (await mod.access.createInvite(ownerId, {})) as { code: string };
  const member = await mod.access.acceptInvite({
    code: invite.code,
    name: "Membro",
    email: "membro@example.com",
    password: "correct horse battery",
  });
  memberToken = member.token;
  memberId = member.user.id;
  server = await startTestServer();
  useAuthModule(mod);
});

afterAll(async () => {
  useAuthModule(null);
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("devices", () => {
  test("registers a Mac with the session, refuses a device token and bad input", async () => {
    expect((await request("/devices")).status).toBe(401);
    const created = await register(ownerToken, mac("MacBook Air", "machine-1"));
    expect(created.status).toBe(201);
    expect(created.body.token).toStartWith("rbk_");
    expect(created.body.device).toMatchObject({ name: "MacBook Air", userId: ownerId, connected: false });
    expect(mod.origins.list()).toContain(new URL(server.url).origin);
    const memberCreated = await register(memberToken, mac("Mac do membro", "machine-8"));
    expect(memberCreated.status).toBe(201);
    expect(mod.origins.remembered()).toEqual([new URL(server.url).origin]);
    await revokeDevice({ userId: memberId, role: "member" } as Principal, memberCreated.body.device.id);
    const fromDevice = await register(created.body.token, mac("Outro", "machine-9"));
    expect(fromDevice.status).toBe(403);
    expect(fromDevice.body).toMatchObject({ code: "forbidden" });
    const noName = await register(ownerToken, { model: "x" });
    expect(noName.status).toBe(400);
    expect(noName.body).toMatchObject({ field: "name" });
    expect((await register(ownerToken, [])).status).toBe(400);
    const tooLong = await register(ownerToken, mac("Mac", "m", { model: "x".repeat(81) }));
    expect(tooLong.body).toMatchObject({ field: "model" });
    expect((await register(ownerToken, mac("Mac", "m", { osVersion: 3 }))).body).toMatchObject({ field: "osVersion" });
    const broken = await request("/devices", { method: "POST", headers: bearer(ownerToken), body: "{nope" });
    expect(broken.status).toBe(400);
    expect((await request("/devices/a/b", { headers: bearer(ownerToken) })).status).toBe(404);
    await revokeDevice({ userId: ownerId, role: "owner" } as Principal, created.body.device.id);
  });

  test("connects with the device token, keeps the id on re-register and revoking drops the socket", async () => {
    const first = await register(ownerToken, mac("Mac mini", "machine-2"));
    const id = first.body.device.id;
    const socket = openSocket(first.body.token);
    expect(await socket.opened).toBe(true);
    socket.ws.send(JSON.stringify({ type: "hello", version: "1.2.3", capabilities: ["turns"] }));
    await until(() => macRunnerConnected(id));
    await until(async () => {
      const listed = await request<{ devices: Device[] }>("/devices", { headers: bearer(ownerToken) });
      return listed.body.devices.some((item) => item.id === id && item.connected && item.appVersion === "1.2.3");
    });
    const stored = await listRegisteredDevices();
    expect(stored.find((item) => item.id === id)?.registeredAt).toBe(
      (first.body.device as Device & { registeredAt: string }).registeredAt,
    );
    const sessionSocket = openSocket(ownerToken);
    expect(await sessionSocket.opened).toBe(false);

    const again = await register(ownerToken, mac("Mac mini (novo nome)", "machine-2"));
    expect(again.body.device.id).toBe(id);
    expect(again.body.token).not.toBe(first.body.token);
    const stale = openSocket(first.body.token);
    expect(await stale.opened).toBe(false);

    const removed = await request<{ revoked: boolean; disconnected: boolean }>(`/devices/${id}`, {
      method: "DELETE",
      headers: bearer(ownerToken),
    });
    expect(removed.body).toMatchObject({ ok: true, revoked: true, disconnected: true });
    expect(await socket.closed).toMatchObject({ code: revokedCloseCode, reason: "revoked" });
    expect(macRunnerConnected(id)).toBe(false);
    expect((await request(`/devices/${id}`, { method: "DELETE", headers: bearer(ownerToken) })).status).toBe(404);
    expect(await openSocket(again.body.token).opened).toBe(false);
  });

  test("members see and revoke only their own Macs, the owner sees all", async () => {
    const ownerMac = await register(ownerToken, mac("Mac da dona", "machine-3"));
    const memberMac = await register(memberToken, mac("Mac do membro", "machine-4"));
    const memberList = await request<{ devices: Device[] }>("/devices", { headers: bearer(memberToken) });
    expect(memberList.body.devices.map((item) => item.name)).toEqual(["Mac do membro"]);
    const ownerList = await request<{ devices: Device[] }>("/devices", { headers: bearer(ownerToken) });
    expect(ownerList.body.devices.map((item) => item.userId).sort()).toEqual([ownerId, memberId].sort());
    const refused = await request(`/devices/${ownerMac.body.device.id}`, {
      method: "DELETE",
      headers: bearer(memberToken),
    });
    expect(refused.status).toBe(404);
    expect((await listRegisteredDevices()).map((item) => item.name).sort()).toEqual(["Mac da dona", "Mac do membro"]);
    const byOwner = await request(`/devices/${memberMac.body.device.id}`, {
      method: "DELETE",
      headers: bearer(ownerToken),
    });
    expect(byOwner.body).toMatchObject({ revoked: true, disconnected: false });
    await revokeDevice({ userId: ownerId, role: "owner" } as Principal, ownerMac.body.device.id);
  });

  test("a key with forged device metadata is not a device and new keys expire", async () => {
    const forged = await mod.auth.api.createApiKey({
      body: {
        name: deviceKeyName,
        userId: memberId,
        expiresIn: 86_400,
        metadata: { kind: "device", deviceId: "owner-mac", registeredAt: "2000-01-01T00:00:00.000Z" },
      },
    });
    const outcome = await mod.authenticate(
      new Request("http://127.0.0.1:2999/runner/connect", { headers: bearer(forged.key) }),
    );
    expect(outcome).toMatchObject({ kind: "principal", principal: { method: "api-key", userId: memberId } });
    expect((outcome as { principal: Principal }).principal.device).toBeUndefined();
    expect(await openSocket(forged.key).opened).toBe(false);
    const blocked = await request("/api/auth/api-key/create", {
      method: "POST",
      headers: { ...bearer(memberToken), origin: server.url },
      body: JSON.stringify({ name: "device", metadata: { kind: "device", deviceId: "x" } }),
    });
    expect(blocked.status).toBe(404);
    const owner = { userId: ownerId, role: "owner", method: "session" } as Principal;
    const unnamed = await registerDevice(owner, { name: "Sem id" });
    expect(unnamed.device).toMatchObject({ model: null, osVersion: null, appVersion: null });
    const key = (await mod.devices.list()).find((item) => item.id === unnamed.device.id);
    const verified = await mod.auth.api.verifyApiKey({ body: { key: unnamed.token } });
    const expires = new Date((verified.key as { expiresAt: Date }).expiresAt).getTime();
    expect(Math.round((expires - Date.now()) / 86_400_000)).toBe(180);
    expect(key?.apiKeyId).toBe(verified.key?.id);
    expect((await listRegisteredDevices()).find((item) => item.id === unnamed.device.id)).toMatchObject({
      owner: true,
      userId: ownerId,
    });
    await revokeDevice(owner, unnamed.device.id);
  });

  test("answers 401 without auth and lists nothing", async () => {
    useAuthModule(null);
    try {
      expect(await listRegisteredDevices()).toEqual([]);
      const response = await request<{ code: string }>("/devices");
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("unauthorized");
      const principal = { userId: "u", role: "owner", method: "session" } as Principal;
      await expect(listDevices(principal)).rejects.toBeInstanceOf(DevicesError);
      useAuthModule({
        devices: {
          roles: () => Promise.reject(new Error("db down")),
        },
      } as unknown as AuthModule);
      expect(await listRegisteredDevices()).toEqual([]);
    } finally {
      useAuthModule(mod);
    }
  });
});
