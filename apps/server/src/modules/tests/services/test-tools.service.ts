import { isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { macDeviceCall } from "../../accounts/services/mac-runner.service";
import { beginCall, endCall } from "../../code/services/hooks.service";
import type { Gate } from "../../code/services/policy.service";
import { activeWorkspace } from "../../code/services/workspace.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import type { ToolContext } from "../../engine/services/mcp-gateway.service";
import { testsText } from "../constants/tests-messages.constants";
import { installPlaywright, isLocalUrl, startRun, type TestInput, type TestRun } from "./test-runs.service";

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function runSummary(run: TestRun) {
  const head =
    run.status === "passed"
      ? `Passou (${run.steps.length} passos, ${Math.round((run.durationMs ?? 0) / 1000)} s).`
      : run.status === "failed"
        ? "Falhou."
        : `Não rodou: ${run.error ?? "erro"}`;
  const lines = run.steps.map(
    (step) =>
      `${step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : "–"} ${step.name}${step.error ? ` — ${step.error}` : ""}`,
  );
  const failure = run.status === "failed" && run.error ? [`Erro: ${run.error}`] : [];
  return [head, ...lines, ...failure, `Teste ${run.id}: log completo e print no card da conversa.`].join("\n");
}

function realDataGate(writes: boolean, where: string): Gate {
  return writes
    ? {
        kind: "human",
        prompt: testsText("realDataPrompt", { where }),
        reason: testsText("realDataReason"),
        hard: true,
      }
    : { kind: "allow" };
}

export const playwrightRunsPerTurn = Math.max(1, Number(Bun.env.BOTS_PLAYWRIGHT_PER_TURN ?? 3) || 3);
const playwrightRuns = new Map<string, number>();

export function takePlaywrightRun(key: string, limit = playwrightRunsPerTurn) {
  const used = playwrightRuns.get(key) ?? 0;
  if (used >= limit) return false;
  playwrightRuns.delete(key);
  playwrightRuns.set(key, used + 1);
  while (playwrightRuns.size > 500) {
    const oldest = playwrightRuns.keys().next().value;
    if (oldest === undefined) break;
    playwrightRuns.delete(oldest);
  }
  return true;
}

export function playwrightBudgetMessage(limit = playwrightRunsPerTurn) {
  return `Já rodei o Playwright ${limit} vezes neste pedido, o limite por pedido. Mostre à pessoa o que já tem e pergunte se ela quer outra rodada; não rode o Playwright pelo Bash para contornar.`;
}

const writesRealData = z
  .boolean()
  .optional()
  .describe("true se o teste cria, envia ou altera dado real (campanha, e-mail, pagamento)");

export function registerTestTools(server: McpServer, context: ToolContext) {
  const owner = () => ({ botId: context.botId, sessionId: context.sessionId });
  const pathOf = (args: Record<string, unknown>) => {
    const path = String(args.path);
    if (typeof args.project === "string" || isAbsolute(path)) return path;
    const workspace = activeWorkspace(getStoredSession(context.sessionId));
    return workspace ? join(workspace.path, path) : path;
  };
  const run = async (name: string, label: string, args: Record<string, unknown>, gate: Gate, input: TestInput) => {
    const start = await beginCall(context, {
      name,
      label,
      input: args,
      gate,
      target: { label: input.path, role: "test" },
    });
    if (!start.allowed) return text(start.message ?? "Negado.", true);
    try {
      const { done } = await startRun(input, owner(), context.signal);
      const finished = await done;
      endCall(context, start.callId, name, args, {
        ok: finished.status !== "error",
        output: { id: finished.id, status: finished.status, steps: finished.steps.length },
        error: finished.error ?? "erro",
      });
      return text(runSummary(finished), finished.status === "error");
    } catch (error) {
      endCall(context, start.callId, name, args, { ok: false, error: messageOf(error) });
      return text(messageOf(error), true);
    }
  };

  server.registerTool(
    "test_maestro",
    {
      description:
        "Roda um flow do Maestro (YAML no repositório, em .maestro/) no simulador do Mac e devolve passou/falhou por passo. Escreva o flow com tapOn por texto ou id, inputText, assertVisible, scrollUntilVisible e takeScreenshot; leia o resultado e conserte o flow. App Expo: abra antes com simulator_open_expo e use o appId do app.",
      inputSchema: {
        path: z.string().min(1).max(400).describe("Caminho do flow, relativo ao repositório"),
        project: z.string().max(200).optional(),
        branch: z.string().max(200).optional(),
        udid: z.string().max(80).optional(),
        writesRealData,
      },
    },
    (args: Record<string, unknown>) =>
      run(
        "test_maestro",
        testsText("maestro", { path: String(args.path) }),
        args,
        realDataGate(args.writesRealData === true, testsText("simulator")),
        {
          kind: "maestro",
          path: pathOf(args),
          ...(typeof args.project === "string" ? { project: args.project } : {}),
          ...(typeof args.branch === "string" ? { branch: args.branch } : {}),
          ...(typeof args.udid === "string" ? { udid: args.udid } : {}),
        },
      ),
  );

  server.registerTool(
    "test_playwright",
    {
      description: `Roda uma spec do Playwright (arquivo .spec.ts do repositório, importando só @playwright/test) contra um servidor de desenvolvimento no ar (server, de server_list) ou uma baseUrl. Use page.goto com caminho relativo e test.step para cada passo. Guarda trace, print e vídeo curto quando falha. Só quando a pessoa pedir teste ou prints, ou uma vez para fechar uma feature de UI; nunca depois de cada ajuste. No máximo ${playwrightRunsPerTurn} rodadas por pedido. Para olhar rápido, use browser_open e browser_screenshot.`,
      inputSchema: {
        path: z.string().min(1).max(400),
        project: z.string().max(200).optional(),
        branch: z.string().max(200).optional(),
        server: z.string().max(40).optional(),
        baseUrl: z.string().max(400).optional().describe("Só para algo fora dos servidores locais; pede aprovação"),
        grep: z.string().max(200).optional(),
        writesRealData,
      },
    },
    (args: Record<string, unknown>) => {
      if (!takePlaywrightRun(`${context.sessionId}:${context.turnId}`)) return text(playwrightBudgetMessage(), true);
      const baseUrl = typeof args.baseUrl === "string" ? args.baseUrl : undefined;
      const remote = baseUrl !== undefined && !isLocalUrl(baseUrl);
      const gate: Gate = remote
        ? {
            kind: "human",
            prompt: testsText("remotePrompt", { url: baseUrl }),
            reason: testsText("remoteReason"),
            hard: false,
          }
        : realDataGate(args.writesRealData === true, testsText("localPreview"));
      return run("test_playwright", testsText("playwright", { path: String(args.path) }), args, gate, {
        kind: "playwright",
        path: pathOf(args),
        ...(typeof args.project === "string" ? { project: args.project } : {}),
        ...(typeof args.branch === "string" ? { branch: args.branch } : {}),
        ...(typeof args.server === "string" ? { server: args.server } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(typeof args.grep === "string" ? { grep: args.grep } : {}),
      });
    },
  );

  const install = (name: string, label: string, description: string, act: () => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: {} }, async () => {
      const start = await beginCall(context, {
        name,
        label,
        input: {},
        gate: { kind: "human", prompt: `${label}?`, reason: testsText("installReason"), hard: true },
        alwaysHuman: true,
      });
      if (!start.allowed) return text(start.message ?? "Negado.", true);
      try {
        const output = await act();
        endCall(context, start.callId, name, {}, { ok: true, output });
        return text(`Instalado: ${JSON.stringify(output)}`);
      } catch (error) {
        endCall(context, start.callId, name, {}, { ok: false, error: messageOf(error) });
        return text(messageOf(error), true);
      }
    });
  install(
    "maestro_install",
    testsText("installMaestro"),
    "Instala o Maestro no Mac da pessoa pelo instalador oficial (precisa de Java 17+). Use só quando simulator_list disser que não está instalado.",
    () => macDeviceCall("maestro.install", {}, 10 * 60_000, context.signal),
  );
  install(
    "playwright_install",
    testsText("installPlaywright"),
    "Instala o @playwright/test numa pasta de ferramentas do servidor (fora dos repositórios). Os testes usam o Chrome que o servidor já tem.",
    () => installPlaywright(),
  );
}
