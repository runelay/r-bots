import type { BoxRuntime } from "@runelay-bots/protocol";

export const runnerCapabilities = ["turns", "boxes", "mcp-proxy", "hooks"];
export const hostCapabilities = ["turns", "host", "mcp-proxy", "hooks"];
export const runnerProviders = ["docker", "host"] as const;
export const hostAgentFile = "box-agent.js";
export const hostAgentSource = "box-agent-main.ts";
export const hostProbeMemory = "64M";
export const hostProviderBinaries = { claude: ["claude"], codex: ["codex"] };
export const runnerConnectPath = "/runner/connect";
export const revokedCloseCode = 4001;
export const fatalUpgradeStatuses = [401, 403];
export const reconnectMinMs = 1000;
export const reconnectMaxMs = 15_000;
export const capacityIntervalMs = 15_000;
export const tokenWaitMs = 5000;

export const defaultDockerSocket = "/var/run/docker.sock";
export const defaultImageRepository = "ghcr.io/runelay/r-bots";
export const defaultImageTag = "dev";
export const boxNamePrefix = "rbbox-";
export const boxBotLabel = "rbots.bot";
export const boxSpecLabel = "rbots.spec";
export const imageProvidersLabel = "rbots.providers";
export const boxCacheVolume = "rbbox-cache:/cache";
export const boxPidsLimit = 1024;
export const boxCapAdd = ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL"];
export const boxExecUser = "app";
export const boxKillUser = "root";
export const boxPidDir = "/tmp";
export const boxSandboxRootsEnv = "RBOX_SANDBOX_ROOTS";
export const boxEntrypoint = ["/usr/local/bin/rbbox-init"];
export const boxHealthcheck = { Test: ["NONE"] };
export const boxRuntimes: readonly BoxRuntime[] = ["kata", "runsc", "runc"];
export const kataRuntimePrefix = "kata";
export const cgroupMemoryMaxPath = "/sys/fs/cgroup/memory.max";
export const accountRootPrefix = ".";
export const forbiddenMountHosts = ["/var/run/docker.sock", "/run/docker.sock"];

export const boxPauseAfterMs = 120_000;
export const boxStopAfterMs = 1_800_000;
export const boxMemReserveMb = 1024;
export const boxDefaultMemMb = 2048;

export const boxAgentArgv = ["sh", "-c", "umask 002 && exec bun /opt/rbots/box-agent.js"];
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
export const startErrorCode = "box.start";

export const defaultRegistry = "docker.io";
export const registryAuthUser = "rbots";
export const pullProgressSteps = 10;
export const boxImagesKept = 2;
export const boxRemoveAfterMs = 7 * 24 * 60 * 60 * 1000;
export const cleanupIntervalMs = 6 * 60 * 60 * 1000;
export const defaultHealthFile = "/tmp/rbots-runner.health";
export const healthMaxAgeMs = 3 * capacityIntervalMs;
