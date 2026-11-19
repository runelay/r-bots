import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readBrowserState } from "./browser";
import { rootDir } from "./config";
import { decideApproval } from "./decisions";
import { macRunnerSupports } from "./mac-runner";
import type { ToolContext } from "./mcp";
import { redactDeep, redactText, variantsOf } from "./redact";
import {
  envNameOf,
  envRefsIn,
  getSecretMeta,
  hasRefs,
  issueExecTicket,
  listSecretMeta,
  normalizeDomains,
  normalizeHost,
  policyError,
  refsIn,
  resolveSecret,
  secretNamePattern,
  substituteRefs,
  VaultError,
} from "./vault";

export const vaultGuide = [
  "## Segredos (cofre)",
  "- Nunca peça senha, token, chave de API ou código no chat. Use `request_secret({name, reason, fields?, domains?})`: a pessoa digita num campo protegido do app e o valor vai direto para o cofre do Mac. Você recebe só o nome (`segredo:nome`).",
  "- Para usar um segredo, escreva a referência `segredo:nome` no lugar do valor: no `text` do `browser_fill`, no `text` do `computer_type`, nos cabeçalhos ou no corpo do `http_request`. No Bash do modo código, use a variável `$SEGREDO_NOME` (nome em maiúsculas, hífen vira _); `segredo:nome` também funciona. O valor entra só na hora, dentro da ferramenta, e você nunca vê.",
  "- `list_secrets` mostra os nomes e descrições disponíveis (nunca os valores).",
  "- Nunca tente ler, repetir, imprimir, converter, salvar em arquivo ou registrar o valor de um segredo. Saídas com o valor aparecem como ••••.",
  "- Se o uso for negado (site não liberado, bot não liberado, Touch ID cancelado, segredo vencido), conte à pessoa em uma frase e não insista. Se o Mac estiver offline e o segredo só existir no Mac, diga isso à pessoa: ela pode abrir o app ou ligar “usar com o Mac fechado” no Cofre.",
].join("\n");

const fieldShape = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe("id curto do campo, como usuario ou senha"),
  label: z.string().min(1).max(60).describe("Rótulo em português que a pessoa vê"),
  secure: z.boolean().optional().describe("true (padrão) mascara o campo; false para usuário/e-mail"),
});

function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text" as const, text: redactText(text) }], ...(isError ? { isError: true } : {}) };
}

function newCallId() {
  return `call_${randomBytes(9).toString("base64url")}`;
}

function scopeOf(context: ToolContext) {
  return { runId: context.runId(), turnId: context.turnId };
}

function ownerOf(context: ToolContext) {
  return context.ownerCallId ? { callId: context.ownerCallId } : { runId: context.runId() };
}

function requested(context: ToolContext, callId: string, name: string, label: string, input: Record<string, unknown>) {
  context.log.emit({
    type: "call.requested",
    data: { callId, capability: { kind: "tool", name, label, surface: "vault" }, input, owner: ownerOf(context), ...(context.origin ? { origin: { agent: context.origin } } : {}) },
    scope: scopeOf(context),
  });
}

function settledOk(context: ToolContext, callId: string, output: unknown, summary: string) {
  context.log.emit({ type: "call.settled", data: { callId, outcome: "completed", output }, scope: scopeOf(context) });
  context.onCallSettled(summary);
}

function settledFail(context: ToolContext, callId: string, message: string, code = "TOOL_EXECUTION_FAILED", outcome: "failed" | "rejected" = "failed") {
  context.log.emit({ type: "call.settled", data: { callId, outcome, error: { code, message } }, scope: scopeOf(context) });
  context.onCallSettled(`erro: ${message.slice(0, 160)}`);
}

function usableBy(botId: string) {
  return (meta: ReturnType<typeof listSecretMeta>[number]) => policyError({ ...meta, domains: [] }, botId, null) === null;
}

const blockedHosts = /^(localhost|0\.0\.0\.0|.*\.localhost|.*\.internal|metadata\.google\.internal)$/i;

function blockedAddress(host: string) {
  if (blockedHosts.test(host)) return true;
  const version = isIP(host);
  if (version === 4) return /^(127\.|0\.|169\.254\.)/.test(host);
  if (version === 6) return host === "::1" || host.startsWith("fe80:") || host === "::";
  return false;
}

export async function prepareSecretInput(context: ToolContext, tool: string, input: Record<string, unknown>) {
  if (tool !== "browser_fill" || !hasRefs(input.text)) return input;
  const page = await readBrowserState(context.bot.id);
  const host = normalizeHost(page?.url ?? null);
  const text = await substituteRefs(String(input.text), { botId: context.bot.id, botName: context.bot.name, tool, host, sessionId: context.sessionId });
  return { ...input, text, secretFill: true };
}

const leakyCommand = /(^|[\s|;&(`$])(base64|basenc|xxd|od|hexdump|rev|tac|fold|cut|tr|printenv|env|set|declare|export|compgen|strings|openssl|gpg|python3?|perl|ruby|node|php|awk|sed)(?=$|[\s|;&)`])|\/proc\/|>{1,2}\s*(?!&|\/dev\/null\b)[^\s]|\btee\b|\bcurl\b[^|;&]*\s(-d|--data[\w-]*|-F|--form)\s+@/;

export async function secretBashCommand(context: ToolContext, command: string) {
  const { names, unknown } = envRefsIn(command);
  if (unknown.length > 0) throw new VaultError("not_found", `Não existe segredo para ${unknown.join(", ")}. Veja os nomes com list_secrets.`);
  if (names.length === 0) return null;
  if (leakyCommand.test(command)) {
    throw new VaultError(
      "leaky_command",
      "Esse comando poderia expor o valor do segredo (conversão, impressão do ambiente, gravação em arquivo ou outro interpretador). Use o segredo direto no programa que precisa dele, por exemplo curl -H \"Authorization: Bearer $SEGREDO_X\" https://…, sem redirecionar a saída para arquivo.",
    );
  }
  const hosts = [...new Set([...command.matchAll(/\bhttps?:\/\/([^/\s'"`$:?#]+)/gi)].map((match) => normalizeHost(match[1]) ?? ""))].filter(Boolean);
  const env: Record<string, string> = {};
  const redact: string[] = [];
  for (const name of names) {
    const meta = getSecretMeta(name);
    if (meta && meta.domains.length > 0) {
      if (hosts.length === 0) throw new VaultError("denied_domain", `O segredo:${name} só vale para ${meta.domains.join(", ")}, e o comando não tem o endereço do site. Escreva a URL completa no comando.`);
      const outside = hosts.find((host) => policyError(meta, context.bot.id, host)?.code === "denied_domain");
      if (outside) throw new VaultError("denied_domain", `O segredo:${name} só pode ser usado em ${meta.domains.join(", ")}, não em ${outside}.`);
    }
    const value = await resolveSecret({ name, botId: context.bot.id, botName: context.bot.name, tool: "Bash", host: hosts[0] ?? null, sessionId: context.sessionId });
    env[envNameOf(name)] = value;
    redact.push(...variantsOf(value));
  }
  const rewritten = command.replace(/segredo:([a-z0-9][a-z0-9_-]{0,63})/g, (_match, name: string) => `\${${envNameOf(name)}}`);
  const ticket = issueExecTicket(env, redact);
  const helper = join(rootDir, "bin", "rb-secret-run.mjs");
  const port = process.env.GATEWAY_PORT ?? "2000";
  return `'${process.execPath}' '${helper}' ${port} ${ticket} ${Buffer.from(rewritten, "utf8").toString("base64")}`;
}

export function registerVaultTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    "list_secrets",
    {
      description: "Lista os segredos do cofre que existem (nome, descrição, sites liberados). Nunca mostra valores. Use segredo:nome nas ferramentas.",
      inputSchema: {},
    },
    async () => {
      const callId = newCallId();
      context.onCallStart();
      try {
        requested(context, callId, "list_secrets", "Ver os segredos do cofre", {});
        context.log.emit({ type: "call.started", data: { callId }, scope: scopeOf(context) });
        const usable = usableBy(context.bot.id);
        const items = listSecretMeta().map((meta) => ({
          ref: `segredo:${meta.name}`,
          env: envNameOf(meta.name),
          description: meta.description,
          sites: meta.domains.length ? meta.domains : "qualquer site",
          liberadoParaVoce: usable(meta),
          guardadoEm: meta.storage === "mac+server" ? "Mac e servidor (funciona com o Mac fechado)" : "só no Mac",
          ...(meta.expiresAt ? { venceEm: meta.expiresAt } : {}),
        }));
        const output = { macOnline: macRunnerSupports("vault"), segredos: items };
        settledOk(context, callId, { count: items.length }, `list_secrets → ${items.length}`);
        return textResult(output);
      } finally {
        context.onCallEnd();
      }
    },
  );

  server.registerTool(
    "request_secret",
    {
      description:
        "Pede uma senha, token ou chave à pessoa por um formulário seguro no app. O valor vai direto para o cofre do Mac e você recebe só o nome segredo:nome. Use sempre isto em vez de pedir no chat.",
      inputSchema: {
        name: z.string().regex(secretNamePattern).describe("Nome curto em minúsculas, como github-token"),
        reason: z.string().min(1).max(300).describe("Por que você precisa, em uma frase para a pessoa"),
        description: z.string().max(200).optional().describe("O que é esse segredo, para aparecer no Cofre"),
        fields: z.array(fieldShape).min(1).max(6).optional().describe("Campos do formulário. Sem isto, um campo só. Com vários, cada um vira segredo:nome-id"),
        domains: z.array(z.string().max(253)).max(20).optional().describe("Sites onde o segredo pode ser usado, como github.com ou *.github.com"),
        kind: z.enum(["password", "token", "text"]).optional(),
      },
    },
    async (args: Record<string, unknown>) => {
      const callId = newCallId();
      const name = String(args.name);
      context.onCallStart();
      try {
        const fields = ((args.fields as Array<{ id: string; label: string; secure?: boolean }> | undefined) ?? []).map((field) => ({ ...field, secure: field.secure !== false }));
        let domains: string[] = [];
        try {
          domains = normalizeDomains(args.domains);
        } catch {}
        const names = fields.length > 1 ? fields.map((field) => `${name}-${field.id}`) : [name];
        const input = { name, reason: args.reason, ...(args.description ? { description: args.description } : {}), ...(fields.length ? { fields: fields.map((field) => field.label) } : {}), ...(domains.length ? { domains } : {}) };
        requested(context, callId, "request_secret", `Pedir “${name}” num formulário seguro`, input);
        if (context.isSchedule) {
          settledFail(context, callId, "Ninguém está aqui para preencher agora.", "TOOL_EXECUTION_DENIED", "rejected");
          return textResult("Ninguém está aqui para preencher o formulário agora. Avise a pessoa na próxima conversa.", true);
        }
        if (!macRunnerSupports("vault")) {
          const message = "O app runelay bots não está aberto no Mac, e o formulário seguro precisa dele. Diga isso à pessoa e peça para abrir o app.";
          settledFail(context, callId, message);
          return textResult(message, true);
        }
        const before = new Map(names.map((item) => [item, getSecretMeta(item)?.updatedAt ?? null]));
        const { choice, interactionId } = await context.requestApproval(`${context.bot.name} pediu ${fields.length > 1 ? "estes dados" : "um segredo"}: ${String(args.reason)}`, callId, context.origin, {
          reason: String(args.reason),
          secret: {
            name,
            names,
            reason: String(args.reason),
            description: String(args.description ?? ""),
            kind: String(args.kind ?? "password"),
            fields: fields.length ? fields : [{ id: "valor", label: "Valor", secure: true }],
            domains,
            botId: context.bot.id,
            botName: context.bot.name,
          },
        });
        if (choice !== "approve") {
          context.log.emit({ type: "call.settled", data: { callId, cause: { interactionId }, outcome: "rejected", error: { code: "TOOL_EXECUTION_DENIED", message: "A pessoa preferiu não informar agora." } }, scope: scopeOf(context) });
          context.onCallSettled(`request_secret(${name}) → recusado`);
          return textResult("A pessoa preferiu não informar agora. Não peça de novo neste turno; siga sem isso ou pergunte outra coisa.", true);
        }
        const saved = names.filter((item) => {
          const meta = getSecretMeta(item);
          return meta && meta.updatedAt !== before.get(item);
        });
        if (saved.length === 0) {
          settledFail(context, callId, "O formulário fechou sem salvar.");
          return textResult("O formulário fechou sem salvar nada. Pergunte à pessoa se quer tentar de novo.", true);
        }
        const refs = saved.map((item) => `segredo:${item}`);
        settledOk(context, callId, { saved: refs }, `request_secret(${name}) → ${refs.join(", ")}`);
        return textResult(`Ok, salvo como ${refs.join(", ")}. Use a referência nas ferramentas; você nunca vai ver o valor.`);
      } finally {
        context.onCallEnd();
      }
    },
  );

  server.registerTool(
    "http_request",
    {
      description:
        "Faz uma chamada HTTP(S) a uma API externa. Cabeçalhos, corpo e URL (fora o host) aceitam segredo:nome no lugar do valor. Não segue redirecionamento (devolve o Location). GET e HEAD rodam direto; os outros métodos podem pedir aprovação.",
      inputSchema: {
        method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        url: z.string().min(8).max(4000),
        headers: z.record(z.string(), z.string().max(8000)).optional(),
        body: z.string().max(200_000).optional(),
        reason: z.string().max(160).optional(),
      },
    },
    async (args: Record<string, unknown>) => {
      const callId = newCallId();
      const method = String(args.method ?? "GET");
      const rawUrl = String(args.url);
      const headers = (args.headers as Record<string, string> | undefined) ?? {};
      const body = typeof args.body === "string" ? args.body : undefined;
      context.onCallStart();
      try {
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          requested(context, callId, "http_request", `${method} (URL inválida)`, { method, url: rawUrl });
          settledFail(context, callId, "URL inválida.");
          return textResult("URL inválida. Use https://…", true);
        }
        const host = normalizeHost(parsed.hostname) ?? "";
        const input = { method, url: rawUrl, ...(Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body: body.length > 2000 ? `${body.slice(0, 2000)}…` : body } : {}) };
        requested(context, callId, "http_request", `${method} ${host}${parsed.pathname.length > 1 ? parsed.pathname.slice(0, 50) : ""}`, input);
        if (!/^https?:$/.test(parsed.protocol) || hasRefs(parsed.hostname) || blockedAddress(host)) {
          settledFail(context, callId, "Esse endereço não é permitido.", "TOOL_POLICY", "rejected");
          return textResult("Esse endereço não é permitido (só http/https para hosts externos).", true);
        }
        let cleared: Record<string, unknown> | null = null;
        if (method !== "GET" && method !== "HEAD") {
          const decision = await decideApproval(
            { botName: context.bot.name, botRole: context.bot.role, request: context.request, tool: "http_request", input, page: null, element: "" },
            context.decisions,
            callId,
          );
          context.emitDecision(decision);
          if (decision.outcome === "auto_approved") cleared = { decision: "jev", model: decision.model };
          else {
            if (context.isSchedule) {
              settledFail(context, callId, "Ninguém está aqui para aprovar.", "TOOL_EXECUTION_DENIED", "rejected");
              return textResult("Ninguém está aqui para aprovar essa chamada agora.", true);
            }
            const { choice, interactionId } = await context.requestApproval(`Posso fazer ${method} em ${host}?`, callId, context.origin, {
              target: { label: host, role: "page", url: `${parsed.origin}${parsed.pathname}` },
              ...(args.reason ? { reason: String(args.reason) } : {}),
            });
            if (choice !== "approve") {
              context.log.emit({ type: "call.settled", data: { callId, cause: { interactionId }, outcome: "rejected", error: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." } }, scope: scopeOf(context) });
              return textResult("A pessoa negou essa chamada.", true);
            }
            cleared = { interactionId };
          }
        }
        context.log.emit({ type: "call.started", data: { callId, ...(cleared ? { clearedBy: cleared } : {}) }, scope: scopeOf(context) });
        const request = { botId: context.bot.id, botName: context.bot.name, tool: "http_request", host, sessionId: context.sessionId };
        try {
          const finalUrl = hasRefs(rawUrl) ? await substituteRefs(rawUrl, request) : rawUrl;
          const finalHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(headers)) finalHeaders[key] = hasRefs(value) ? await substituteRefs(value, request) : value;
          const finalBody = body !== undefined && hasRefs(body) ? await substituteRefs(body, request) : body;
          const response = await fetch(finalUrl, {
            method,
            headers: finalHeaders,
            ...(finalBody !== undefined && method !== "GET" && method !== "HEAD" ? { body: finalBody } : {}),
            redirect: "manual",
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
          });
          const text = method === "HEAD" ? "" : await response.text();
          const shownHeaders: Record<string, string> = {};
          for (const key of ["content-type", "location", "retry-after", "x-ratelimit-remaining", "www-authenticate"]) {
            const value = response.headers.get(key);
            if (value) shownHeaders[key] = value;
          }
          const output = redactDeep({ status: response.status, statusText: response.statusText, headers: shownHeaders, body: text.length > 20_000 ? `${text.slice(0, 20_000)}… (cortado)` : text });
          settledOk(context, callId, { ...output, body: output.body.length > 4000 ? `${output.body.slice(0, 4000)}…` : output.body }, `http_request(${method} ${host}) → ${response.status}`);
          return textResult(output);
        } catch (error) {
          const message = redactText(error instanceof Error ? error.message : String(error)).slice(0, 1000);
          settledFail(context, callId, message, error instanceof VaultError ? "SECRET_DENIED" : "TOOL_EXECUTION_FAILED");
          return textResult(message, true);
        }
      } finally {
        context.onCallEnd();
      }
    },
  );
}

export function computerTypeSecretsOnly(tool: string, args: Record<string, unknown>) {
  return tool === "computer_type" && typeof args.text === "string" && refsIn(args.text).length > 0 && args.text.replace(/segredo:[a-z0-9][a-z0-9_-]{0,63}/g, "").trim() === "";
}
