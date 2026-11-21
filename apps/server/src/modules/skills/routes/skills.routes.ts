import { type Res, runelayFailure, sendJson } from "../../../shared/http";
import { RunelayApiError, runelayEnabled } from "../../connectors/services/runelay.service";
import { listSkills } from "../services/skills.service";

export async function handleSkills(res: Res, url: URL) {
  if (!runelayEnabled())
    return sendJson(res, 503, {
      ok: false,
      error: "runelay não está configurado no servidor.",
      code: "not_configured",
    });
  try {
    return sendJson(
      res,
      200,
      await listSkills(url.searchParams.get("query") ?? "", url.searchParams.get("refresh") === "1"),
    );
  } catch (error) {
    if (error instanceof RunelayApiError) return sendJson(res, error.status, { ok: false, error: error.message });
    return runelayFailure(res, error);
  }
}
