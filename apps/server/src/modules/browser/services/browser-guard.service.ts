import { env } from "../../../config/env";
import { ValidationError } from "../../../shared/errors";
import { resolvePublic } from "../../../shared/net-guard";
import { browserText } from "../constants/browser-messages.constants";
import { liveWorkspaceIds } from "../repositories/workspaces.repository";
import { type EgressProxy, loopbackName, startEgressProxy } from "./egress-proxy.service";

const internalPorts = [3900, 3903, 5432, 6379];

export async function devPortAllowed(botId: string, port: number) {
  if (port === env.GATEWAY_PORT || internalPorts.includes(port)) return false;
  const { portOwner, previewTarget } = await import("../../code/services/dev-server.service");
  if (portOwner(port)?.target.kind === "project") return true;
  return (await liveWorkspaceIds(botId)).some((id) => previewTarget(id, port) !== null);
}

function portOf(url: URL) {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

export async function assertBrowsable(botId: string, raw: string) {
  let url: URL;
  try {
    url = loopbackName(new URL(raw));
  } catch {
    throw new ValidationError(browserText("urlInvalid"), "url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ValidationError(browserText("httpOnly"), "url");
  const port = portOf(url);
  await resolvePublic(url, { allowLoopbackPorts: (await devPortAllowed(botId, port)) ? [port] : [] });
}

const proxies = new Map<string, Promise<EgressProxy>>();

export function browserProxy(botId: string) {
  let proxy = proxies.get(botId);
  if (!proxy) {
    proxy = startEgressProxy({ loopbackAllowed: (port) => devPortAllowed(botId, port) });
    proxies.set(botId, proxy);
  }
  return proxy;
}

export async function stopBrowserProxies() {
  const all = [...proxies.values()];
  proxies.clear();
  for (const proxy of all) await (await proxy).close();
}

export async function browserLaunchArgs(botId: string) {
  const { port } = await browserProxy(botId);
  return [
    "--no-sandbox",
    `--proxy-server=http://127.0.0.1:${port}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ].join(",");
}
