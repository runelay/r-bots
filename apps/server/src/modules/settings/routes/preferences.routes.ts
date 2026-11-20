import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { readPreferences, updatePreferences } from "../services/preferences.service";

export async function handlePreferences(req: Req, res: Res, method: string, parts: string[]) {
  if (parts.length !== 1) return notFound(res);
  if (method === "GET") return sendJson(res, 200, await readPreferences(), { "cache-control": "no-store" });
  if (method === "PATCH") {
    try {
      return sendJson(res, 200, await updatePreferences(await readBody(req)));
    } catch (error) {
      return validationResponse(res, error);
    }
  }
  return notFound(res);
}
