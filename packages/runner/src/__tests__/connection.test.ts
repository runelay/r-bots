import { afterEach, describe, expect, test } from "bun:test";
import type { EnvironmentCapacity, EnvironmentHello } from "@runelay-bots/protocol";
import { connectUrl } from "../backoff";
import { RunnerConnection } from "../connection";
import type { JsonRecord } from "../types";
import { FakeClock, type FakeServer, fakeServer, until } from "./helpers";

const capacity: EnvironmentCapacity = {
  cpus: 4,
  memTotalMb: 8000,
  memFreeMb: 6000,
  boxesRunning: 0,
  boxesPaused: 0,
  maxBoxes: 3,
};

const helloFrame: EnvironmentHello = { type: "hello", capabilities: ["turns", "boxes", "mcp-proxy", "hooks"] };

let server: FakeServer;
let connection: RunnerConnection | null = null;

afterEach(() => {
  connection?.stop();
  connection = null;
  server.stop();
});

function connect(
  hello: () => Promise<EnvironmentHello> = async () => helloFrame,
  token: () => string | null = () => "rbk_device",
) {
  server = fakeServer();
  const clock = new FakeClock();
  const frames: JsonRecord[] = [];
  const stops: string[] = [];
  const logs: string[] = [];
  let closes = 0;
  const current = new RunnerConnection({
    url: connectUrl(server.url, "/runner/connect"),
    token,
    clock,
    hello,
    capacity: async () => capacity,
    onFrame: (frame) => frames.push(frame),
    onClose: () => {
      closes += 1;
    },
    onStop: (reason) => stops.push(reason),
    log: (line) => logs.push(line),
  });
  connection = current;
  return { clock, frames, stops, logs, closes: () => closes, connection: current };
}

describe("RunnerConnection", () => {
  test("authenticates, says hello, reports capacity, answers ping and forwards frames", async () => {
    const { clock, frames, connection: current } = connect();
    expect(current.send({ type: "early" })).toBe(false);
    current.start();
    const hello = await server.waitFor(({ type }) => type === "hello", "hello");
    expect(hello).toEqual({ ...helloFrame });
    expect(server.tokens).toEqual(["rbk_device"]);
    expect(current.connected).toBe(true);
    expect(clock.delays()).toEqual([15_000]);
    clock.advance(15_000);
    expect(await server.waitFor(({ type }) => type === "capacity", "capacity")).toEqual({ type: "capacity", capacity });
    server.send({ type: "ping" });
    await server.waitFor(({ type }) => type === "pong", "pong");
    server.sockets[0]?.send(new Uint8Array([1, 2]));
    server.sockets[0]?.send("not json");
    server.send({ type: "turn.cancel", id: "t" });
    await until(() => frames.length === 1, "frame");
    expect(frames).toEqual([{ type: "turn.cancel", id: "t" }]);
  });

  test("reconnects with backoff and resets it after a successful open", async () => {
    const { clock, stops, logs, closes, connection: current } = connect();
    let refuse = 2;
    server.accept = () => (refuse-- > 0 ? 500 : 101);
    current.start();
    await until(() => clock.delays().length === 1, "first retry");
    expect(clock.delays()).toEqual([1000]);
    clock.advance(1000);
    await until(() => clock.delays()[0] === 2000, "second retry");
    clock.advance(2000);
    await server.waitFor(({ type }) => type === "hello", "hello");
    server.sockets[0]?.close(1011, "bye");
    await until(() => clock.delays().includes(1000), "reset backoff");
    expect(closes()).toBe(3);
    expect(stops).toEqual([]);
    expect(logs).toContain("runner desconectado (1011); tentando de novo em 1000 ms");
  });

  test("waits for the token every 5 s and reads it again at each reconnection", async () => {
    const tokens: Array<string | null> = [null, null, "rbk_first", "rbk_second"];
    const { clock, logs, connection: current } = connect(undefined, () => tokens.shift() ?? null);
    current.start();
    expect(clock.delays()).toEqual([5000]);
    clock.advance(5000);
    expect(clock.delays()).toEqual([5000]);
    expect(logs.filter((line) => line.startsWith("token do runner"))).toEqual([
      "token do runner ainda não existe; tentando de novo a cada 5 s",
    ]);
    clock.advance(5000);
    await server.waitFor(({ type }) => type === "hello", "hello");
    server.sockets[0]?.close(1011, "bye");
    await until(() => clock.delays().includes(1000), "retry");
    clock.advance(1000);
    await until(() => server.tokens.length === 2, "second connect");
    expect(server.tokens).toEqual(["rbk_first", "rbk_second"]);
  });

  test("stops for good on 4001 revoked", async () => {
    const { clock, stops, connection: current } = connect();
    server.onOpen = (socket) => socket.close(4001, "revoked");
    current.start();
    await until(() => stops.length === 1, "stop");
    expect(stops).toEqual(["revoked"]);
    expect(clock.delays()).toEqual([]);
  });

  test("stops for good when the upgrade is refused with 401 or 403", async () => {
    const { stops, connection: current } = connect();
    server.accept = () => 403;
    current.start();
    await until(() => stops.length === 1, "stop");
    expect(stops).toEqual(["refused 403"]);
  });

  test("stop closes the socket once and drops a late hello", async () => {
    const release: Array<() => void> = [];
    const {
      clock,
      stops,
      connection: current,
    } = connect(
      () =>
        new Promise<EnvironmentHello>((resolve) => {
          release.push(() => resolve(helloFrame));
        }),
    );
    current.start();
    await until(() => release.length === 1, "hello requested");
    current.stop();
    current.stop();
    for (const resolve of release) resolve();
    await until(() => server.sockets.length === 0, "closed");
    expect(stops).toEqual(["stopped"]);
    expect(server.frames).toEqual([]);
    expect(clock.delays()).toEqual([]);
    current.start();
    expect(server.tokens).toHaveLength(1);
  });
});
