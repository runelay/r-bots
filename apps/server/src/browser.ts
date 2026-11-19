import { execFile } from "node:child_process";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { botDir } from "./config";
import { waitForBotControl } from "./control";
import { readJson, writeJson } from "./json-file";

export interface BrowserState {
  url: string;
  title: string;
  updatedAt: string;
}

export function browserDir(botId: string) {
  return join(botDir(botId), "browser");
}

export function browserStateFile(botId: string) {
  return join(browserDir(botId), "state.json");
}

export function latestScreenshotFile(botId: string) {
  return join(browserDir(botId), "latest.png");
}

export function readBrowserState(botId: string) {
  return readJson<BrowserState | null>(browserStateFile(botId), null);
}

export const viewport = { width: 1280, height: 800 };
const viewportReady = new Set<string>();
const actionInFlight = new Set<string>();
const lastSnapshots = new Map<string, string>();
const lastRefs = new Map<string, Record<string, { name?: string; role?: string }>>();

export interface ApprovalTarget {
  label: string;
  role: string;
  app?: string;
  bundleId?: string;
  url?: string;
}

export function elementTarget(botId: string, ref: string): ApprovalTarget | null {
  const id = ref.trim().replace(/^@/, "");
  const entry = lastRefs.get(botId)?.[id];
  if (entry) return { label: String(entry.name ?? "").trim(), role: String(entry.role ?? "") };
  const line = elementText(botId, ref);
  const match = line.match(/^-?\s*([\w-]+)(?:\s+"([^"]*)")?/);
  return match ? { label: (match[2] ?? "").trim(), role: match[1] } : null;
}

export function cropPreview(
  source: string | Buffer,
  box: { x: number; y: number; width: number; height: number },
  pad = 28,
) {
  const width = Math.max(48, Math.round(box.width + pad * 2));
  const height = Math.max(32, Math.round(box.height + pad * 2));
  const left = Math.max(0, Math.round(box.x - pad));
  const top = Math.max(0, Math.round(box.y - pad));
  const filter = `crop='min(iw,${width})':'min(ih,${height})':'min(${left},iw-min(iw,${width}))':'min(${top},ih-min(ih,${height}))',scale='min(360,iw)':-2`;
  const input = typeof source === "string" ? source : "pipe:0";
  return new Promise<string | null>((resolve) => {
    const child = execFile(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        input,
        "-vf",
        filter,
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 8000 },
      (error, stdout) =>
        resolve(error || !stdout.length ? null : `data:image/jpeg;base64,${stdout.toString("base64")}`),
    );
    if (typeof source !== "string") child.stdin?.end(source);
  });
}

export async function elementPreview(botId: string, ref: string) {
  if (actionInFlight.has(botId)) return null;
  const target = normalizeRef(ref);
  const file = join(browserDir(botId), "preview.png");
  try {
    await run(botId, ["scrollintoview", target], undefined, 8000).catch(() => undefined);
    const box = await run(botId, ["get", "box", target], undefined, 8000);
    if (!(Number(box.width) > 0 && Number(box.height) > 0)) return null;
    await run(botId, ["screenshot", file], undefined, 15_000);
    return await cropPreview(file, {
      x: Number(box.x),
      y: Number(box.y),
      width: Number(box.width),
      height: Number(box.height),
    });
  } catch {
    return null;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

export function elementText(botId: string, ref: string) {
  const id = ref.trim().replace(/^@/, "");
  const snapshot = lastSnapshots.get(botId) ?? "";
  const line = snapshot
    .split("\n")
    .find((item) => item.includes(`[ref=${id}]`) || item.includes(`ref=${id},`) || item.includes(`ref=${id} `));
  return line?.trim().slice(0, 300) ?? "";
}

const lastViewed = new Map<string, number>();
const lastUsed = new Map<string, number>();
const browserIdleMs = Number(process.env.BROWSER_IDLE_MS ?? 10 * 60_000);
const viewedWindowMs = 20_000;

export function markBrowserViewed(botId: string) {
  lastViewed.set(botId, Date.now());
}

export function closeIdleBrowsers(keep: (botId: string) => boolean) {
  const now = Date.now();
  for (const [botId, used] of [...lastUsed]) {
    if (now - used < browserIdleMs || actionInFlight.has(botId) || liveInFlight.has(botId) || keep(botId)) continue;
    lastUsed.delete(botId);
    viewportReady.delete(botId);
    execFile("agent-browser", ["--session", `runelay-${botId}`, "close"], { timeout: 15_000 }, (error) => {
      if (!error) console.log(`browser ${botId} idle, closed`);
    });
  }
}

function run(botId: string, args: string[], signal?: AbortSignal, timeoutMs = 60_000) {
  lastUsed.set(botId, Date.now());
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(
      "agent-browser",
      ["--session", `runelay-${botId}`, "--args", "--no-sandbox", "--json", ...args],
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        let parsed: { success?: boolean; data?: Record<string, unknown>; error?: string | null } = {};
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = {};
        }
        if (error || parsed.success === false) {
          reject(new Error(parsed.error || stderr.trim() || error?.message || "agent-browser falhou"));
          return;
        }
        resolve(parsed.data ?? {});
      },
    );
  });
}

export async function captureAfterAction(botId: string, signal?: AbortSignal) {
  const dir = browserDir(botId);
  const shotsDir = join(dir, "shots");
  await mkdir(shotsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const shot = join(shotsDir, `${stamp}.png`);
  await run(botId, ["screenshot", shot], signal);
  await copyFile(shot, latestScreenshotFile(botId));
  const url = String((await run(botId, ["get", "url"], signal)).url ?? "");
  const title = String((await run(botId, ["get", "title"], signal)).title ?? "");
  const state: BrowserState = { url, title, updatedAt: new Date().toISOString() };
  await writeJson(browserStateFile(botId), state);
  return { ...state, screenshot: shot };
}

const liveInFlight = new Set<string>();

export async function liveCapture(botId: string) {
  if (Date.now() - (lastViewed.get(botId) ?? 0) > viewedWindowMs) return;
  if (liveInFlight.has(botId) || actionInFlight.has(botId)) return;
  const state = await readBrowserState(botId);
  if (!state) return;
  liveInFlight.add(botId);
  try {
    const tmp = join(browserDir(botId), "live.png");
    await run(botId, ["screenshot", tmp]);
    await rename(tmp, latestScreenshotFile(botId));
    const url = String((await run(botId, ["get", "url"])).url ?? state.url);
    const title = String((await run(botId, ["get", "title"])).title ?? state.title);
    await writeJson(browserStateFile(botId), { url, title, updatedAt: new Date().toISOString() });
  } catch {
  } finally {
    liveInFlight.delete(botId);
  }
}

export function startLiveView(botIds: string[], intervalMs = 1500) {
  if (botIds.length === 0) return () => undefined;
  const timer = setInterval(() => {
    for (const botId of botIds) void liveCapture(botId);
  }, intervalMs);
  return () => clearInterval(timer);
}

async function ensureViewport(botId: string, signal?: AbortSignal, force = false) {
  if (!force && viewportReady.has(botId)) return;
  await run(botId, ["set", "viewport", String(viewport.width), String(viewport.height)], signal, 20_000);
  viewportReady.add(botId);
}

async function settle(botId: string, signal?: AbortSignal) {
  await run(botId, ["wait", "500"], signal, 10_000).catch(() => undefined);
  await run(botId, ["wait", "--fn", "document.readyState === 'complete'"], signal, 15_000).catch(() => undefined);
}

async function action<T>(botId: string, work: () => Promise<T>, byUser = false, signal?: AbortSignal) {
  if (!byUser) await waitForBotControl(botId, signal);
  actionInFlight.add(botId);
  try {
    return await work();
  } finally {
    actionInFlight.delete(botId);
  }
}

export function browserOpen(botId: string, url: string, signal?: AbortSignal, byUser = false) {
  return action(
    botId,
    async () => {
      await ensureViewport(botId, signal, true);
      await run(botId, ["open", url], signal);
      await settle(botId, signal);
      return captureAfterAction(botId, signal);
    },
    byUser,
    signal,
  );
}

export function browserHistory(botId: string, command: "back" | "forward" | "reload") {
  return action(
    botId,
    async () => {
      await ensureViewport(botId);
      await run(botId, [command], undefined, 20_000);
      await settle(botId);
      return captureAfterAction(botId);
    },
    true,
  );
}

export function browserAlive(botId: string) {
  return new Promise<boolean>((resolve) => {
    execFile("agent-browser", ["session", "list", "--json"], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(true);
      try {
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        const sessions = (JSON.parse(line) as { data?: { sessions?: string[] } }).data?.sessions ?? [];
        resolve(sessions.includes(`runelay-${botId}`));
      } catch {
        resolve(true);
      }
    });
  });
}

export async function ensureBrowser(botId: string) {
  if (!(await readBrowserState(botId))) await browserOpen(botId, "about:blank", undefined, true);
  await ensureViewport(botId);
}

export async function cdpUrl(botId: string) {
  await ensureBrowser(botId);
  const data = await run(botId, ["get", "cdp-url"], undefined, 20_000);
  const url = String(data.cdpUrl ?? "");
  if (!url.startsWith("ws")) throw new Error("agent-browser não devolveu a URL do CDP.");
  return url;
}

export async function fullScreenshot(botId: string) {
  const file = join(browserDir(botId), "full.png");
  await run(botId, ["screenshot", "--full", file], undefined, 30_000);
  return file;
}

export async function browserSnapshot(botId: string, signal?: AbortSignal) {
  await waitForBotControl(botId, signal);
  await ensureViewport(botId, signal);
  const data = await run(botId, ["snapshot", "-i"], signal);
  lastSnapshots.set(botId, String(data.snapshot ?? ""));
  lastRefs.set(botId, (data.refs as Record<string, { name?: string; role?: string }> | undefined) ?? {});
  const page = await captureAfterAction(botId, signal);
  return { ...page, snapshot: String(data.snapshot ?? "") };
}

export function browserClick(botId: string, ref: string, signal?: AbortSignal) {
  return action(botId, async () => {
    await ensureViewport(botId, signal);
    await run(botId, ["scrollintoview", normalizeRef(ref)], signal, 15_000).catch(() => undefined);
    await run(botId, ["click", normalizeRef(ref)], signal);
    await settle(botId, signal);
    return captureAfterAction(botId, signal);
  });
}

function runFillStdin(botId: string, ref: string, text: string, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "agent-browser",
      ["--session", `runelay-${botId}`, "--args", "--no-sandbox", "--json", "batch", "--bail"],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal },
      (error, stdout) => {
        let ok = !error;
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "null") as unknown;
          const results = Array.isArray(parsed) ? parsed : [parsed];
          if (
            results.some(
              (item) => item && typeof item === "object" && (item as { success?: boolean }).success === false,
            )
          )
            ok = false;
        } catch {}
        if (ok) resolve();
        else
          reject(new Error("Não consegui preencher o campo com o segredo. Confira a referência com browser_snapshot."));
      },
    );
    const mask =
      "(() => { const el = document.activeElement; if (el && 'value' in el) { el.style.setProperty('-webkit-text-security', 'disc'); el.setAttribute('autocomplete', 'off'); } return true; })()";
    child.stdin?.end(
      JSON.stringify([
        ["fill", normalizeRef(ref), text],
        ["eval", mask],
      ]),
    );
  });
}

export function browserFill(botId: string, ref: string, text: string, signal?: AbortSignal, secret = false) {
  return action(botId, async () => {
    await ensureViewport(botId, signal);
    await run(botId, ["scrollintoview", normalizeRef(ref)], signal, 15_000).catch(() => undefined);
    if (secret) await runFillStdin(botId, ref, text, signal);
    else await run(botId, ["fill", normalizeRef(ref), text], signal);
    await settle(botId, signal);
    return captureAfterAction(botId, signal);
  });
}

export async function browserScreenshot(botId: string, signal?: AbortSignal) {
  await waitForBotControl(botId, signal);
  await ensureViewport(botId, signal);
  return captureAfterAction(botId, signal);
}

function normalizeRef(ref: string) {
  const trimmed = ref.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}
