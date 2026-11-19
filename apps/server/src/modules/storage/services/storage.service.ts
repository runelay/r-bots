import { blobDriver, blobsDir, s3Settings } from "../../../config/storage";
import type { BlobStore } from "./blob-store";
import { FsBlobStore } from "./fs-blob-store";
import { S3BlobStore } from "./s3-blob-store";

export function createBlobStore(env: Record<string, string | undefined> = process.env, root = blobsDir): BlobStore {
  if (blobDriver(env) === "fs") return new FsBlobStore(env.BLOB_FS_DIR ?? root);
  const settings = s3Settings(env);
  if (!settings.accessKeyId || !settings.secretAccessKey)
    throw new Error("BLOB_DRIVER=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
  return new S3BlobStore(settings);
}

let current: BlobStore | null = null;

export function getBlobStore() {
  current ??= createBlobStore();
  return current;
}

export function setBlobStore(store: BlobStore | null) {
  current = store;
}

export function blobKeys(botId: string) {
  return {
    upload: (uploadId: string, name: string) => `bots/${botId}/uploads/${uploadId}/${safeName(name)}`,
    derived: (uploadId: string, name: string) => `bots/${botId}/uploads/${uploadId}/derived/${safeName(name)}`,
  };
}

export function safeName(name: string) {
  const cleaned = name
    .replace(/[/\\\0]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return cleaned.slice(0, 200) || "file";
}
