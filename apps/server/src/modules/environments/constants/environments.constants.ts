export const localEnvironmentId = "local";
export const localCapabilities = ["turns"];
export const boxesCapability = "boxes";
export const runnerDroppedMessage = "O runner desta máquina desconectou no meio do turno.";
export const hostFallbackNotice = "O runner desta máquina está desconectado; este turno roda no container do servidor.";
export const macDroppedMessage = "Este Mac desconectou no meio do turno; abra o app no Mac ou troque para VPS.";
export const macOfflineMessage = "Este Mac está desconectado; abra o app no Mac ou troque para VPS.";
export const capacityRefusal = "box.capacity";
export const boxHome = "/home/app";
export const boxToolHome = "/home/runelaytool";
export const boxToolCredentials = [
  { path: ".config/gh", box: ".config/gh", readOnly: true },
  { path: ".config/.wrangler", box: ".config/.wrangler", readOnly: false },
  { path: ".supabase/access-token", box: ".supabase/access-token", readOnly: true },
  { path: ".gitconfig", box: ".gitconfig.host", readOnly: true },
];
export const meminfoFile = "/proc/meminfo";
export const bytesPerMb = 1024 * 1024;
export const kbPerMb = 1024;
export const missingHooksMessage = "O servidor não tem hooks para este turno.";
export const invalidHookMessage = "Pedido de hook inválido.";
export const failedHookMessage = "O hook do servidor falhou.";
export const localRunnerName = "local-runner";
export const localRunnerMachineId = "local-runner";
export const localRunnerDir = "runner";
export const localRunnerTokenFile = "box-runner.token";
export const localRunnerSecretKey = "box-runner";
export const localRunnerRetryMs = 10_000;
