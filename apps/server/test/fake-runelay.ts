import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler = (args: Record<string, unknown>) => unknown;

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface ApiReply {
  status?: number;
  data?: unknown;
  body?: unknown;
}

export type ApiHandler = (call: ApiCall) => ApiReply | Promise<ApiReply>;

export const runelayToken = "test-runelay-token";

function toolText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function parseBody(request: Request) {
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function createFakeRunelay() {
  const tools = new Map<string, ToolHandler>();
  const routes = new Map<string, ApiHandler>();
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const apiCalls: ApiCall[] = [];
  let server: ReturnType<typeof Bun.serve> | null = null;

  function mcpServer() {
    const mcp = new Server({ name: "fake-runelay", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...tools.keys()].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      toolCalls.push({ name, args });
      const handler = tools.get(name);
      if (!handler) return { isError: true, content: [{ type: "text" as const, text: `unknown tool ${name}` }] };
      try {
        return { content: [{ type: "text" as const, text: toolText(await handler(args)) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        };
      }
    });
    return mcp;
  }

  async function handle(request: Request) {
    if (request.headers.get("authorization") !== `Bearer ${runelayToken}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const mcp = mcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      return transport.handleRequest(request);
    }
    const path = url.pathname.replace(/^\/v1/, "");
    const call: ApiCall = {
      method: request.method,
      path: `${path}${url.search}`,
      body: await parseBody(request),
      headers: Object.fromEntries(request.headers),
    };
    apiCalls.push(call);
    const handler = routes.get(`${call.method} ${path}`);
    if (!handler) return Response.json({ error: { message: `no fake route ${call.method} ${path}` } }, { status: 404 });
    const reply = await handler(call);
    const body = "data" in reply ? { data: reply.data } : (reply.body ?? null);
    return Response.json(body, { status: reply.status ?? 200 });
  }

  return {
    token: runelayToken,
    toolCalls,
    apiCalls,
    get url() {
      if (!server) throw new Error("fake runelay is not running");
      return `http://127.0.0.1:${server.port}`;
    },
    get mcpUrl() {
      return `${this.url}/mcp`;
    },
    tool(name: string, handler: ToolHandler) {
      tools.set(name, handler);
    },
    route(method: string, path: string, handler: ApiHandler | ApiReply) {
      routes.set(`${method.toUpperCase()} ${path}`, typeof handler === "function" ? handler : () => handler);
    },
    reset() {
      tools.clear();
      routes.clear();
      toolCalls.length = 0;
      apiCalls.length = 0;
    },
    start() {
      server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
      return this.url;
    },
    async stop() {
      await server?.stop(true);
      server = null;
    },
  };
}

export const fakeRunelay = createFakeRunelay();
