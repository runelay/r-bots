import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readItem } from "./handoff";
import type { ToolContext } from "./mcp";
import { getStoredSession } from "./sessions";

function scopeOf(context: ToolContext) {
  return { runId: context.runId(), turnId: context.turnId };
}

export function registerThreadTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "thread_read",
    {
      description:
        "Lê um item da história desta conversa pelo id (os ids omitidos vêm no bloco “Contexto da conversa (handoff)”): mensagem, resultado completo de ferramenta, diff de código. Texto longo vem em pedaços de 4000 caracteres: chame de novo com offset = nextOffset até nextOffset ser null.",
      inputSchema: { itemId: z.string().min(1).max(300), offset: z.number().int().min(0).optional() },
    },
    async (args: Record<string, unknown>) => {
      const callId = `call_${randomBytes(9).toString("base64url")}`;
      const itemId = String(args.itemId);
      const offset = Number(args.offset ?? 0);
      context.onCallStart();
      try {
        context.log.emit({
          type: "call.requested",
          data: {
            callId,
            capability: { kind: "tool", name: "thread_read", label: "Relendo a conversa" },
            input: { itemId, offset },
            owner: context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() },
            ...(context.origin ? { origin: { agent: context.origin } } : {}),
          },
          scope: scopeOf(context),
        });
        context.log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
        const session = getStoredSession(context.sessionId);
        const result = session ? readItem(session, itemId, offset) : { error: "Conversa não encontrada." };
        const failed = "error" in result;
        context.log.emit({
          type: "call.settled",
          data: failed
            ? { callId, outcome: "failed", error: { code: "ITEM_NOT_FOUND", message: String(result.error) } }
            : {
                callId,
                outcome: "completed",
                output: {
                  itemId,
                  offset: result.offset,
                  chars: result.text.length,
                  totalChars: result.totalChars,
                  nextOffset: result.nextOffset,
                },
              },
          scope: scopeOf(context),
        });
        context.onCallSettled(`thread_read(${itemId}) → ${failed ? "não achou" : "ok"}`);
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
