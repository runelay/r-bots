import net from "node:net";
import { resolvePublic } from "../../../shared/net-guard";

export interface EgressPolicy {
  loopbackAllowed: (port: number) => boolean | Promise<boolean>;
}

export interface EgressProxy {
  port: number;
  close: () => Promise<void>;
}

const maxHead = 64 * 1024;
const hopHeaders = new Set(["proxy-connection", "connection", "keep-alive", "proxy-authorization"]);

function answer(client: net.Socket, status: number, reason: string) {
  if (!client.destroyed) client.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

export function loopbackName(url: URL) {
  if (url.hostname.toLowerCase() === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function targetOf(method: string, target: string) {
  try {
    if (method === "CONNECT")
      return /^[^/?#@\s]+:\d+$/.test(target) ? loopbackName(new URL(`https://${target}`)) : null;
    const url = loopbackName(new URL(target));
    return url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function portOf(url: URL) {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

function originHead(lines: string[], method: string, url: URL, version: string) {
  const headers = lines.slice(1).filter((line) => {
    const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
    return line.includes(":") && !hopHeaders.has(name);
  });
  return `${[`${method} ${url.pathname}${url.search} ${version}`, ...headers, "Connection: close"].join("\r\n")}\r\n\r\n`;
}

async function route(client: net.Socket, head: Buffer, rest: Buffer, policy: EgressPolicy) {
  const lines = head.toString("latin1").split("\r\n").slice(0, -2);
  const [method = "", target = "", version = ""] = (lines[0] ?? "").split(" ");
  const url = /^HTTP\/1\.[01]$/.test(version) ? targetOf(method, target) : null;
  if (!url) return answer(client, 400, "Bad Request");
  const port = portOf(url);
  let address: string;
  try {
    const allowed = await policy.loopbackAllowed(port);
    address = (await resolvePublic(url, { allowLoopbackPorts: allowed ? [port] : [] })).address;
  } catch {
    return answer(client, 403, "Forbidden");
  }
  const upstream = net.connect({ host: address, port });
  let connected = false;
  client.once("close", () => upstream.destroy());
  upstream.on("error", () => (connected ? client.destroy() : answer(client, 502, "Bad Gateway")));
  upstream.once("connect", () => {
    connected = true;
    if (method === "CONNECT") client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    else upstream.write(originHead(lines, method, url, version));
    if (rest.length) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
}

export function startEgressProxy(policy: EgressPolicy): Promise<EgressProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > maxHead) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      void route(client, head.subarray(0, end + 4), head.subarray(end + 4), policy);
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      server.unref();
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
