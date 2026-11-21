import { type Res, sendJson } from "../../../shared/http";
import { serverVersion } from "../services/server-version.service";

export async function handleServerVersion(res: Res) {
  return sendJson(res, 200, await serverVersion(), { "cache-control": "no-store" });
}
