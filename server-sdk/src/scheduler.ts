import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { listBots, onBotsChanged } from "./bots";
import { deliver } from "./engine";
import { getStoredSession } from "./sessions";
import { ensureThread } from "./threads";

let jobs: Cron[] = [];

export async function fire(botId: string, scheduleName: string, prompt: string) {
  const thread = await ensureThread(botId);
  const session = getStoredSession(thread.sessionId);
  if (!session) return null;
  const deliveryId = randomUUID();
  console.log(`schedule ${botId}/${scheduleName} -> ${thread.sessionId}`);
  deliver(session, { deliveryId, text: prompt, source: "schedule", scheduleId: scheduleName });
  return { sessionId: thread.sessionId, deliveryId };
}

export function reloadSchedules() {
  for (const job of jobs) job.stop();
  jobs = [];
  for (const bot of listBots()) {
    for (const schedule of bot.schedules) {
      try {
        jobs.push(
          new Cron(schedule.cron, { timezone: schedule.timezone, protect: true, name: `${bot.id}:${schedule.name}` }, () => {
            void fire(bot.id, schedule.name, schedule.prompt).catch((error) => console.error("schedule failed", error));
          }),
        );
      } catch (error) {
        console.error(`invalid schedule ${bot.id}/${schedule.name}`, error);
      }
    }
  }
  console.log(`schedules loaded: ${jobs.map((job) => `${job.name}@${job.nextRun()?.toISOString()}`).join(", ") || "none"}`);
}

export function startScheduler() {
  if (process.env.BOTS_SCHEDULES === "off") return console.log("schedules off");
  reloadSchedules();
  onBotsChanged(reloadSchedules);
}
