const mask = "••••";
const ttlMs = 30 * 60_000;
const minLength = 4;

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

export function variantsOf(value: string) {
  if (value.length < minLength) return [];
  const list = [
    value,
    JSON.stringify(value).slice(1, -1),
    JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64").replace(/=+$/, ""),
    Buffer.from(value, "utf8").toString("base64url"),
  ];
  return [...new Set(list.filter((item) => item.length >= minLength))];
}

export function rememberSecretValue(key: string, value: string) {
  const variants = variantsOf(value);
  if (variants.length === 0) return [];
  const current = live.get(key);
  const merged = current ? [...new Set([...current.variants, ...variants])] : variants;
  live.set(key, { variants: merged, until: Date.now() + ttlMs });
  rebuild();
  return variants;
}

export function forgetSecretValue(key: string) {
  if (live.delete(key)) rebuild();
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

function patchStream(stream: NodeJS.WriteStream) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (patterns.length === 0) return write(chunk, ...rest);
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null;
    return write(text === null ? chunk : redactText(text), ...rest);
  }) as typeof stream.write;
}

export function installConsoleRedaction() {
  if (consolePatched) return;
  consolePatched = true;
  patchStream(process.stdout);
  patchStream(process.stderr);
}
