import type {
  BoxRuntime,
  BoxSpec,
  BoxStatus,
  EnvironmentCapacity,
  EnvironmentHello,
  ExecHandle,
  NativeToolGate,
  NativeToolHooks,
  ProviderEvent,
  SandboxProvider,
  TurnRequest,
} from "@runelay-bots/protocol";
import type { DockerApi } from "./docker-api";

export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  after(ms: number, fn: () => void): TimerHandle;
  every(ms: number, fn: () => void): TimerHandle;
}

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}

export interface BoxExecHandle extends ExecHandle {
  write(line: string): void;
}

export interface EnsureOptions {
  idle: boolean;
}

export interface BoxProvider extends SandboxProvider {
  ensure(botId: string, spec: BoxSpec, options?: EnsureOptions): Promise<BoxStatus>;
  exec(botId: string, argv: string[], opts: ExecOptions): BoxExecHandle;
}

export interface ImageRef {
  repository: string;
  tag: string;
  registry: string;
}

export interface RegistryCredentials {
  user: string | null;
  token: string | null;
}

export interface CleanupOptions {
  removeAfterMs: number;
  busy: (botId: string) => boolean;
}

export type JsonRecord = Record<string, unknown>;

export type Send = (frame: JsonRecord) => void;

export interface McpRequestMessage {
  type: "mcp.request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface McpResponseMessage {
  type: "mcp.response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AgentHookRequest {
  type: "hook.request";
  id: string;
  phase: "before" | "after";
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  response?: unknown;
  failed?: boolean;
}

export interface AgentHookResponse {
  type: "hook.response";
  id: string;
  gate?: NativeToolGate;
}

export interface AgentStart {
  type: "start";
  request: TurnRequest;
  hooks: boolean;
}

export type AgentInbound = AgentStart | AgentHookResponse | McpResponseMessage | { type: "cancel" };

export type AgentOutbound =
  | { type: "event"; event: ProviderEvent }
  | AgentHookRequest
  | McpRequestMessage
  | { type: "end"; ok: boolean };

export type RunTurnFn = (
  request: TurnRequest,
  baseDir: string,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  hooks?: NativeToolHooks,
) => Promise<void>;

export interface MemInfo {
  totalMb: number;
  availableMb: number;
}

export interface LifecycleOptions {
  provider: BoxProvider;
  memory: () => Promise<MemInfo>;
  clock: Clock;
  pauseAfterMs: number;
  stopAfterMs: number;
  reserveMb: number;
  onChange: (boxes: BoxStatus[]) => void;
}

export interface BoxCounts {
  running: number;
  paused: number;
}

export interface ConnectionOptions {
  url: string;
  token: () => string | null;
  clock: Clock;
  hello: () => Promise<EnvironmentHello>;
  capacity: () => Promise<EnvironmentCapacity>;
  onFrame: (frame: JsonRecord) => void;
  onClose: () => void;
  onStop: (reason: string) => void;
  onBeat?: () => void;
  log: (line: string) => void;
}

export interface DockerResponse {
  status: number;
  body: unknown;
}

export interface BoxMount {
  host: string;
  box: string;
  readOnly: boolean;
  optional?: boolean;
}

export interface RuntimeChoice {
  runtime: BoxRuntime;
  engine: string;
}

export interface RuntimeRequest {
  kvm: boolean;
  forced: BoxRuntime | null;
}

export interface DockerProviderOptions {
  api: DockerApi;
  image: string;
  registryAuth?: string | null;
  choice: RuntimeChoice;
  now?: () => Date;
  log: (line: string) => void;
}

export interface RunnerEnv {
  url: string;
  token: string | null;
  tokenFile: string | null;
  name: string;
  workspaceRoots: string[];
  accountRoots: string[];
  runtime: BoxRuntime | null;
  socketPath: string;
  image: string;
  pauseAfterMs: number;
  stopAfterMs: number;
  reserveMb: number;
  maxBoxes: number | null;
  registry: RegistryCredentials;
  removeAfterMs: number;
  healthFile: string;
}
