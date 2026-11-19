export type Json = Record<string, unknown>;

export function extraOf(source: Json, known: readonly string[]) {
  const extra: Json = {};
  for (const [key, value] of Object.entries(source))
    if (!known.includes(key) && value !== undefined) extra[key] = value;
  return Object.keys(extra).length ? extra : null;
}

export function present<T extends Json>(values: T) {
  const result: Json = {};
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) result[key] = value;
  return result as { [K in keyof T]?: NonNullable<T[K]> };
}
