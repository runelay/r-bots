import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../../test/db-helpers";
import type { BlobStore } from "../../storage/services/blob-store";
import { FsBlobStore } from "../../storage/services/fs-blob-store";
import { type AuthModule, createAuthModule } from "..";
import { createAuthRoutes } from "../routes/auth.routes";
import type { AccessService } from "../services/accounts-access.service";
import type { Principal } from "../services/auth.middleware";
import type { Auth } from "../services/auth.service";
import { avatarMaxBytes, avatarPath, createAvatarService } from "../services/avatar.service";

const base = "http://127.0.0.1:2997";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP"), 1]);

let dir: string;
let store: FsBlobStore;
let mod: AuthModule;
let token = "";
let userId = "";

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const request = new Request(`${base}${path}`, { ...init, headers });
  const outcome = await mod.authenticate(request);
  if (outcome instanceof Response) return outcome;
  const principal = outcome.kind === "principal" ? outcome.principal : null;
  return (await mod.handle(request, principal)) ?? new Response(null, { status: 418 });
}

function upload(body: Uint8Array, type: string) {
  return call("/auth/me/avatar", { method: "PUT", body, headers: { "content-type": type }, token });
}

async function blobFiles() {
  const keys: string[] = [];
  for await (const head of store.list(`users/${userId}/avatar/`)) keys.push(head.key);
  return keys;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-avatar-"));
  store = new FsBlobStore(join(dir, "blobs"));
  mod = createAuthModule({
    db: await freshDb(),
    env: {},
    dataDir: join(dir, "data"),
    repoDir: join(dir, "repo"),
    serverDir: join(dir, "server"),
    host: "127.0.0.1",
    port: 2997,
    blobs: () => store,
  });
  const created = await call("/auth/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-setup-token": readFileSync(mod.setupToken.issue(), "utf8").trim(),
    },
    body: JSON.stringify({ name: "Dona", email: "dona@example.com", password: "correct horse battery" }),
  });
  const body = (await created.json()) as { token: string; user: { id: string } };
  token = body.token;
  userId = body.user.id;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("avatar", () => {
  test("starts without a photo and /auth/me reports image null", async () => {
    const me = (await (await call("/auth/me", { token })).json()) as { user: { image: string | null } };
    expect(me.user.image).toBeNull();
  });

  test("uploading a png stores it, links it to the user and serves it back", async () => {
    const response = await upload(png, "image/png");
    expect(response.status).toBe(200);
    const { image } = (await response.json()) as { image: string };
    expect(image).toMatch(new RegExp(`^/auth/avatars/${userId}/[a-z0-9-]+\\.png$`));
    const me = (await (await call("/auth/me", { token })).json()) as { user: { image: string } };
    expect(me.user.image).toBe(image);
    const served = await call(image, { token });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    expect(await blobFiles()).toHaveLength(1);
  });

  test("a new photo replaces the old blob, and jpeg and webp are accepted", async () => {
    const first = (await (await upload(jpeg, "image/jpeg")).json()) as { image: string };
    expect(first.image.endsWith(".jpg")).toBe(true);
    const second = (await (await upload(webp, "image/webp; charset=binary")).json()) as { image: string };
    expect(second.image.endsWith(".webp")).toBe(true);
    const files = await blobFiles();
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith(".webp")).toBe(true);
    expect((await call(first.image, { token })).status).toBe(404);
  });

  test("rejects unsupported types, empty bodies, lying files and oversized uploads", async () => {
    const gif = await upload(new Uint8Array([0x47, 0x49, 0x46]), "image/gif");
    expect(gif.status).toBe(400);
    expect(await gif.json()).toEqual({ ok: false, error: "Envie uma imagem PNG, JPEG ou WebP.", field: "image" });
    expect((await upload(new Uint8Array(), "image/png")).status).toBe(400);
    const lie = await upload(jpeg, "image/png");
    expect(((await lie.json()) as { error: string }).error).toBe("O arquivo não é a imagem que diz ser.");
    const big = new Uint8Array(avatarMaxBytes + 1);
    big.set(png);
    const tooBig = await upload(big, "image/png");
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { code: string }).code).toBe("too_large");
  });

  test("serving needs a session and unknown or malformed paths are 404", async () => {
    const me = (await (await call("/auth/me", { token })).json()) as { user: { image: string } };
    expect((await call(me.user.image)).status).toBe(401);
    expect((await call(avatarPath(userId, "nope.png"), { token })).status).toBe(404);
    expect((await call(avatarPath(userId, "../x.png"), { token })).status).toBe(404);
    expect((await call("/auth/avatars/bad%2Fid/a.png", { token })).status).toBe(418);
    expect((await call("/auth/me/avatar", { token })).status).toBe(418);
  });

  test("delete clears the image and removes the blob", async () => {
    const response = await call("/auth/me/avatar", { method: "DELETE", token });
    expect(await response.json()).toEqual({ ok: true, image: null });
    expect(await blobFiles()).toHaveLength(0);
    const again = await call("/auth/me/avatar", { method: "DELETE", token });
    expect(again.status).toBe(200);
    const me = (await (await call("/auth/me", { token })).json()) as { user: { image: string | null } };
    expect(me.user.image).toBeNull();
  });

  test("an image that points elsewhere is kept on disk when replaced", async () => {
    const context = await mod.auth.$context;
    await context.internalAdapter.updateUser(userId, { image: "https://example.com/me.png" });
    const saved = await upload(png, "image/png");
    expect(saved.status).toBe(200);
    await call("/auth/me/avatar", { method: "DELETE", token });
  });
});

describe("avatar routes without a user", () => {
  const principal: Principal = { userId: "ghost", email: "", name: "", role: "owner", method: "internal" };
  const missing = {
    $context: Promise.resolve({ internalAdapter: { findUserById: async () => null } }),
  } as unknown as Auth;

  test("a principal with no account gets 404 on upload and has no image", async () => {
    const avatars = createAvatarService(missing, () => store);
    const routes = createAuthRoutes({ auth: missing, access: {} as AccessService, avatars, secret: "s" });
    const put = new Request(`${base}/auth/me/avatar`, {
      method: "POST",
      body: png,
      headers: { "content-type": "image/png" },
    });
    const response = await routes.handle(put, principal);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ ok: false, error: "Conta não encontrada.", code: "not_found" });
    expect(await avatars.imageOf("ghost")).toBeNull();
  });

  test("a blob that vanishes between head and get is not served", async () => {
    const vanishing = {
      head: async () => ({ key: "k", size: 1, mime: "image/png", modifiedAt: null }),
      get: async () => null,
    } as unknown as BlobStore;
    expect(await createAvatarService(missing, () => vanishing).read("u1", "a.png")).toBeNull();
  });
});
