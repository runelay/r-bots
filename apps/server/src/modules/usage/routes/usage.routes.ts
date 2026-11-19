import { type Res, sendJson } from "../../../shared/http";
import { limitsCheckedAt, usageLimits, usageSummary } from "../services/usage.service";

export async function handleUsageRoute(res: Res, url: URL) {
  try {
    if (url.pathname === "/usage/limits") {
      const accounts = await usageLimits(url.searchParams.get("refresh") === "1");
      return sendJson(res, 200, { checkedAt: limitsCheckedAt(), accounts });
    }
    if (url.pathname === "/usage/summary") {
      const provider = url.searchParams.get("provider");
      const environment = url.searchParams.get("environment");
      return sendJson(
        res,
        200,
        await usageSummary(
          url.searchParams.get("range") ?? "30d",
          provider === "claude" || provider === "codex" ? provider : null,
          environment === "vps" || environment === "mac" ? environment : null,
        ),
      );
    }
    return sendJson(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: `Não deu para calcular o uso: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    });
  }
}
