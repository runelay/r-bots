import { mkdir } from "node:fs/promises";
import { activeMarkers, sweepOrphans } from "@runelay-bots/providers/proc-tree";
import { startServer } from "./app";
import { dataDir, host, model, port } from "./config/env";
import { refreshAccounts } from "./modules/accounts/services/accounts.service";
import { initAuth } from "./modules/auth/gate";
import { loadBots } from "./modules/bots/services/bots.service";
import { closeIdleBrowsers } from "./modules/browser/services/browser.service";
import { stopAllDesktops } from "./modules/browser/services/desktop.service";
import { hasLiveClients } from "./modules/browser/services/live-view.service";
import { stopAllDevServers } from "./modules/code/services/dev-server.service";
import { startCodeHousekeeping } from "./modules/code/services/housekeeping.service";
import { listConnections } from "./modules/connectors/services/runelay.service";
import { loadSessions } from "./modules/conversations/services/sessions.service";
import { settleOrphanTurns } from "./modules/conversations/services/turn-repair.service";
import { botStatuses } from "./modules/engine/services/engine.service";
import { loadGroups } from "./modules/groups/services/groups.service";
import { startScheduler } from "./modules/schedules/services/scheduler.service";
import { loadSections } from "./modules/sections/services/sections.service";
import { warmUsage } from "./modules/usage/services/usage.service";
import { loadVault } from "./modules/vault/services/vault.service";
import { endAllCalls } from "./modules/voice/services/voice.service";
import { installConsoleRedaction } from "./shared/redact";

for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY", "XAI_API_KEY"])
  delete Bun.env[key];

async function main() {
  installConsoleRedaction();
  await mkdir(dataDir, { recursive: true });
  await loadVault();
  await loadBots();
  void listConnections(true).catch(() => undefined);
  setInterval(() => void listConnections(true).catch(() => undefined), 5 * 60_000).unref();
  await loadSessions();
  const orphanTurns = await settleOrphanTurns();
  if (orphanTurns > 0) console.log(`settled ${orphanTurns} turns left open by a restart`);
  await loadSections();
  await loadGroups();
  startScheduler();
  warmUsage();
  startCodeHousekeeping();
  const startupOrphans = sweepOrphans();
  if (startupOrphans.length > 0) console.log(`killed ${startupOrphans.length} orphan processes at startup`);
  setInterval(() => {
    const orphans = sweepOrphans(activeMarkers());
    if (orphans.length > 0)
      console.log(`killed orphans: ${orphans.map((proc) => `${proc.pid} ${proc.command.slice(0, 60)}`).join("; ")}`);
    closeIdleBrowsers((botId) => botStatuses()[botId] === "working" || hasLiveClients(botId));
  }, 60_000).unref();
  void refreshAccounts().then((accounts) =>
    console.log(`accounts: ${accounts.map((item) => `${item.id}=${item.status}`).join(", ")}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopAllDesktops();
      stopAllDevServers();
      endAllCalls();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
  await initAuth();
  startServer(host, port);
  console.log(`runelay bots (claude-agent-sdk, ${model}) on http://${host}:${port}`);
}

void main();
