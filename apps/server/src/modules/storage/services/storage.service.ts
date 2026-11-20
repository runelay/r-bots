import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { blobDriver, blobsDir, s3Settings } from "../../../config/storage";
import { type Db, getDb } from "../../../db";
import { blobs } from "../../../db/tables";
import type { BlobBody, BlobStore } from "./blob-store";
import { FsBlobStore } from "./fs-blob-store";
import { S3BlobStore } from "./s3-blob-store";

export function createBlobStore(env: Record<string, string | undefined> = process.env, root = blobsDir): BlobStore {
  if (blobDriver(env) === "fs") return new FsBlobStore(env.BLOB_FS_DIR ?? root);
  const settings = s3Settings(env);
  if (!settings.accessKeyId || !settings.secretAccessKey)
    throw new Error("BLOB_DRIVER=s3 needs the storage keys in <data>/secrets (run the storage-init service)");
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

export interface StoredBlob {
  key: string;
  size: number;
  mime: string;
  sha256: string;
}

export async function putBlob(
  key: string,
  body: BlobBody,
  options: { mime?: string; botId?: string | null; sessionId?: string | null } = {},
  store: BlobStore = getBlobStore(),
  db: Db = getDb(),
): Promise<StoredBlob> {
  const info = await store.put(key, body, options.mime ? { mime: options.mime } : {});
  const row = {
    key,
    mime: info.mime,
    size: info.size,
    sha256: info.sha256,
    botId: options.botId ?? null,
    sessionId: options.sessionId ?? null,
    createdAt: new Date().toISOString(),
  };
  await db
    .insert(blobs)
    .values(row)
    .onConflictDoUpdate({ target: blobs.key, set: { mime: row.mime, size: row.size, sha256: row.sha256 } });
  return info;
}

export async function blobText(key: string, store: BlobStore = getBlobStore()) {
  const stream = await store.get(key);
  return stream ? new Response(stream).text() : null;
}

export async function blobToFile(key: string, path: string, store: BlobStore = getBlobStore()) {
  const stream = await store.get(key);
  if (!stream) return false;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.part`;
  try {
    await Bun.write(temp, new Response(stream));
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return true;
}
