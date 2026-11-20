export type BlobBody = ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array | string;

export interface BlobPutOptions {
  mime?: string;
}

export interface BlobInfo {
  key: string;
  size: number;
  mime: string;
  sha256: string;
}

export interface BlobHead {
  key: string;
  size: number;
  mime: string;
  modifiedAt: string | null;
}

export interface PresignOptions {
  expiresIn?: number;
  method?: "GET" | "PUT";
  mime?: string;
}

export interface BlobStore {
  readonly driver: "s3" | "fs";
  put(key: string, body: BlobBody, options?: BlobPutOptions): Promise<BlobInfo>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<BlobHead | null>;
  delete(key: string): Promise<void>;
  presign(key: string, options?: PresignOptions): Promise<string | null>;
  list(prefix?: string): AsyncIterable<BlobHead>;
}

export const defaultMime = "application/octet-stream";

export function validKey(key: string) {
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    /[\u0000-\u001f\u007f\\]/.test(key) ||
    key.split("/").some((part) => part === "" || part === ".." || part === ".")
  )
    throw new Error(`invalid blob key: ${key}`);
  return key;
}

export function toStream(body: BlobBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  return new Response(body).body as ReadableStream<Uint8Array>;
}

export function hashing(body: BlobBody) {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  const stream = toStream(body).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hasher.update(chunk);
        size += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return {
    stream,
    result: () => ({ size, sha256: hasher.digest("hex") }),
  };
}

export async function sha256Of(stream: ReadableStream<Uint8Array>) {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of stream) {
    hasher.update(chunk);
    size += chunk.byteLength;
  }
  return { size, sha256: hasher.digest("hex") };
}
