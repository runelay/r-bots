import { httpText, type Res, sendJson } from "../../../shared/http";
import { usageText } from "../constants/usage-messages.constants";
import { limitsCheckedAt, usageLimits, usageSummary } from "../services/usage.service";

export async function handleUsageRoute(res: Res, url: URL) {
  try {
    if (url.pathname === "/usage/limits") {
      const accounts = await usageLimits(url.searchParams.get("refresh") === "1");
      return sendJson(res, 200, { checkedAt: limitsCheckedAt(), accounts });
    }
    if (url.pathname === "/usage/summary") {
      const provider = url.searchParams.get("provider");
      const account = url.searchParams.get("account");
      return sendJson(
        res,
        200,
        await usageSummary(
          url.searchParams.get("range") ?? "30d",
          provider === "claude" || provider === "codex" ? provider : null,
          account?.trim() || null,
        ),
      );
    }
    return sendJson(res, 404, { ok: false, error: httpText("notFound") });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: usageText("failed", { reason: error instanceof Error ? error.message : String(error) }).slice(0, 300),
    });
  }
}
