import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const queues = new Map<string, Promise<unknown>>();

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

export function updateJson<T>(path: string, fallback: T, update: (current: T) => T | undefined) {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    const current = await readJson(path, fallback);
    const result = update(current);
    if (result !== undefined) await writeJson(path, result);
  });
  queues.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}
