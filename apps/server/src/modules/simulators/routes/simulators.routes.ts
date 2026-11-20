import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { listDevices, openExpo } from "../services/simulators.service";

function body(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Corpo inválido.", "body");
  return value as Record<string, unknown>;
}

export async function handleSimulators(req: Req, res: Res, method: string, parts: string[]) {
  try {
    if (method === "GET" && parts.length === 1) return sendJson(res, 200, await listDevices());
    if (method === "POST" && parts[1] === "open-expo" && parts.length === 2) {
      const input = body(await readBody(req));
      if (typeof input.server !== "string" || !input.server) throw new ValidationError("Diga o servidor.", "server");
      const client = input.client === "go" || input.client === "dev" ? input.client : undefined;
      const result = await openExpo({
        serverId: input.server,
        ...(typeof input.udid === "string" && input.udid ? { udid: input.udid } : {}),
        ...(client ? { client } : {}),
      });
      return sendJson(res, 200, { ok: true, ...result });
    }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError) return validationResponse(res, error);
    return sendJson(res, 502, { ok: false, error: (error as Error).message });
  }
  return notFound(res);
}
