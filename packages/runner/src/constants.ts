import type { BoxRuntime } from "@runelay-bots/protocol";

export const runnerCapabilities = ["turns", "boxes", "mcp-proxy", "hooks"];
export const runnerConnectPath = "/runner/connect";
export const revokedCloseCode = 4001;
export const fatalUpgradeStatuses = [401, 403];
export const reconnectMinMs = 1000;
export const reconnectMaxMs = 15_000;
export const capacityIntervalMs = 15_000;
export const tokenWaitMs = 5000;

export const defaultDockerSocket = "/var/run/docker.sock";
export const defaultBoxImage = "runelay-bots-box:latest";
export const boxNamePrefix = "rbbox-";
export const boxBotLabel = "rbots.bot";
export const boxSpecLabel = "rbots.spec";
export const imageProvidersLabel = "rbots.providers";
export const boxCacheVolume = "rbbox-cache:/cache";
export const boxPidsLimit = 1024;
export const boxCapAdd = ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL"];
export const boxExecUser = "app";
export const boxKillUser = "root";
export const boxPidDir = "/tmp";
export const boxSandboxRootsEnv = "RBOX_SANDBOX_ROOTS";
export const boxRuntimes: readonly BoxRuntime[] = ["kata", "runsc", "runc"];
export const kataRuntimePrefix = "kata";
export const cgroupMemoryMaxPath = "/sys/fs/cgroup/memory.max";
export const accountRootPrefix = ".";
export const forbiddenMountHosts = ["/var/run/docker.sock", "/run/docker.sock"];

export const boxPauseAfterMs = 120_000;
export const boxStopAfterMs = 1_800_000;
export const boxMemReserveMb = 1024;
export const boxDefaultMemMb = 2048;

export const boxAgentArgv = ["bun", "/opt/rbots/box-agent.js"];
export const boxAgentCwd = "/data";
export const boxDataDir = "/data";
export const cancelKillAfterMs = 5000;
export const hookTimeoutMs = 30_000;
export const hookTimeoutMessage = "O servidor não respondeu ao hook a tempo; a ferramenta foi negada.";
export const mcpForwardedHeaders = [
  "authorization",
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
];

export const meminfoPath = "/proc/meminfo";
export const kvmPath = "/dev/kvm";

export const capacityErrorCode = "box.capacity";
export const mountErrorCode = "box.mount";
export const busyErrorCode = "box.busy";
export const startErrorCode = "box.start";
