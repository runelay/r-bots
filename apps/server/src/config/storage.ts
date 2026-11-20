import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./env";

export const backupDir = process.env.BOTS_BACKUP_DIR ?? join(homedir(), ".local", "share", "runelay-bots-backups");
export const backupKeepDays = Number(process.env.BOTS_BACKUP_KEEP_DAYS ?? 7);
export const blobsDir = process.env.BLOB_FS_DIR ?? join(dataDir, "blobs");

export type BlobDriverName = "s3" | "fs";

export interface S3Settings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function blobDriver(env: Record<string, string | undefined> = process.env): BlobDriverName {
  return env.BLOB_DRIVER === "fs" ? "fs" : "s3";
}

export function s3Settings(env: Record<string, string | undefined> = process.env): S3Settings {
  return {
    endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:3900",
    bucket: env.S3_BUCKET ?? "runelay-bots",
    region: env.S3_REGION ?? "garage",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
  };
}
