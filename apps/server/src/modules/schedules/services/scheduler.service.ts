import { randomUUID } from "node:crypto";
import { env } from "../../../config/env";
import { getBot, listBots, onBotsChanged } from "../../bots/services/bots.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import { deliver } from "../../engine/services/engine.service";
import { defineJob, schedule, scheduledJobs, unschedule } from "../../jobs/services/jobs.service";

export const fireJobType = "schedule.fire";

export interface FirePayload {
  botId: string;
  scheduleId: string;
}

let reloading: Promise<void> = Promise.resolve();

export async function fire(botId: string, scheduleName: string, prompt: string) {
  const thread = await ensureThread(botId);
  const session = getStoredSession(thread.sessionId);
  if (!session) return null;
  const deliveryId = randomUUID();
  console.log(`schedule ${botId}/${scheduleName} -> ${thread.sessionId}`);
  await deliver(session, { deliveryId, text: prompt, source: "schedule", scheduleId: scheduleName });
  return { sessionId: thread.sessionId, deliveryId };
}

export async function runFireJob(payload: FirePayload) {
  if (env.BOTS_SCHEDULES === "off") return { skipped: "off" };
  const item = getBot(payload.botId)?.schedules.find((entry) => entry.name === payload.scheduleId);
  if (!item) return { skipped: "gone" };
  if (item.paused) return { skipped: "paused" };
  return fire(payload.botId, item.name, item.prompt);
}

defineJob<FirePayload>(fireJobType, { attempts: 3, backoffMs: 5000, handler: runFireJob });

export function scheduleKey(botId: string, name: string) {
  return `schedule.${botId}.${encodeURIComponent(name)}`;
}

async function syncSchedules() {
  const desired = new Map<string, { botId: string; name: string; cron: string; timezone: string }>();
  for (const bot of listBots()) {
    for (const item of bot.schedules.filter((entry) => !entry.paused))
      desired.set(scheduleKey(bot.id, item.name), {
        botId: bot.id,
        name: item.name,
        cron: item.cron,
        timezone: item.timezone,
      });
  }
  const current = (await scheduledJobs()).filter((item) => item.type === fireJobType);
  for (const item of current) if (!desired.has(item.key)) await unschedule(item.key);
  const loaded: string[] = [];
  for (const [key, item] of desired) {
    const existing = current.find((entry) => entry.key === key);
    try {
      if (existing?.pattern !== item.cron || existing.timezone !== item.timezone)
        await schedule<FirePayload>(key, { pattern: item.cron, timezone: item.timezone }, fireJobType, {
          botId: item.botId,
          scheduleId: item.name,
        });
      loaded.push(key);
    } catch (error) {
      console.error(`invalid schedule ${item.botId}/${item.name}`, error);
    }
  }
  const next = new Map((await scheduledJobs()).map((item) => [item.key, item.next]));
  console.log(`schedules loaded: ${loaded.map((key) => `${key}@${next.get(key) ?? "?"}`).join(", ") || "none"}`);
}

export function reloadSchedules() {
  reloading = reloading.then(syncSchedules).catch((error) => console.error("schedules not loaded", error));
  return reloading;
}

export async function startScheduler() {
  if (env.BOTS_SCHEDULES === "off") return console.log("schedules off");
  await reloadSchedules();
  onBotsChanged(() => void reloadSchedules());
}
