import { formatWithOptions } from "node:util";

const mask = "••••";
const ttlMs = 30 * 60_000;
export const minSecretLength = 4;
const staticKeys = /^(database|REDIS_PASSWORD|auth|runner)$|^(integration|runtime|storage):/;

interface LiveSecret {
  variants: string[];
  until: number;
}

const live = new Map<string, LiveSecret>();
let patterns: string[] = [];

function rebuild() {
  const now = Date.now();
  for (const [name, entry] of live) if (entry.until < now) live.delete(name);
  patterns = [...new Set([...live.values()].flatMap((entry) => entry.variants))].sort((a, b) => b.length - a.length);
}

setInterval(rebuild, 60_000).unref();

function base64Shifts(bytes: Buffer) {
  const out: string[] = [];
  for (const shift of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64");
    const core = encoded.slice(Math.ceil((shift * 8) / 6), Math.floor(((shift + bytes.length) * 8) / 6));
    out.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return out;
}

export function variantsOf(value: string) {
  if (value.length < minSecretLength) return [];
  const bytes = Buffer.from(value, "utf8");
  const component = encodeURIComponent(value);
  const list = [
    value,
    JSON.stringify(value).slice(1, -1),
    JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1),
    component,
    component.replace(/%[0-9A-F]{2}/g, (sequence) => sequence.toLowerCase()),
    component.replace(/%20/g, "+"),
    encodeURI(value),
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("base64url"),
    ...base64Shifts(bytes),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
  ];
  return [...new Set(list.filter((item) => item.length >= minSecretLength))];
}

export function rememberSecretValue(key: string, value: string, options: { pinned?: boolean } = {}) {
  const variants = variantsOf(value);
  if (variants.length === 0) return [];
  const pinned = options.pinned ?? staticKeys.test(key);
  const current = live.get(key);
  const merged = current ? [...new Set([...current.variants, ...variants])] : variants;
  live.set(key, { variants: merged, until: pinned ? Number.POSITIVE_INFINITY : Date.now() + ttlMs });
  rebuild();
  return variants;
}

export function forgetSecretValue(key: string) {
  if (live.delete(key)) rebuild();
}

export function forgetAllSecretValues() {
  live.clear();
  rebuild();
}

export function redactionActive() {
  return patterns.length > 0;
}

export function redactText(text: string) {
  if (patterns.length === 0 || !text) return text;
  let out = text;
  for (const pattern of patterns) if (out.includes(pattern)) out = out.split(pattern).join(mask);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (patterns.length === 0) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redactText(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) out[key] = walk(entry);
      return out;
    }
    return item;
  };
  return walk(value) as T;
}

let consolePatched = false;
const redactingWrites = new WeakSet<object>();

function patchStream(stream: NodeJS.WriteStream) {
  if (redactingWrites.has(stream.write)) return;
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const redacting = ((chunk: unknown, ...rest: unknown[]) => {
    if (patterns.length === 0) return write(chunk, ...rest);
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null;
    return write(text === null ? chunk : redactText(text), ...rest);
  }) as typeof stream.write;
  redactingWrites.add(redacting);
  stream.write = redacting;
}

const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"] as const;

function patchConsole() {
  for (const method of consoleMethods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]) => {
      if (patterns.length === 0) return original(...args);
      original(redactText(formatWithOptions({ colors: false, depth: 6 }, ...args)));
    };
  }
}

export function installConsoleRedaction() {
  patchStream(process.stdout);
  patchStream(process.stderr);
  if (consolePatched) return;
  consolePatched = true;
  patchConsole();
}
