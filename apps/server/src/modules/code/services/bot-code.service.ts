import type { BotDefinition } from "../../bots/services/bots.service";
import { getStoredSession, sessionsOf } from "../../conversations/services/sessions.service";
import { peekThread } from "../../conversations/services/threads.service";
import { isRunning } from "../../engine/services/engine.service";
import { activeWorkspace, codeSummary } from "./workspace.service";

const summaryCache = new Map<string, { at: number; value: unknown }>();

export async function botCodeSummary(bot: BotDefinition) {
  const thread = await peekThread(bot.id);
  if (!thread?.sessionId) return null;
  const session = getStoredSession(thread.sessionId);
  const workspace = activeWorkspace(session);
  if (!workspace) return null;
  const cached = summaryCache.get(workspace.id);
  const running = isRunning(thread.sessionId);
  if (cached && Date.now() - cached.at < 3_000) return { ...(cached.value as object), running };
  const summary = await codeSummary(workspace);
  const pr = workspace.pr ? { number: workspace.pr.number, status: workspace.pr.status, ci: workspace.pr.ci } : null;
  const value = {
    repoName: summary.repoName,
    branch: summary.branch,
    path: summary.path,
    files: summary.files,
    added: summary.added,
    removed: summary.removed,
    pr,
  };
  summaryCache.set(workspace.id, { at: Date.now(), value });
  return { ...value, running };
}

export function botIsCoding(botId: string) {
  return Promise.resolve(
    sessionsOf(botId).some(
      (session) =>
        (session.meta.kind === "thread" || session.meta.kind === "conversation") && Boolean(activeWorkspace(session)),
    ),
  );
}
