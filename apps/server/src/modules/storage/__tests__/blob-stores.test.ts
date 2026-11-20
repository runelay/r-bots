import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeS3 } from "../../../../test/fake-s3";
import { s3Settings } from "../../../config/storage";
import { type BlobStore, hashing, sha256Of, toStream, validKey } from "../services/blob-store";
import { FsBlobStore } from "../services/fs-blob-store";
import { S3BlobStore } from "../services/s3-blob-store";

const dir = mkdtempSync(join(tmpdir(), "rb-blobs-"));
const fake = startFakeS3("bucket");
afterAll(() => {
  fake.server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const expectedSha = new Bun.CryptoHasher("sha256").update("hello world").digest("hex");

async function text(stream: ReadableStream<Uint8Array> | null) {
  return stream ? new Response(stream).text() : null;
}

async function collect(store: BlobStore, prefix?: string) {
  const keys: string[] = [];
  for await (const head of store.list(prefix)) keys.push(head.key);
  return keys;
}

const stores: [string, () => BlobStore][] = [
  ["fs", () => new FsBlobStore(join(dir, "fs"))],
  [
    "s3",
    () =>
      new S3BlobStore({
        ...s3Settings({}),
        endpoint: fake.endpoint,
        bucket: "bucket",
        accessKeyId: "id",
        secretAccessKey: "secret",
      }),
  ],
];

for (const [name, make] of stores) {
  describe(`${name} blob store`, () => {
    const store = make();

    test("puts, reads, heads, lists and deletes", async () => {
      const info = await store.put("a/b c.txt", "hello world", { mime: "text/plain" });
      expect(info).toEqual({ key: "a/b c.txt", mime: "text/plain", size: 11, sha256: expectedSha });
      expect(await text(await store.get("a/b c.txt"))).toBe("hello world");
      const head = await store.head("a/b c.txt");
      expect(head?.size).toBe(11);
      expect(head?.mime.startsWith("text/plain")).toBe(true);
      await store.put("z/blob.bin", new Blob([new Uint8Array([1, 2, 3])], { type: "application/x-test" }));
      await store.put("z/raw.bin", new Uint8Array([4]));
      expect(await collect(store)).toEqual(["a/b c.txt", "z/blob.bin", "z/raw.bin"]);
      expect(await collect(store, "z/")).toEqual(["z/blob.bin", "z/raw.bin"]);
      await store.delete("a/b c.txt");
      expect(await store.get("a/b c.txt")).toBeNull();
      expect(await store.head("a/b c.txt")).toBeNull();
      await store.delete("missing");
    });

    test("streams large bodies", async () => {
      const big = new Uint8Array(9 * 1024 * 1024).map((_, index) => index % 251);
      const info = await store.put("big.bin", new Response(big).body as ReadableStream<Uint8Array>);
      expect(info.size).toBe(big.byteLength);
      expect(info.mime).toBe("application/octet-stream");
      const read = await store.get("big.bin");
      expect((await sha256Of(read as ReadableStream<Uint8Array>)).sha256).toBe(info.sha256);
    });

    test("rejects unsafe keys", async () => {
      await expect(store.put("../x", "a")).rejects.toThrow("invalid blob key");
    });
  });
}

describe("fs specifics", () => {
  test("presign is not available and missing mime falls back", async () => {
    const store = new FsBlobStore(join(dir, "fs2"));
    expect(await store.presign()).toBeNull();
    await store.put("k", "v");
    rmSync(join(dir, "fs2", "k.mime"));
    expect((await store.head("k"))?.mime).toBe("application/octet-stream");
    expect(await collect(new FsBlobStore(join(dir, "none")))).toEqual([]);
  });

  test("cleans the temp file when the body fails", async () => {
    const store = new FsBlobStore(join(dir, "fs3"));
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("broken"));
      },
    });
    await expect(store.put("k", broken)).rejects.toThrow();
    expect(await collect(store)).toEqual([]);
  });
});

describe("s3 specifics", () => {
  const store = new S3BlobStore({
    ...s3Settings({ S3_FORCE_PATH_STYLE: "true" }),
    endpoint: fake.endpoint,
    bucket: "bucket",
    accessKeyId: "id",
    secretAccessKey: "secret",
  });

  test("presigns get and put", async () => {
    expect(await store.presign("a")).toContain("X-Amz-Signature");
    expect(await store.presign("a", { method: "PUT", expiresIn: 60, mime: "text/plain" })).toContain(
      "X-Amz-Expires=60",
    );
  });

  test("lists across pages", async () => {
    const paged = new S3BlobStore({
      ...s3Settings({}),
      endpoint: fake.endpoint,
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
    });
    for (let index = 0; index < 1002; index++)
      fake.objects.set(`p/${String(index).padStart(4, "0")}`, {
        body: new Uint8Array([1]),
        type: "",
        modified: new Date(),
      });
    expect((await collect(paged, "p/")).length).toBe(1002);
    for (const key of [...fake.objects.keys()]) if (key.startsWith("p/")) fake.objects.delete(key);
  });

  test("rethrows unexpected head errors and aborts failed uploads", async () => {
    const broken = new S3BlobStore({
      ...s3Settings({}),
      endpoint: "http://127.0.0.1:1",
      bucket: "b",
      accessKeyId: "i",
      secretAccessKey: "s",
    });
    await expect(broken.head("k")).rejects.toBeDefined();
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("broken"));
      },
    });
    await expect(store.put("k", failing)).rejects.toThrow("broken");
  });
});

describe("helpers", () => {
  test("validKey, toStream and hashing", async () => {
    expect(() => validKey("")).toThrow();
    expect(() => validKey("/a")).toThrow();
    expect(() => validKey("a/./b")).toThrow();
    expect(validKey("a/b")).toBe("a/b");
    for (const bad of ["a/../b", "..", "a/b/..", "a//b", "a/", "a\0b", "a/\u0000", "a\\..\\b", "a\nb", "a\u007fb"])
      expect(() => validKey(bad)).toThrow("invalid blob key");
    expect(() => validKey("x".repeat(1025))).toThrow();
    expect(validKey("a/%2e%2e/b")).toBe("a/%2e%2e/b");
    const fsStore = new FsBlobStore(join(dir, "validkey"));
    await fsStore.put("a/%2e%2e/b", "x");
    expect(await fsStore.head("a/%2e%2e/b")).toMatchObject({ size: 1 });
    await expect(fsStore.put("a/../../escape", "x")).rejects.toThrow("invalid blob key");
    await expect(fsStore.put("a/b\u0000c", "x")).rejects.toThrow("invalid blob key");
    const stream = toStream("x");
    expect(toStream(stream)).toBe(stream);
    const hashed = hashing(new ArrayBuffer(2));
    await new Response(hashed.stream).arrayBuffer();
    expect(hashed.result().size).toBe(2);
  });
});
