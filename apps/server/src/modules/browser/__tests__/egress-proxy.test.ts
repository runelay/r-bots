import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { type EgressProxy, startEgressProxy } from "../services/egress-proxy.service";

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function upstream() {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      seen.push(chunk.toString("latin1"));
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  return new Promise<{ port: number; seen: string[] }>((resolve) => {
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      closers.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve({ port: (server.address() as net.AddressInfo).port, seen });
    });
  });
}

async function proxy(allowed: number[] = []) {
  const started = await startEgressProxy({ loopbackAllowed: (port) => allowed.includes(port) });
  closers.push(() => started.close());
  return started;
}

function exchange(target: EgressProxy, payload: string | Buffer, after?: (reply: string) => string | null) {
  return new Promise<string>((resolve) => {
    const socket = net.connect({ port: target.port, host: "127.0.0.1" });
    let reply = "";
    let followed = false;
    socket.on("data", (chunk) => {
      reply += chunk.toString("latin1");
      if (after && !followed && reply.includes("\r\n\r\n")) {
        followed = true;
        const next = after(reply);
        if (next) socket.write(next);
      }
    });
    socket.on("close", () => resolve(reply));
    socket.on("error", () => resolve(reply));
    socket.write(payload);
  });
}

describe("egress proxy", () => {
  test("refuses private, loopback and metadata targets", async () => {
    const target = await proxy();
    const { port } = await upstream();
    expect(await exchange(target, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`)).toStartWith(
      "HTTP/1.1 403 Forbidden",
    );
    expect(await exchange(target, "GET http://169.254.169.254/latest HTTP/1.1\r\nHost: x\r\n\r\n")).toStartWith(
      "HTTP/1.1 403 Forbidden",
    );
    expect(await exchange(target, "CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403 Forbidden");
    expect(await exchange(target, "GET http://[::1]:80/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403 Forbidden");
  });

  test("rejects malformed requests and non-http targets", async () => {
    const target = await proxy();
    for (const line of [
      "GET /relative HTTP/1.1",
      "GET file:///etc/passwd HTTP/1.1",
      "GET http://x.com/ SPDY/3",
      "CONNECT nohost HTTP/1.1",
      "CONNECT user@host:443 HTTP/1.1",
      "",
    ])
      expect(await exchange(target, `${line}\r\n\r\n`)).toStartWith("HTTP/1.1 400 Bad Request");
  });

  test("tunnels CONNECT to an allowed dev port", async () => {
    const { port, seen } = await upstream();
    const target = await proxy([port]);
    const reply = await exchange(target, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`, () => "PING\r\n");
    expect(reply).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(reply).toEndWith("ok");
    expect(seen).toEqual(["PING\r\n"]);
    const named = await exchange(target, `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`, () => "PONG\r\n");
    expect(named).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(seen).toEqual(["PING\r\n", "PONG\r\n"]);
  });

  test("forwards plain http in origin form without hop headers and with early body bytes", async () => {
    const { port, seen } = await upstream();
    const target = await proxy([port]);
    const reply = await exchange(
      target,
      `POST http://127.0.0.1:${port}/a/b?c=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: x\r\nKeep-Alive: 5\r\nbroken line\r\nContent-Length: 4\r\n\r\nbody`,
    );
    expect(reply).toStartWith("HTTP/1.1 200 OK");
    expect(seen.join("")).toBe(
      "POST /a/b?c=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody",
    );
  });

  test("answers 502 when the upstream refuses and drops oversized heads", async () => {
    const closed = await upstream();
    await closers.pop()?.();
    const target = await proxy([closed.port]);
    expect(await exchange(target, `CONNECT 127.0.0.1:${closed.port} HTTP/1.1\r\n\r\n`)).toStartWith(
      "HTTP/1.1 502 Bad Gateway",
    );
    expect(await exchange(target, Buffer.alloc(70 * 1024, 0x41))).toBe("");
  });

  test("survives a client that resets mid request", async () => {
    const target = await proxy();
    await new Promise<void>((resolve) => {
      const socket = net.connect({ port: target.port, host: "127.0.0.1" }, () => {
        socket.write("GET", () => {
          socket.resetAndDestroy();
          resolve();
        });
      });
    });
    expect(await exchange(target, "GET /x HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400 Bad Request");
  });
});
