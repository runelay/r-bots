import type { EnvironmentCapacity, Provider } from "@runelay-bots/protocol";
import {
  disconnectMacDevice,
  macRunnerConnections,
  runnerSocket,
} from "../src/modules/accounts/services/mac-runner.service";
import type { Socket } from "../src/shared/ws";

export type RunnerFrame = Record<string, unknown> & { type: string; id?: string };

export function runnerDevice(key: string, rank = 1, extra: Record<string, unknown> = {}) {
  return { kind: "runner", deviceKey: key, rank, deviceName: `Máquina ${key}`, userId: "u1", owner: true, ...extra };
}

export function capacity(memFreeMb: number, extra: Partial<EnvironmentCapacity> = {}): EnvironmentCapacity {
  return { cpus: 4, memTotalMb: 16_384, memFreeMb, boxesRunning: 0, boxesPaused: 0, maxBoxes: 8, ...extra };
}

export function boxHello({
  memFreeMb = 8192,
  providers = ["claude"],
  workspaceRoots = ["/srv"],
  name = "vps-2",
}: {
  memFreeMb?: number;
  providers?: Provider[];
  workspaceRoots?: string[];
  name?: string;
} = {}) {
  return {
    type: "hello",
    capabilities: ["turns", "boxes", "mcp-proxy", "hooks"],
    runner: {
      version: "1.0.0",
      name,
      kvm: false,
      runtime: "runsc",
      providers,
      workspaceRoots,
      capacity: capacity(memFreeMb),
    },
  };
}

export function hostHello({ memFreeMb = 8192, name = "vps" }: { memFreeMb?: number; name?: string } = {}) {
  return {
    type: "hello",
    capabilities: ["turns", "host", "mcp-proxy", "hooks"],
    runner: {
      version: "1.0.0",
      name,
      kvm: false,
      runtime: "host",
      providers: ["claude"],
      workspaceRoots: [],
      capacity: capacity(memFreeMb),
    },
  };
}

export function fakeRunner(data: Record<string, unknown> = runnerDevice("box-1")) {
  const sent: RunnerFrame[] = [];
  const ws = {
    readyState: 1,
    data,
    send(raw: string) {
      sent.push(JSON.parse(raw) as RunnerFrame);
    },
    close() {},
    ping() {},
    terminate() {},
  };
  const as = ws as unknown as Socket;
  runnerSocket.open(as);
  return {
    ws,
    sent,
    say(message: unknown) {
      runnerSocket.message(as, JSON.stringify(message));
    },
    drop() {
      ws.readyState = 3;
      runnerSocket.close(as, 1000, "");
    },
    async next(type: string) {
      for (let tick = 0; tick < 20; tick++) {
        const found = sent.find((frame) => frame.type === type);
        if (found) {
          sent.splice(sent.indexOf(found), 1);
          return found;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`runner never received ${type}`);
    },
  };
}

export function dropAllRunners() {
  for (const live of macRunnerConnections()) disconnectMacDevice(live.key, 1000, "test");
}
