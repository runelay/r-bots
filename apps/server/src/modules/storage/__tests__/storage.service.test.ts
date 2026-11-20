import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../../test/db-helpers";
import { blobDriver, s3Settings } from "../../../config/storage";
import { tables } from "../../../db";
import { FsBlobStore } from "../services/fs-blob-store";
import { S3BlobStore } from "../services/s3-blob-store";
import {
  blobKeys,
  blobText,
  blobToFile,
  createBlobStore,
  getBlobStore,
  putBlob,
  safeName,
  setBlobStore,
} from "../services/storage.service";

const dir = mkdtempSync(join(tmpdir(), "rb-storage-"));
afterAll(async () => rmSync(dir, { recursive: true, force: true }));

describe("storage service", () => {
  test("picks the driver from env", async () => {
    expect(blobDriver({})).toBe("s3");
    expect(blobDriver({ BLOB_DRIVER: "fs" })).toBe("fs");
    expect(s3Settings({ S3_FORCE_PATH_STYLE: "false" }).forcePathStyle).toBe(false);
    expect(createBlobStore({ BLOB_DRIVER: "fs", BLOB_FS_DIR: "/tmp/x" }, "/tmp/y")).toBeInstanceOf(FsBlobStore);
    expect((createBlobStore({ BLOB_DRIVER: "fs" }, "/tmp/y") as FsBlobStore).root).toBe("/tmp/y");
    expect(createBlobStore({ S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "b" })).toBeInstanceOf(S3BlobStore);
    expect(() => createBlobStore({ BOTS_DATA_DIR: dir })).toThrow("storage keys");
  });

  test("reads the storage keys from the secrets folder", async () => {
    const root = join(dir, "keys");
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets", "s3.access-key-id"), "GKfile\n");
    writeFileSync(join(root, "secrets", "s3.secret-access-key"), "secret-from-file\n");
    const settings = s3Settings({ BOTS_DATA_DIR: root });
    expect(settings.accessKeyId).toBe("GKfile");
    expect(settings.secretAccessKey).toBe("secret-from-file");
    expect(s3Settings({ BOTS_DATA_DIR: root, S3_ACCESS_KEY_ID: "GKenv" }).accessKeyId).toBe("GKenv");
    expect(createBlobStore({ BOTS_DATA_DIR: root })).toBeInstanceOf(S3BlobStore);
  });

  test("keeps one shared store", async () => {
    const store = new FsBlobStore("/tmp/z");
    setBlobStore(store);
    expect(getBlobStore()).toBe(store);
    setBlobStore(null);
    const previous = { driver: process.env.BLOB_DRIVER };
    process.env.BLOB_DRIVER = "fs";
    expect(getBlobStore().driver).toBe("fs");
    setBlobStore(null);
    if (previous.driver === undefined) delete process.env.BLOB_DRIVER;
    else process.env.BLOB_DRIVER = previous.driver;
  });

  test("builds safe keys", async () => {
    const keys = blobKeys("bot");
    expect(keys.upload("u1", "a/b.png")).toBe("bots/bot/uploads/u1/a_b.png");
    expect(keys.derived("u1", "thumb.jpg")).toBe("bots/bot/uploads/u1/derived/thumb.jpg");
    expect(safeName("..hidden")).toBe("_hidden");
    expect(safeName("   ")).toBe("file");
  });
});

describe("blob helpers", () => {
  test("putBlob stores the object and records or updates its row", async () => {
    const store = new FsBlobStore(join(dir, "put"));
    const db = await freshDb();
    const first = await putBlob("bots/b/one.txt", "abc", { mime: "text/plain", botId: "b", sessionId: "s" }, store, db);
    expect(first).toMatchObject({ key: "bots/b/one.txt", size: 3, mime: "text/plain" });
    const again = await putBlob("bots/b/one.txt", "abcdef", {}, store, db);
    expect(again.mime).toBe("application/octet-stream");
    expect(await db.select().from(tables.blobs)).toEqual([
      {
        key: "bots/b/one.txt",
        mime: "application/octet-stream",
        size: 6,
        sha256: again.sha256,
        botId: "b",
        sessionId: "s",
        createdAt: expect.any(String),
      },
    ]);
    expect(await blobText("bots/b/one.txt", store)).toBe("abcdef");
    expect(await blobText("bots/b/none.txt", store)).toBeNull();
  });

  test("putBlob uses the shared store and database by default", async () => {
    const stored = await putBlob("tests/storage/shared.txt", "oi");
    expect(await blobText(stored.key)).toBe("oi");
    expect(await blobToFile(stored.key, join(dir, "shared", "copy.txt"))).toBe(true);
    expect(readFileSync(join(dir, "shared", "copy.txt"), "utf8")).toBe("oi");
  });

  test("blobToFile writes atomically, reports a missing key and cleans up on failure", async () => {
    const store = new FsBlobStore(join(dir, "copy"));
    await store.put("a/b.txt", "conteúdo");
    const target = join(dir, "out", "deep", "b.txt");
    expect(await blobToFile("a/b.txt", target, store)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("conteúdo");
    expect(await blobToFile("a/missing.txt", join(dir, "out", "missing.txt"), store)).toBe(false);
    expect(existsSync(join(dir, "out", "missing.txt"))).toBe(false);
    const write = spyOn(Bun, "write").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(blobToFile("a/b.txt", join(dir, "out", "fail.txt"), store)).rejects.toThrow("disk full");
    } finally {
      write.mockRestore();
    }
    expect(readdirSync(join(dir, "out"))).toEqual(["deep"]);
  });
});
