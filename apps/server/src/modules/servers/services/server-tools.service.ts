import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listServers, type PublicDevServer, serverLogs } from "../../code/services/dev-server.service";
import { beginCall, endCall } from "../../code/services/hooks.service";
import type { Gate } from "../../code/services/policy.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { registerSimulatorTools } from "../../simulators/services/simulator-tools.service";
import { registerTestTools } from "../../tests/services/test-tools.service";
import { listProjects } from "./projects.service";
import { listProfiles, requireServer, restart, startProjectServer, stopServer } from "./servers.service";

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function summary(server: PublicDevServer) {
  const where = server.branch ? `${server.name} · ${server.branch}` : server.name;
  return `${server.id} · ${where} · ${server.tool} · porta ${server.port} · ${server.status}`;
}

export function emitServerCard(context: ToolContext, server: PublicDevServer) {
  context.log.emit({
    type: "server.card",
    data: { serverId: server.id, botId: context.botId, server },
    scope: { turnId: context.turnId },
  });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function registerServerTools(server: McpServer, context: ToolContext) {
  registerSimulatorTools(server, context);
  registerTestTools(server, context);
  server.registerTool(
    "server_list",
    {
      description:
        "Lista os servidores de desenvolvimento que o runelay bots subiu (no ar, subindo, caiu), os projetos liberados com as worktrees e os perfis salvos.",
      inputSchema: {},
    },
    async () => {
      const start = await beginCall(context, {
        name: "server_list",
        label: "Ver os servidores",
        input: {},
        gate: { kind: "allow" },
      });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      const [projects, profiles] = await Promise.all([listProjects(), listProfiles()]);
      endCall(context, start.callId, "server_list", {}, { ok: true, output: { servers: listServers().length } });
      return text({
        servers: listServers().map((item) => ({ ...item, summary: summary(item) })),
        projects: projects.map((item) => ({
          name: item.name,
          worktrees: item.worktrees.map((tree) => tree.branch ?? tree.path),
        })),
        profiles: profiles.map((item) => ({ id: item.id, name: item.name, script: item.script, cmd: item.cmd })),
      });
    },
  );
  server.registerTool(
    "server_start",
    {
      description:
        "Sobe um servidor de desenvolvimento de um projeto liberado e espera ele responder. Use script (do package.json) ou profile; cmd livre pede aprovação. Devolve id, porta e as últimas linhas do log.",
      inputSchema: {
        project: z.string().max(200).optional().describe("Nome do repositório liberado"),
        branch: z.string().max(200).optional().describe("Branch da worktree; sem isso, o checkout principal"),
        script: z.string().max(100).optional(),
        profile: z.string().max(80).optional(),
        cmd: z.string().max(500).optional(),
        cwd: z.string().max(300).optional().describe("Subpasta do app dentro do repositório"),
        port: z.number().int().min(1024).max(65535).optional(),
      },
    },
    async (args: Record<string, unknown>) => {
      const cmd = typeof args.cmd === "string" ? args.cmd : undefined;
      const gate: Gate = cmd
        ? {
            kind: "human",
            prompt: `Posso subir este comando como servidor? ${cmd.slice(0, 160)}`,
            reason: "Comando livre fora do package.json.",
            hard: true,
          }
        : { kind: "allow" };
      const label = String(args.profile ?? args.script ?? cmd ?? "servidor");
      const start = await beginCall(context, {
        name: "server_start",
        label: `Rodar ${String(args.project ?? "")} ${label}`.replace(/\s+/g, " ").trim(),
        input: args,
        gate,
        target: { label, role: "command" },
      });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      try {
        const { server: launched, ready } = await startProjectServer({
          ...(typeof args.project === "string" ? { project: args.project } : {}),
          ...(typeof args.branch === "string" ? { branch: args.branch } : {}),
          ...(typeof args.script === "string" ? { script: args.script } : {}),
          ...(typeof args.profile === "string" ? { profile: args.profile } : {}),
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(cmd ? { cmd } : {}),
          ...(typeof args.port === "number" ? { port: args.port } : {}),
          startedBy: "bot",
          botId: context.botId,
          sessionId: context.sessionId,
        });
        emitServerCard(context, launched);
        const result = await ready;
        const { logs, ...view } = result;
        endCall(context, start.callId, "server_start", args, {
          ok: view.status === "running",
          output: { ...view, logs: logs.slice(-3000) },
          error: `O servidor saiu (código ${view.exitCode}).\n${logs.slice(-3000)}`,
        });
        if (view.status !== "running")
          return text(`O servidor saiu antes de responder (código ${view.exitCode}). Últimas linhas:\n${logs}`, true);
        return text(`No ar: ${summary(view)}. Últimas linhas:\n${logs}`);
      } catch (error) {
        endCall(context, start.callId, "server_start", args, { ok: false, error: messageOf(error) });
        return text(messageOf(error), true);
      }
    },
  );
  const simple = (
    name: string,
    description: string,
    label: (id: string) => string,
    act: (id: string) => Promise<string>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: { id: z.string().min(1).max(40) } },
      async (args: Record<string, unknown>) => {
        const id = String(args.id);
        const start = await beginCall(context, { name, label: label(id), input: args, gate: { kind: "allow" } });
        if (!start.allowed) return text(start.message ?? "Negado.", true);
        try {
          const output = await act(id);
          endCall(context, start.callId, name, args, { ok: true, output });
          return text(output);
        } catch (error) {
          endCall(context, start.callId, name, args, { ok: false, error: messageOf(error) });
          return text(messageOf(error), true);
        }
      },
    );
  simple(
    "server_stop",
    "Para um servidor de desenvolvimento pelo id (de server_list).",
    (id) => `Parar o servidor ${id}`,
    async (id) => {
      const stopped = await stopServer(id);
      emitServerCard(context, stopped);
      return `Parado: ${summary(stopped)}.`;
    },
  );
  simple(
    "server_restart",
    "Reinicia um servidor de desenvolvimento pelo id e espera ele responder.",
    (id) => `Reiniciar o servidor ${id}`,
    async (id) => {
      const { ready } = await restart(id);
      const { logs, ...view } = await ready;
      emitServerCard(context, view);
      return `${view.status === "running" ? "No ar de novo" : "Saiu"}: ${summary(view)}. Últimas linhas:\n${logs}`;
    },
  );
  server.registerTool(
    "server_logs",
    {
      description: "Lê o log de um servidor de desenvolvimento (sem cores). query filtra as linhas.",
      inputSchema: {
        id: z.string().min(1).max(40),
        lines: z.number().int().min(1).max(400).optional(),
        query: z.string().max(200).optional(),
      },
    },
    async (args: Record<string, unknown>) => {
      const start = await beginCall(context, {
        name: "server_logs",
        label: "Ler o log do servidor",
        input: args,
        gate: { kind: "allow" },
      });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      try {
        const result = await serverLogs(
          requireServer(String(args.id)),
          Number(args.lines ?? 80),
          typeof args.query === "string" ? args.query : undefined,
        );
        const { logs, ...view } = result;
        emitServerCard(context, view);
        endCall(context, start.callId, "server_logs", args, {
          ok: true,
          output: { id: view.id, status: view.status, lines: logs ? logs.split("\n").length : 0 },
        });
        return text(`${summary(view)}:\n${logs || "(sem linhas)"}`);
      } catch (error) {
        endCall(context, start.callId, "server_logs", args, { ok: false, error: messageOf(error) });
        return text(messageOf(error), true);
      }
    },
  );
}
