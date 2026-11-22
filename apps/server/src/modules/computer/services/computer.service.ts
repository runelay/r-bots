import {
  MacRunnerUnavailable,
  macComputerCall,
  macComputerHealth,
  macRunnerConnected,
  watchMacComputerEvents,
} from "../../accounts/services/mac-runner.service";
import { parseShell, type Segment } from "../../code/services/policy.service";
import { computerText } from "../constants/computer-messages.constants";

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
  if (!macRunnerConnected()) return { ok: false, code: "COMPUTER_UNAVAILABLE", error: computerText("macOffline") };
  try {
    return await macComputerHealth();
  } catch (error) {
    return {
      ok: false,
      code: "COMPUTER_UNAVAILABLE",
      error: computerText("appNoAnswer", { reason: error instanceof Error ? error.message : String(error) }),
    };
  }
}

export async function callComputer(
  tool: string,
  args: Record<string, unknown>,
  context: ComputerContext,
  signal?: AbortSignal,
) {
  if (!macRunnerConnected()) throw new ComputerError("COMPUTER_UNAVAILABLE", computerText("macOffline"));
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

const sensitiveShellPath =
  /(^|[\s/'"=])(\.ssh|\.aws|\.gnupg|\.netrc|\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa)[\w.-]*|Keychains|credentials?(\.json)?|\.config\/gh)($|[\s/'"])/;
const alwaysHumanPrograms = new Set([
  "sudo",
  "su",
  "doas",
  "eval",
  "exec",
  "source",
  ".",
  "security",
  "launchctl",
  "diskutil",
  "dd",
  "mkfs",
  "csrutil",
  "spctl",
  "tccutil",
  "networksetup",
  "shutdown",
  "reboot",
  "halt",
  "killall",
  "chown",
  "ssh",
  "scp",
  "sftp",
  "rsync",
]);
const shellInterpreters = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);
const readPrograms = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "pwd",
  "echo",
  "printf",
  "which",
  "whereis",
  "type",
  "date",
  "uname",
  "sw_vers",
  "ps",
  "jq",
  "tree",
  "mdfind",
  "mdls",
  "sed",
  "git",
  "plutil",
  "defaults",
  "screencapture",
  "true",
]);
const gitReads = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "remote"]);
const findWrites = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"]);
const quietTargets = new Set(["/dev/null", "&1", "&2", "1", "2"]);

function shellSegments(command: string) {
  try {
    return parseShell(command);
  } catch {
    return null;
  }
}

function programOf(words: string[]) {
  const first = words.findIndex((word) => !/^[A-Za-z_][\w]*=/.test(word));
  return first < 0
    ? { program: "", args: [] as string[] }
    : { program: words[first] ?? "", args: words.slice(first + 1) };
}

function shellSegmentReason({ words }: Segment, piped: boolean): string | null {
  const { program, args } = programOf(words);
  const name = program.split("/").pop() ?? program;
  if (alwaysHumanPrograms.has(name)) return computerText("alwaysHuman", { name });
  if (shellInterpreters.has(name) && (piped || args.includes("-c"))) return computerText("nestedShell");
  if (name === "rm" && args.some((arg) => /^-[a-zA-Z]*[rRf]/.test(arg) || arg === "--recursive" || arg === "--force"))
    return computerText("forceDelete");
  if (name === "git" && args.includes("push")) return computerText("gitPush");
  if (
    (name === "curl" || name === "wget") &&
    args.some(
      (arg) =>
        /^(-d|--data.*|-F|--form.*|-T|--upload-file|--post-data|--post-file|--method)/.test(arg) || /^-X/.test(arg),
    )
  )
    return computerText("upload");
  if (name === "osascript" && /\b(do\s+shell\s+script|send|deliver|delete|purchase|buy|pay)\b/i.test(args.join(" ")))
    return computerText("appleScript");
  if (name === "defaults" && args[0] !== "read") return computerText("defaults");
  return null;
}

function shellHumanReason(command: string): string | null {
  if (!command.trim()) return "Comando vazio.";
  if (sensitiveShellPath.test(command))
    return "Comando que mexe em chave, senha ou credencial sempre passa por uma pessoa.";
  const segments = shellSegments(command);
  if (!segments) return computerText("unparsed");
  if (/\$\(|`|[<>]\(/.test(command))
    return "Comando montado na hora ($(…), crase ou disfarce) sempre passa por uma pessoa.";
  for (const [index, segment] of segments.entries()) {
    if (segment.opaque || segment.obfuscated)
      return "Comando montado na hora ($(…), crase ou disfarce) sempre passa por uma pessoa.";
    const reason = shellSegmentReason(segment, index > 0 && segment.piped);
    if (reason) return reason;
  }
  return null;
}

function readOnlySegment({ words, redirects, background }: Segment) {
  if (background) return false;
  if (redirects.some(({ op, target }) => !quietTargets.has(target) || op.startsWith("<"))) return false;
  const { program, args } = programOf(words);
  if (!readPrograms.has(program)) return false;
  if (program === "sed") return !args.some((arg) => /^(-i|--in-place)/.test(arg) || /(^|;)\s*w\s/.test(arg));
  if (program === "find") return !args.some((arg) => findWrites.has(arg));
  if (program === "git") return gitReads.has(args.find((arg) => !arg.startsWith("-")) ?? "");
  if (program === "defaults") return args[0] === "read";
  if (program === "plutil") return args[0] === "-p" || args[0] === "-lint";
  return true;
}

export function computerShellReadOnly(tool: string, args: Record<string, unknown>) {
  if (tool !== "shell_run") return false;
  const command = String(args.cmd ?? "");
  if (shellHumanReason(command)) return false;
  const segments = shellSegments(command);
  return Boolean(segments?.length) && (segments ?? []).every((segment) => !segment.dynamic && readOnlySegment(segment));
}

const doShellScript = /\bdo\s+shell\s+script\b/i;

export function computerHumanReason(tool: string, args: Record<string, unknown>): string | null {
  const text = JSON.stringify(args);
  if (tool === "computer_applescript" && doShellScript.test(String(args.script ?? ""))) return computerText("doShell");
  if (
    tool === "computer_applescript" &&
    /\b(send|deliver|delete|empty trash|purchase|buy|pay)\b|\bMail\b|\bMessages\b/i.test(String(args.script ?? ""))
  ) {
    return computerText("appleScriptSend");
  }
  if (tool === "files_trash" && Array.isArray(args.paths) && args.paths.length > 10) return computerText("bigTrash");
  if (tool === "shell_run") return shellHumanReason(String(args.cmd ?? ""));
  if (
    (tool === "computer_type" || tool === "computer_key") &&
    /(?:\d[ -]?){13,19}|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(text)
  )
    return computerText("sensitiveTyping");
  if (tool === "computer_open" && /(checkout|pagamento|payment|pay\b|comprar|buy)/i.test(String(args.url ?? "")))
    return computerText("payment");
  return null;
}
