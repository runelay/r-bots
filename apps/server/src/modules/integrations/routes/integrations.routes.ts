import type { Req, Res } from "../../../shared/http";
import { notFound, readBody, sendJson, validationResponse } from "../../../shared/http";
import { isIntegrationId } from "../services/integration-store.service";
import {
  IntegrationError,
  listIntegrations,
  removeIntegration,
  saveIntegration,
} from "../services/integrations.service";

const noStore = { "cache-control": "no-store" };

export async function handleIntegrations(req: Req, res: Res, method: string, parts: string[]) {
  if (parts.length === 1 && method === "GET") return sendJson(res, 200, { integrations: listIntegrations() }, noStore);
  const id = parts[1] ?? "";
  if (parts.length !== 2 || !isIntegrationId(id)) return notFound(res);
  try {
    if (method === "PUT") {
      const body = await readBody(req);
      const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      return sendJson(res, 200, await saveIntegration(id, record), noStore);
    }
    if (method === "DELETE") return sendJson(res, 200, removeIntegration(id), noStore);
  } catch (error) {
    if (error instanceof IntegrationError)
      return sendJson(res, error.status, { ok: false, code: error.code, status: "invalid", error: error.message });
    return validationResponse(res, error);
  }
  return notFound(res);
}
