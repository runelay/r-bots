import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { CliUpdateError, listVersions, rollback, startUpdate } from "../services/cli-versions.service";

const noStore = { "cache-control": "no-store" };

function versionOf(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Corpo inválido.", "body");
  return (value as Record<string, unknown>).version;
}

export async function handleProviders(req: Req, res: Res, method: string, parts: string[]) {
  try {
    if (method === "GET" && parts.length === 2 && parts[1] === "versions")
      return sendJson(res, 200, { ok: true, providers: await listVersions() }, noStore);
    if (method === "POST" && parts.length === 3 && parts[2] === "update") {
      const started = await startUpdate(parts[1], versionOf(await readBody(req)));
      return sendJson(res, 202, { ok: true, ...started }, noStore);
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "rollback")
      return sendJson(res, 200, { ok: true, version: await rollback(parts[1]) }, noStore);
  } catch (error) {
    if (error instanceof CliUpdateError)
      return sendJson(res, error.status, { ok: false, error: error.message }, noStore);
    return validationResponse(res, error);
  }
  return notFound(res);
}
