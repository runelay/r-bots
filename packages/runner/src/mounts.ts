import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { BoxSpec } from "@runelay-bots/protocol";
import type { BoxMount } from "./types";

export function insideRoot(path: string, roots: string[]) {
  const target = resolve(path);
  return roots.some((root) => {
    const base = resolve(root);
    return base !== "/" && (target === base || target.startsWith(`${base}/`));
  });
}

export function rejectedMount(mounts: BoxMount[], roots: string[], forbidden: string[]) {
  const blocked = forbidden.map((path) => resolve(path));
  const found = mounts.find(({ host }) => blocked.includes(resolve(host)) || !insideRoot(host, roots));
  return found?.host ?? null;
}

export function bindsOf(mounts: BoxMount[]) {
  return mounts.map(({ host, box, readOnly }) => `${host}:${box}${readOnly ? ":ro" : ""}`);
}

export function specKey({ memMb, cpus, mounts }: BoxSpec) {
  const sorted = [...bindsOf(mounts)].sort();
  return createHash("sha256").update(JSON.stringify({ memMb, cpus, sorted })).digest("hex").slice(0, 16);
}
