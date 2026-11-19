import { describe, expect, test } from "bun:test";
import { blobDriver, s3Settings } from "../../../config/storage";
import { FsBlobStore } from "../services/fs-blob-store";
import { S3BlobStore } from "../services/s3-blob-store";
import { blobKeys, createBlobStore, getBlobStore, safeName, setBlobStore } from "../services/storage.service";

describe("storage service", () => {
  test("picks the driver from env", () => {
    expect(blobDriver({})).toBe("s3");
    expect(blobDriver({ BLOB_DRIVER: "fs" })).toBe("fs");
    expect(s3Settings({ S3_FORCE_PATH_STYLE: "false" }).forcePathStyle).toBe(false);
    expect(createBlobStore({ BLOB_DRIVER: "fs", BLOB_FS_DIR: "/tmp/x" }, "/tmp/y")).toBeInstanceOf(FsBlobStore);
    expect((createBlobStore({ BLOB_DRIVER: "fs" }, "/tmp/y") as FsBlobStore).root).toBe("/tmp/y");
    expect(createBlobStore({ S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "b" })).toBeInstanceOf(S3BlobStore);
    expect(() => createBlobStore({})).toThrow("S3_ACCESS_KEY_ID");
  });

  test("keeps one shared store", () => {
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

  test("builds safe keys", () => {
    const keys = blobKeys("bot");
    expect(keys.upload("u1", "a/b.png")).toBe("bots/bot/uploads/u1/a_b.png");
    expect(keys.derived("u1", "thumb.jpg")).toBe("bots/bot/uploads/u1/derived/thumb.jpg");
    expect(safeName("..hidden")).toBe("_hidden");
    expect(safeName("   ")).toBe("file");
  });
});
