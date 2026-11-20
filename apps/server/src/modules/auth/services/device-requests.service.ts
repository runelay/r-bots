export interface DeviceRequestInfo {
  clientName: string;
  ip: string;
  requestedAt: string;
}

const ttlMs = 10 * 60_000;
const maxEntries = 2000;

export const clientNames: Record<string, string> = { "runelay-bots-mac": "app runelay bots para Mac" };

export function normalizeUserCode(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function createDeviceRequests(now: () => number = Date.now) {
  const entries = new Map<string, { info: DeviceRequestInfo; expiresAt: number }>();

  function prune(at: number) {
    for (const [code, entry] of entries) if (entry.expiresAt <= at) entries.delete(code);
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function record(userCode: string, clientId: string, ip: string) {
    const at = now();
    prune(at);
    entries.set(normalizeUserCode(userCode), {
      info: { clientName: clientNames[clientId] ?? clientId, ip, requestedAt: new Date(at).toISOString() },
      expiresAt: at + ttlMs,
    });
  }

  function lookup(userCode: string) {
    const entry = entries.get(normalizeUserCode(userCode));
    if (!entry || entry.expiresAt <= now()) return null;
    return entry.info;
  }

  return { record, lookup, size: () => entries.size };
}

export type DeviceRequests = ReturnType<typeof createDeviceRequests>;
