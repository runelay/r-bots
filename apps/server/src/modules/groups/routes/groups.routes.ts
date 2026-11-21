import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { handleEve } from "../../conversations/routes/sessions.routes";
import {
  ensureThread,
  markThreadRead,
  markThreadUnread,
  publicThread,
} from "../../conversations/services/threads.service";
import { isRunning } from "../../engine/services/engine.service";
import {
  createGroup,
  type Group,
  getGroup,
  listGroups,
  setGroupArchived,
  updateGroup,
} from "../services/groups.service";

async function publicGroup(group: Group) {
  const state = await ensureThread(group.id, "group");
  return {
    id: group.id,
    name: group.name,
    members: group.members,
    sessionBasePath: `/groups/${group.id}/eve/v1`,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    archivedAt: group.archivedAt,
    thread: { ...publicThread(state), running: isRunning(state.sessionId) },
  };
}

export async function handleGroups(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  try {
    if (parts.length === 1 && method === "GET") {
      return sendJson(
        res,
        200,
        await Promise.all(listGroups(url.searchParams.get("archived") === "1").map(publicGroup)),
      );
    }
    if (parts.length === 1 && method === "POST")
      return sendJson(res, 201, await publicGroup(await createGroup(await readBody(req))));
    const group = getGroup(parts[1] ?? "");
    if (!group) return sendJson(res, 404, { ok: false, error: "Grupo não encontrado." });
    const tail = parts.slice(2).join("/");
    if (parts[2] === "eve") {
      if (parts[4] === "session" && !parts[5])
        return sendJson(res, 405, { ok: false, error: "Grupos usam só a conversa do grupo (GET /groups/:id/thread)." });
      const owner = { id: group.id, archivedAt: group.archivedAt, deletedAt: null } as unknown as BotDefinition;
      return handleEve(req, res, url, owner, parts.slice(3));
    }
    if (tail === "" && method === "GET") return sendJson(res, 200, await publicGroup(group));
    if (tail === "" && method === "PATCH") {
      const updated = await updateGroup(group.id, await readBody(req));
      if (!updated) return sendJson(res, 404, { ok: false, error: "Grupo não encontrado." });
      return sendJson(res, 200, await publicGroup(updated));
    }
    if ((tail === "archive" || tail === "unarchive") && method === "POST") {
      await readBody(req).catch(() => undefined);
      const updated = await setGroupArchived(group.id, tail === "archive");
      if (!updated) return sendJson(res, 404, { ok: false, error: "Grupo não encontrado." });
      return sendJson(res, 200, await publicGroup(updated));
    }
    if (tail === "thread" && method === "GET") return sendJson(res, 200, (await publicGroup(group)).thread);
    if (tail === "thread/read" && method === "POST") {
      await readBody(req).catch(() => undefined);
      return sendJson(res, 200, publicThread(await markThreadRead(group.id)));
    }
    if (tail === "thread/unread" && method === "POST") {
      await readBody(req).catch(() => undefined);
      return sendJson(res, 200, publicThread(await markThreadUnread(group.id)));
    }
    return notFound(res);
  } catch (error) {
    return validationResponse(res, error);
  }
}
