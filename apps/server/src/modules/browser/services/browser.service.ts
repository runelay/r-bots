import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { childEnv, runBytes, run as runProcess } from "@runelay-bots/providers/proc";
import { botDir, env } from "../../../config/env";
import { readJson, writeJson } from "../../../shared/json-file";
import { assertBrowsable, browserLaunchArgs } from "./browser-guard.service";
import { waitForBotControl } from "./control.service";

export interface BrowserState {
  url: string;
  title: string;
  updatedAt: string;
}

export function browserDir(botId: string) {
  return join(botDir(botId), "browser");
}

export function browserProfileDir(botId: string) {
  return join(browserDir(botId), "profile");
}

const staleLocks = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

export const defaultUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

function launchEnv(botId: string) {
  return childEnv({
    AGENT_BROWSER_PROFILE: browserProfileDir(botId),
    AGENT_BROWSER_USER_AGENT: process.env.BROWSER_USER_AGENT?.trim() || defaultUserAgent,
  });
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
const lastTexts = new Map<string, string>();
export const snapshotLimit = 16_000;
export const textLimit = 12_000;

export function pageExcerpt(text: string, offset = 0, length = textLimit) {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  const end = Math.min(text.length, start + Math.max(1, Math.min(Math.floor(length), textLimit)));
  return {
    text: text.slice(start, end),
    offset: start,
    totalChars: text.length,
    ...(end < text.length
      ? { more: `Tem mais texto. Leia o resto com browser_text e offset ${end}.`, nextOffset: end }
      : {}),
  };
}

function clipSnapshot(snapshot: string) {
  if (snapshot.length <= snapshotLimit) return snapshot;
  const cut = snapshot.lastIndexOf("\n", snapshotLimit);
  return `${snapshot.slice(0, cut > 0 ? cut : snapshotLimit)}\n… (${snapshot.length - snapshotLimit} caracteres cortados; use browser_text para o texto da página)`;
}

async function readPageText(botId: string, signal?: AbortSignal) {
  const data = await run(botId, ["get", "text", "body"], signal, 30_000).catch(() => ({}) as Record<string, unknown>);
  const text = String(data.text ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  lastTexts.set(botId, text);
  return text;
}

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
  return runBytes(
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
    { timeoutMs: 8000, ...(typeof source === "string" ? {} : { stdin: source }) },
  ).then(({ code, stdout }) =>
    code !== 0 || !stdout.length ? null : `data:image/jpeg;base64,${Buffer.from(stdout).toString("base64")}`,
  );
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
const browserIdleMs = env.BROWSER_IDLE_MS ?? 10 * 60_000;
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
    void runProcess("agent-browser", ["--session", `runelay-${botId}`, "close"], { timeoutMs: 15_000 }).then(
      ({ code }) => {
        if (code === 0) console.log(`browser ${botId} idle, closed`);
      },
    );
  }
}

const guarded = new Set<string>();

async function sessionNames() {
  const { stdout } = await runProcess("agent-browser", ["session", "list", "--json"], { timeoutMs: 5000 });
  try {
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    return (JSON.parse(line) as { data?: { sessions?: string[] } }).data?.sessions ?? [];
  } catch {
    return [];
  }
}

async function guardedArgs(botId: string) {
  const args = await browserLaunchArgs(botId);
  if (!guarded.has(botId)) {
    guarded.add(botId);
    if ((await sessionNames()).includes(`runelay-${botId}`)) {
      viewportReady.delete(botId);
      await runProcess("agent-browser", ["--session", `runelay-${botId}`, "close"], { timeoutMs: 15_000 });
    }
    const profile = browserProfileDir(botId);
    await mkdir(profile, { recursive: true });
    await Promise.all(staleLocks.map((name) => rm(join(profile, name), { force: true }).catch(() => undefined)));
  }
  return args;
}

async function run(botId: string, args: string[], signal?: AbortSignal, timeoutMs = 60_000) {
  lastUsed.set(botId, Date.now());
  const launch = await guardedArgs(botId);
  const { code, stdout, stderr } = await runProcess(
    "agent-browser",
    ["--session", `runelay-${botId}`, "--args", launch, "--json", ...args],
    { timeoutMs, signal, env: launchEnv(botId) },
  );
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed: { success?: boolean; data?: Record<string, unknown>; error?: string | null } = {};
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = {};
  }
  if (code !== 0 || parsed.success === false)
    throw new Error(parsed.error || stderr.trim() || `agent-browser saiu com código ${code}`);
  return parsed.data ?? {};
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

export async function browserOpen(botId: string, url: string, signal?: AbortSignal, byUser = false) {
  if (!byUser) await assertBrowsable(botId, url);
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

export async function browserAlive(botId: string) {
  const { code, stdout } = await runProcess("agent-browser", ["session", "list", "--json"], { timeoutMs: 5000 });
  if (code !== 0) return true;
  try {
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const sessions = (JSON.parse(line) as { data?: { sessions?: string[] } }).data?.sessions ?? [];
    return sessions.includes(`runelay-${botId}`);
  } catch {
    return true;
  }
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
  const snapshot = String(data.snapshot ?? "");
  lastSnapshots.set(botId, snapshot);
  lastRefs.set(botId, (data.refs as Record<string, { name?: string; role?: string }> | undefined) ?? {});
  const text = await readPageText(botId, signal);
  const page = await captureAfterAction(botId, signal);
  return { ...page, snapshot: clipSnapshot(snapshot), page: pageExcerpt(text) };
}

export async function browserText(botId: string, offset = 0, length = textLimit, signal?: AbortSignal) {
  await waitForBotControl(botId, signal);
  const text = offset > 0 && lastTexts.has(botId) ? (lastTexts.get(botId) ?? "") : await readPageText(botId, signal);
  const state = await readBrowserState(botId);
  return { url: state?.url ?? "", title: state?.title ?? "", ...pageExcerpt(text, offset, length) };
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

async function runFillStdin(botId: string, ref: string, text: string, signal?: AbortSignal) {
  const mask =
    "(() => { const el = document.activeElement; if (el && 'value' in el) { el.style.setProperty('-webkit-text-security', 'disc'); el.setAttribute('autocomplete', 'off'); } return true; })()";
  const { code, stdout } = await runProcess(
    "agent-browser",
    ["--session", `runelay-${botId}`, "--args", await guardedArgs(botId), "--json", "batch", "--bail"],
    {
      timeoutMs: 60_000,
      signal,
      env: launchEnv(botId),
      stdin: JSON.stringify([
        ["fill", normalizeRef(ref), text],
        ["eval", mask],
      ]),
    },
  );
  let ok = code === 0;
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "null") as unknown;
    const results = Array.isArray(parsed) ? parsed : [parsed];
    if (results.some((item) => item && typeof item === "object" && (item as { success?: boolean }).success === false))
      ok = false;
  } catch {}
  if (!ok) throw new Error("Não consegui preencher o campo com o segredo. Confira a referência com browser_snapshot.");
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
