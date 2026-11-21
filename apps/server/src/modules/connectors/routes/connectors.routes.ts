import { notFound, type Req, type Res, readBody, runelayFailure, sendFile, sendJson } from "../../../shared/http";
import {
  connectorLogo,
  getCatalog,
  installCatalogItem,
  listConnections,
  RunelayApiError,
  reconnectSource,
  removeSource,
  runelayEnabled,
} from "../services/runelay.service";

export async function handleConnectorActions(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  try {
    if (parts.length === 2 && parts[1] === "catalog" && method === "GET") {
      return sendJson(res, 200, await getCatalog((url.searchParams.get("query") ?? "").trim().slice(0, 100)));
    }
    if (parts.length === 3 && parts[1] === "logos" && method === "GET") {
      const logo = await connectorLogo(parts[2] ?? "");
      if (!logo) return notFound(res);
      return sendFile(res, new Blob([logo.data], { type: logo.type }), {
        "content-type": logo.type,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      });
    }
    const name = parts[1] ?? "";
    if (!/^[a-z0-9_-]{1,60}$/.test(name))
      return sendJson(res, 400, { ok: false, error: "Nome de conector inválido.", field: "name" });
    if (parts.length === 3 && parts[2] === "install" && method === "POST") {
      const body = ((await readBody(req).catch(() => undefined)) ?? {}) as { token?: unknown };
      const connectorToken = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined;
      return sendJson(res, 201, await installCatalogItem(name, connectorToken));
    }
    if (parts.length === 3 && parts[2] === "reconnect" && method === "POST") {
      await readBody(req).catch(() => undefined);
      return sendJson(res, 200, await reconnectSource(name));
    }
    if (parts.length === 2 && method === "DELETE") return sendJson(res, 200, await removeSource(name));
    return notFound(res);
  } catch (error) {
    if (error instanceof RunelayApiError) return sendJson(res, error.status, { ok: false, error: error.message });
    return runelayFailure(res, error);
  }
}

export async function handleConnections(req: Req, res: Res, url: URL, method: string) {
  if (method === "POST") await readBody(req).catch(() => undefined);
  if (!runelayEnabled()) return sendJson(res, 503, { ok: false, error: "runelay não está configurado no servidor." });
  try {
    return sendJson(res, 200, await listConnections(method === "POST" || url.searchParams.get("refresh") === "1"));
  } catch (error) {
    return runelayFailure(res, error);
  }
}
