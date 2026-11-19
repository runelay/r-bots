import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { clearSection } from "../../bots/services/bots.service";
import {
  archiveSection,
  createSection,
  listSections,
  publicSection,
  updateSection,
} from "../services/sections.service";

export async function handleSections(req: Req, res: Res, method: string, parts: string[]) {
  try {
    if (parts.length === 1 && method === "GET") return sendJson(res, 200, listSections().map(publicSection));
    if (parts.length === 1 && method === "POST")
      return sendJson(res, 201, publicSection(await createSection(await readBody(req))));
    const id = parts[1] ?? "";
    if (parts.length === 2 && method === "PATCH") {
      const section = await updateSection(id, await readBody(req));
      return section
        ? sendJson(res, 200, publicSection(section))
        : sendJson(res, 404, { ok: false, error: "Seção não encontrada." });
    }
    if (parts.length === 3 && parts[2] === "archive" && method === "POST") {
      await readBody(req).catch(() => undefined);
      const section = await archiveSection(id);
      if (!section) return sendJson(res, 404, { ok: false, error: "Seção não encontrada." });
      await clearSection(id);
      return sendJson(res, 200, { ...publicSection(section), archivedAt: section.archivedAt });
    }
    return notFound(res);
  } catch (error) {
    return validationResponse(res, error);
  }
}
