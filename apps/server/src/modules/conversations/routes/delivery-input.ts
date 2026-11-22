import { type Res, runelayFailure, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { RunelayApiError, runelayEnabled } from "../../connectors/services/runelay.service";
import { type LoadedSkill, loadSkill, skillSlugPattern } from "../../skills/services/skills.service";
import { resolveUploads, type UploadMeta } from "../../uploads/services/uploads.service";
import { conversationsText } from "../constants/conversations-messages.constants";
import type { StoredSession } from "../services/sessions.service";

const acceptedFields = [
  "inbox",
  "message",
  "answers",
  "clientContext",
  "outputSchema",
  "turnPolicy",
  "callback",
  "forwardedPrincipal",
  "idempotencyKey",
  "skills",
  "attachments",
];

export function checkFields(body: unknown) {
  if (body === undefined) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object.";
  for (const key of Object.keys(body)) {
    if (!acceptedFields.includes(key)) return `Unknown field '${key}'. Accepted fields: ${acceptedFields.join(", ")}.`;
  }
  const raw = body as Record<string, unknown>;
  if (raw.message !== undefined && typeof raw.message !== "string") return "Field 'message' must be a string.";
  if (raw.answers !== undefined && !Array.isArray(raw.answers)) return "Field 'answers' must be an array.";
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills) || raw.skills.length > 5)
      return "Field 'skills' must be an array with up to 5 slugs.";
    if (raw.skills.some((slug) => typeof slug !== "string" || !skillSlugPattern.test(slug)))
      return "Field 'skills' has an invalid slug.";
  }
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > 10)
      return "Field 'attachments' must be an array with up to 10 upload ids.";
    if (raw.attachments.some((id) => typeof id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)))
      return "Field 'attachments' has an invalid upload id.";
  }
  return null;
}

export async function resolveSkills(res: Res, body: unknown): Promise<LoadedSkill[] | null> {
  const slugs = [...new Set(((body as { skills?: string[] } | undefined)?.skills ?? []) as string[])];
  if (slugs.length === 0) return [];
  if (!runelayEnabled()) {
    sendJson(res, 503, { ok: false, error: conversationsText("runelayMissing") });
    return null;
  }
  try {
    return await Promise.all(slugs.map(loadSkill));
  } catch (error) {
    if (error instanceof RunelayApiError && error.status === 404)
      sendJson(res, 400, { ok: false, error: conversationsText("skillGone"), field: "skills" });
    else runelayFailure(res, error);
    return null;
  }
}

export function deliveryText(message: string | undefined, skills: LoadedSkill[]) {
  if (message?.trim()) return message;
  return skills.map((skill) => `/${skill.name}`).join(" ");
}

export async function resolveAttachments(res: Res, bot: BotDefinition, body: unknown): Promise<UploadMeta[] | null> {
  const ids = [...new Set(((body as { attachments?: string[] } | undefined)?.attachments ?? []) as string[])];
  if (ids.length === 0) return [];
  const metas = await resolveUploads(bot.id, ids);
  if (!metas) {
    sendJson(res, 400, { ok: false, error: conversationsText("attachmentGone"), field: "attachments" });
    return null;
  }
  return metas;
}

export function accepted(res: Res, session: StoredSession, deliveryId: string) {
  sendJson(
    res,
    202,
    { ok: true, sessionId: session.meta.sessionId, deliveryId },
    { "x-eve-session-id": session.meta.sessionId },
  );
}

export function rejectInactiveBot(res: Res, bot: BotDefinition) {
  if (bot.deletedAt) {
    sendJson(res, 409, { ok: false, code: "bot_deleted", error: conversationsText("botDeleted") });
    return true;
  }
  if (bot.archivedAt) {
    sendJson(res, 409, { ok: false, code: "bot_archived", error: conversationsText("botArchived") });
    return true;
  }
  return false;
}
