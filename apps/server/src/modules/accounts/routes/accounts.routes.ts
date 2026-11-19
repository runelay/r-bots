import { type Req, type Res, readBody, sendJson } from "../../../shared/http";
import { listAccounts, refreshAccounts } from "../services/accounts.service";

export async function handleAccounts(res: Res, url: URL) {
  const accounts = url.searchParams.get("refresh") === "1" ? await refreshAccounts() : await listAccounts();
  return sendJson(res, 200, accounts);
}

export async function handleAccountsRefresh(req: Req, res: Res) {
  await readBody(req).catch(() => undefined);
  return sendJson(res, 200, await refreshAccounts());
}
