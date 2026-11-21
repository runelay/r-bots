import {
  MacRunnerUnavailable,
  macComputerCall,
  macComputerHealth,
  macRunnerConnected,
  watchMacComputerEvents,
} from "../../accounts/services/mac-runner.service";

const macOffline = "Mac desconectado: abra o app r/bots nele.";
export class ComputerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const defaultRoots = ["~/Desktop", "~/Downloads", "~/Documents"];

export interface ComputerContext {
  botId: string;
  botName: string;
  sessionId: string;
  allowedRoots: string[];
}

export async function computerHealth() {
  if (!macRunnerConnected()) return { ok: false, code: "COMPUTER_UNAVAILABLE", error: macOffline };
  try {
    return await macComputerHealth();
  } catch (error) {
    return {
      ok: false,
      code: "COMPUTER_UNAVAILABLE",
      error: `O app r/bots não respondeu: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function callComputer(
  tool: string,
  args: Record<string, unknown>,
  context: ComputerContext,
  signal?: AbortSignal,
) {
  if (!macRunnerConnected()) throw new ComputerError("COMPUTER_UNAVAILABLE", macOffline);
  let reply: Awaited<ReturnType<typeof macComputerCall>>;
  try {
    reply = await macComputerCall(tool, { args, context }, signal);
  } catch (error) {
    if (error instanceof MacRunnerUnavailable) throw new ComputerError("COMPUTER_UNAVAILABLE", error.message);
    throw error;
  }
  const { status, body } = reply;
  if (status >= 400 || body.ok === false) {
    const code = body.code ?? (status === 503 ? "COMPUTER_UNAVAILABLE" : "COMPUTER_ERROR");
    throw new ComputerError(code, body.error ?? `O computador respondeu ${status}.`);
  }
  return body.result;
}

export function watchComputerEvents(onStop: (event: { type: string; botId?: string }) => void) {
  return watchMacComputerEvents((event) => {
    if (event.type === "stop" || event.type === "user_took_over") onStop(event);
  });
}

const shellMetacharacters = /[;&|`$()<>\n\r*?[\]{}\\'"!#~]/;
const shellPrograms = new Set(["npm", "pnpm", "bun", "node", "swift", "xcodebuild", "ls", "cat", "mkdir"]);
const gitReadWrite = new Set(["status", "diff", "add", "commit"]);

export function shellArgv(command: string): string[] | null {
  if (shellMetacharacters.test(command)) return null;
  return command
    .trim()
    .split(/[ \t]+/)
    .filter(Boolean);
}

function shellAllowed(argv: string[]) {
  const [program, sub] = argv;
  if (program === "git") return gitReadWrite.has(sub ?? "");
  return shellPrograms.has(program);
}

const doShellScript = /\bdo\s+shell\s+script\b/i;

export function computerHumanReason(tool: string, args: Record<string, unknown>): string | null {
  const text = JSON.stringify(args);
  if (tool === "computer_applescript" && doShellScript.test(String(args.script ?? "")))
    return "AppleScript com do shell script roda comando no Mac: sempre passa por uma pessoa.";
  if (
    tool === "computer_applescript" &&
    /\b(send|deliver|delete|empty trash|purchase|buy|pay)\b|\bMail\b|\bMessages\b/i.test(String(args.script ?? ""))
  ) {
    return "AppleScript que envia, apaga ou compra sempre passa por uma pessoa.";
  }
  if (tool === "files_trash" && Array.isArray(args.paths) && args.paths.length > 10)
    return "Mandar mais de 10 itens para a lixeira sempre passa por uma pessoa.";
  if (tool === "shell_run") {
    const argv = shellArgv(String(args.cmd ?? ""));
    if (!argv)
      return "Comando com caractere especial de shell (; & | $ ` ( ) < > aspas ou curinga) sempre passa por uma pessoa.";
    if (!shellAllowed(argv)) return "Comando fora da lista permitida sempre passa por uma pessoa.";
  }
  if (
    (tool === "computer_type" || tool === "computer_key") &&
    /(?:\d[ -]?){13,19}|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(text)
  )
    return "Digitar cartão ou documento sempre passa por uma pessoa.";
  if (tool === "computer_open" && /(checkout|pagamento|payment|pay\b|comprar|buy)/i.test(String(args.url ?? "")))
    return "Página de pagamento sempre passa por uma pessoa.";
  return null;
}
