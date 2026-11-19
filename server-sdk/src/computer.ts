import { MacRunnerUnavailable, macComputerCall, macComputerHealth, macRunnerConnected, watchMacComputerEvents } from "./mac-runner";

const macUrl = process.env.MAC_RUNNER_URL ?? "http://100.122.172.127:4790";
const runnerToken = process.env.RUNNER_TOKEN ?? "";

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
  if (macRunnerConnected()) {
    try {
      return await macComputerHealth();
    } catch (error) {
      return { ok: false, code: "COMPUTER_UNAVAILABLE", error: `O app runelay bots não respondeu: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    const response = await fetch(`${macUrl}/computer/health`, { headers: { authorization: `Bearer ${runnerToken}` }, signal: AbortSignal.timeout(5000) });
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, code: "COMPUTER_UNAVAILABLE", error: `Runner do Mac fora do ar: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function callComputerSocket(tool: string, args: Record<string, unknown>, context: ComputerContext, signal?: AbortSignal) {
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

export async function callComputer(tool: string, args: Record<string, unknown>, context: ComputerContext, signal?: AbortSignal) {
  if (macRunnerConnected()) return callComputerSocket(tool, args, context, signal);
  let response: Response;
  try {
    response = await fetch(`${macUrl}/computer/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ args, context }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new ComputerError("COMPUTER_UNAVAILABLE", `O Mac não respondeu: ${error instanceof Error ? error.message : String(error)}`);
  }
  let body: { ok?: boolean; code?: string; error?: string; result?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!response.ok || body.ok === false) {
    const code = body.code ?? (response.status === 503 ? "COMPUTER_UNAVAILABLE" : "COMPUTER_ERROR");
    throw new ComputerError(code, body.error ?? `O computador respondeu ${response.status}.`);
  }
  return body.result;
}

export function watchComputerEvents(onStop: (event: { type: string; botId?: string }) => void) {
  const stopSocket = watchMacComputerEvents((event) => {
    if (event.type === "stop" || event.type === "user_took_over") onStop(event);
  });
  if (macRunnerConnected()) return stopSocket;
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`${macUrl}/computer/events`, { headers: { authorization: `Bearer ${runnerToken}` }, signal: controller.signal });
      if (!response.ok || !response.body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
          if (!line) continue;
          try {
            const event = JSON.parse(line) as { type: string; botId?: string };
            if (event.type === "stop" || event.type === "user_took_over") onStop(event);
          } catch {}
        }
      }
    } catch {}
  })();
  return () => {
    stopSocket();
    controller.abort();
  };
}

const shellAllowlist = /^\s*(npm|pnpm|bun|node|swift|xcodebuild|ls|cat|mkdir|git\s+(status|diff|add|commit))\b/;

export function computerHumanReason(tool: string, args: Record<string, unknown>): string | null {
  const text = JSON.stringify(args);
  if (tool === "computer_applescript" && /\b(send|deliver|delete|empty trash|purchase|buy|pay)\b|\bMail\b|\bMessages\b/i.test(String(args.script ?? ""))) {
    return "AppleScript que envia, apaga ou compra sempre passa por uma pessoa.";
  }
  if (tool === "files_trash" && Array.isArray(args.paths) && args.paths.length > 10) return "Mandar mais de 10 itens para a lixeira sempre passa por uma pessoa.";
  if (tool === "shell_run" && !shellAllowlist.test(String(args.cmd ?? ""))) return "Comando fora da lista permitida sempre passa por uma pessoa.";
  if (tool === "shell_run" && /\bsudo\b|[;&|`$(]\s*rm\s|\brm\s+-rf?\b/.test(String(args.cmd ?? ""))) return "Comando perigoso sempre passa por uma pessoa.";
  if ((tool === "computer_type" || tool === "computer_key") && /(?:\d[ -]?){13,19}|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(text)) return "Digitar cartão ou documento sempre passa por uma pessoa.";
  if (tool === "computer_open" && /(checkout|pagamento|payment|pay\b|comprar|buy)/i.test(String(args.url ?? ""))) return "Página de pagamento sempre passa por uma pessoa.";
  return null;
}
