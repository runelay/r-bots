import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setKnownConnectors } from "../../bots/services/bots.service";
import {
  integrationSecret,
  integrationSource,
  integrationUrl,
  onIntegrationChange,
} from "../../integrations/services/integration-store.service";

const url = () => integrationUrl("runelay") ?? "";
const token = () => integrationSecret("runelay") ?? "";
const reconnectUrl = process.env.RUNELAY_RECONNECT_URL ?? null;

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

export function runelayEnabled() {
  return Boolean(url() && token());
}

async function connect() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const next = new Client({ name: "runelay-bots", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url()), {
      requestInit: { headers: { Authorization: `Bearer ${token()}` } },
    });
    await next.connect(transport);
    next.onclose = () => {
      if (client === next) client = null;
    };
    client = next;
    return next;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

function textOf(result: unknown) {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("\n");
}

export async function runelayCall(name: string, args: Record<string, unknown>, timeoutMs = 60_000) {
  if (!runelayEnabled()) throw new Error("runelay não está configurado no servidor.");
  let attempt = 0;
  while (true) {
    try {
      const current = await connect();
      const result = await current.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      const text = textOf(result);
      if ((result as { isError?: boolean }).isError) throw new Error(text.slice(0, 2000) || `Falha em ${name}.`);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    } catch (error) {
      attempt++;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt > 1 || !/closed|ECONNREFUSED|session|fetch failed|socket/i.test(message)) throw error;
      client = null;
    }
  }
}

export interface Connection {
  name: string;
  label: string;
  icon: string | null;
  status: "ok" | "needs_auth" | "error";
  toolCount: number;
  reconnectUrl: string | null;
}

const labels: Record<string, string> = {
  linear_server: "Linear",
  github: "GitHub",
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  notion: "Notion",
  supabase: "Supabase",
  neon: "Neon",
  posthog: "PostHog",
  resend: "Resend",
  cloudflare: "Cloudflare",
  cloudflare_docs: "Cloudflare Docs",
  doop: "Doop",
  meta_social_technologies: "Meta",
};

function labelOf(name: string) {
  return (
    labels[name] ??
    name
      .split(/[_-]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

let cache: { at: number; list: Connection[] } | null = null;

export function clearConnectionsCache() {
  cache = null;
  setKnownConnectors([]);
}

onIntegrationChange((id) => {
  if (id !== "runelay") return;
  const previous = client;
  client = null;
  cache = null;
  void previous?.close().catch(() => undefined);
  if (runelayEnabled()) void listConnections(true).catch(() => undefined);
  else setKnownConnectors([]);
});

export async function listConnections(force = false): Promise<Connection[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.list;
  const raw = (await runelayCall("list_connections", {})) as Array<{
    name: string;
    status?: string;
    toolCount?: number;
    icon?: string | null;
    enabled?: boolean;
  }>;
  const list = raw
    .filter((item) => item.enabled !== false)
    .map((item) => {
      const status: Connection["status"] =
        item.status === "ok" ? "ok" : item.status === "needs_auth" ? "needs_auth" : "error";
      return {
        name: item.name,
        label: labelOf(item.name),
        icon: item.icon ?? null,
        status,
        toolCount: item.toolCount ?? 0,
        reconnectUrl: status === "ok" ? null : reconnectUrl,
      };
    });
  cache = { at: Date.now(), list };
  setKnownConnectors(list.filter((item) => item.status === "ok").map((item) => item.name));
  return list;
}

const logoCache = new Map<string, { type: string; data: Uint8Array }>();
const logoLimit = 512 * 1024;

function logoOrigins() {
  const origins: string[] = [];
  for (const candidate of [url(), apiBase()]) {
    try {
      const origin = candidate ? new URL(candidate).origin : "";
      if (origin && !origins.includes(origin)) origins.push(origin);
    } catch {}
  }
  return origins;
}

export async function connectorLogo(file: string) {
  if (!/^[a-z0-9_-]{1,60}\.(png|svg)$/.test(file)) return null;
  const cached = logoCache.get(file);
  if (cached) return cached;
  for (const origin of logoOrigins()) {
    try {
      const response = await fetch(`${origin}/logos/${file}`, { signal: AbortSignal.timeout(8000) });
      const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
      if (!response.ok || !type.startsWith("image/")) continue;
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength === 0 || data.byteLength > logoLimit) continue;
      const logo = { type, data };
      logoCache.set(file, logo);
      return logo;
    } catch {}
  }
  return null;
}

export interface FoundTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export async function searchTools(query: string, allowed: string[], limit = 8): Promise<FoundTool[]> {
  const results: FoundTool[] = [];
  const sources = allowed.length === 1 ? [allowed[0]] : [undefined];
  for (const source of sources) {
    const found = (await runelayCall("search_tools", {
      query,
      limit: Math.min(30, limit * 3),
      ...(source ? { source } : {}),
    })) as FoundTool[];
    for (const item of Array.isArray(found) ? found : []) {
      const connection = item.name.split(".")[0];
      if (allowed.includes(connection))
        results.push({
          name: item.name,
          description: String(item.description ?? "").slice(0, 600),
          inputSchema: item.inputSchema,
        });
    }
  }
  return results.slice(0, limit);
}

const outbound =
  /(send|email|mail|message|reply|chat|notify|sms|whatsapp|tweet|dm\b|invite|slack|refund|charge|payment|payout|pay\b|transfer|deploy|publish|merge|delete|purge|drop|truncate|apply_migration|migrate)/i;
const writeSql = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i;
const writes =
  /(create|update|delete|remove|save|set_|add|post|put|patch|merge|deploy|archive|restore|write|insert|upsert|move|assign|close|cancel|approve|reject|publish|execute|run|trigger|import|upload|retire|unshare|mark|link|submit|resolve|refund|charge|pay|transfer|revoke|rotate|purge|drop|truncate|rename|edit|modify|apply|enable|disable|start|stop|schedule|book|respond)/i;
const reads =
  /^(?:get|list|search|read|fetch|query|find|describe|show|view|count|whoami|me|lookup|retrieve|check|preview|inspect|extract|explain|status)(?:[_-]|$)/i;

export type ToolKind = "read" | "write" | "outbound";

function stripSqlNoise(sql: string) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
}

const sqlSideEffect =
  /\b(insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|vacuum|reindex|cluster|copy|call|lock|refresh|reset|begin|commit|rollback|savepoint|prepare|execute|deallocate|listen|notify|unlisten|discard|into)\b|\bfor\s+(update|share|no\s+key|key)\b|\bpg_(terminate|cancel|reload|rotate|sleep|advisory|read_file|write|ls_dir|stat_file)|\b(lo_\w+|dblink\w*|set_config|nextval|setval)\s*\(/i;

export function isReadOnlySql(sql: string) {
  const cleaned = stripSqlNoise(sql).trim().replace(/;\s*$/, "").trim();
  if (!cleaned || cleaned.includes(";")) return false;
  if (!/^(select|with|explain\s+select)\b/i.test(cleaned)) return false;
  return !sqlSideEffect.test(cleaned);
}

export function touchesDatabase(qualified: string) {
  return /sql|query|migration|postgres|supabase\.|database/i.test(qualified);
}

function sqlOf(args: Record<string, unknown>) {
  const value = args.query ?? args.sql ?? args.statement;
  return typeof value === "string" ? value : null;
}

export function classifyTool(qualified: string, args: Record<string, unknown> = {}): ToolKind {
  const tool = qualified.split(".").slice(1).join(".") || qualified;
  const sql = /sql|query/i.test(tool) ? sqlOf(args) : null;
  if (sql !== null) return isReadOnlySql(sql) ? "read" : "outbound";
  if (outbound.test(tool) && !reads.test(tool)) return "outbound";
  if (/sql|query/i.test(tool) && writeSql.test(JSON.stringify(args))) return "outbound";
  if (reads.test(tool) && !writes.test(tool.replace(reads, ""))) return "read";
  return "write";
}

function apiBase() {
  const origin = url() ? new URL(url()).origin : "";
  if (integrationSource("runelay") === "app") return origin;
  return process.env.RUNELAY_API_URL ?? origin;
}

export class RunelayApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function runelayApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!runelayEnabled()) throw new RunelayApiError(503, "runelay não está configurado no servidor.");
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RunelayApiError(
      502,
      `runelay não respondeu: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    );
  }
  const payload = (await response.json().catch(() => null)) as { data?: T; error?: { message?: string } | null } | null;
  if (!response.ok || payload?.error) {
    const status =
      response.status === 404
        ? 404
        : response.status >= 500
          ? 502
          : response.status === 401 || response.status === 403
            ? 502
            : 400;
    throw new RunelayApiError(
      status,
      (payload?.error?.message ?? `runelay respondeu ${response.status}.`).slice(0, 300),
    );
  }
  return payload?.data as T;
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  auth: "oauth" | "api_key" | "none";
  tokenUrl: string | null;
  featured: boolean;
  installed: boolean;
  sourceName: string | null;
  status: "ok" | "needs_auth" | "error" | "idle" | null;
}

export interface CatalogSection {
  id: string;
  title: string;
  items: CatalogItem[];
}

interface RawCatalog {
  sections: Array<{ id: string; title: string; items: Array<Record<string, unknown>> }>;
}

function catalogItemOf(raw: Record<string, unknown>): CatalogItem {
  const auth = raw.auth === "api_key" || raw.auth === "none" ? raw.auth : "oauth";
  const status = typeof raw.status === "string" ? (raw.status as CatalogItem["status"]) : null;
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    description: String(raw.description ?? ""),
    icon: typeof raw.icon === "string" && raw.icon ? raw.icon : null,
    auth,
    tokenUrl: typeof raw.tokenUrl === "string" ? raw.tokenUrl : null,
    featured: raw.featured === true,
    installed: raw.installed === true,
    sourceName: typeof raw.sourceName === "string" ? raw.sourceName : null,
    status,
  };
}

export async function getCatalog(query: string) {
  const params = query ? `?${new URLSearchParams({ query })}` : "";
  const raw = await runelayApi<RawCatalog>("GET", `/catalog${params}`);
  const sections = (raw?.sections ?? []).map((section) => ({
    id: section.id,
    title: section.title,
    items: section.items.map(catalogItemOf),
  }));
  return {
    featured: sections.flatMap((section) => section.items.filter((item) => item.featured)),
    sections: sections
      .map((section) => ({ ...section, items: section.items.filter((item) => !item.featured) }))
      .filter((section) => section.items.length > 0),
  };
}

async function startLogin(sourceName: string) {
  const started = await runelayApi<{ authorizationUrl: string | null }>(
    "POST",
    `/sources/${encodeURIComponent(sourceName)}/oauth`,
  );
  return started?.authorizationUrl ?? null;
}

export async function installCatalogItem(id: string, connectorToken?: string) {
  const catalog = await runelayApi<RawCatalog>("GET", "/catalog");
  const raw = catalog?.sections.flatMap((section) => section.items).find((item) => item.id === id);
  if (!raw) throw new RunelayApiError(404, `Não existe conector "${id}" no catálogo.`);
  const item = catalogItemOf(raw);
  if (item.installed) throw new RunelayApiError(409, `${item.name} já está instalado.`);
  if (item.auth === "api_key" && !connectorToken) throw new RunelayApiError(400, `${item.name} pede um token.`);
  const source = await runelayApi<{ name: string; status: string; error: string | null }>("POST", "/catalog/install", {
    id,
    ...(connectorToken ? { token: connectorToken } : {}),
  });
  cache = null;
  const authorizationUrl = item.auth === "oauth" ? await startLogin(source.name) : null;
  return { sourceName: source.name, status: source.status, error: source.error ?? null, authorizationUrl };
}

export async function reconnectSource(sourceName: string) {
  const authorizationUrl = await startLogin(sourceName);
  cache = null;
  return { sourceName, authorizationUrl };
}

export async function removeSource(sourceName: string) {
  await runelayApi<unknown>("DELETE", `/sources/${encodeURIComponent(sourceName)}`);
  cache = null;
  return { ok: true, sourceName };
}
