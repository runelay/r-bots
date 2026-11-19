import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { activeWorkspace, changedFiles, CodeError, publicWorkspace, type WorkspaceState } from "./code";
import { closeTaskWorkspace, deliverProblem, deliverWorkspace, openTaskWorkspace } from "./code-actions";
import { kickPr } from "./code-pr";
import { beginCall, endCall } from "./code-hooks";
import { type Gate, gateCommand } from "./code-policy";
import { devServerLogs, devServersOf, startDevServer, stopDevServers } from "./devserver";
import type { ToolContext } from "./mcp";
import { getStoredSession } from "./sessions";

function text(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function installNote(workspace: WorkspaceState) {
  const install = workspace.install;
  if (install.status === "running") return `Dependências instalando em segundo plano (${install.command}). dev_server_start espera a instalação terminar.`;
  if (install.status === "failed") return `A instalação das dependências falhou: ${install.error ?? ""}`;
  if (install.status === "done") return "Dependências instaladas.";
  return "";
}

export function codeModeSupported(provider: string, runner: string) {
  return runner === "vps" && (provider === "claude" || provider === "codex");
}

export function registerCodeTools(server: McpServer, context: ToolContext, runnerOf: () => string) {
  const session = () => getStoredSession(context.sessionId);
  server.registerTool(
    "workspace_open",
    {
      description:
        "Abre um repositório para trabalhar em código nesta conversa: cria uma worktree e uma branch feat/<tarefa> só desta conversa e liga as ferramentas de código (ler, editar, rodar comandos). Use quando o pedido envolver código de um repositório. repo é o nome (ex.: conty-whitelabel) ou o caminho. task é uma frase curta da tarefa, vira o nome da branch.",
      inputSchema: { repo: z.string().min(1).max(300), task: z.string().min(1).max(300) },
    },
    async (args: Record<string, unknown>) => {
      const repo = String(args.repo);
      const task = String(args.task);
      const start = await beginCall(context, { name: "workspace_open", label: `Abrir ${repo.split("/").pop()}`, input: { repo, task }, gate: { kind: "allow" } });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      const current = session();
      if (!current) {
        endCall(context, start.callId, "workspace_open", { repo }, { ok: false, error: "Conversa não encontrada." });
        return text("Conversa não encontrada.", true);
      }
      try {
        const before = activeWorkspace(current)?.id ?? null;
        const { workspace } = await openTaskWorkspace(current, context.botId, repo, task);
        const output = { ...publicWorkspace(workspace) };
        endCall(context, start.callId, "workspace_open", { repo, task }, { ok: true, output });
        const supported = codeModeSupported(context.provider, runnerOf());
        const lines = [
          `Workspace aberto: ${workspace.repoName} em ${workspace.path}, branch ${workspace.branch} (a partir de ${workspace.base}).`,
          installNote(workspace),
        ];
        if (!supported) lines.push("O modelo desta conversa não roda código na VPS. Diga à pessoa para escolher um modelo Claude ou Codex da VPS para eu editar os arquivos.");
        else if (before !== workspace.id && context.endRun) {
          lines.push("Continuando já dentro da worktree, com as ferramentas de código.");
          context.endRun();
        }
        return text(lines.filter(Boolean).join("\n"));
      } catch (error) {
        const message = error instanceof CodeError || error instanceof Error ? error.message : String(error);
        endCall(context, start.callId, "workspace_open", { repo }, { ok: false, error: message });
        return text(message, true);
      }
    },
  );
  server.registerTool(
    "workspace_close",
    { description: "Desliga o modo código desta conversa. A worktree e a branch continuam no disco. Só use quando a pessoa pedir para parar de mexer no repositório.", inputSchema: {} },
    async () => {
      const start = await beginCall(context, { name: "workspace_close", label: "Fechar o repositório", input: {}, gate: { kind: "allow" } });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      const current = session();
      const workspace = activeWorkspace(current);
      if (!current || !workspace) {
        endCall(context, start.callId, "workspace_close", {}, { ok: true, output: { closed: false } });
        return text("Nenhum repositório aberto nesta conversa.");
      }
      await closeTaskWorkspace(current);
      endCall(context, start.callId, "workspace_close", {}, { ok: true, output: { closed: true, path: workspace.path, branch: workspace.branch } });
      return text(`Fechado. A worktree continua em ${workspace.path} (branch ${workspace.branch}).`);
    },
  );
  const workspace = activeWorkspace(session());
  if (!workspace) return;
  server.registerTool(
    "dev_server_start",
    {
      description:
        "Sobe um servidor de desenvolvimento desta tarefa em segundo plano (npm run dev, wrangler dev…), numa porta livre, e espera ele responder. Devolve a url (http://localhost:<porta>) para testar com browser_open. Não use & no Bash para isso. cmd pode usar {port}; sem isso a porta vai como --port. cwd é uma subpasta da worktree, se o app não estiver na raiz.",
      inputSchema: { cmd: z.string().min(1).max(500), port: z.number().int().min(1024).max(65535).optional(), cwd: z.string().max(300).optional() },
    },
    async (args: Record<string, unknown>) => {
      const cmd = String(args.cmd);
      const start = await beginCall(context, {
        name: "dev_server_start",
        label: `Subir ${cmd.replace(/\s+/g, " ").slice(0, 60)}`,
        input: args,
        gate: gateCommand(cmd, workspace),
        workspace,
        target: { label: cmd, role: "command" },
      });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      try {
        const result = await startDevServer(workspace, { cmd, ...(args.port ? { port: Number(args.port) } : {}), ...(args.cwd ? { cwd: String(args.cwd) } : {}) }, (server) => {
          session()?.log.emit({ type: "code.devserver", data: { action: server.status === "stopped" ? "stopped" : "exited", ...server } });
        });
        const { logs, ...server } = result;
        session()?.log.emit({ type: "code.devserver", data: { action: "started", ...server } });
        endCall(context, start.callId, "dev_server_start", args, { ok: result.status === "running", output: { ...server, logs: logs.slice(-3000) }, error: `O servidor saiu (código ${result.exitCode}).\n${logs.slice(-3000)}` });
        if (result.status !== "running") return text(`O servidor saiu antes de responder (código ${result.exitCode}). Últimas linhas:\n${logs}`, true);
        return text(`Servidor no ar em ${result.url} (porta ${result.port}). Teste com browser_open("${result.url}"). Últimas linhas:\n${logs}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        endCall(context, start.callId, "dev_server_start", args, { ok: false, error: message });
        return text(message, true);
      }
    },
  );
  server.registerTool(
    "dev_server_stop",
    { description: "Para o servidor de desenvolvimento desta tarefa (todos, ou só o da porta).", inputSchema: { port: z.number().int().optional() } },
    async (args: Record<string, unknown>) => {
      const start = await beginCall(context, { name: "dev_server_stop", label: args.port ? `Parar o servidor da porta ${String(args.port)}` : "Parar o servidor", input: args, gate: { kind: "allow" } });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      const stopped = await stopDevServers(workspace, args.port ? Number(args.port) : undefined);
      endCall(context, start.callId, "dev_server_stop", args, { ok: true, output: { stopped: stopped.map((item) => item.port) } });
      return text(stopped.length > 0 ? `Parado: porta ${stopped.map((item) => item.port).join(", ")}.` : "Nenhum servidor rodando.");
    },
  );
  server.registerTool(
    "dev_server_logs",
    { description: "Mostra as últimas linhas do servidor de desenvolvimento desta tarefa.", inputSchema: { port: z.number().int().optional(), lines: z.number().int().min(1).max(400).optional() } },
    async (args: Record<string, unknown>) => {
      const start = await beginCall(context, { name: "dev_server_logs", label: "Ver o log do servidor", input: args, gate: { kind: "allow" } });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      try {
        const result = await devServerLogs(workspace, args.port ? Number(args.port) : undefined, Number(args.lines ?? 80));
        endCall(context, start.callId, "dev_server_logs", args, { ok: true, output: { port: result.port, status: result.status, lines: result.logs.split("\n").length } });
        return text(`Servidor ${result.status} na porta ${result.port}:\n${result.logs}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        endCall(context, start.callId, "dev_server_logs", args, { ok: false, error: message });
        return text(message, true);
      }
    },
  );
  server.registerTool(
    "workspace_deliver",
    {
      description:
        "Entrega o trabalho desta tarefa: action commit faz UM commit com tudo o que está pendente na branch da tarefa; action push faz esse commit (se houver pendência) e git push da branch (nunca force); se a branch já tem PR aberto, o push atualiza esse PR; action pr faz o mesmo e abre PR para a base (develop ou main) só se ainda não existir um, senão devolve o PR existente. Se a pessoa disser só push, use push, nunca pr. Roda direto, sem card. Mudanças de módulos diferentes: faça antes um commit por módulo no Bash (git add <arquivos> + git commit -m) e use isto só para o resto, para o push ou para o PR. message em conventional commits, em inglês, curta (até 2 linhas), sem assinatura de IA; pode ficar vazia no push quando não há nada pendente.",
      inputSchema: { action: z.enum(["commit", "push", "pr"]), message: z.string().max(200).optional(), title: z.string().max(200).optional(), body: z.string().max(5000).optional(), base: z.string().max(100).optional().describe("Base do PR; por padrão, a de onde a branch saiu") },
    },
    async (args: Record<string, unknown>) => {
      const input = { action: args.action === "pr" ? "pr" : args.action === "push" ? "push" : "commit", message: String(args.message ?? ""), ...(args.title ? { title: String(args.title) } : {}), ...(args.body ? { body: String(args.body) } : {}), ...(args.base ? { base: String(args.base) } : {}) } as const;
      const files = (await changedFiles(workspace, true)).length;
      const problem = deliverProblem(input, input.action === "commit");
      const gate: Gate = problem ? { kind: "deny", message: problem } : { kind: "allow" };
      const start = await beginCall(context, {
        name: "workspace_deliver",
        label: input.action === "pr" ? `Abrir PR da branch ${workspace.branch}` : input.action === "push" ? `Push da branch ${workspace.branch}` : `Commit na branch ${workspace.branch}`,
        input: args,
        gate,
        workspace,
        target: { label: input.message || workspace.branch, role: "commit" },
      });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      try {
        const result = await deliverWorkspace(workspace, input);
        const owner = session();
        owner?.log.emit({ type: "code.delivered", data: { workspaceId: workspace.id, ...result } });
        if (owner && result.prUrl) kickPr(owner, result.prUrl);
        endCall(context, start.callId, "workspace_deliver", args, { ok: true, output: result });
        const committed = result.commit ? `Commit ${result.commit}` : "Nada novo para commitar";
        if (input.action === "push") return text(`${committed}; push da branch ${result.branch} feito.${result.prUrl ? ` O PR ${result.prUrl} foi atualizado.` : " A branch ainda não tem PR aberto."}`);
        return text(result.prUrl ? (result.prExisted ? `${committed}; push feito. O PR já existia e foi atualizado: ${result.prUrl}` : `PR aberto: ${result.prUrl}`) : `${committed} na branch ${result.branch}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        endCall(context, start.callId, "workspace_deliver", args, { ok: false, error: message });
        return text(message, true);
      }
    },
  );
  void devServersOf;
}
