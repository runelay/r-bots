import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ValidationError } from "../../../shared/errors";
import { guardedFetch } from "../../../shared/net-guard";
import {
  clearStored,
  envLast4,
  type IntegrationId,
  integrationIds,
  integrationSource,
  integrationUrl,
  readStored,
  storedIntegrationBroken,
  writeStored,
} from "./integration-store.service";

export type IntegrationStatus = "connected" | "not_configured" | "invalid";

interface Definition {
  name: string;
  description: string;
  unlocks: string;
  fallback: string;
  keyUrl: string;
  domain: string;
  needsUrl: boolean;
}

const definitions: Record<IntegrationId, Definition> = {
  elevenlabs: {
    name: "ElevenLabs",
    description: "Voz natural nas chamadas e transcrição de áudio no servidor.",
    unlocks: "Chamada de voz com os bots",
    fallback: "Sem ElevenLabs a chamada de voz fica desligada e os áudios são transcritos no Mac.",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    domain: "elevenlabs.io",
    needsUrl: false,
  },
  jev: {
    name: "Jev",
    description: "Decide sozinho as aprovações de rotina, percebe bot travado e faz a triagem do que é importante.",
    unlocks: "Aprovações automáticas",
    fallback: "Sem Jev toda ação de risco espera você aprovar e nada é marcado como lido sozinho.",
    keyUrl: "https://typesafe.ai",
    domain: "typesafe.ai",
    needsUrl: false,
  },
  runelay: {
    name: "runelay",
    description: "Conectores (Linear, GitHub, Supabase…), memória e skills compartilhadas em todos os bots.",
    unlocks: "Conectores, memória e skills",
    fallback: "Sem runelay os bots trabalham sem conectores, memória e skills.",
    keyUrl: "https://docs.runelay.com",
    domain: "runelay.com",
    needsUrl: true,
  },
};

export class IntegrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function describe(id: IntegrationId) {
  const definition = definitions[id];
  const source = integrationSource(id);
  const stored = readStored(id);
  const broken = storedIntegrationBroken(id);
  const status: IntegrationStatus = broken ? "invalid" : source ? "connected" : "not_configured";
  return {
    id,
    ...definition,
    status,
    configured: source !== null,
    source,
    last4: source === "app" ? (stored?.last4 ?? "") : source === "env" ? envLast4(id) : "",
    validatedAt: source === "app" ? (stored?.validatedAt ?? null) : null,
    url: definition.needsUrl ? integrationUrl(id) : null,
  };
}

export function listIntegrations() {
  return integrationIds.map(describe);
}

export function integrationFlags() {
  return Object.fromEntries(integrationIds.map((id) => [id, integrationSource(id) !== null])) as Record<
    IntegrationId,
    boolean
  >;
}

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function trustedServiceUrl(value: string | undefined, fallback: string) {
  const raw = value?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return fallback;
    if (url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname))) return raw;
  } catch {}
  console.warn(`ignoring insecure service URL ${raw.slice(0, 80)}: use https`);
  return fallback;
}

function elevenLabsBase() {
  return trustedServiceUrl(process.env.ELEVENLABS_API_URL, "https://api.elevenlabs.io");
}

let probeLoopbackPorts: number[] = [];

export function setProbeLoopbackPorts(ports: number[]) {
  probeLoopbackPorts = [...ports];
}

function runelayFetch(input: string | URL, init?: RequestInit) {
  const url = new URL(String(input));
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const allow = process.env.RUNELAY_ALLOW_LOOPBACK === "1" ? [...probeLoopbackPorts, port] : probeLoopbackPorts;
  return guardedFetch(url, { ...init, allowLoopbackPorts: allow, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
}

async function probeElevenLabs(key: string) {
  const response = await fetch(`${elevenLabsBase()}/v1/user`, {
    headers: { "xi-api-key": key },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) return "O ElevenLabs recusou essa chave.";
  if (!response.ok) return `O ElevenLabs respondeu ${response.status}. Tente de novo em instantes.`;
  return null;
}

async function probeJev(key: string) {
  const response = await fetch(process.env.JEV_URL ?? "https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.JEV_MODEL ?? "jev-1.14.0",
      state: { check: "ok" },
      questions: { ping: { type: "noul", instructions: "O estado diz ok?" } },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) return "O Jev recusou essa chave.";
  if (!response.ok) return `O Jev respondeu ${response.status}. Tente de novo em instantes.`;
  return null;
}

async function probeRunelay(key: string, url: string) {
  const client = new Client({ name: "runelay-bots-check", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: runelayFetch,
  });
  try {
    await client.connect(transport);
    const result = (await client.callTool({ name: "list_connections", arguments: {} }, undefined, {
      timeout: 15_000,
    })) as { isError?: boolean };
    return result.isError ? "O runelay não listou as conexões com essa chave." : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) return "O runelay recusou essa chave.";
    return "Não consegui falar com o runelay nesse endereço.";
  } finally {
    await transport.close();
  }
}

function normalizeUrl(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError("Endereço inválido.", "url");
  try {
    const parsed = new URL(value.trim());
    if (parsed.username || parsed.password) throw new Error("userinfo");
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname)))
      throw new Error("protocol");
    return parsed.toString();
  } catch {
    throw new ValidationError("Endereço inválido: use https:// (http só para 127.0.0.1).", "url");
  }
}

export async function saveIntegration(id: IntegrationId, body: Record<string, unknown>) {
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (key.length < 8 || key.length > 4096 || /\s/.test(key)) throw new ValidationError("Cole a chave inteira.", "key");
  const definition = definitions[id];
  const url = definition.needsUrl ? (normalizeUrl(body.url) ?? integrationUrl(id)) : null;
  if (definition.needsUrl && !url) throw new ValidationError("Informe o endereço do seu runelay.", "url");
  let problem: string | null;
  try {
    problem =
      id === "elevenlabs"
        ? await probeElevenLabs(key)
        : id === "jev"
          ? await probeJev(key)
          : await probeRunelay(key, url as string);
  } catch {
    problem = `Não consegui falar com o ${definition.name} agora. Tente de novo em instantes.`;
  }
  if (problem) throw new IntegrationError(422, "invalid_key", problem);
  await writeStored(id, key, url);
  return describe(id);
}

export async function removeIntegration(id: IntegrationId) {
  await clearStored(id);
  return describe(id);
}
