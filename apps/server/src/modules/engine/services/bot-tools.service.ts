import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { botDir } from "../../../config/env";
import { artifactTools } from "../../artifacts/services/artifacts.service";
import { blockTools } from "../../blocks/services/block-tools.service";
import type { BotDefinition } from "../../bots/services/bots.service";
import {
  type ApprovalTarget,
  browserClick,
  browserFill,
  browserOpen,
  browserScreenshot,
  browserSnapshot,
  browserText,
  cropPreview,
  elementPreview,
  elementTarget,
  readBrowserState,
} from "../../browser/services/browser.service";
import { assertBrowsable } from "../../browser/services/browser-guard.service";
import { waitForBotControl } from "../../browser/services/control.service";
import { getDesktop } from "../../browser/services/desktop.service";
import { canvasTools } from "../../canvas/services/canvas.service";
import { uploadTools } from "../../uploads/services/uploads.service";
import { speechTools } from "../../voice/services/speech-tools.service";
import { botToolsText } from "../constants/bot-tools-messages.constants";

export interface BotTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  approval: ((input: Record<string, unknown>) => string | null | Promise<string | null>) | null;
  label: (input: Record<string, unknown>) => string | Promise<string>;
  run: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  details?: (input: Record<string, unknown>) => Promise<ApprovalDetails>;
  humanReason?: (input: Record<string, unknown>) => string | null;
}

export interface ApprovalDetails {
  target?: ApprovalTarget;
  previewImage?: string;
  reason?: string;
  grant?: string;
  untilTurnEnd?: boolean;
  secret?: Record<string, unknown>;
  integration?: Record<string, unknown>;
}

const webUrl = z
  .string()
  .url()
  .regex(/^https?:\/\//i, "Só endereços http ou https.");

const reasonField = z
  .string()
  .max(160)
  .optional()
  .describe("Uma frase curta, em português, dizendo à pessoa por que você quer fazer isso");

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
  if (bot.capabilities.browser) {
    tools.push(
      {
        name: "browser_open",
        description:
          "Abre uma URL http ou https no seu navegador (o Navegador do bot, que roda no servidor e não atrapalha a pessoa). É o padrão para qualquer site ou app web: use antes de pensar em computer_*. O login fica salvo entre as conversas. Devolve url e título; veja a página com browser_snapshot (texto e referências) ou browser_screenshot (imagem). Endereços internos (localhost, rede privada, tailnet, metadados) são bloqueados, exceto os servidores de dev que você abriu; para um app que roda no Mac da pessoa, peça uma URL pública (túnel).",
        shape: { url: webUrl },
        approval: null,
        label: (input) => botToolsText("open", { url: text(input.url) }),
        run: (input, signal) => browserOpen(bot.id, text(input.url), signal),
      },
      {
        name: "browser_snapshot",
        description:
          "Lê a página atual: as referências dos elementos interativos (@e1, @e2...) e, em page, o começo do texto da página. Quando a página é longa, page.more diz o offset para continuar com browser_text. Ao responder com o que leu, cite a página (título e URL). Se a página não abriu ou veio uma página de erro, diga isso à pessoa em vez de responder de memória.",
        shape: {},
        approval: null,
        label: () => botToolsText("readPage"),
        run: (_input, signal) => browserSnapshot(bot.id, signal),
      },
      {
        name: "browser_text",
        description:
          "Lê o texto da página atual em trechos, a partir de offset (em caracteres). Use para páginas longas, seguindo o nextOffset que cada trecho devolve. Cite a página (título e URL) ao usar o conteúdo.",
        shape: {
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(500).max(12_000).optional(),
        },
        approval: null,
        label: () => botToolsText("readPageText"),
        run: (input, signal) =>
          browserText(
            bot.id,
            Number(input.offset ?? 0),
            input.length === undefined ? undefined : Number(input.length),
            signal,
          ),
      },
      {
        name: "browser_click",
        description:
          "Clica num elemento da página pela referência do snapshot (ex.: @e3). Pede aprovação de uma pessoa.",
        shape: { ref: z.string().min(1), reason: reasonField },
        approval: (input) => botToolsText("clickPrompt", { target: named(input.ref, botToolsText("pageElement")) }),
        label: (input) => botToolsText("click", { target: named(input.ref, botToolsText("element")) }),
        details: pageDetails,
        run: (input, signal) => browserClick(bot.id, text(input.ref), signal),
      },
      {
        name: "browser_fill",
        description:
          "Preenche um campo da página pela referência do snapshot (ex.: @e2). Para senha ou token, use text = segredo:nome (do cofre): o valor entra só na hora e não pede aprovação. Texto comum pede aprovação de uma pessoa.",
        shape: { ref: z.string().min(1), text: z.string(), reason: reasonField },
        approval: (input) =>
          botToolsText("fillPrompt", { target: named(input.ref, botToolsText("field")), text: text(input.text) }),
        label: (input) => botToolsText("fill", { target: named(input.ref, botToolsText("field")) }),
        details: pageDetails,
        run: (input, signal) =>
          browserFill(bot.id, text(input.ref), text(input.text), signal, input.secretFill === true),
      },
      {
        name: "browser_screenshot",
        description: "Tira um print da página atual do seu navegador e devolve a imagem para você ver.",
        shape: {},
        approval: null,
        label: () => botToolsText("screenshot"),
        run: async (_input, signal) => {
          const page = await browserScreenshot(bot.id, signal);
          const png = await readFile(page.screenshot);
          return { ...page, imageBase64: png.toString("base64") };
        },
      },
    );
  }
  if (bot.capabilities.desktop) {
    const desktop = () => getDesktop(bot.id);
    const ready = () => waitForBotControl(bot.id);
    tools.push(
      {
        name: "desktop_screenshot",
        description:
          "Tira um print do seu computador virtual (1280x800). Use antes de clicar para saber as coordenadas.",
        shape: {},
        approval: null,
        label: () => botToolsText("desktopScreenshot"),
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
        shape: {
          x: z.number().min(0).max(1280),
          y: z.number().min(0).max(800),
          button: z.enum(["left", "right"]).optional(),
          double: z.boolean().optional(),
          reason: reasonField,
        },
        approval: () => botToolsText("desktopClickPrompt"),
        label: () => botToolsText("desktopClick"),
        details: async (input) => {
          const png = await desktop()
            .screenshot()
            .catch(() => null);
          const previewImage = png
            ? await cropPreview(png, { x: Number(input.x) - 60, y: Number(input.y) - 30, width: 120, height: 60 })
            : null;
          return {
            target: { label: botToolsText("desktopTarget"), role: "desktop" },
            ...(previewImage ? { previewImage } : {}),
            ...reasonOf(input),
          };
        },
        run: async (input) => {
          await ready();
          return desktop().click(
            Number(input.x),
            Number(input.y),
            input.button === "right" ? "right" : "left",
            input.double === true,
          );
        },
      },
      {
        name: "desktop_type",
        description: "Digita um texto no computador virtual, onde estiver o foco. Pede aprovação.",
        shape: { text: z.string().min(1).max(2000), reason: reasonField },
        details: async (input) => ({
          target: { label: botToolsText("desktopTarget"), role: "desktop" },
          ...reasonOf(input),
        }),
        approval: (input) => botToolsText("typePrompt", { text: text(input.text).slice(0, 120) }),
        label: (input) => botToolsText("type", { text: text(input.text).slice(0, 40) }),
        run: async (input) => {
          await ready();
          return desktop().type(text(input.text));
        },
      },
      {
        name: "desktop_key",
        description:
          "Aperta uma tecla ou atalho no computador virtual, no formato do xdotool (Return, ctrl+l, alt+Left). Pede aprovação.",
        shape: { combo: z.string().min(1).max(60), reason: reasonField },
        details: async (input) => ({
          target: { label: botToolsText("desktopTarget"), role: "desktop" },
          ...reasonOf(input),
        }),
        approval: (input) => botToolsText("keyPrompt", { combo: text(input.combo) }),
        label: (input) => botToolsText("key", { combo: text(input.combo) }),
        run: async (input) => {
          await ready();
          return desktop().key(text(input.combo));
        },
      },
      {
        name: "desktop_scroll",
        description: "Rola a tela do computador virtual numa coordenada.",
        shape: {
          x: z.number().min(0).max(1280),
          y: z.number().min(0).max(800),
          direction: z.enum(["up", "down"]),
          amount: z.number().int().min(1).max(20).optional(),
        },
        approval: null,
        label: (input) => botToolsText(input.direction === "down" ? "scrollDown" : "scrollUp"),
        run: async (input) => {
          await ready();
          return desktop().scroll(
            Number(input.x),
            Number(input.y),
            input.direction === "down" ? "down" : "up",
            Number(input.amount ?? 3),
          );
        },
      },
      {
        name: "desktop_open",
        description:
          "Abre um app no computador virtual: browser (com url opcional) ou terminal. Abrir o terminal pede aprovação.",
        shape: { app: z.enum(["browser", "terminal"]), url: webUrl.optional(), reason: reasonField },
        details: async (input) => ({
          target: input.url
            ? { label: hostOf(text(input.url)), role: "page", url: text(input.url) }
            : { label: botToolsText(input.app === "terminal" ? "terminal" : "browser"), role: "app" },
          ...reasonOf(input),
        }),
        approval: (input) =>
          input.app === "terminal"
            ? botToolsText("terminalPrompt")
            : input.url
              ? botToolsText("browserAtPrompt", { url: text(input.url) })
              : botToolsText("browserPrompt"),
        label: (input) =>
          input.app === "terminal"
            ? botToolsText("openTerminal")
            : input.url
              ? botToolsText("openBrowserAt", { host: hostOf(text(input.url)) })
              : botToolsText("openBrowser"),
        run: async (input) => {
          await ready();
          if (input.app === "terminal") return desktop().openTerminal();
          if (input.url) await assertBrowsable(bot.id, text(input.url));
          return desktop().openBrowser(text(input.url) || "about:blank");
        },
      },
    );
  }
  tools.push(...artifactTools(bot.id));
  tools.push(...canvasTools(bot.id));
  tools.push(...uploadTools(bot.id));
  tools.push(...speechTools(bot));
  tools.push(...blockTools(bot.id));
  return tools;
}
