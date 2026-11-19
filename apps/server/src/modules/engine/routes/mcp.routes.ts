import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Req, Res } from "../../../shared/http";
import { buildServer, findToolContext } from "../services/mcp-gateway.service";

async function readBody(req: Req) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export async function handleMcp(req: Req, res: Res, botId: string, sessionId: string) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const context = findToolContext(token);
  if (!context || context.botId !== botId || context.sessionId !== sessionId) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return;
  }
  const server = buildServer(context);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  res.respond(await transport.handleRequest(req.raw, { parsedBody: body }));
}
