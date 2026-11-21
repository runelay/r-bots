import { ValidationError } from "../../../shared/errors";
import { type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { requestServerUpdate } from "../services/server-update.service";
import { serverVersion } from "../services/server-version.service";

const refusals = {
  agent_missing: "O vigia de atualização não está instalado neste servidor. Rode rbots update no servidor.",
  update_in_progress: "Já tem uma atualização em andamento.",
  turns_running: "Há turnos rodando agora.",
} as const;

export async function handleServerVersion(res: Res) {
  return sendJson(res, 200, await serverVersion(), { "cache-control": "no-store" });
}

function forceOf(body: unknown) {
  if (body === undefined || body === null) return false;
  if (typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Corpo inválido.", "body");
  const force = (body as Record<string, unknown>).force;
  if (force === undefined) return false;
  if (typeof force !== "boolean") throw new ValidationError("force precisa ser true ou false.", "force");
  return force;
}

export async function handleServerUpdate(req: Req, res: Res) {
  let force: boolean;
  try {
    force = forceOf(await readBody(req));
  } catch (error) {
    return validationResponse(res, error);
  }
  const result = await requestServerUpdate(force);
  if (result.ok) return sendJson(res, 202, result, { "cache-control": "no-store" });
  return sendJson(res, result.status, {
    ok: false,
    code: result.code,
    error: refusals[result.code],
    ...(result.running === undefined ? {} : { running: result.running }),
  });
}
