import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  type BlobBody,
  type BlobHead,
  type BlobPutOptions,
  type BlobStore,
  defaultMime,
  hashing,
  validKey,
} from "./blob-store";

const mimeSuffix = ".mime";

export class FsBlobStore implements BlobStore {
  readonly driver = "fs" as const;

  constructor(readonly root: string) {}

  private path(key: string) {
    return join(this.root, ...validKey(key).split("/"));
  }

  async put(key: string, body: BlobBody, options: BlobPutOptions = {}) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const mime = options.mime ?? (body instanceof Blob && body.type ? body.type : defaultMime);
    const { stream, result } = hashing(body);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await Bun.write(temp, new Response(stream));
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await Bun.write(`${path}${mimeSuffix}`, mime);
    return { key, mime, ...result() };
  }

  async get(key: string) {
    const file = Bun.file(this.path(key));
    if (!(await file.exists())) return null;
    return file.stream();
  }

  async head(key: string): Promise<BlobHead | null> {
    const path = this.path(key);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    const mimeFile = Bun.file(`${path}${mimeSuffix}`);
    const mime = (await mimeFile.exists()) ? await mimeFile.text() : defaultMime;
    return { key, size: info.size, mime, modifiedAt: info.mtime.toISOString() };
  }

  async delete(key: string) {
    const path = this.path(key);
    await rm(path, { force: true });
    await rm(`${path}${mimeSuffix}`, { force: true });
  }

  async presign() {
    return null;
  }

  async *list(prefix = ""): AsyncIterable<BlobHead> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true }).catch(() => []);
    const keys = entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith(mimeSuffix) && !entry.name.endsWith(".tmp"))
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .filter((key) => key.startsWith(prefix))
      .sort();
    for (const key of keys) {
      const head = await this.head(key);
      if (head) yield head;
    }
  }
}
