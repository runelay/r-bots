import type { Req, Res } from "../../../shared/http";
import { macRunnerAuthorized } from "../../accounts/services/mac-runner.service";
import { principalOf } from "../../auth/gate";
import {
  audit,
  deleteSecret,
  ensureVaultLoaded,
  envNameOf,
  listSecretMeta,
  markUsed,
  readAudit,
  type SecretMeta,
  saveSecretMeta,
  secretNamePattern,
  serverStorageAvailable,
  setServerCopy,
  takeExecTicket,
  VaultError,
} from "../services/vault.service";

function json(res: Res, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: Req) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new VaultError("too_big", "Corpo grande demais.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new VaultError("bad_json", "JSON inválido.");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function publicMeta(meta: SecretMeta) {
  return { ...meta, ref: `segredo:${meta.name}`, env: envNameOf(meta.name) };
}

export async function handleVaultRoute(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  await ensureVaultLoaded();
  if (parts[1] === "exec" && parts.length === 3 && method === "POST") {
    if (req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"])
      return json(res, 404, { ok: false, error: "Rota não encontrada." });
    const grant = takeExecTicket(parts[2]);
    if (!grant) return json(res, 410, { ok: false, error: "Esse tíquete já foi usado ou venceu." });
    return json(res, 200, grant);
  }
  if (!macRunnerAuthorized(req)) return json(res, 401, { ok: false, error: "O cofre só responde ao app r/bots." });
  try {
    if (parts.length === 2 && parts[1] === "secrets" && method === "GET") {
      return json(res, 200, { secrets: listSecretMeta().map(publicMeta), serverStorage: serverStorageAvailable() });
    }
    if (parts.length === 2 && parts[1] === "audit" && method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      return json(res, 200, await readAudit(url.searchParams.get("name"), limit));
    }
    if (parts.length === 2 && parts[1] === "audit" && method === "POST") {
      if (!principalOf(req.raw)?.device)
        return json(res, 403, { ok: false, error: "Só o app do Mac registrado pode gravar no histórico do cofre." });
      const body = await readJsonBody(req);
      const name = String(body.name ?? "");
      if (!secretNamePattern.test(name)) throw new VaultError("bad_name", "Nome inválido.");
      const outcome = String(body.outcome ?? "");
      if (!["used", "denied", "revealed"].includes(outcome)) throw new VaultError("bad_outcome", "outcome inválido.");
      await audit({
        name,
        outcome,
        by: body.botId ? "bot" : "person",
        ...(body.botId ? { botId: String(body.botId).slice(0, 60) } : {}),
        ...(body.botName ? { botName: String(body.botName).slice(0, 60) } : {}),
        ...(body.tool ? { tool: String(body.tool).slice(0, 60) } : {}),
        ...(body.domain ? { domain: String(body.domain).slice(0, 253) } : {}),
        ...(body.reason ? { reason: String(body.reason).slice(0, 60) } : {}),
        source: "mac",
      });
      if (outcome === "used" && body.botId) await markUsed(name, String(body.botId), String(body.tool ?? ""));
      return json(res, 200, { ok: true });
    }
    const name = parts[2] ?? "";
    if (parts[1] === "secrets" && parts.length === 3 && method === "PUT")
      return json(res, 200, publicMeta(await saveSecretMeta(name, await readJsonBody(req))));
    if (parts[1] === "secrets" && parts.length === 3 && method === "DELETE") {
      const existed = await deleteSecret(name);
      return json(
        res,
        existed ? 200 : 404,
        existed ? { ok: true, name } : { ok: false, error: "Esse segredo não existe no cofre." },
      );
    }
    if (parts[1] === "secrets" && parts.length === 4 && parts[3] === "server-copy" && method === "PUT") {
      const body = await readJsonBody(req);
      const value = typeof body.value === "string" ? body.value : "";
      body.value = null;
      if (!value || value.length > 16_384)
        throw new VaultError("bad_value", "Valor vazio ou grande demais (máximo 16 KB).");
      return json(res, 200, publicMeta(await setServerCopy(name, value)));
    }
    if (parts[1] === "secrets" && parts.length === 4 && parts[3] === "server-copy" && method === "DELETE")
      return json(res, 200, publicMeta(await setServerCopy(name, null)));
    return json(res, 404, { ok: false, error: "Rota não encontrada." });
  } catch (error) {
    if (error instanceof VaultError)
      return json(res, error.code === "not_found" ? 404 : 400, { ok: false, code: error.code, error: error.message });
    throw error;
  }
}
