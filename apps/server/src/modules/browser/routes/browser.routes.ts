import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { dataDir } from "../../../config/env";
import { notFound, type Req, type Res, readBody, sendJson } from "../../../shared/http";
import type { BotDefinition } from "../../bots/services/bots.service";
import { botIsCoding } from "../../code/services/bot-code.service";
import {
  browserAlive,
  browserDir,
  browserHistory,
  browserOpen,
  fullScreenshot,
  markBrowserViewed,
  readBrowserState,
} from "../services/browser.service";
import { controllerOf, setController } from "../services/control.service";
import { publishLiveState } from "../services/live-view.service";

async function handleBrowser(res: Res, bot: BotDefinition) {
  markBrowserViewed(bot.id);
  const state = await readBrowserState(bot.id);
  if (!state) return sendJson(res, 404, { ok: false, error: "Esse bot ainda não abriu nenhuma página." });
  sendJson(res, 200, {
    ...state,
    screenshotPath: `/bots/${bot.id}/browser/latest.png`,
    controller: controllerOf(bot.id),
    alive: await browserAlive(bot.id),
  });
}

async function handleFullScreenshot(res: Res, bot: BotDefinition) {
  if (!(await readBrowserState(bot.id))) return sendJson(res, 404, { ok: false, error: "Nenhum print ainda." });
  try {
    await fullScreenshot(bot.id);
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      error: `Não consegui tirar o print: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    });
  }
  return handleScreenshot(res, bot, "full.png");
}

async function handleScreenshot(res: Res, bot: BotDefinition, name = "latest.png") {
  if (name === "latest.png") markBrowserViewed(bot.id);
  const file = join(browserDir(bot.id), name);
  try {
    const info = await stat(file);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(info.size),
      "cache-control": "no-store",
      "last-modified": info.mtime.toUTCString(),
    });
    res.end(Bun.file(file));
  } catch {
    sendJson(res, 404, { ok: false, error: "Nenhum print ainda." });
  }
}

async function handleDesktopScreenshot(res: Res, bot: BotDefinition) {
  const file = join(dataDir, "bots", bot.id, "desktop", "latest.png");
  try {
    const info = await stat(file);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(info.size),
      "cache-control": "no-store",
      "last-modified": info.mtime.toUTCString(),
    });
    res.end(Bun.file(file));
  } catch {
    sendJson(res, 404, { ok: false, error: "Nenhum print do computador ainda." });
  }
}

export async function handleBotBrowser(req: Req, res: Res, method: string, bot: BotDefinition, tail: string) {
  if (tail === "browser" && method === "GET") return handleBrowser(res, bot);
  if (tail === "browser/open" && method === "POST") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
    }
    if (!bot.capabilities.browser && !(await botIsCoding(bot.id).catch(() => false)))
      return sendJson(res, 409, { ok: false, code: "no_browser", error: "Esse bot não tem navegador." });
    const raw = (body as { url?: unknown } | undefined)?.url;
    let target: URL | null = null;
    try {
      target = typeof raw === "string" ? new URL(raw) : null;
    } catch {
      target = null;
    }
    if (!target || !["http:", "https:"].includes(target.protocol)) {
      return sendJson(res, 400, { ok: false, error: "Use uma URL http ou https.", field: "url" });
    }
    try {
      const state = await browserOpen(bot.id, target.toString(), undefined, true);
      publishLiveState(bot.id);
      return sendJson(res, 200, {
        url: state.url,
        title: state.title,
        updatedAt: state.updatedAt,
        screenshotPath: `/bots/${bot.id}/browser/latest.png`,
      });
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: `Não consegui abrir a página: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      });
    }
  }
  if (tail === "browser/control" && method === "POST") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "JSON inválido.", field: "body" });
    }
    const mode = (body as { mode?: unknown } | undefined)?.mode;
    if (mode !== "user" && mode !== "bot")
      return sendJson(res, 400, { ok: false, error: "Use mode user ou bot.", field: "mode" });
    if (!bot.capabilities.browser && !bot.capabilities.desktop && !(await botIsCoding(bot.id).catch(() => false)))
      return sendJson(res, 409, { ok: false, code: "no_browser", error: "Esse bot não tem navegador nem computador." });
    setController(bot.id, mode);
    return sendJson(res, 200, { ok: true, controller: controllerOf(bot.id) });
  }
  if (["browser/back", "browser/forward", "browser/reload"].includes(tail) && method === "POST") {
    await readBody(req).catch(() => undefined);
    if (!bot.capabilities.browser && !(await botIsCoding(bot.id).catch(() => false)))
      return sendJson(res, 409, { ok: false, code: "no_browser", error: "Esse bot não tem navegador." });
    try {
      const state = await browserHistory(bot.id, tail.split("/")[1] as "back" | "forward" | "reload");
      publishLiveState(bot.id);
      return sendJson(res, 200, {
        url: state.url,
        title: state.title,
        updatedAt: state.updatedAt,
        screenshotPath: `/bots/${bot.id}/browser/latest.png`,
        controller: controllerOf(bot.id),
      });
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: `Falha no navegador: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      });
    }
  }
  if (tail === "desktop/latest.png" && method === "GET") return handleDesktopScreenshot(res, bot);
  if (tail === "browser/full.png" && method === "GET") return handleFullScreenshot(res, bot);
  if (tail === "browser/latest.png" && method === "GET") return handleScreenshot(res, bot);
  const shot = /^browser\/(?:shots|screenshots)\/([\w-][\w.-]*\.png)$/.exec(tail);
  if (shot && method === "GET") return handleScreenshot(res, bot, join("shots", basename(shot[1])));
  notFound(res);
}
