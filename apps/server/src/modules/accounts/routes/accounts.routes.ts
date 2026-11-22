import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { emitSettingsChange } from "../../settings/services/settings-events.service";
import { accountsText } from "../constants/accounts-messages.constants";
import {
  addAccountDir,
  listAccounts,
  loginGuide,
  refreshAccounts,
  removeAccountDir,
  updateAccount,
} from "../services/accounts.service";

export async function handleAccounts(res: Res, url: URL) {
  const accounts = url.searchParams.get("refresh") === "1" ? await refreshAccounts() : await listAccounts();
  return sendJson(res, 200, accounts);
}

export async function handleAccountsRefresh(req: Req, res: Res) {
  await readBody(req).catch(() => undefined);
  const accounts = await refreshAccounts();
  emitSettingsChange(["accounts", "usage"]);
  return sendJson(res, 200, accounts);
}

function changed(res: Res, result: unknown) {
  emitSettingsChange(["accounts", "usage"]);
  return sendJson(res, 200, result);
}

export async function handleAccountRoutes(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  try {
    if (method === "GET" && parts.length === 2 && parts[1] === "login-guide")
      return sendJson(res, 200, await loginGuide(url.searchParams.get("provider") ?? "claude"));
    if (method === "POST" && parts.length === 2 && parts[1] === "dirs")
      return changed(res, await addAccountDir(await readBody(req)));
    if (parts.length === 2 && (method === "PATCH" || method === "DELETE")) {
      const result =
        method === "PATCH" ? await updateAccount(parts[1], await readBody(req)) : await removeAccountDir(parts[1]);
      if (!result) return sendJson(res, 404, { ok: false, error: accountsText("accountMissing") });
      return changed(res, result);
    }
    return notFound(res);
  } catch (error) {
    return validationResponse(res, error);
  }
}
