import { S3Client } from "bun";
import type { S3Settings } from "../../../config/storage";
import {
  type BlobBody,
  type BlobHead,
  type BlobPutOptions,
  type BlobStore,
  defaultMime,
  hashing,
  type PresignOptions,
  validKey,
} from "./blob-store";

const partSize = 8 * 1024 * 1024;

export class S3BlobStore implements BlobStore {
  readonly driver = "s3" as const;
  readonly client: S3Client;

  constructor(settings: S3Settings) {
    this.client = new S3Client({
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      virtualHostedStyle: !settings.forcePathStyle,
    });
  }

  async put(key: string, body: BlobBody, options: BlobPutOptions = {}) {
    validKey(key);
    const mime = options.mime ?? (body instanceof Blob && body.type ? body.type : defaultMime);
    const { stream, result } = hashing(body);
    const writer = this.client.file(key).writer({ type: mime, partSize: partSize, retry: 3 });
    try {
      for await (const chunk of stream) {
        writer.write(chunk);
        await writer.flush();
      }
      await writer.end();
    } catch (error) {
      await Promise.allSettled([writer.end(error as Error)]);
      throw error;
    }
    return { key, mime, ...result() };
  }

  async get(key: string) {
    const file = this.client.file(validKey(key));
    if (!(await file.exists())) return null;
    return file.stream();
  }

  async head(key: string): Promise<BlobHead | null> {
    const file = this.client.file(validKey(key));
    try {
      const info = await file.stat();
      return {
        key,
        size: info.size,
        mime: info.type || defaultMime,
        modifiedAt: info.lastModified ? new Date(info.lastModified).toISOString() : null,
      };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string) {
    await this.client.delete(validKey(key));
  }

  async presign(key: string, options: PresignOptions = {}) {
    return this.client.presign(validKey(key), {
      expiresIn: options.expiresIn ?? 900,
      method: options.method ?? "GET",
      ...(options.mime ? { type: options.mime } : {}),
    });
  }

  async *list(prefix = ""): AsyncIterable<BlobHead> {
    let token: string | undefined;
    do {
      const page = await this.client.list({ prefix, maxKeys: 1000, ...(token ? { continuationToken: token } : {}) });
      for (const item of page.contents ?? []) {
        yield {
          key: item.key,
          size: item.size ?? 0,
          mime: defaultMime,
          modifiedAt: item.lastModified ? new Date(item.lastModified).toISOString() : null,
        };
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
  }
}

function notFound(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return code === "NoSuchKey" || code === "ERR_S3_FILE_NOT_FOUND" || code === "NotFound";
}
