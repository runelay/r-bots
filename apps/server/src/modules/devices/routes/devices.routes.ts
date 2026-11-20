import type { Req, Res } from "../../../shared/http";
import { notFound, readBody, sendJson, validationResponse } from "../../../shared/http";
import { currentAuthModule, principalOf } from "../../auth/gate";
import { DevicesError, listDevices, registerDevice, revokeDevice } from "../services/devices.service";

const noStore = { "cache-control": "no-store" };

export async function handleDevices(req: Req, res: Res, method: string, parts: string[]) {
  const principal = principalOf(req.raw);
  try {
    if (!principal) throw new DevicesError(401, "unauthorized", "Entre na sua conta para gerenciar dispositivos.");
    if (parts.length === 1 && method === "GET")
      return sendJson(res, 200, { ok: true, devices: await listDevices(principal) }, noStore);
    if (parts.length === 1 && method === "POST") {
      const registered = await registerDevice(principal, await readBody(req));
      const origins = currentAuthModule()?.origins;
      if (origins) await origins.remember(origins.originOf(req.raw), principal);
      return sendJson(res, 201, { ok: true, ...registered }, noStore);
    }
    if (parts.length === 2 && method === "DELETE")
      return sendJson(res, 200, { ok: true, ...(await revokeDevice(principal, parts[1] ?? "")) }, noStore);
  } catch (error) {
    if (error instanceof DevicesError)
      return sendJson(res, error.status, { ok: false, code: error.code, error: error.message }, noStore);
    return validationResponse(res, error);
  }
  return notFound(res);
}
