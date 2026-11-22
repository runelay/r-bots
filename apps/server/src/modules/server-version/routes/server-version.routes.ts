import { ValidationError } from "../../../shared/errors";
import { type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { commonText } from "../../../shared/messages";
import { serverVersionText } from "../constants/server-version-messages.constants";
import { requestServerUpdate } from "../services/server-update.service";
import { serverVersion } from "../services/server-version.service";

export async function handleServerVersion(res: Res) {
  return sendJson(res, 200, await serverVersion(), { "cache-control": "no-store" });
}

function forceOf(body: unknown) {
  if (body === undefined || body === null) return false;
  if (typeof body !== "object" || Array.isArray(body)) throw new ValidationError(commonText("bodyInvalid"), "body");
  const force = (body as Record<string, unknown>).force;
  if (force === undefined) return false;
  if (typeof force !== "boolean") throw new ValidationError(serverVersionText("forceInvalid"), "force");
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
    error: serverVersionText(result.code),
    ...(result.running === undefined ? {} : { running: result.running }),
  });
}
