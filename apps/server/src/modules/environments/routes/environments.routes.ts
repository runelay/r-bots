import type { Res } from "../../../shared/http";
import { sendJson } from "../../../shared/http";
import { listEnvironments } from "../services/environments.service";

export function handleEnvironments(res: Res) {
  return sendJson(res, 200, { ok: true, environments: listEnvironments() }, { "cache-control": "no-store" });
}
