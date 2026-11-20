import { type Mock, spyOn } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DecisionRecord } from "../src/modules/approvals/services/decisions.service";
import { type BotDefinition, createBot, decisionsOf, getBot } from "../src/modules/bots/services/bots.service";
import {
  createStoredSession,
  type Fact,
  type StoredSession,
} from "../src/modules/conversations/services/sessions.service";
import type { ApprovalDetails } from "../src/modules/engine/services/bot-tools.service";
import {
  type ApprovalResult,
  newToken,
  registerContext,
  type ToolContext,
} from "../src/modules/engine/services/mcp-gateway.service";

export type JevHandler = (body: {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
}) => Record<string, unknown> | Response;

let jevSpy: Mock<typeof fetch> | null = null;

export function fakeJev(handler: JevHandler) {
  stopJev();
  const jevUrl = process.env.JEV_URL ?? "";
  const original = globalThis.fetch;
  process.env.JEV_API_KEY = "test-jev-key";
  jevSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target !== jevUrl) return original(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const reply = handler(body);
    if (reply instanceof Response) return reply;
    return Response.json({ model: "jev-test", usage: { input_tokens: 10 }, ...reply });
  }) as typeof fetch);
  return jevSpy;
}

export function stopJev() {
  jevSpy?.mockRestore();
  jevSpy = null;
  delete process.env.JEV_API_KEY;
}

let counter = 0;

export async function makeBot(overrides: Record<string, unknown> = {}): Promise<BotDefinition> {
  counter++;
  const created = await createBot({
    name: `T${counter} ${Math.random().toString(36).slice(2, 8)}`,
    role: "Tester",
    instructions: "Você testa.",
    ...overrides,
  });
  const bot = getBot(created.id) as BotDefinition;
  bot.capabilities = { ...bot.capabilities, browser: false, computer: false, desktop: false };
  return bot;
}

export function newSession(botId: string, kind: "thread" | "session" | "group" | "conversation" = "conversation") {
  return createStoredSession({ botId, kind, source: "chat", title: "" });
}

type FactSource = StoredSession | { lines: string[] | (() => Promise<string[]>) };

export async function factsOf(session: FactSource): Promise<Fact[]> {
  const source = "log" in session ? session.log.lines : session.lines;
  const lines = typeof source === "function" ? await source.call("log" in session ? session.log : session) : source;
  const facts: Fact[] = [];
  for (const line of lines) {
    try {
      facts.push(...((JSON.parse(line) as { facts?: Fact[] }).facts ?? []));
    } catch {}
  }
  return facts;
}

export async function factTypes(session: FactSource) {
  return (await factsOf(session)).map((fact) => fact.type);
}

export async function factsOfType(session: FactSource, type: string) {
  return (await factsOf(session)).filter((fact) => fact.type === type);
}

export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 4000): Promise<NonNullable<T>> {
  const started = Date.now();
  while (true) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export async function connectMcp(url: string, token: string) {
  const client = new Client({ name: "engine-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

export function gatewayUrl(serverUrl: string, mcpUrl: string) {
  const path = new URL(mcpUrl).pathname;
  return `${serverUrl}${path}`;
}

export function textOf(result: unknown) {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

export interface ContextOptions extends Partial<ToolContext> {
  approve?: (prompt: string, details?: ApprovalDetails) => ApprovalResult["choice"] | Promise<ApprovalResult["choice"]>;
}

export function toolContext(bot: BotDefinition, session: StoredSession, options: ContextOptions = {}) {
  const { approve, ...overrides } = options;
  const approvals: Array<{ prompt: string; callId: string; origin: string | null; details?: ApprovalDetails }> = [];
  const decisions: DecisionRecord[] = [];
  const settled: string[] = [];
  const handoffs: Array<{ botId: string; note: string }> = [];
  const cancelled: string[] = [];
  let calls = 0;
  const context: ToolContext = {
    token: newToken(),
    botId: bot.id,
    sessionId: session.meta.sessionId,
    log: session.log,
    turnId: "turn_0",
    runId: () => "run_0",
    tools: [],
    delegates: [],
    origin: null,
    ownerCallId: null,
    isSchedule: false,
    signal: new AbortController().signal,
    onCallStart: () => {
      calls++;
    },
    onCallEnd: () => undefined,
    requestApproval: async (prompt, callId, origin, details) => {
      approvals.push({ prompt, callId, origin, details });
      const choice = approve ? await approve(prompt, details) : "approve";
      return { choice, interactionId: `int_${approvals.length}` };
    },
    delegate: async () => "relatório",
    bot,
    request: "pedido de teste",
    asked: { commit: false, push: false, pr: false },
    decisions: decisionsOf(bot),
    emitDecision: (record) => decisions.push(record),
    onCallSettled: (summary) => settled.push(summary),
    groupMembers: [],
    onHandoff: (botId, note) => handoffs.push({ botId, note }),
    provider: "claude",
    cancelTurn: (reason) => cancelled.push(reason),
    runner: "vps",
    permission: "default",
    ...overrides,
  };
  const revoke = registerContext(context);
  return {
    context,
    approvals,
    decisions,
    settled,
    handoffs,
    cancelled,
    revoke,
    calls: () => calls,
    url: (serverUrl: string) => `${serverUrl}/mcp/${bot.id}/${session.meta.sessionId}`,
  };
}
