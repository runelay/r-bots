import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rememberSecretValue } from "../shared/redact";
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

export function s3SecretsDir(env: Record<string, string | undefined> = process.env) {
  return join(env.BOTS_DATA_DIR ?? dataDir, "secrets");
}

function secretFile(env: Record<string, string | undefined>, name: string) {
  try {
    return readFileSync(join(s3SecretsDir(env), name), "utf8").trim();
  } catch {
    return "";
  }
}

export function s3Settings(env: Record<string, string | undefined> = process.env): S3Settings {
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY || secretFile(env, "s3.secret-access-key");
  if (secretAccessKey) rememberSecretValue("storage:s3", secretAccessKey, { pinned: true });
  return {
    endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:3900",
    bucket: env.S3_BUCKET ?? "runelay-bots",
    region: env.S3_REGION ?? "garage",
    accessKeyId: env.S3_ACCESS_KEY_ID || secretFile(env, "s3.access-key-id"),
    secretAccessKey,
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
  };
}
