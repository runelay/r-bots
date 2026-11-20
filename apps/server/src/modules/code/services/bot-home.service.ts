import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { worktreesRoot } from "./repos.service";
import type { WorkspaceState } from "./workspace.service";

export function shellSupported(provider: string, runner: string) {
  return runner === "vps" && provider === "claude";
}

export function botHomePath(botId: string) {
  return join(worktreesRoot, ".bots", botId.replace(/[^\w-]/g, "_"));
}

export async function ensureBotHome(botId: string): Promise<WorkspaceState> {
  const path = botHomePath(botId);
  await mkdir(path, { recursive: true });
  return {
    id: `home:${botId}`,
    repo: "",
    repoName: "",
    path,
    branch: "",
    base: "",
    baseCommit: "",
    task: "",
    openedAt: "",
    active: true,
    closedAt: null,
    install: { status: "skipped", manager: null, command: null, startedAt: null, finishedAt: null },
  };
}
