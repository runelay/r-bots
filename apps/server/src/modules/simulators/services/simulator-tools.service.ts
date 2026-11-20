import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { beginCall, endCall } from "../../code/services/hooks.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { deviceCall, listDevices, openExpo } from "./simulators.service";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const udid = z.string().max(80).optional().describe("UDID do simulador; sem isso, o que estiver ligado");

export function registerSimulatorTools(server: McpServer, context: ToolContext) {
  const tool = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    label: (args: Record<string, unknown>) => string,
    act: (args: Record<string, unknown>) => Promise<{ summary: string; output: unknown; content?: Content[] }>,
  ) =>
    server.registerTool(name, { description, inputSchema: shape }, async (args: Record<string, unknown>) => {
      const start = await beginCall(context, { name, label: label(args), input: args, gate: { kind: "allow" } });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      try {
        const result = await act(args);
        endCall(context, start.callId, name, args, { ok: true, output: result.output });
        return result.content ? { content: result.content } : text(result.summary);
      } catch (error) {
        endCall(context, start.callId, name, args, { ok: false, error: messageOf(error) });
        return text(messageOf(error), true);
      }
    });

  tool(
    "simulator_list",
    "Lista os simuladores iOS e emuladores Android do Mac da pessoa (ligados ou não) e se o Maestro está instalado.",
    {},
    () => "Ver os simuladores",
    async () => {
      const list = await listDevices(context.signal);
      return { summary: JSON.stringify(list), output: { devices: list.devices.length } };
    },
  );
  tool(
    "simulator_boot",
    "Liga um simulador do Mac e abre a janela do Simulator.",
    { udid: z.string().min(1).max(80) },
    (args) => `Ligar o simulador ${String(args.udid).slice(0, 8)}`,
    async (args) => {
      const result = await deviceCall("sim.boot", { udid: args.udid }, 180_000, context.signal);
      return { summary: `Ligado: ${JSON.stringify(result)}`, output: result };
    },
  );
  tool(
    "simulator_shutdown",
    "Desliga um simulador do Mac.",
    { udid: z.string().min(1).max(80) },
    (args) => `Desligar o simulador ${String(args.udid).slice(0, 8)}`,
    async (args) => {
      const result = await deviceCall("sim.shutdown", { udid: args.udid }, 90_000, context.signal);
      return { summary: "Desligado.", output: result };
    },
  );
  tool(
    "simulator_open_url",
    "Abre uma URL ou deep link (ex.: conty://campanhas) no simulador ligado.",
    { url: z.string().min(1).max(2000), udid },
    (args) => `Abrir ${String(args.url).slice(0, 60)} no simulador`,
    async (args) => {
      const result = await deviceCall("sim.open_url", { url: args.url, udid: args.udid }, 60_000, context.signal);
      return { summary: "Aberto.", output: result };
    },
  );
  tool(
    "simulator_open_expo",
    "Abre no simulador o app Expo de um servidor Metro que está no ar na VPS (id de server_list). Cria a ponte do Metro até o Mac pelo app; usa o dev client quando o projeto tem expo-dev-client.",
    {
      server: z.string().min(1).max(40),
      udid,
      client: z.enum(["go", "dev"]).optional().describe("go = Expo Go, dev = dev client; sem isso, detecta"),
    },
    () => "Abrir o app Expo no simulador",
    async (args) => {
      const result = await openExpo(
        {
          serverId: String(args.server),
          ...(typeof args.udid === "string" ? { udid: args.udid } : {}),
          ...(args.client === "go" || args.client === "dev" ? { client: args.client } : {}),
        },
        context.signal,
      );
      return { summary: `Abri ${result.url} (${result.client === "dev" ? "dev client" : "Expo Go"}).`, output: result };
    },
  );
  tool(
    "simulator_screenshot",
    "Print da tela do simulador ligado.",
    { udid },
    () => "Print do simulador",
    async (args) => {
      const result = await deviceCall("sim.screenshot", { udid: args.udid }, 60_000, context.signal);
      const meta = { width: result.width, height: result.height };
      return {
        summary: "",
        output: meta,
        content: [
          { type: "image", data: String(result.base64 ?? ""), mimeType: String(result.mimeType ?? "image/jpeg") },
          { type: "text", text: JSON.stringify(meta) },
        ],
      };
    },
  );
  tool(
    "simulator_tap",
    "Toca no simulador pelo texto visível (text), pelo id de acessibilidade (id) ou por um ponto em porcentagem da tela (x, y de 0 a 100). Usa o Maestro no Mac.",
    {
      text: z.string().max(200).optional(),
      id: z.string().max(200).optional(),
      x: z.number().min(0).max(100).optional(),
      y: z.number().min(0).max(100).optional(),
      udid,
    },
    (args) => `Tocar em ${String(args.text ?? args.id ?? `${args.x}%, ${args.y}%`).slice(0, 60)}`,
    async (args) => {
      const result = await deviceCall("sim.tap", args, 120_000, context.signal);
      return { summary: "Tocado.", output: result };
    },
  );
  tool(
    "simulator_type",
    "Digita um texto no campo focado do simulador (Maestro inputText).",
    { text: z.string().min(1).max(2000), udid },
    () => "Digitar no simulador",
    async (args) => {
      const result = await deviceCall("sim.type", args, 120_000, context.signal);
      return { summary: "Digitado.", output: result };
    },
  );
}
