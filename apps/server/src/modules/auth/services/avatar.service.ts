import { randomUUID } from "node:crypto";
import { ValidationError } from "../../../shared/errors";
import type { BlobStore } from "../../storage/services/blob-store";
import type { Auth } from "./auth.service";

export const avatarMaxBytes = 2 * 1024 * 1024;
export const avatarBasePath = "/auth/avatars";

const formats: Record<string, { ext: string; magic: (bytes: Uint8Array) => boolean }> = {
  "image/png": { ext: "png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": {
    ext: "webp",
    magic: (b) => String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP",
  },
};

const fileName = /^[a-z0-9-]{1,64}\.(png|jpg|webp)$/;
const userIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export class AvatarNotFoundError extends Error {}

function blobKey(userId: string, file: string) {
  return `users/${userId}/avatar/${file}`;
}

export function avatarPath(userId: string, file: string) {
  return `${avatarBasePath}/${encodeURIComponent(userId)}/${file}`;
}

function ownFile(userId: string, image: string | null | undefined) {
  const prefix = `${avatarBasePath}/${encodeURIComponent(userId)}/`;
  if (!image?.startsWith(prefix)) return null;
  const file = image.slice(prefix.length);
  return fileName.test(file) ? file : null;
}

export function createAvatarService(auth: Auth, blobs: () => BlobStore) {
  async function findUser(userId: string) {
    const context = await auth.$context;
    const found = await context.internalAdapter.findUserById(userId);
    if (!found) throw new AvatarNotFoundError("Conta não encontrada.");
    return { context, found };
  }

  async function imageOf(userId: string) {
    const context = await auth.$context;
    const found = await context.internalAdapter.findUserById(userId);
    return found?.image ?? null;
  }

  async function dropPrevious(userId: string, previous: string | null | undefined) {
    const file = ownFile(userId, previous);
    if (file) await blobs().delete(blobKey(userId, file));
  }

  async function save(userId: string, mime: string, bytes: Uint8Array) {
    const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
    const format = formats[type];
    if (!format) throw new ValidationError("Envie uma imagem PNG, JPEG ou WebP.", "image");
    if (bytes.byteLength === 0) throw new ValidationError("A imagem veio vazia.", "image");
    if (bytes.byteLength > avatarMaxBytes) throw new ValidationError("A imagem passa de 2 MB.", "image");
    if (!format.magic(bytes)) throw new ValidationError("O arquivo não é a imagem que diz ser.", "image");
    const { context, found } = await findUser(userId);
    const file = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${format.ext}`;
    await blobs().put(blobKey(userId, file), bytes, { mime: type });
    const image = avatarPath(userId, file);
    await context.internalAdapter.updateUser(userId, { image });
    await dropPrevious(userId, found.image);
    return { image };
  }

  async function remove(userId: string) {
    const { context, found } = await findUser(userId);
    if (found.image) await context.internalAdapter.updateUser(userId, { image: null });
    await dropPrevious(userId, found.image);
    return { image: null };
  }

  async function read(userId: string, file: string) {
    if (!userIdPattern.test(userId) || !fileName.test(file)) return null;
    const store = blobs();
    const key = blobKey(userId, file);
    const head = await store.head(key);
    if (!head) return null;
    const stream = await store.get(key);
    return stream ? { stream, mime: head.mime, size: head.size } : null;
  }

  return { imageOf, save, remove, read };
}

export type AvatarService = ReturnType<typeof createAvatarService>;
