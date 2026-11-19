import { join, resolve } from "node:path";

export const rootDir = resolve(import.meta.dirname, "..", "..");
export const repoDir = resolve(rootDir, "..", "..");
export const dataDir = process.env.BOTS_DATA_DIR ?? join(repoDir, "data");
export const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
export const port = Number(process.env.GATEWAY_PORT ?? 2000);
export const model = process.env.BOTS_MODEL ?? "claude-sonnet-5-5";

export const botsDir = join(dataDir, "bots");
export const sessionsDir = join(dataDir, "sessions");
export const threadsDir = join(dataDir, "threads");
export const workspacesDir = join(dataDir, "workspaces");

export function botDir(botId: string) {
  return join(botsDir, botId);
}

export function botFile(botId: string) {
  return join(botsDir, `${botId}.json`);
}

export function workspaceDir(botId: string) {
  return join(workspacesDir, botId);
}
