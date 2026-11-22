import { notFound, type Req, type Res, readBody, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { rejectInactiveBot } from "../../conversations/routes/delivery-input";
import { schedulesText } from "../constants/schedules-messages.constants";
import { fire } from "../services/scheduler.service";

export async function handleBotSchedules(req: Req, res: Res, method: string, bot: BotDefinition, rest: string[]) {
  if (rest[1] !== "run" || rest.length !== 2 || method !== "POST") return notFound(res);
  await readBody(req).catch(() => undefined);
  if (rejectInactiveBot(res, bot)) return;
  const schedule = bot.schedules.find((item) => item.name === rest[0]);
  if (!schedule) return sendJson(res, 404, { ok: false, error: schedulesText("notFound") });
  const started = await fire(bot.id, schedule.name, schedule.prompt);
  if (!started) return sendJson(res, 500, { ok: false, error: schedulesText("openFailed") });
  return sendJson(res, 202, { ok: true, ...started, scheduleId: schedule.name });
}
