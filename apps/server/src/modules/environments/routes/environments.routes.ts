import type { Res } from "../../../shared/http";
import { sendJson } from "../../../shared/http";
import { readEnvironments } from "../services/environments.service";

export async function handleEnvironments(res: Res) {
  return sendJson(res, 200, await readEnvironments(), { "cache-control": "no-store" });
}
