import { findAccount } from "../../accounts/services/accounts.service";
import { getBot } from "../../bots/services/bots.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { defineJob, enqueue, jobsActive } from "../../jobs/services/jobs.service";
import { type CaptureInput, capture, type RecallItem } from "./memory.service";

export const captureJobType = "memory.capture";

export interface CapturePayload {
  botId: string;
  accountId: string;
  model: string;
  userText: string;
  replyText: string;
  recalled: RecallItem[];
  sessionId: string;
  turnId: string;
}

export async function runCaptureJob(payload: CapturePayload) {
  const bot = getBot(payload.botId);
  const account = await findAccount(payload.accountId);
  const session = getStoredSession(payload.sessionId);
  if (!bot || !account || !session) return { skipped: true };
  await capture({
    bot,
    account,
    model: payload.model,
    userText: payload.userText,
    replyText: payload.replyText,
    recalled: payload.recalled,
    log: session.log,
    turnId: payload.turnId,
  });
  await session.log.flush();
  return { skipped: false };
}

defineJob<CapturePayload>(captureJobType, { attempts: 4, backoffMs: 5000, handler: runCaptureJob });

export async function queueCapture(input: CaptureInput & { sessionId: string }) {
  if (!jobsActive()) return capture(input);
  await enqueue<CapturePayload>(captureJobType, {
    botId: input.bot.id,
    accountId: input.account.id,
    model: input.model,
    userText: input.userText,
    replyText: input.replyText,
    recalled: input.recalled,
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
}
