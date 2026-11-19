import { botCodeSummary, botIsCoding } from "../../code/services/bot-code.service";
import { listConversations } from "../../conversations/services/conversations.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import {
  ensureThread,
  peekThread,
  publicThread,
  recordThreadMessage,
} from "../../conversations/services/threads.service";
import { botStatus } from "../../engine/services/engine.service";
import {
  type BotDefinition,
  connectorsOf,
  decisionsOf,
  engineOf,
  memoryOf,
  permissionOfBot,
  sidebarOf,
  voiceOf,
} from "./bots.service";

export async function publicBot(bot: BotDefinition) {
  return {
    id: bot.id,
    name: bot.name,
    role: bot.role,
    accent: bot.accent,
    glyph: bot.glyph,
    sessionBasePath: `/bots/${bot.id}/eve/v1`,
    schedules: bot.schedules,
    hasBrowser: bot.capabilities.browser || (await botIsCoding(bot.id).catch(() => false)),
    instructions: bot.instructions,
    capabilities: bot.capabilities,
    engine: engineOf(bot),
    decisions: decisionsOf(bot),
    connectors: connectorsOf(bot),
    memory: memoryOf(bot),
    computer: bot.computer ?? { allowedRoots: ["~/Desktop", "~/Downloads", "~/Documents"] },
    voice: voiceOf(bot),
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    archivedAt: bot.archivedAt,
    deletedAt: bot.deletedAt ?? null,
    sidebar: sidebarOf(bot),
    permission: permissionOfBot(bot),
    conversations: await listConversations(bot.id),
    thread: {
      ...publicThread(await peekThread(bot.id)),
      running: botStatus(bot.id) !== "idle",
      status: botStatus(bot.id),
    },
    code: await botCodeSummary(bot).catch(() => null),
  };
}

export async function postGreeting(bot: BotDefinition) {
  const thread = await ensureThread(bot.id);
  const session = getStoredSession(thread.sessionId);
  if (!session) return;
  const value = `Oi! Eu sou ${bot.name} e acabei de chegar no time. O que você quer que eu faça?`;
  session.log.emit({
    type: "content.completed",
    data: { kind: "text", partId: "greeting.0", phase: "reply", runId: "greeting", value, greeting: true },
    scope: { runId: "greeting" },
  });
  await recordThreadMessage(bot.id, thread.sessionId, { role: "bot", text: value, at: new Date().toISOString() });
}
