import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BotDefinition } from "../../bots/services/bots.service";
import { type PublicDevServer, ServerRunning } from "../../code/services/dev-server.service";
import type { EventLog } from "../../conversations/services/sessions.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { registerServerTools } from "../services/server-tools.service";
import * as servers from "../services/servers.service";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const spies: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function running(): PublicDevServer {
  return {
    id: "dev_live",
    workspaceId: "project:web",
    kind: "project",
    name: "web",
    branch: null,
    path: "/srv/web",
    cwd: "",
    command: "npm run dev",
    tool: "node",
    script: "dev",
    profileId: null,
    startedBy: "user",
    botId: null,
    sessionId: null,
    envKeys: [],
    port: 4300,
    url: "http://localhost:4300",
    previewPath: "/preview/project:web/4300/?t=x",
    status: "running",
    exitCode: null,
    reason: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
  };
}

function harness() {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const context = {
    token: "t",
    botId: "bot1",
    sessionId: "s1",
    turnId: "turn1",
    runId: () => "run1",
    log: {
      emit: (event: { type: string; data: Record<string, unknown> }) => events.push(event),
    } as unknown as EventLog,
    origin: null,
    ownerCallId: null,
    isSchedule: false,
    signal: new AbortController().signal,
    onCallStart: () => undefined,
    onCallEnd: () => undefined,
    onCallSettled: () => undefined,
    emitDecision: () => undefined,
    requestApproval: async () => ({ choice: "approve" as const, interactionId: "i1" }),
    bot: { id: "bot1", name: "Bot", role: "dev" } as BotDefinition,
    decisions: { autoApprove: false, threshold: 0.7 },
    request: "",
    provider: "claude",
  } as unknown as ToolContext;
  const tools = new Map<string, Handler>();
  registerServerTools(
    {
      registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler),
    } as unknown as McpServer,
    context,
  );
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(name);
    return handler(args);
  };
  return { call, events };
}

describe("server_start", () => {
  test("hands back the server already running in the folder with its card", async () => {
    const live = running();
    const start = spyOn(servers, "startProjectServer").mockRejectedValue(new ServerRunning(live, []));
    spies.push(start);
    const { call, events } = harness();
    const result = await call("server_start", { project: "web", script: "dev" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(new ServerRunning(live, []).message);
    expect(events.find((event) => event.type === "server.card")?.data).toMatchObject({ serverId: "dev_live" });
    expect(events.find((event) => event.type === "call.settled")?.data).toMatchObject({
      outcome: "completed",
      output: { id: "dev_live", port: 4300 },
    });
  });
});
