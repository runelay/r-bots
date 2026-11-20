import net from "node:net";
import type { Req } from "../../../shared/http";
import { type Socket, type SocketHandler, socketOpen } from "../../../shared/ws";
import { runnerUpgradeData } from "../../accounts/services/mac-runner.service";
import { portOwner } from "../../code/services/dev-server.service";

export const tunnelPath = "/runner/tunnel";

export function isTunnelUpgrade(pathname: string) {
  return pathname === tunnelPath;
}

export function tunnelUpgradeData(req: Req, url: URL) {
  const runner = runnerUpgradeData(req);
  if (!runner) return { status: 401 as const };
  const port = Number(url.searchParams.get("port"));
  if (!Number.isInteger(port) || !portOwner(port)) return { status: 404 as const };
  return { status: 200 as const, data: { kind: "tunnel", port, deviceKey: runner.deviceKey } };
}

interface Pipe {
  upstream: net.Socket;
  ready: boolean;
  queue: Buffer[];
}

const pipes = new WeakMap<Socket, Pipe>();

function connect(port: number, hosts: string[], client: Socket, pipe: Pipe) {
  const [host, ...rest] = hosts;
  const upstream = net.connect({ port, host });
  pipe.upstream = upstream;
  upstream.on("connect", () => {
    pipe.ready = true;
    for (const chunk of pipe.queue) upstream.write(chunk);
    pipe.queue = [];
  });
  upstream.on("data", (chunk: Buffer) => {
    if (client.readyState === socketOpen) client.send(chunk);
  });
  upstream.on("error", () => {
    if (!pipe.ready && rest.length > 0) {
      connect(port, rest, client, pipe);
      return;
    }
    client.close();
  });
  upstream.on("close", () => {
    if (pipe.upstream === upstream && (pipe.ready || rest.length === 0)) client.close();
  });
}

export const tunnelSocket: SocketHandler = {
  open(client) {
    const port = Number(client.data.port);
    const pipe: Pipe = { upstream: new net.Socket(), ready: false, queue: [] };
    pipes.set(client, pipe);
    connect(port, ["127.0.0.1", "::1"], client, pipe);
  },
  message(client, message) {
    const pipe = pipes.get(client);
    if (!pipe) return;
    const chunk = typeof message === "string" ? Buffer.from(message, "utf8") : message;
    if (pipe.ready) pipe.upstream.write(chunk);
    else pipe.queue.push(chunk);
  },
  close(client) {
    const pipe = pipes.get(client);
    pipes.delete(client);
    pipe?.upstream.destroy();
  },
};
