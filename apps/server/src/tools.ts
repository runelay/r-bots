import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BotDefinition } from "./bots";
import { botDir } from "./config";
import { type ApprovalTarget, browserClick, browserFill, browserOpen, browserScreenshot, browserSnapshot, cropPreview, elementPreview, elementTarget, readBrowserState } from "./browser";
import { waitForBotControl } from "./control";
import { getDesktop } from "./desktop";
import { runProdQuery } from "./prod-query";
import { artifactTools } from "./artifacts";
import { canvasTools } from "./canvas";
import { uploadTools } from "./uploads";

export interface BotTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  approval: ((input: Record<string, unknown>) => string) | null;
  label: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  details?: (input: Record<string, unknown>) => Promise<ApprovalDetails>;
}

export interface ApprovalDetails {
  target?: ApprovalTarget;
  previewImage?: string;
  reason?: string;
  grant?: string;
  secret?: Record<string, unknown>;
}

const reasonField = z.string().max(160).optional().describe("Uma frase curta, em português, dizendo à pessoa por que você quer fazer isso");

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function reasonOf(input: Record<string, unknown>) {
  const value = String(input.reason ?? "").trim();
  return value ? { reason: value } : {};
}

const text = (value: unknown) => String(value ?? "");

export function toolsFor(bot: BotDefinition): BotTool[] {
  const tools: BotTool[] = [];
  const named = (ref: unknown, fallback: string) => {
    const label = elementTarget(bot.id, String(ref ?? ""))?.label;
    return label ? `“${label}”` : fallback;
  };
  const pageDetails = async (input: Record<string, unknown>): Promise<ApprovalDetails> => {
    const ref = String(input.ref ?? "");
    const page = await readBrowserState(bot.id);
    const element = elementTarget(bot.id, ref);
    const previewImage = await elementPreview(bot.id, ref);
    return {
      ...(element ? { target: { ...element, ...(page?.url ? { url: page.url } : {}) } } : {}),
      ...(previewImage ? { previewImage } : {}),
      ...reasonOf(input),
    };
  };
  if (bot.capabilities.prodQuery) {
    tools.push({
      name: "prod_query",
      description:
        "Roda uma consulta SQL somente leitura no banco de produção (Postgres). Aceita uma única instrução SELECT ou WITH. Use information_schema e pg_catalog para descobrir tabelas e colunas antes de consultar dados. Prefira LIMIT e agregações.",
      shape: { sql: z.string().min(1).describe("Uma única instrução SELECT ou WITH") },
      approval: null,
      label: (input) => `Consulta: ${text(input.sql).replace(/\s+/g, " ").slice(0, 80)}`,
      run: (input, signal) => runProdQuery(text(input.sql), signal),
    });
  }
  if (bot.capabilities.browser) {
    tools.push(
      {
        name: "browser_open",
        description: "Abre uma URL no navegador do bot e tira um print da página.",
        shape: { url: z.string().url() },
        approval: null,
        label: (input) => `Abrir ${text(input.url)}`,
        run: (input, signal) => browserOpen(bot.id, text(input.url), signal),
      },
      {
        name: "browser_snapshot",
        description: "Lê a árvore de acessibilidade da página atual com as referências dos elementos interativos (@e1, @e2...).",
        shape: {},
        approval: null,
        label: () => "Ler a página",
        run: (_input, signal) => browserSnapshot(bot.id, signal),
      },
      {
        name: "browser_click",
        description: "Clica num elemento da página pela referência do snapshot (ex.: @e3). Pede aprovação de uma pessoa.",
        shape: { ref: z.string().min(1), reason: reasonField },
        approval: (input) => `Posso clicar em ${named(input.ref, "um elemento da página")}?`,
        label: (input) => `Clicar em ${named(input.ref, "um elemento")}`,
        details: pageDetails,
        run: (input, signal) => browserClick(bot.id, text(input.ref), signal),
      },
      {
        name: "browser_fill",
        description: "Preenche um campo da página pela referência do snapshot (ex.: @e2). Para senha ou token, use text = segredo:nome (do cofre): o valor entra só na hora e não pede aprovação. Texto comum pede aprovação de uma pessoa.",
        shape: { ref: z.string().min(1), text: z.string(), reason: reasonField },
        approval: (input) => `Posso preencher ${named(input.ref, "um campo")} com "${text(input.text)}"?`,
        label: (input) => `Preencher ${named(input.ref, "um campo")}`,
        details: pageDetails,
        run: (input, signal) => browserFill(bot.id, text(input.ref), text(input.text), signal, input.secretFill === true),
      },
      {
        name: "browser_screenshot",
        description: "Tira um print da página atual do navegador do bot.",
        shape: {},
        approval: null,
        label: () => "Tirar print",
        run: (_input, signal) => browserScreenshot(bot.id, signal),
      },
    );
  }
  if (bot.capabilities.desktop) {
    const desktop = () => getDesktop(bot.id);
    const ready = () => waitForBotControl(bot.id);
    tools.push(
      {
        name: "desktop_screenshot",
        description: "Tira um print do seu computador virtual (1280x800). Use antes de clicar para saber as coordenadas.",
        shape: {},
        approval: null,
        label: () => "Print do computador",
        run: async () => {
          await ready();
          const png = await desktop().screenshot();
          await mkdir(join(botDir(bot.id), "desktop"), { recursive: true });
          await writeFile(join(botDir(bot.id), "desktop", "latest.png"), png);
          const state = await desktop().state();
          return { ...state, imageBase64: png.toString("base64") };
        },
      },
      {
        name: "desktop_click",
        description: "Clica numa coordenada do computador virtual (pixels, 1280x800).",
        shape: { x: z.number().min(0).max(1280), y: z.number().min(0).max(800), button: z.enum(["left", "right"]).optional(), double: z.boolean().optional(), reason: reasonField },
        approval: () => "Posso clicar neste ponto do computador?",
        label: () => "Clicar no computador",
        details: async (input) => {
          const png = await desktop().screenshot().catch(() => null);
          const previewImage = png ? await cropPreview(png, { x: Number(input.x) - 60, y: Number(input.y) - 30, width: 120, height: 60 }) : null;
          return { target: { label: "computador do bot", role: "desktop" }, ...(previewImage ? { previewImage } : {}), ...reasonOf(input) };
        },
        run: async (input) => (await ready(), desktop().click(Number(input.x), Number(input.y), input.button === "right" ? "right" : "left", input.double === true)),
      },
      {
        name: "desktop_type",
        description: "Digita um texto no computador virtual, onde estiver o foco. Pede aprovação.",
        shape: { text: z.string().min(1).max(2000), reason: reasonField },
        details: async (input) => ({ target: { label: "computador do bot", role: "desktop" }, ...reasonOf(input) }),
        approval: (input) => `Posso digitar no computador: "${text(input.text).slice(0, 120)}"?`,
        label: (input) => `Digitar "${text(input.text).slice(0, 40)}"`,
        run: async (input) => (await ready(), desktop().type(text(input.text))),
      },
      {
        name: "desktop_key",
        description: "Aperta uma tecla ou atalho no computador virtual, no formato do xdotool (Return, ctrl+l, alt+Left). Pede aprovação.",
        shape: { combo: z.string().min(1).max(60), reason: reasonField },
        details: async (input) => ({ target: { label: "computador do bot", role: "desktop" }, ...reasonOf(input) }),
        approval: (input) => `Posso apertar ${text(input.combo)} no computador?`,
        label: (input) => `Tecla ${text(input.combo)}`,
        run: async (input) => (await ready(), desktop().key(text(input.combo))),
      },
      {
        name: "desktop_scroll",
        description: "Rola a tela do computador virtual numa coordenada.",
        shape: { x: z.number().min(0).max(1280), y: z.number().min(0).max(800), direction: z.enum(["up", "down"]), amount: z.number().int().min(1).max(20).optional() },
        approval: null,
        label: (input) => `Rolar ${input.direction === "down" ? "para baixo" : "para cima"}`,
        run: async (input) => (await ready(), desktop().scroll(Number(input.x), Number(input.y), input.direction === "down" ? "down" : "up", Number(input.amount ?? 3))),
      },
      {
        name: "desktop_open",
        description: "Abre um app no computador virtual: browser (com url opcional) ou terminal. Abrir o terminal pede aprovação.",
        shape: { app: z.enum(["browser", "terminal"]), url: z.string().url().optional(), reason: reasonField },
        details: async (input) => ({
          target: input.url ? { label: hostOf(text(input.url)), role: "page", url: text(input.url) } : { label: input.app === "terminal" ? "Terminal" : "Navegador", role: "app" },
          ...reasonOf(input),
        }),
        approval: (input) => (input.app === "terminal" ? "Posso abrir um terminal no computador?" : `Posso abrir o navegador do computador${input.url ? ` em ${text(input.url)}` : ""}?`),
        label: (input) => (input.app === "terminal" ? "Abrir terminal" : `Abrir navegador${input.url ? ` em ${hostOf(text(input.url))}` : ""}`),
        run: async (input) => (await ready(), (input.app === "terminal" ? desktop().openTerminal() : desktop().openBrowser(text(input.url) || "about:blank"))),
      },
    );
  }
  tools.push(...artifactTools(bot.id));
  tools.push(...canvasTools(bot.id));
  tools.push(...uploadTools(bot.id));
  return tools;
}
