import { notFound, type Res, sendJson, validationResponse } from "../../../shared/http";
import { listTools, startInstall, ToolError } from "../services/tools.service";

const noStore = { "cache-control": "no-store" };

export function handleTools(res: Res, method: string, parts: string[]) {
  try {
    if (method === "GET" && parts.length === 1) return sendJson(res, 200, { ok: true, tools: listTools() }, noStore);
    if (method === "POST" && parts.length === 3 && parts[2] === "install") {
      const result = startInstall(parts[1]);
      return sendJson(res, result.started ? 202 : 200, { ok: true, ...result }, noStore);
    }
  } catch (error) {
    if (error instanceof ToolError) return sendJson(res, error.status, { ok: false, error: error.message }, noStore);
    return validationResponse(res, error);
  }
  return notFound(res);
}
