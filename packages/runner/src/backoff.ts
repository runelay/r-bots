import { reconnectMaxMs, reconnectMinMs } from "./constants";

export function backoffDelay(attempt: number) {
  return Math.min(reconnectMaxMs, reconnectMinMs * 2 ** Math.max(0, attempt));
}

export function connectUrl(base: string, path: string) {
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return url.toString();
}

export function upgradeStatus(message: string) {
  const match = message.match(/status code:?\s*(\d{3})/i);
  return match ? Number(match[1]) : null;
}
