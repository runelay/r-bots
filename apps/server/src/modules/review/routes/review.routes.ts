import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { defaultBot, readPresets, runPreset, savePresets } from "../services/review.service";

function optional(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 120) throw new ValidationError("Valor inválido.", field);
  return value;
}

export async function handleReview(req: Req, res: Res, method: string, parts: string[]) {
  try {
    const [, first] = parts;
    if (parts.length === 1 && method === "GET")
      return sendJson(res, 200, { presets: await readPresets(), defaultBotId: defaultBot()?.id ?? null });
    if (first === "presets" && parts.length === 2 && method === "PUT")
      return sendJson(res, 200, {
        presets: await savePresets(await readBody(req)),
        defaultBotId: defaultBot()?.id ?? null,
      });
    if (first === "run" && parts.length === 2 && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new ValidationError("Corpo inválido.", "body");
      const presetId = optional(body.presetId, "presetId");
      if (!presetId) throw new ValidationError("Escolha o preset.", "presetId");
      return sendJson(
        res,
        201,
        await runPreset({
          presetId,
          botId: optional(body.botId, "botId"),
          view: optional(body.view, "view"),
          project: optional(body.project, "project"),
        }),
      );
    }
    return notFound(res);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError) return validationResponse(res, error);
    return sendJson(res, 502, {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
  }
}
