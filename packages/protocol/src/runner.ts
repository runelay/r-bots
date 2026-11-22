import type { NativeToolGate, Provider, TurnRequest } from "./index";

export type BoxRuntime = "kata" | "runsc" | "runc" | "host";

export const hostCapability = "host";

export interface EnvironmentCapacity {
  cpus: number;
  memTotalMb: number;
  memFreeMb: number;
  boxesRunning: number;
  boxesPaused: number;
  maxBoxes: number;
}

export interface EnvironmentHello {
  type: "hello";
  capabilities: string[];
  runner?: {
    version: string;
    name: string;
    kvm: boolean;
    runtime: BoxRuntime;
    providers: Provider[];
    workspaceRoots: string[];
    capacity: EnvironmentCapacity;
  };
}

export interface CapacityFrame {
  type: "capacity";
  capacity: EnvironmentCapacity;
}

export type BoxState = "running" | "paused" | "stopped";

export interface BoxStatus {
  botId: string;
  state: BoxState;
  memMb: number;
  startedAt: string;
  lastUsedAt: string;
}

export interface BoxesFrame {
  type: "boxes";
  boxes: BoxStatus[];
}

export interface HookRequestFrame {
  type: "hook.request";
  id: string;
  turnId: string;
  phase: "before" | "after";
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  response?: unknown;
  failed?: boolean;
}

export interface HookResponseFrame {
  type: "hook.response";
  id: string;
  gate?: NativeToolGate;
}

export interface BoxSpec {
  memMb: number;
  cpus: number;
  mounts: Array<{ host: string; box: string; readOnly: boolean; optional?: boolean }>;
}

export interface RemoteTurnStart {
  type: "request";
  id: string;
  op: "turn.start";
  turnId: string;
  botId: string;
  request: TurnRequest;
  box: BoxSpec;
  hooks: boolean;
}

export interface ExecHandle {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface SandboxProvider {
  readonly runtime: BoxRuntime;
  ensure(botId: string, spec: BoxSpec): Promise<BoxStatus>;
  exec(
    botId: string,
    argv: string[],
    opts: { cwd: string; env: Record<string, string>; signal: AbortSignal },
  ): ExecHandle;
  pause(botId: string): Promise<void>;
  resume(botId: string): Promise<void>;
  stop(botId: string): Promise<void>;
  list(): Promise<BoxStatus[]>;
}

export interface PlacementInput {
  botId: string;
  provider: Provider;
  codeCwd: string | null;
  memMb: number;
}

export type Placement = { kind: "local"; notice?: string } | { kind: "remote"; environmentId: string; host?: boolean };

export interface EnvironmentInfo {
  id: string;
  name: string;
  kind: "local" | "runner";
  connected: boolean;
  capabilities: string[];
  runtime: BoxRuntime | null;
  capacity: EnvironmentCapacity | null;
  boxes: BoxStatus[];
}
