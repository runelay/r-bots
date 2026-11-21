import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ValidationError } from "../../../shared/errors";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { addReaction, normalizeEmoji, ReactionTargetMissing, removeReaction } from "./reactions.service";
import { getStoredSession } from "./sessions.service";

function reply(payload: Record<string, unknown>, failed = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(failed ? { isError: true } : {}),
  };
}

async function guarded(run: () => Promise<Record<string, unknown>>) {
  try {
    return reply(await run());
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ReactionTargetMissing)
      return reply({ ok: false, error: error.message }, true);
    throw error;
  }
}

export function registerReactionTools(server: McpServer, context: ToolContext) {
  const session = () => getStoredSession(context.sessionId);
  const author = { kind: "bot" as const, id: context.botId };
  const targetOf = (args: Record<string, unknown>) =>
    typeof args.target === "string" && args.target.trim() ? args.target.trim() : context.messageId;
  server.registerTool(
    "react",
    {
      description:
        "Reage com um emoji a uma mensagem desta conversa, como numa conversa entre pessoas. Sem target, reage à mensagem que você está respondendo. Você tem no máximo uma reação por mensagem: chamar de novo troca a anterior (ex.: 👀 → ✅). Não substitui a resposta em texto.",
      inputSchema: {
        emoji: z.string().min(1).max(32),
        target: z.string().min(1).max(200).optional(),
      },
    },
    async (args: Record<string, unknown>) =>
      guarded(async () => {
        const current = session();
        const target = targetOf(args);
        if (!current || !target) throw new ReactionTargetMissing("Sem mensagem para reagir.");
        const reactions = await addReaction(current, { target, emoji: normalizeEmoji(args.emoji), author });
        return { ok: true, target, reactions };
      }),
  );
  server.registerTool(
    "unreact",
    {
      description:
        "Tira a sua reação de uma mensagem desta conversa. Sem target, vale a mensagem que você está respondendo.",
      inputSchema: {
        target: z.string().min(1).max(200).optional(),
      },
    },
    async (args: Record<string, unknown>) =>
      guarded(async () => {
        const current = session();
        const target = targetOf(args);
        if (!current || !target) throw new ReactionTargetMissing("Sem mensagem para tirar a reação.");
        const result = await removeReaction(current, { target, author });
        return { ok: true, target, ...result };
      }),
  );
}
