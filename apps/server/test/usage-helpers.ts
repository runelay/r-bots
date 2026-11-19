import { spyOn } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CodexRpcMessage {
  id?: number;
  method?: string;
}

export type CodexResponder = (message: CodexRpcMessage) => string[] | "close" | "error" | "throw" | undefined;

export interface FakeCodexServer {
  commands: string[][];
  killed: string[];
  restore(): void;
}

export function fakeCodexAppServer(respond: CodexResponder): FakeCodexServer {
  const commands: string[][] = [];
  const killed: string[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
    commands.push(command);
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const encoder = new TextEncoder();
    const close = () => {
      if (closed) return;
      closed = true;
      controller?.close();
    };
    const stdout = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    let input = "";
    return {
      stdin: {
        write(chunk: string) {
          input += chunk;
          let newline = input.indexOf("\n");
          while (newline !== -1) {
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            newline = input.indexOf("\n");
            const reply = respond(JSON.parse(line) as CodexRpcMessage);
            if (reply === "throw") throw new Error("broken pipe");
            if (reply === "error") {
              closed = true;
              controller?.error(new Error("stream failed"));
            } else if (reply === "close") close();
            else if (reply && !closed) for (const out of reply) controller?.enqueue(encoder.encode(`${out}\n`));
          }
          return chunk.length;
        },
        flush() {
          return 0;
        },
      },
      stdout,
      kill(signal: string) {
        killed.push(signal);
        close();
      },
    };
  }) as unknown as typeof Bun.spawn);
  return { commands, killed, restore: () => spy.mockRestore() };
}

export async function writeFixture(path: string, content: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}

export async function resetUsageTables() {
  const { getDb } = await import("../src/db");
  const client = getDb().$client;
  for (const table of ["usage_buckets", "usage_sessions", "usage_cursors", "usage_seen"])
    client.run(`DELETE FROM ${table}`);
  client.run("DELETE FROM settings WHERE key LIKE 'usage.%'");
}
