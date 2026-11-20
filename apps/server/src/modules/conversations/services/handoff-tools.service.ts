import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { readableThread, readThread } from "../../engine/services/side-threads.service";
import { readItem } from "./handoff.service";
import { getStoredSession } from "./sessions.service";

function scopeOf(context: ToolContext) {
  return { runId: context.runId(), turnId: context.turnId };
}

async function lookup(context: ToolContext, itemId: string, threadId: string, offset: number, limit: number) {
  if (!itemId && !threadId) return { error: "Passe itemId ou threadId." };
  if (!itemId) return readThread(context, threadId, limit);
  const session = threadId ? readableThread(context, threadId) : getStoredSession(context.sessionId);
  if (!session) return { error: "Conversa não encontrada." };
  const result = await readItem(session, itemId, offset);
  const parent = !threadId && session.meta.parentSessionId ? getStoredSession(session.meta.parentSessionId) : undefined;
  if ("error" in result && parent) {
    const inherited = await readItem(parent, itemId, offset);
    if (!("error" in inherited)) return inherited;
  }
  return result;
}

export function registerThreadTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "thread_read",
    {
      description:
        "Lê um item da história desta conversa pelo id (os ids omitidos vêm no bloco “Contexto da conversa (handoff)”): mensagem, resultado completo de ferramenta, diff de código. Texto longo vem em pedaços de 4000 caracteres: chame de novo com offset = nextOffset até nextOffset ser null. Com threadId (uma conversa sua ou filha desta) e sem itemId, traz o status e as últimas mensagens dela.",
      inputSchema: {
        itemId: z.string().min(1).max(300).optional(),
        threadId: z.string().min(1).max(120).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    async (args: Record<string, unknown>) => {
      const callId = `call_${randomBytes(9).toString("base64url")}`;
      const itemId = typeof args.itemId === "string" ? args.itemId : "";
      const threadId = typeof args.threadId === "string" ? args.threadId : "";
      const offset = Number(args.offset ?? 0);
      context.onCallStart();
      try {
        context.log.emit({
          type: "call.requested",
          data: {
            callId,
            capability: { kind: "tool", name: "thread_read", label: "Relendo a conversa" },
            input: { ...(itemId ? { itemId, offset } : {}), ...(threadId ? { threadId } : {}) },
            owner: context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() },
            ...(context.origin ? { origin: { agent: context.origin } } : {}),
          },
          scope: scopeOf(context),
        });
        context.log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
        const result = await lookup(context, itemId, threadId, offset, Number(args.limit ?? 10));
        const failed = "error" in result;
        context.log.emit({
          type: "call.settled",
          data: failed
            ? { callId, outcome: "failed", error: { code: "ITEM_NOT_FOUND", message: String(result.error) } }
            : {
                callId,
                outcome: "completed",
                output:
                  "messages" in result
                    ? { threadId, status: result.status, messages: result.messages.length }
                    : {
                        itemId,
                        offset: result.offset,
                        chars: result.text.length,
                        totalChars: result.totalChars,
                        nextOffset: result.nextOffset,
                      },
              },
          scope: scopeOf(context),
        });
        context.onCallSettled(`thread_read(${itemId || threadId}) → ${failed ? "não achou" : "ok"}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(failed ? { isError: true } : {}),
        };
      } finally {
        context.onCallEnd();
      }
    },
  );
}
