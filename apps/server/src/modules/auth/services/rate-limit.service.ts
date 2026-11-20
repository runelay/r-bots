export interface WindowRule {
  windowMs: number;
  max: number;
}

export interface Limited {
  retryAfter: number;
}

const maxEntries = 10_000;

export function createWindowLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function prune(at: number) {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
    while (buckets.size >= maxEntries) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  function hit(key: string, rule: WindowRule): Limited | null {
    const at = now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= at) {
      if (buckets.size >= maxEntries / 2) prune(at);
      buckets.set(key, { count: 1, resetAt: at + rule.windowMs });
      return null;
    }
    current.count += 1;
    if (current.count <= rule.max) return null;
    return { retryAfter: Math.max(1, Math.ceil((current.resetAt - at) / 1000)) };
  }

  return { hit, size: () => buckets.size };
}

export interface LockoutOptions {
  threshold?: number;
  windowMs?: number;
  baseLockMs?: number;
  maxLockMs?: number;
  now?: () => number;
}

interface LockState {
  failures: number;
  firstAt: number;
  lockedUntil: number;
  strikes: number;
}

export function createAccountLockout(options: LockoutOptions = {}) {
  const threshold = options.threshold ?? 5;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const baseLockMs = options.baseLockMs ?? 60_000;
  const maxLockMs = options.maxLockMs ?? 30 * 60_000;
  const now = options.now ?? Date.now;
  const states = new Map<string, LockState>();

  function prune(at: number) {
    for (const [key, state] of states)
      if (state.lockedUntil <= at && state.firstAt + windowMs <= at && state.lockedUntil + maxLockMs <= at)
        states.delete(key);
    while (states.size >= maxEntries) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  }

  function key(account: string) {
    return account.trim().toLowerCase();
  }

  function locked(account: string): Limited | null {
    const state = states.get(key(account));
    const at = now();
    if (!state || state.lockedUntil <= at) return null;
    return { retryAfter: Math.max(1, Math.ceil((state.lockedUntil - at) / 1000)) };
  }

  function failed(account: string) {
    const at = now();
    if (states.size >= maxEntries / 2) prune(at);
    const id = key(account);
    const state = states.get(id) ?? { failures: 0, firstAt: at, lockedUntil: 0, strikes: 0 };
    if (state.firstAt + windowMs <= at) {
      state.failures = 0;
      state.firstAt = at;
    }
    state.failures += 1;
    if (state.failures >= threshold) {
      state.lockedUntil = at + Math.min(maxLockMs, baseLockMs * 2 ** state.strikes);
      state.strikes += 1;
      state.failures = 0;
      state.firstAt = at;
    }
    states.set(id, state);
  }

  function succeeded(account: string) {
    states.delete(key(account));
  }

  return { locked, failed, succeeded, size: () => states.size };
}

export type WindowLimiter = ReturnType<typeof createWindowLimiter>;
export type AccountLockout = ReturnType<typeof createAccountLockout>;
